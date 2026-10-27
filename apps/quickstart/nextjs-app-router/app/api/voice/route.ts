// Speak a call in your own voice. A call minted with `voiceWebhook` (see ../call/route.ts) POSTs
// each sentence here; whatever audio this streams back is what she says.
import { RealtimeAvatarWebhookError, verifyVoiceWebhook } from "realtime-avatar";

export async function POST(request: Request): Promise<Response> {
  // RAW bytes: parsing and re-serializing first changes the bytes the signature covers.
  const raw = new Uint8Array(await request.arrayBuffer());
  let job;
  try {
    job = await verifyVoiceWebhook(raw, request.headers, process.env.VOICE_WEBHOOK_SECRET!);
  } catch (err) {
    // A 401 ends the call: a secret that does not match now will not match on the next sentence.
    if (err instanceof RealtimeAvatarWebhookError) {
      return new Response(null, { status: err.code === "invalid_body" ? 400 : 401 });
    }
    throw err;
  }

  // OpenAI's `pcm` is raw signed 16-bit little-endian mono at 24 kHz: exactly `audio/pcm`.
  const speech = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: job.voice_id ?? "alloy", input: job.text, response_format: "pcm" }),
    // The worker closes the connection when the user interrupts her; stop synthesizing too.
    signal: request.signal,
  });
  // A 5xx is retried once as a new POST; if that fails too, the rest of this reply goes unspoken
  // and the next reply tries again. Never answer 401/403 for this: that ends the call.
  if (!speech.ok || !speech.body) return new Response(null, { status: 502 });

  // Stream it through as it arrives: the first byte is what the caller waits for. `rate=` names
  // the rate outright, whatever `output.sample_rate` the mint asked for.
  return new Response(speech.body, { headers: { "content-type": "audio/pcm;rate=24000" } });
}
