/**
 * WhatsApp Cloud API adapter.
 *
 * This is the only file in the project that knows about Meta's API.
 * Everything awkward about WhatsApp is handled here and hidden behind
 * the MessagingAdapter interface.
 */
import { env } from '../env';
import { db } from '../supabase';
import { log } from '../logger';
import type { IncomingMessage, MessagingAdapter, TemplateSpec } from './types';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.graphVersion()}/${path}`;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.whatsappToken()}` };
}

/** POST a JSON body to the messages endpoint and throw a readable error on failure. */
async function postMessage(body: unknown): Promise<void> {
  const url = graphUrl(`${env.whatsappPhoneNumberId()}/messages`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WhatsApp send failed (HTTP ${response.status}): ${detail}`);
  }
}

/** Record an outbound message so the dashboard can show full history. */
async function recordOutbound(content: string, wasVoice = false): Promise<void> {
  const { error } = await db()
    .from('messages')
    .insert({ direction: 'outbound', content, was_voice: wasVoice });
  if (error) log.error('Could not save outbound message', { error: error.message });
}

/**
 * When did the user last message us?
 *
 * WhatsApp only permits freeform replies within 24 hours of the user's
 * last inbound message. Outside that window only approved templates go
 * through, so we have to check before every send.
 */
async function lastInboundAt(): Promise<Date | null> {
  const { data, error } = await db()
    .from('messages')
    .select('created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error('Could not read last inbound time; assuming window is closed', {
      error: error.message,
    });
    return null;
  }
  return data ? new Date(data.created_at as string) : null;
}

export class WhatsAppAdapter implements MessagingAdapter {
  async send(content: string, templateFallback: TemplateSpec, to?: string): Promise<void> {
    const last = await lastInboundAt();
    const open = last !== null && Date.now() - last.getTime() < TWENTY_FOUR_HOURS_MS;

    if (open) {
      await this.sendText(content, to);
    } else {
      log.info('24-hour window closed, falling back to template', {
        template: templateFallback.name,
      });
      await this.sendTemplate(templateFallback);
    }
  }

  /** `to` defaults to WHATSAPP_RECIPIENT_NUMBER, which is what the cron jobs use. */
  async windowIsOpen(): Promise<boolean> {
    const last = await lastInboundAt();
    return last !== null && Date.now() - last.getTime() < TWENTY_FOUR_HOURS_MS;
  }

  async sendText(text: string, to?: string): Promise<void> {
    await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to ?? env.whatsappRecipient(),
      type: 'text',
      text: { preview_url: false, body: text },
    });
    await recordOutbound(text);
  }

  async sendTemplate(spec: TemplateSpec): Promise<void> {
    await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: env.whatsappRecipient(),
      type: 'template',
      template: {
        name: spec.name,
        language: { code: spec.language },
        components: spec.params.length
          ? [
              {
                type: 'body',
                parameters: spec.params.map((text) => ({ type: 'text', text })),
              },
            ]
          : [],
      },
    });
    await recordOutbound(`[template: ${spec.name}] ${spec.params.join(' | ')}`);
  }

  /**
   * Send audio as a playable message.
   *
   * OGG Opus renders as a voice-note waveform; MP3 renders as an audio
   * player. Both play inline. We send MP3 because producing OGG Opus
   * would mean bundling ffmpeg, which is not worth 78MB on a free plan.
   */
  async sendVoice(audio: Buffer, mimeType = 'audio/mpeg'): Promise<void> {
    const mediaId = await this.uploadMedia(audio, mimeType);
    await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: env.whatsappRecipient(),
      type: 'audio',
      audio: { id: mediaId },
    });
    await recordOutbound('[voice message]', true);
  }

  /** Upload bytes to Meta and get back a media id we can attach to a message. */
  async uploadMedia(buffer: Buffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      mimeType === 'audio/ogg' ? 'voice.ogg' : mimeType === 'audio/mpeg' ? 'voice.mp3' : 'upload.bin',
    );

    const response = await fetch(graphUrl(`${env.whatsappPhoneNumberId()}/media`), {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Media upload failed (HTTP ${response.status}): ${await response.text()}`);
    }
    const json = (await response.json()) as { id: string };
    return json.id;
  }

  /**
   * Download an inbound voice note.
   *
   * Two steps, and the second one is what trips people up:
   *   1. GET /{media-id}  ->  returns a temporary download URL
   *   2. GET that URL, WITH the auth token in the header. Without the
   *      header it returns 401 even though the URL looks public.
   */
  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const lookup = await fetch(graphUrl(mediaId), { headers: authHeaders() });
    if (!lookup.ok) {
      throw new Error(`Media lookup failed (HTTP ${lookup.status}): ${await lookup.text()}`);
    }
    const meta = (await lookup.json()) as { url: string; mime_type: string };

    const download = await fetch(meta.url, { headers: authHeaders() });
    if (!download.ok) {
      throw new Error(`Media download failed (HTTP ${download.status}): ${await download.text()}`);
    }

    const buffer = Buffer.from(await download.arrayBuffer());
    return { buffer, mimeType: meta.mime_type };
  }

  parseIncoming(payload: unknown): IncomingMessage[] {
    const results: IncomingMessage[] = [];
    const body = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              id?: string;
              from?: string;
              type?: string;
              timestamp?: string;
              text?: { body?: string };
              audio?: { id?: string };
            }>;
          };
        }>;
      }>;
    };

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Meta also sends delivery and read receipts through this same
        // webhook. Those have no messages array, so they are skipped.
        for (const message of change.value?.messages ?? []) {
          if (!message.id || !message.from) continue;

          // WhatsApp timestamps are Unix seconds; JavaScript wants milliseconds.
          const sentAt = message.timestamp
            ? new Date(Number(message.timestamp) * 1000)
            : new Date();

          if (message.type === 'text' && message.text?.body) {
            results.push({
              whatsappMessageId: message.id,
              from: message.from,
              kind: 'text',
              text: message.text.body,
              sentAt,
            });
          } else if (message.type === 'audio' && message.audio?.id) {
            results.push({
              whatsappMessageId: message.id,
              from: message.from,
              kind: 'audio',
              audioMediaId: message.audio.id,
              sentAt,
            });
          } else {
            results.push({
              whatsappMessageId: message.id,
              from: message.from,
              kind: 'unsupported',
              sentAt,
            });
          }
        }
      }
    }

    return results;
  }
}

/** The single adapter instance the rest of the app uses. */
export const messaging: MessagingAdapter = new WhatsAppAdapter();
