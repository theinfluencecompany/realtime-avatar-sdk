import type { TranscriptPayload } from "./types.ts";

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
  headers: Headers | Record<string, string | undefined>,
  secret: string,
  options: { toleranceSeconds?: number } = {},
): Promise<TranscriptPayload> {
  const get = (name: string): string | undefined =>
    headers instanceof Headers ? (headers.get(name) ?? undefined) : headers[name];

  const signature = get("x-rta-signature");
  const timestamp = get("x-rta-timestamp");
  if (!signature || !timestamp) throw new Error("missing x-rta-signature / x-rta-timestamp");

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > (options.toleranceSeconds ?? 300)) {
    throw new Error("transcript webhook timestamp is outside the replay window");
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

  if (!timingSafeEqual(expected, signature)) throw new Error("transcript webhook signature mismatch");
  return JSON.parse(text) as TranscriptPayload;
}

/** Constant-time compare — a fast-path `===` leaks the signature one byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
