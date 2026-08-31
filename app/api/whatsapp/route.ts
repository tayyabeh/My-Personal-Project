/**
 * The WhatsApp webhook.
 *
 * GET  — Meta calls this once when you save the webhook URL, to check
 *        you really own it. We echo back its challenge string.
 * POST — every incoming message arrives here.
 *
 * The critical rule for POST: return 200 immediately. Meta gives us only
 * a few seconds, and if we are slow it assumes failure and re-sends the
 * same message. So we acknowledge first and do the real work afterwards
 * using waitUntil, which keeps the function alive after the response has
 * already been sent.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { env } from '@/lib/env';
import { log } from '@/lib/logger';
import { messaging } from '@/lib/messaging';
import { handleIncomingSafely } from '@/lib/handlers/incoming';

export const runtime = 'nodejs';
export const maxDuration = 60; // Vercel Hobby allows up to 60 seconds.

// -------------------------------------------------------------------
// GET — webhook verification
// -------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token === env.whatsappVerifyToken() && challenge) {
    log.info('Webhook verified by Meta');
    // Must be the raw challenge string, as plain text.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  log.warn('Webhook verification rejected', { mode, tokenMatched: token === env.whatsappVerifyToken() });
  return new Response('Forbidden', { status: 403 });
}

// -------------------------------------------------------------------
// POST — incoming messages
// -------------------------------------------------------------------

/**
 * Confirm the request genuinely came from Meta, by checking the
 * signature it sends against a hash computed with our app secret.
 * Skipped if META_APP_SECRET is not set, so you can test before you
 * have configured it.
 */
function signatureIsValid(rawBody: string, header: string | null): boolean {
  const secret = env.metaAppSecret();
  if (!secret) return true; // not configured yet

  if (!header?.startsWith('sha256=')) return false;

  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // Lengths must match before timingSafeEqual, or it throws.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  // Read the body as raw text, because the signature is computed over
  // the exact bytes Meta sent. Re-serialising parsed JSON would not match.
  const rawBody = await request.text();

  if (!signatureIsValid(rawBody, request.headers.get('x-hub-signature-256'))) {
    log.warn('Rejected webhook with bad signature');
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn('Webhook body was not valid JSON');
    return new Response('OK', { status: 200 }); // never make Meta retry a malformed body
  }

  const messages = messaging.parseIncoming(payload);

  if (messages.length > 0) {
    // Do NOT await this. The response below goes out immediately and
    // waitUntil keeps the function running until the work finishes.
    waitUntil(
      (async () => {
        for (const message of messages) {
          try {
            await handleIncomingSafely(message);
          } catch (error) {
            log.error('Failed to handle message', {
              id: message.whatsappMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })(),
    );
  }

  return new Response('OK', { status: 200 });
}
