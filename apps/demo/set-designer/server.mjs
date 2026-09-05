/**
 * Set designer.
 *
 * One clip, many worlds. The avatar's stored source video is the plate;
 * `video.edits.instruction` rewrites that plate under a sentence, and `video.edits.live.rules`
 * hands the sentence to the conversation — say "I'd rather be somewhere warm" and the room
 * behind her follows.
 *
 * THE DESIGN POINT: the browser picks a set by **id**. It never sends instruction text. The
 * docs are explicit that `instruction` and `live.rules` are the app's policy about what a
 * conversation may do to the picture — a browser that could write them could redress the
 * character into anything. So the id→prose map lives here, server-side, next to the key.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

/** Served raw so this example needs no build step. A real app imports the package and bundles it. */
const BROWSER_MODULE = createRequire(import.meta.url).resolve("realtime-avatar/browser");

const PORT = Number(process.env.PORT ?? 4201);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 240);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "set-designer" });

/** The sets this app is willing to be. Ids are the only thing the browser may name. */
const SETS = {
  none: { label: "As built", instruction: null },
  cabin: {
    label: "Snowy cabin",
    instruction: "a snowy cabin at night, warm lamplight, frost on the window behind her",
  },
  golden: {
    label: "Golden hour",
    instruction: "her studio at golden hour, long warm light raking across the wall behind her",
  },
  rain: {
    label: "Rain at dusk",
    instruction: "a rain-streaked window at dusk behind her, cool blue light, city glow beyond",
  },
  festival: {
    label: "Lantern festival",
    instruction: "a night lantern festival behind her, warm paper lanterns, soft bokeh",
  },
};

/**
 * The standing brief for the LIVE lane. Narrow on purpose: every change of direction buys a
 * fresh pass over the clip and a visible cut, so the brief names exactly what a conversation
 * may touch — and the negative clause is the one that does the work.
 */
const LIVE_RULES = [
  "Only change the room, the weather and the light behind her.",
  "Never change her face, her hair, her clothes, or the framing.",
  "Only redress the set when the conversation genuinely moves somewhere else —",
  "a new place, a new time of day, or a clear shift in mood. Small talk is not a shift.",
].join(" ");

/** Her behavior. The picture is `video`'s; who she is stays here, per the docs' split. */
const INSTRUCTIONS = [
  "You are Kestrel, a scenic designer on a video call, and the room behind you is your canvas.",
  "Speak in one or two short, vivid sentences, then ask something back.",
  "When someone names a place or a mood, describe what you would put behind you — concretely,",
  "in light and texture. You are delighted when the set changes around you; say so when it does.",
  "Never mention being an AI, a model, or a demo.",
].join(" ");

/**
 * The character to call. `AVATAR_ID` wins so a host can launch this with an avatar the user
 * picked; with nothing set we call the first READY avatar built from a VIDEO source — edits
 * need a clip to edit, and an image-sourced avatar also has nothing usable to publish.
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
 * Calls THIS process started, so `/api/end` can only end its own — relaying an arbitrary id
 * from the body would let one page hang up another's call. Swept lazily at mint time: once a
 * call cannot still be live (its cap plus slack has passed), the entry has nothing to protect.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "POST" && path === "/api/call") {
      const body = await readJson(req);
      // An id we don't recognise falls back to "as built" rather than erroring: the set is
      // cosmetic, and a page that guesses wrong should still get a call.
      const requested = Object.hasOwn(SETS, body.set) ? body.set : "none";
      const chosen = SETS[requested];
      const live = body.live === true;

      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: INSTRUCTIONS,
        maxSeconds: MAX_SECONDS,
        // `metadata` is string→string on the wire — a boolean here is a 422.
        metadata: { surface: "set-designer", set: requested, live: String(live) },
        // No instruction ⇒ no `video` key at all ⇒ the call is byte-identical to one made
        // before edits existed. That is the documented "off unless you ask" — and `live`
        // rides the opening instruction, because a re-edit needs a look to depart from.
        ...(chosen.instruction
          ? {
              video: {
                edits: {
                  instruction: chosen.instruction,
                  ...(live ? { live: { rules: LIVE_RULES, cooldownSeconds: 30 } } : {}),
                },
              },
            }
          : {}),
      });

      if (isQueued(call)) {
        return void json(res, 429, {
          queued: true,
          position: call.position,
          retryAfterMs: call.retryAfterMs,
        });
      }
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
      // lands — BEFORE the room exists — and a tab closed in that gap tells no one else.
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply, and
      // an unknown id should not learn whether it named something real.
      return void json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/config") {
      // Ids and labels only. The prose the ids map to never crosses this boundary.
      return void json(res, 200, {
        maxSeconds: MAX_SECONDS,
        sets: Object.entries(SETS).map(([id, s]) => ({ id, label: s.label })),
      });
    }

    if (req.method === "GET" && path === "/sdk/browser.js") {
      const js = await readFile(BROWSER_MODULE);
      return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
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

server.listen(PORT, () => console.log(`set designer on http://localhost:${PORT}`));
