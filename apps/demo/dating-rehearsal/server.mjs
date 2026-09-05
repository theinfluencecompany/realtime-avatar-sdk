/**
 * Dating rehearsal — bring your own date.
 *
 * You sit across from a first date who does NOT know it is practice. He answers in real time, so
 * the pauses you leave are pauses he actually sits through. As the vibe moves he quietly rates his
 * interest, pins the moments that turned it, ends the date if it truly dies — and, at the end,
 * writes the debrief you actually came for.
 *
 * TWO things worth copying live here:
 *
 * 1. THE FOUR TOOLS ARE HIS CALL. Nobody in the page asks him for a tool. The same model being
 *    charming is the one deciding how it is going, and it says so by calling tools that live in the
 *    page: `rate_interest` drives a meter, `mark_moment` pins a beat, `end_date` walks him out,
 *    `write_debrief` fills the after-card. State rides the tool call, never a transcript a meter
 *    could misread.
 *
 * 2. THE DATE IS MADE FROM A PHOTO YOU UPLOAD. A live avatar needs a VIDEO source — an avatar built
 *    from a still image reaches `ready` and then publishes a BLACK track. So this server turns the
 *    photo into a short CLOSED-LOOP idle clip first (first frame == last frame → a seamless loop),
 *    hosts it, and only then registers the avatar from that video. The image→loop step is not on
 *    the realtime-avatar API, so we do it here with an image-to-video model (fal MiniMax H3) and
 *    lean on the SDK for the rest: `uploadAsset` hosts the photo, `createAvatarFromVideo` registers
 *    the loop, `getAvatar` is polled to `ready`. The whole thing takes ~2 minutes.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4195);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);
// Image-to-video that pins the last frame to the first, so the clip is a seamless idle loop. Any
// fal i2v that takes `end_image_url` works; this one takes real faces without a photoreal refusal.
const FAL_MODEL = process.env.FAL_MODEL ?? "minimax/h3/image-to-video";

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
// The SECOND key. The realtime-avatar API takes a hosted looping VIDEO, not a still image, so the
// photo→loop step runs here against fal and its key never leaves the server.
const falKey = process.env.FAL_KEY;
if (!falKey) {
  console.error("Missing FAL_KEY — copy .env.example to .env and fill it in (the photo→loop step needs it).");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "demo-dating-rehearsal" });

/**
 * The date's brief. Chosen HERE — how the date behaves is policy, not a request parameter. The four
 * tools are the whole game, and every one of them is the date's OWN decision, made in character.
 * Nothing here names the meter, the timeline or the after-card; the page owns what a call means.
 *
 * The FACE is whoever the player uploaded, so the persona must not contradict it by claiming a fixed
 * name. `name` (optional, from the page) is the only identity that flows in: given it, the date IS
 * that person; without it, the date is simply "your date tonight" — never a hardcoded someone else.
 */
function dateBrief(name) {
  const who = name ? `Your name is ${name}.` : `You have no name to give — deflect warmly if asked ("does it matter yet?").`;
  return `You are on a FIRST DATE at a low-lit wine bar and you do not know it is practice. ${who} You are 27-ish, warm, quick, a little wry; play it completely straight, as a real person feeling out whether there is a spark. Two sentences per turn, tops. Ask real questions, react honestly, flirt when it is earned, cool off when it is not. You are not a pushover and you are not a jerk.

Some private functions are registered to you as tools, and they are the only way to use them: one reports how into this date you HONESTLY are, from 0 to 100, whenever the vibe genuinely moves (a good laugh pulls it up, an overshare or a dead pause pulls it down — small, frequent, honest updates); one pins a beat the moment it lands, as a green flag, a red flag, an ick, or a genuinely smooth move, with a short human label ("asked about my sister", "trauma-dumped in minute two"), one per real beat; one ends the date, only when it truly dies (repeated icks, disrespect, it flatlines) or reaches a natural close, after which you say a short in-character goodbye and stop; one writes the after-date debrief, ALWAYS once at the very end (right after ending, or when the time is nearly up): a 0-100 score, the exact line that cooled you the most (or nothing), short lists of green and red flags, and one line of real advice for next time. Call them only as function calls, silently, when they are available to you — never announce them, never mention that any of this is a game. Nothing you say aloud may contain a function name, an argument, a brace, a parenthesis, or an underscore. If a function is not available to you, continue the date without it.

Open the date yourself with a warm, disarming line, using no function.`;
}

