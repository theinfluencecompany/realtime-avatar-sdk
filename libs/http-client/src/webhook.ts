import { RealtimeAvatarWebhookError } from "./errors.ts";
import { voiceWebhookRequestSchema } from "./generated/voice-webhook.ts";
import type { TranscriptPayload, VoiceWebhookRequest } from "./types.ts";

type WebhookHeaders = Headers | Record<string, string | undefined>;
type VerifyOptions = { toleranceSeconds?: number };

/**
 * Verify a transcript webhook.
 *
 * Pass the RAW request bytes. Parsing to an object and re-serializing changes the whitespace
 * and the signature will never match — that is the single most common way this is got wrong.
 *
 * ```ts
 * const raw = Buffer.from(await request.arrayBuffer());
 * const transcript = await verifyTranscript(raw, request.headers, process.env.TRANSCRIPT_SECRET!);
 * ```
 */
export async function verifyTranscript(
  rawBody: Uint8Array | string,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): Promise<TranscriptPayload> {
  const text = await verifiedBody("transcript webhook", rawBody, headers, secret, options);
  return JSON.parse(text) as TranscriptPayload;
}

/**
 * Verify one `voice.synthesize` request from a call minted with `voiceWebhook`, and return it
 * typed. Same signature scheme and the same rule as {@link verifyTranscript}: pass the RAW bytes.
 *
 * Throws {@link RealtimeAvatarWebhookError}. Answer a signature or timestamp refusal with 401 and
 * `invalid_body` with 400. The worker ends the call on a 401 or 403, because a secret that does not
 * match will not match on the next sentence either.
 *
 * ```ts
 * const raw = Buffer.from(await request.arrayBuffer());
 * const { text, output } = await verifyVoiceWebhook(raw, request.headers, process.env.VOICE_SECRET!);
 * // reply 200, Content-Type audio/pcm: s16le mono at output.sample_rate, streamed
 * ```
 */
export async function verifyVoiceWebhook(
  rawBody: Uint8Array | string,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): Promise<VoiceWebhookRequest> {
  const text = await verifiedBody("voice webhook", rawBody, headers, secret, options);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new RealtimeAvatarWebhookError("invalid_body", "voice webhook body is not JSON", { cause });
  }
  const parsed = voiceWebhookRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RealtimeAvatarWebhookError("invalid_body", "voice webhook body does not match the voice.synthesize contract", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** The signed body as text, once its `x-rta-signature` and `x-rta-timestamp` check out. */
async function verifiedBody(
  label: string,
  rawBody: Uint8Array | string,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions,
): Promise<string> {
  const get = (name: string): string | undefined =>
    headers instanceof Headers ? (headers.get(name) ?? undefined) : headers[name];

  const signature = get("x-rta-signature");
  const timestamp = get("x-rta-timestamp");
  if (!signature || !timestamp) {
    throw new RealtimeAvatarWebhookError("missing_signature", "missing x-rta-signature / x-rta-timestamp");
  }

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > (options.toleranceSeconds ?? 300)) {
    throw new RealtimeAvatarWebhookError("stale_timestamp", `${label} timestamp is outside the replay window`);
  }

  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${text}`));
  const expected = `v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  if (!timingSafeEqual(expected, signature)) {
    throw new RealtimeAvatarWebhookError("bad_signature", `${label} signature mismatch`);
  }
  return text;
}

/** Constant-time compare — a fast-path `===` leaks the signature one byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
