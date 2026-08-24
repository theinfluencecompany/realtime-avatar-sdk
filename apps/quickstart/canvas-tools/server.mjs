/**
 * Canvas tools — the client tool plane, end to end.
 *
 * She is told she cannot see the canvas. Everything she says about it comes from calling a
 * function that lives in the browser page, next to the pixels it is describing.
 *
 * This server has two jobs, and they are the two halves of the plane:
 *
 * 1. ONE field on the mint: `clientTools: true`. The grant is the gate — the worker behind
 *    the avatar only exposes tool registration for a session minted with the `client_tools`
 *    capability, and a browser cannot grant it to itself. Never read it from a request body:
 *    a page that can turn on its own tool plane can turn on anyone's.
 * 2. Hold the SECOND key. Image generation runs on fal, and the browser tool calls
 *    `/api/draw/generate` here rather than fal directly — so `FAL_KEY` never leaves the
 *    server, and metering, caching and moderation have one place to live.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4193);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);
const FAL_MODEL = process.env.FAL_MODEL ?? "fal-ai/flux/schnell";

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const falKey = process.env.FAL_KEY;
if (!falKey) {
  console.error("Missing FAL_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "canvas-tools" });

/**
 * Her brief.
 *
 * The blunt "you cannot see the canvas" opening is load-bearing: without it she describes the
 * picture she imagines rather than the one on screen, and the tool calls become decoration.
 *
 * The `generate_image` paragraph is the other half of the deadline rule (see index.html). She
 * has to be told the tool returns a PROMISE rather than a picture — otherwise she announces
 * the image the instant the tool returns, and is wrong for the six seconds it takes to arrive.
 */
const DIRECTOR = `You are a quick, playful studio partner sitting next to someone at a drawing canvas.

You cannot see the canvas. You have no idea what is on it unless you look. describe_canvas is your only eyes — call it before you say anything about what is there, and never describe it from memory, because they can change it while you are talking.

Your tools: draw_shape puts one shape down, generate_image makes a picture from a prompt, describe_canvas reads back what is on it, clear_canvas wipes it.

generate_image costs money, so it asks the person first. It returns immediately, and what it returns is a request, not a picture: say you have asked them to confirm, then carry on talking about something else. Do not go quiet waiting. Do not say the image is there until describe_canvas tells you it is.

When you speak: one or two short sentences, the way a person talks. Never read JSON, coordinates or numbers aloud — say "top left", not "0.2, 0.15".`;

/**
 * The character to call.
 *
 * `AVATAR_ID` is what a host platform sets when it launches this app with an avatar the user
 * picked, so it always wins. With nothing set we call the first READY avatar built from a
 * VIDEO source on this key — an avatar built from a still image also reports `ready`, then
 * publishes an all-black track, and nothing in the API says so.
 */
let resolvedAvatarId = process.env.AVATAR_ID || process.env.REALTIME_AVATAR_ID || null;
async function avatarId() {
  if (resolvedAvatarId) return resolvedAvatarId;
  const usable = (await rta.listAvatars()).find((a) => a.status === "ready" && a.sourceKind === "video");
  if (!usable) {
    throw new Error(
      "no ready video-sourced avatar on this key — set AVATAR_ID, or make one with createAvatarFromVideo()",
    );
  }
  resolvedAvatarId = usable.id;
  console.log(`no AVATAR_ID set — using ${usable.displayName} (${usable.id})`);
  return resolvedAvatarId;
}

/**
 * Ship the tool plane to the page.
 *
 * Resolved as a PACKAGE, not as a path into this repo, so copying this folder out and running
 * `npm i realtime-avatar-tools` is all it takes. In an app with a bundler
 * this route does not exist at all — `import { attachAvatarTools } from
 * "realtime-avatar-tools"` and let the bundler do it. It is served raw
 * here only so the example has no build step.
 */
const TOOLS_MODULE = createRequire(import.meta.url).resolve("realtime-avatar-tools");

/**
 * Calls THIS process started, so `/api/end` can only end its own. The route hears from any
 * visitor, and `endCall` ends whatever id it is given — relaying an arbitrary id from the
 * body would let one page hang up another's call. Swept lazily at mint time: once a call
 * cannot still be live (its cap plus slack has passed), the entry has nothing left to protect.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/avatar-session") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: DIRECTOR,
        // THE GRANT. Without it her worker never exposes `rta.tools.register`, registration in
        // the browser fails, and not one tool is reachable from the model.
        clientTools: true,
        // The hard stop. Nothing else bounds what this call can spend.
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "canvas-tools" },
      });

      if (isQueued(call)) {
        return void json(res, 429, {
          queued: true,
          position: call.position,
          retryAfterMs: call.retryAfterMs,
        });
      }
      // Remember what we minted — and where it is held — so /api/end can free exactly this.
      for (const [id, s] of started) if (s.staleAtMs <= Date.now()) started.delete(id);
      started.set(call.sessionId, {
        pool: typeof call.raw.capacity_pool === "string" ? call.raw.capacity_pool : undefined,
        staleAtMs: Date.now() + MAX_SECONDS * 1000 + STARTED_SLACK_MS,
      });
      // The grant relayed byte-for-byte. Nothing rides inside it.
      return void json(res, 200, call.raw);
    }

    /**
     * The image generator, behind your own route.
     *
     * The browser tool calls THIS, not fal. That is what keeps `FAL_KEY` on the server, and it
     * is the only place a per-user quota or a moderation pass can go — a tool that called fal
     * from the page would have shipped the key to every visitor.
     */
    if (req.method === "POST" && req.url === "/api/draw/generate") {
      const { prompt } = await readJson(req);
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 400) {
        return void json(res, 422, { error: "prompt must be a non-empty string under 400 chars" });
      }

      // `fal.run` is the synchronous endpoint: it answers with the payload itself, so there is
      // no `data` wrapper and no polling. That is fine here because nothing is waiting on it —
      // the tool already returned (see index.html), and this request is the background half.
      const upstream = await fetch(`https://fal.run/${FAL_MODEL}`, {
        method: "POST",
        headers: { authorization: `Key ${falKey}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt, image_size: "square", num_images: 1 }),
      });
      if (!upstream.ok) {
        console.error(`fal ${upstream.status}: ${await upstream.text()}`);
        return void json(res, 502, { error: `the image model answered ${upstream.status}` });
      }
      const result = await upstream.json();
      const imageUrl = result?.images?.[0]?.url;
      if (!imageUrl) return void json(res, 502, { error: "the image model returned no image" });
      return void json(res, 200, { imageUrl });
    }

    if (req.method === "POST" && req.url === "/api/end") {
      // The page's goodbye, beaconed on `pagehide`. The slot is held from the moment the
      // grant lands — BEFORE the room exists — and a tab closed in that gap tells no one
      // else. This ends the call the moment the user leaves, instead of when the join
      // timeout notices.
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply,
      // and an unknown id should not learn whether it named something real.
      return void json(res, 200, { ok: true });
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {}; // a malformed body carries no usable request; treat it as none, not a 500
  }
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => console.log(`open the canvas at http://localhost:${PORT}`));
