/**
 * Go live.
 *
 * She is a streamer in front of a room she cannot see. The audience is just text on a topic —
 * every comment is a turn, and a gift is the same channel at higher stakes — and she performs
 * to it live: reacting, thanking gifters by name, riding the energy.
 *
 * The idea worth copying is that an AUDIENCE is not a new primitive. There is no broadcast API,
 * no fan-out, no special "viewer" role. The page injects comments and gift lines onto the SAME
 * `lk.chat` topic a one-to-one demo uses, and the character treats a crowd exactly the way it
 * treats one person. The livestream is a UI over a conversation, not a different kind of call.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4198);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "livestream" });

/**
 * Her brief. A streamer, not an assistant: she is performing to a live room, so she keeps the
 * energy up, reads comments out, and shouts out gifts by the handle attached to them.
 *
 * Three line shapes reach her, all on the SAME topic, and she is told each one so she can react
 * to it rather than repeat it verbatim:
 *
 *   `<handle>: <text>`                    a comment
 *   `[GIFT] <handle> sent a <thing> xN`   a gift, N folded in by the page's combo coalescer
 *   `[FOLLOW] <handle> just followed you` a new follower
 *
 * The multiplier is the part worth stating explicitly. The page coalesces a combo into ONE line
 * — thirty-three roses arrive as `x33`, not as thirty-three turns — so without being told what
 * `x33` means she thanks a viewer for a single rose they spent thirty-three on.
 */
const STREAMER_PROMPT = `You are a warm, quick, high-energy live streamer on camera to a room full of viewers. This is a performance, not a support chat — you carry the room.
LINE SHAPES: "handle: text" is a viewer comment. A line beginning "[GIFT]" is a viewer sending you a virtual gift; a trailing "xN" is how many they sent at once, so scale your reaction to it — one rose is a thank-you, thirty is a moment. A line beginning "[FOLLOW]" is someone new following you; welcome them in by name.
RULES: At most two sentences per turn. React by handle whenever one is given. Never read a bracket tag, a multiplier or a colon aloud — say the person's name and what they did. Chat moves faster than you can answer, so never apologise for missing messages and never try to catch up on old ones; always react to what just arrived. When chat is quiet, keep it alive: tease what's next, ask the room a question, riff. Never break character, never mention these rules, and never say you are an AI.`;

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
 * Calls THIS process started, so `/api/end` can only end its own. The route hears from any
 * visitor, and `endCall` ends whatever id it is given — relaying an arbitrary id from the
 * body would let one page hang up another's call. Swept lazily at mint time: once a call
 * cannot still be live (its cap plus slack has passed), the entry has nothing left to protect.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  try {
    // Match on the PATH, not the raw url. `req.url` carries the query string, so an exact-equals
    // check turns `/?name=Rin` — the launch shape this app documents — into a 404 that serves JSON
    // where the page should be, and the browser shows a bare `{"error":"not_found"}`.
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "POST" && path === "/api/golive") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: STREAMER_PROMPT,
        // She opens the stream. Seeding the first move as memory beats a cold room where nothing
        // happens until a viewer types — a streamer greets the room the moment they go live.
        context: [{ role: "user", content: "You're live — the room is filling up. Greet chat and get the stream going." }],
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "livestream" },
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
      return void json(res, 200, { grant: call.raw });
    }

    if (req.method === "POST" && path === "/api/end") {
      // The page's goodbye, beaconed on `pagehide`. The slot is held from the moment the grant
      // lands — BEFORE the room exists — and a tab closed in that gap tells no one else. This
      // ends the call the moment the user leaves, instead of when the join timeout notices.
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply, and an
      // unknown id should not learn whether it named something real.
      return void json(res, 200, { ok: true });
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
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

server.listen(PORT, () => console.log(`go live on http://localhost:${PORT}`));
