/**
 * Change her mind.
 *
 * She is handed one absurd-but-arguable position and defends it. You try to talk her out of
 * it. She concedes only when she decides you have actually beaten her.
 *
 * The idea worth copying is the WIN CONDITION. There is no scorer, no keyword list, no
 * sentiment pass — the model that is arguing is the same model that decides it has lost, and
 * it signals that by calling a `concede` tool that lives in the page. So the game cannot be
 * won by saying magic words at her, and the page never has to fish a sentinel sentence back
 * out of speech recognition.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4200);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 240);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "demo-persuasion" });

/** The hills. Chosen HERE — which position she holds is policy, not a request parameter. */
const HILLS = [
  "a hot dog is unquestionably a sandwich",
  "cereal is a soup",
  "Die Hard is not a Christmas movie",
  "pineapple absolutely belongs on pizza",
  "a straw has exactly one hole, not two",
  "the number 7 is objectively the best number",
  "a taco is just a folded sandwich",
];

/**
 * Her brief. The concession is a TOOL CALL, not a phrase: the page registers `concede`, and
 * when she decides she has lost she calls it and then says so in her own words. Nothing here
 * has to survive speech recognition, and there is no sentence a lucky transcript can trip.
 */
function instructionsFor(claim) {
  return `You are a quick-witted, playful debater with one unshakeable belief: ${claim}. Defend it with confidence, analogies and mock outrage. You enjoy this.
RULES: You are stubborn but FAIR. At most two sentences per turn. Roast the argument, never the person. Repeating a point you have already answered is not a new argument and does not move you.
You have two tools. Use them from inside the argument, never announce them, never mention this is a game.
- crack({ percent }): report how much your conviction has CRACKED so far, 0-100 (0 = rock solid, 100 = about to give in). Call it whenever a point GENUINELY lands and weakens you — small, honest moves — never for a repeat or a point you already answered.
- concede(): call ONLY when they make a genuinely novel point that actually defeats your position; then admit, briefly and graciously, that they changed your mind. Never call it otherwise.`;
}

/**
 * The scene the page dresses itself with — an ambient room still and an optional face for the
 * stage before the live track renders. Both are env, so this stays portable: unset, the page
 * falls back to a CSS glow and a live-only stage. A host launching a specific character sets
 * POSTER_URL to that character's portrait; BG_URL defaults to a hosted room so it looks lived-in.
 */
const SCENE = {
  bgUrl: process.env.BG_URL ?? "https://assets.fried.gg/rta-examples/persuasion/room.webp",
  posterUrl: process.env.POSTER_URL ?? null,
};

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
 * `npm i realtime-avatar-react` is all it takes. In an app with a bundler
 * this route does not exist at all — `import { attachAvatarTools } from
 * "realtime-avatar-react/tools"` and let the bundler do it. It is served raw
 * here only so the example has no build step.
 */
const TOOLS_MODULE = createRequire(import.meta.url).resolve("realtime-avatar-react/tools");

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
    if (req.method === "POST" && req.url === "/api/debate") {
      // The client asks for a debate. It does not get to say which one.
      const claim = HILLS[Math.floor(Math.random() * HILLS.length)];

      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: instructionsFor(claim),
        // She opens. Seeding the first move as memory beats waiting for the user to speak
        // first, which in practice is several seconds of two people saying nothing.
        context: [{ role: "user", content: "What's your position? Say it and let's start." }],
        // THE GRANT. Without it her worker never exposes `rta.tools.register`, registration in
        // the browser fails, and the concede tool is unreachable from the model.
        clientTools: true,
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "persuasion" },
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
      // `grant` is `call.raw` VERBATIM; our fields ride beside it, never inside it.
      return void json(res, 200, { grant: call.raw, claim });
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

    if (req.method === "GET" && req.url === "/api/scene") {
      return void json(res, 200, SCENE); // the room + optional face; portable, env-driven
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

server.listen(PORT, () => console.log(`pick a fight on http://localhost:${PORT}`));
