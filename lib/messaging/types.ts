/**
 * The messaging interface.
 *
 * Nothing outside lib/messaging/ should know that WhatsApp exists, or
 * anything about media IDs, the 24-hour window, or Meta's payload shape.
 * Feature code just calls these methods.
 */

/** A message that arrived from the user. */
export interface IncomingMessage {
  /** WhatsApp's own id for this message — used to avoid processing duplicates. */
  whatsappMessageId: string;
  /** Sender's number, digits only. */
  from: string;
  kind: 'text' | 'audio' | 'unsupported';
  /** Present when kind === 'text'. */
  text?: string;
  /** Present when kind === 'audio'. Must be downloaded before use. */
  audioMediaId?: string;
  sentAt: Date;
}

/** Identifies a pre-approved WhatsApp template and its {{1}}, {{2}}... values. */
export interface TemplateSpec {
  name: string;
  /** Language code as registered in Meta, e.g. 'en' or 'en_US'. */
  language: string;
  /** Values substituted into {{1}}, {{2}}, ... in order. */
  params: string[];
}

export interface MessagingAdapter {
  /**
   * Send a message, automatically choosing freeform or template based on
   * whether we are inside WhatsApp's 24-hour window. This is the ONLY
   * send method feature code should call.
   */
  send(content: string, templateFallback: TemplateSpec, to?: string): Promise<void>;

  /** Send freeform text. Only valid inside the 24-hour window. */
  sendText(text: string, to?: string): Promise<void>;

  /** Send audio so it appears as a playable voice message. */
  sendVoice(audio: Buffer): Promise<void>;

  /** Send a pre-approved template. Always allowed, any time. */
  sendTemplate(spec: TemplateSpec): Promise<void>;

  /** Download a voice note's raw bytes given the media id from a webhook. */
  downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }>;

  /**
   * Turn a raw webhook body into zero or more messages.
   * Returns an array because Meta can batch several messages into one
   * webhook call — the spec said one, but the API really does batch.
   */
  parseIncoming(payload: unknown): IncomingMessage[];
}