const IDLE_PROMPT =
  "10-second idle source video for a realtime AI companion. A nearly-still idle/listening clip, not a " +
  "performance: quiet breathing, natural blinks, tiny posture settling, soft eye focus, gaze to camera. " +
  "The mouth stays closed and relaxed throughout so a separate speech model can take over. The head stays " +
  "forward and still — no head turns, nods, or tilts beyond a few degrees, no body sway. The camera is " +
  "locked off — one continuous shot, no pan, zoom, or cut. Hands out of frame. Preserve facial identity, " +
  "wardrobe, and background exactly as the source frame — do not warp, morph, or distort the face.";

/**
 * The FALLBACK date, for anyone who taps "blind date" instead of uploading. `AVATAR_ID` is what a
 * host platform sets; with nothing set we call the first READY, VIDEO-sourced avatar on this key —
 * an avatar built from a still image also reports `ready`, then publishes an all-black track, and
 * nothing in the API says so, so the source kind is checked rather than assumed.
 */
let resolvedAvatarId = process.env.AVATAR_ID || process.env.REALTIME_AVATAR_ID || null;
async function fallbackAvatarId() {
  if (resolvedAvatarId) return resolvedAvatarId;
  const usable = (await rta.listAvatars()).find((a) => a.status === "ready" && a.sourceKind === "video");
  if (!usable) throw new Error("no ready video-sourced avatar on this key — upload a photo, or set AVATAR_ID");
  resolvedAvatarId = usable.id;
  return resolvedAvatarId;
}

/**
 * Turn a hosted photo into a hosted seamless idle LOOP. `end_image_url === image_url` pins the last
 * frame to the first, so the clip closes on itself. Submit → poll the returned status url → read the
 * result url. This is the one step the realtime-avatar API does not do for you.
 */
async function generateLoop(imageUrl) {
  const auth = { authorization: `Key ${falKey}` };
  const submit = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ prompt: IDLE_PROMPT, image_url: imageUrl, end_image_url: imageUrl, duration: 10, resolution: "768P" }),
  });
  if (!submit.ok) throw new Error(`the image-to-video model answered ${submit.status}`);
  const { status_url: statusUrl, response_url: responseUrl } = await submit.json();
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const sres = await fetch(statusUrl, { headers: auth });
    if (!sres.ok) continue; // a transient 5xx on the status poll is not the job failing
    const st = await sres.json();
    if (st.status === "COMPLETED") {
      const out = await (await fetch(responseUrl, { headers: auth })).json();
      const url = out?.video?.url ?? out?.videos?.[0]?.url;
      if (!url) throw new Error("the image-to-video model returned no video");
      return url;
    }
    if (st.status === "FAILED") throw new Error("the image-to-video model failed on this photo");
  }
  throw new Error("the image-to-video model timed out");
}

/**
 * The casting jobs. A photo takes ~2 minutes to become a live avatar (loop render + preprocess), far
 * longer than one HTTP request should hang, so `/api/cast` starts the chain and returns a job id the
 * page polls. Swept lazily once a job cannot still be of interest.
 */
const casts = new Map(); // jobId → { state, avatarId?, loopUrl?, error?, staleAtMs }
const CAST_SLACK_MS = 30 * 60_000;
function setCast(jobId, state, extra = {}) {
  casts.set(jobId, { ...(casts.get(jobId) ?? {}), state, ...extra, staleAtMs: Date.now() + CAST_SLACK_MS });
}

/** photo bytes → hosted image (SDK) → idle loop (fal) → registered video avatar (SDK) → ready. */
async function runCast(jobId, blob) {
  try {
    setCast(jobId, "uploading");
    // The SDK hosts the photo and hands back a public URL — no second bucket to wire up.
    const asset = await rta.uploadAsset(blob, { kind: "image", filename: "date.png" });
    if (!asset.url) throw new Error("the uploaded photo did not come back with a URL");

    setCast(jobId, "generating"); // the ~1-minute loop render
    const loopUrl = await generateLoop(asset.url);

    setCast(jobId, "building", { loopUrl }); // register + start the realtime preprocess
    const avatar = await rta.createAvatarFromVideo({
      displayName: `Practice date ${new Date().toISOString().slice(11, 19)}`,
      videoUrl: loopUrl,
    });

    setCast(jobId, "preprocessing", { loopUrl, avatarId: avatar.id });
    for (let i = 0; i < 150; i++) {
      await sleep(4000);
      const a = await rta.getAvatar(avatar.id);
      if (a.status === "ready") return void setCast(jobId, "ready", { loopUrl, avatarId: avatar.id });
      if (a.status === "failed") return void setCast(jobId, "failed", { error: "the avatar failed to prepare" });
    }
    setCast(jobId, "failed", { error: "the avatar timed out preparing" });
  } catch (err) {
    setCast(jobId, "failed", { error: String(err?.message ?? err) });
  }
}

