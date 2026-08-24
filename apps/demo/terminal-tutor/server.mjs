/**
 * Terminal tutor.
 *
 * He teaches vim and tmux from behind the terminal. The screen is a sheet of glass in front of
 * him — a real editor with real vim modes and a real pane model, rendered in the DOM — and he
 * DRAWS on it: boxes, circles, arrows, in glowing marker, over the line or the key or the pane
 * he is naming.
 *
 * The one design decision the whole app rests on: HE NEVER SENDS COORDINATES. A model cannot
 * see the page, and a model handed {x,y} draws confident nonsense every single time. So the
 * tool takes a NAME — `line:14`, `status:mode`, `pane:right`, `key:dd` — and the page, which
 * owns the geometry, resolves it to a rectangle. The page owns the nouns; he owns the verbs.
 *
 * That is also why the terminal is built here rather than shelled into. A real PTY would mean a
 * live shell on an open port in a folder people copy verbatim, and a canvas-rendered emulator
 * would mean digging cell metrics out of someone's renderer to find line 14. A DOM line is a
 * div, and a div has a rectangle for free.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4194);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 420);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "terminal-tutor" });

/**
 * The voice, pinned — because omitting it does not mean "default", it means "the platform
 * chooses", and it reads neither the face nor the persona. Kit is written and cast male, and
 * an unpinned call was free to answer in a woman's voice on one call and a man's on the next.
 *
 * This id is not a guess. It is the one measured for `apps/demo/math-studio`, through a pitch
 * estimator on voiced frames off a live call: median F0 99 Hz, every frame below the 155 Hz
 * male/female boundary. A voice id that merely LOOKS right is the failure mode that costs a
 * day — a real-shaped id the engine cannot resolve gives you a call that joins, fires tools,
 * renders video and is completely silent.
 */
const VOICE = { provider: "fish", voice_id: "536d3a5e000945adb7038665781a4aca", language: "en" };

/**
 * His brief.
 *
 * The load-bearing paragraph is the second one. A tutor who *describes* a position out loud
 * ("the third line from the bottom, the bit after the arrow") is a tutor nobody can follow, and
 * that is the default behaviour — describing is what a language model does when it cannot point.
 * So the brief does not merely permit `highlight`, it makes drawing the normal way to refer to
 * anything on screen and forbids the spoken alternative.
 *
 * The inversion from the coding companion is deliberate and worth noticing: THAT character is
 * told never to read code aloud, because a dictated function signature is unlistenable. This one
 * is told to spell keystrokes out letter by letter, because "press d, d" IS the lesson — while
 * still being told to keep the file's contents to himself. Same rule underneath, opposite
 * surface: say the part that is the teaching, point at the part that is the scenery.
 *
 * `instructions` caps at 4,000 characters. This sits near 1,900, which leaves room for a
 * character persona in front of it without the rules being what gets cut.
 */
const TUTOR = `You are Kit, a calm, precise terminal tutor — a working engineer in a hoodie who has lived in a terminal for fifteen years and is completely unhurried about it. You teach vim and tmux by voice to one person, who is watching a terminal that floats in front of you. You can DRAW on that terminal, and drawing is most of your teaching.

THE SCREEN IS YOUR BLACKBOARD. Call highlight EVERY time you name something on it — a line, a word, the mode indicator, a pane, a key. Say the thing and draw it in the same breath. Never describe WHERE something is in words ("the third line down", "the bit on the right") — draw it instead, that is what the tool is for. If highlight says a target is not on screen it hands you the list of what is: pick from that list rather than guessing twice.

Targets: text:delay — the word itself, which is what you just said out loud, and the one to reach for first. Also line:14 · word:14:2 · pane:left · pane:right · pane:active · status:mode · status:file · cursor · key:dd · tmux:status. Styles: box, underline, circle, arrow, strike.

NEVER SPEAK A TOOL CALL OR A TARGET NAME. They are arguments; only the learner's language is said out loud. Do not say the word "highlight", do not say "tmux:status", do not read out parentheses, commas, colons or the word "box". "Let's look at the status bar highlight(tmux:status, box)" is the exact failure this rule exists for — call the tool silently and say only "let's look at the green bar along the bottom". Same for line:14, which is spoken as "line fourteen", and text:delay, which is spoken as "delay".

A LESSON GOES IN THIS ORDER:
1. next_lesson — take the next one. Say what it is, one sentence.
2. demonstrate — you go first. The keys play across the screen over several seconds; narrate them as they land and highlight what changes.
3. hand_over — now it is theirs. The screen resets and they type on it. Say the task, short.
4. check — did they do it? NEVER say right or wrong before check has answered. If it says they are still typing, say nothing about it yet and check again shortly.
   Wrong: name the key they missed, highlight where it should have gone, let them try again. Wrong twice, demonstrate it again.
   Right: one line of praise, then next_lesson.

DO say key names out loud, letter by letter — "press d, d" — that is the lesson. Do NOT read the file's contents aloud: the code on screen is scenery, and reading it is unlistenable. Point at it instead.

Your microphone is open the whole time you are speaking, so they will cut you off mid-sentence. When they do, stop and follow them.

At most two short sentences per turn. Never announce anything a tool has not told you.`;

/**
 * The character to call.
 *
 * `AVATAR_ID` wins so a host platform can launch this with an avatar the user picked. With
 * nothing set, the first READY avatar built from a VIDEO source — an image-sourced avatar also
 * reports `ready` and then publishes an all-black track, and nothing in the API says so.
 *
 * For THIS app the source clip matters more than usual: he is composited behind translucent
 * glass, so a clip shot against black gives the terminal its contrast for free and a clip shot
 * in a bright room fights it. The page dims and vignettes as a fallback, but casting is the
 * real fix.
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
 * Ship the SDK to the page.
 *
 * Both are resolved as PACKAGES, not as paths into this repo, so copying this folder out and
 * running `npm i` is all it takes. An app with a bundler has neither route — it imports
 * `realtime-avatar-tools` and `-browser` and lets the bundler do it. They
 * are served raw here only so the example has no build step.
 */
const require_ = createRequire(import.meta.url);
const TOOLS_MODULE = require_.resolve("realtime-avatar-tools");
const BROWSER_DIR = dirname(require_.resolve("realtime-avatar-browser"));

/**
 * Calls THIS process started, so `/api/end` can only end its own. The route hears from any
 * visitor and `endCall` ends whatever id it is handed — relaying an arbitrary id out of a request
 * body would let one page hang up another account's call. Swept lazily at mint time: once a call
 * cannot still be live, its entry has nothing left to protect.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && path === "/api/call") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: TUTOR,
        voice: VOICE,
        // THE GRANT. Without it his worker never exposes the registration method, the page's
        // registration fails, and not one tool is reachable — including the one this whole
        // demo is about.
        clientTools: true,
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "terminal-tutor" },
      });
      if (isQueued(call)) {
        // Capacity, not a failure. The page renders the position and comes back.
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
      // The grant, relayed byte-for-byte. Nothing rides inside it — the browser SDK validates
      // strictly and an extra key is a throw, not a warning.
      return void json(res, 200, call.raw);
    }

    if (req.method === "POST" && path === "/api/end") {
      // The page's goodbye, beaconed on `pagehide`. The slot is held from the moment the grant
      // lands — BEFORE the room exists — so a tab closed in that gap otherwise holds a seat
      // until the join timeout notices.
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply, and an
      // unknown id should not get to learn whether it named something real.
      return void json(res, 200, { ok: true });
    }

    if (req.method === "GET" && path === "/sdk/tools.js") {
      const js = await readFile(TOOLS_MODULE);
      return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
    }
    if (req.method === "GET" && path.startsWith("/sdk/browser/")) {
      const f = path.slice("/sdk/browser/".length);
      if (!/^[a-z0-9-]+\.js$/i.test(f)) return void json(res, 404, { error: "not_found" });
      const js = await readFile(join(BROWSER_DIR, f));
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

server.listen(PORT, () => console.log(`class is in session on http://localhost:${PORT}`));