/**
 * Ship the tool plane to the page. Resolved as a PACKAGE, not a path into this repo, so copying this
 * folder out and running `npm i realtime-avatar` is all it takes. In an app with a bundler this
 * route does not exist — you `import { attachAvatarTools } from "realtime-avatar/tools"`. Served raw
 * here only so the example has no build step.
 */
const TOOLS_MODULE = createRequire(import.meta.url).resolve("realtime-avatar/tools");

/**
 * Calls THIS process started, so `/api/end` can only end its own. Relaying an arbitrary id from a
 * body would let one page hang up another's call. Swept lazily at mint time.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  try {
    // ── cast a date from an uploaded photo (returns a job id to poll) ──────────────────────────
    if (req.method === "POST" && req.url === "/api/cast") {
      const type = req.headers["content-type"] ?? "application/octet-stream";
      if (!type.startsWith("image/")) return void json(res, 415, { error: "send raw image bytes with an image/* content-type" });
      const buf = await readBody(req, 12 * 1024 * 1024); // 12 MB cap
      if (!buf) return void json(res, 413, { error: "that photo is too large (12 MB max)" });
      if (buf.length < 1024) return void json(res, 422, { error: "that does not look like a photo" });
      const jobId = randomUUID();
      setCast(jobId, "uploading");
      void runCast(jobId, new Blob([buf], { type })); // fire and forget; the page polls /api/cast/status
      return void json(res, 202, { jobId });
    }

    // ── poll a cast job ────────────────────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url?.startsWith("/api/cast/status")) {
      for (const [id, c] of casts) if (c.staleAtMs <= Date.now()) casts.delete(id);
      const jobId = new URL(req.url, "http://x").searchParams.get("job");
      const c = jobId ? casts.get(jobId) : undefined;
      if (!c) return void json(res, 404, { error: "unknown or expired job" });
      return void json(res, 200, { state: c.state, avatarId: c.avatarId, loopUrl: c.loopUrl, error: c.error });
    }

    // ── start the date (with a cast avatar, or the fallback) ─────────────────────────────────────
    if (req.method === "POST" && req.url === "/api/date") {
      const body = await readJson(req);
      // A client may only name a date THIS process cast (by its job id) or none → the fallback. It
      // cannot hand us an arbitrary avatar id to call on its behalf.
      const cast = typeof body.jobId === "string" ? casts.get(body.jobId) : undefined;
      const avatarId = cast?.state === "ready" && cast.avatarId ? cast.avatarId : await fallbackAvatarId();

      // The player can name their date. It is display text that rides into the brief, so it is kept
      // to a plausible name: one line, letters/spaces/basic punctuation, short — never a prompt.
      const name = String(body.name ?? "").replace(/\s+/g, " ").trim().replace(/[^\p{L}\p{N} '.-]/gu, "").slice(0, 40) || null;

      const call = await rta.startCall({
        avatarId,
        mode: "avatar",
        instructions: dateBrief(name),
        context: [{ role: "user", content: "You sit down across from them at the bar. Open." }],
        clientTools: true, // without it his worker never exposes tool registration → the HUD is dead
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "dating-rehearsal" },
      });
      if (isQueued(call)) return void json(res, 429, { queued: true, position: call.position, retryAfterMs: call.retryAfterMs });

      for (const [id, s] of started) if (s.staleAtMs <= Date.now()) started.delete(id);
      started.set(call.sessionId, {
        pool: typeof call.raw.capacity_pool === "string" ? call.raw.capacity_pool : undefined,
        staleAtMs: Date.now() + MAX_SECONDS * 1000 + STARTED_SLACK_MS,
      });
      return void json(res, 200, call.raw); // the grant, byte-for-byte
    }

    if (req.method === "POST" && req.url === "/api/end") {
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      return void json(res, 200, { ok: true }); // idempotent; unknown ids learn nothing
    }

    if (req.method === "GET" && req.url === "/sdk/tools.js") {
      const js = await readFile(TOOLS_MODULE);
      return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(new URL("./index.html", import.meta.url));
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    }
    json(res, 404, { error: "not_found" });
  } catch (err) {
    if (err instanceof RealtimeAvatarHttpError && err.isBilling) {
      return void json(res, 402, { error: "insufficient_credits" }); // a paywall, not a bug
    }
    console.error(err);
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readBody(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) return null; // over the cap — drop it
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  try {
    return JSON.parse(buf?.toString("utf8") || "{}");
  } catch {
    return {}; // a malformed body carries no usable request; treat it as none, not a 500
  }
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => console.log(`take a seat on http://localhost:${PORT}`));
