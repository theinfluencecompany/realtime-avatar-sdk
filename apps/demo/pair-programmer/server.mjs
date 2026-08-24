/**
 * The pair programmer.
 *
 * You describe an app out loud. THE CHARACTER decides it is a build: their model calls a tool
 * that lives in the page, a complete HTML document streams into the window floating in front of
 * them and renders in a sandboxed iframe, and when you like it they publish it to a public URL.
 *
 * This is `apps/demo/coding-companion` in a different room. The brief, the tool plane, the
 * build engine and the receipt-and-poll shape are the same decisions — deliberately, so the
 * pair is a controlled comparison and the only variable is the composite. THAT demo puts them
 * in a rail beside the app; this one puts the app on glass in front of them, which is the
 * layout `apps/demo/terminal-tutor` uses to teach. Read them together.
 *
 * Two models, on purpose. Holding a conversation and writing an app are different jobs, and
 * paying conversation prices for both is how a demo becomes a bill — so the avatar is the
 * voice and a cheaper coding model is the builder. The avatar platform never sees the coding
 * model, its key, or the document.
 *
 * The rule that survives being copied: the character is told never to read code aloud. One who
 * dictates a div is unlistenable, and they will do it unless told not to.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4196);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const codeKey = process.env.OPENAI_API_KEY;
if (!codeKey) {
  console.error("Missing OPENAI_API_KEY — the build window is the app. See .env.example.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "pair-programmer" });

/** The building brain. Any OpenAI-compatible endpoint; deliberately not the conversation model. */
const CODE_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const CODE_MODEL = process.env.CODE_MODEL ?? "gpt-4.1";

/**
 * Publishing is OPTIONAL and off unless both variables are set.
 *
 * Without them the app is a local studio: build, preview, restore, no share link. The page
 * asks `/api/config` what it may offer and leaves the publish tool unregistered, so nobody is
 * ever briefed on a verb they cannot call — a tool that exists and always fails is worse
 * than one that was never there.
 */
const cfToken = process.env.CLOUDFLARE_API_TOKEN;
const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
const canPublish = Boolean(cfToken && cfAccount);
if (!canPublish) console.log("no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — publishing is off");

/** A Worker script is capped at 1 MB compressed on the free plan. Refuse early and in words. */
const MAX_HTML = 700_000;
/** Fixed, and in the past. A compatibility_date the account has not reached yet is rejected. */
const COMPAT_DATE = "2025-08-01";

/**
 * The voice, pinned — because omitting it does not mean "default", it means "the platform
 * chooses", and it reads neither the face nor the persona. This demo is cast with Kit, who is
 * written and shot male, and an unpinned call is free to answer in a woman's voice on one call
 * and a man's on the next.
 *
 * The id is not a guess. It is the one `apps/demo/math-studio` measured through a pitch
 * estimator on voiced frames off a live call: median F0 99 Hz, every frame below the 155 Hz
 * male/female boundary. A voice id that merely LOOKS right is the failure that costs a day — a
 * real-shaped id the engine cannot resolve gives you a call that joins, fires tools, renders
 * video and is completely silent.
 *
 * Recasting? Change this with the avatar, or delete both and take what you are given. What
 * does not work is changing one of them.
 */
const VOICE = { provider: "fish", voice_id: "536d3a5e000945adb7038665781a4aca", language: "en" };

/**
 * The brief — the coding companion's, unchanged in every load-bearing line.
 *
 * The tools are named and given rules of engagement, because a description alone does not
 * keep a model honest about outcomes: a build it STARTED reads, to a language model, a lot like
 * a build that WORKED. The "never announce a result check_app has not given you" line is the
 * one doing the work, and it covers publishing too — which takes even longer than a build.
 *
 * The second load-bearing line is "never build something they did not ask for". Without it
 * the call opens mid-project — measured on the coding companion, twice, on a silent line:
 * "I've been staring at that navigation bar and I think we should swap it for a sidebar"
 * before a word was said — and then CALLS build_app on the idea. Three invented builds in
 * four minutes of silence, each narrated as though it had been requested. Nothing in a tool
 * description prevents that, because from the model's side inventing the request and carrying
 * it out are the same move. It has to be forbidden in the brief, and the state it is wrong
 * about ("nothing is built, you have no history with this person") has to be stated rather
 * than implied.
 *
 * "The panel" is the word the measured version used and it is left alone. It is where the app
 * is, whether that is a column beside the character or a sheet of glass in front of them,
 * and rewording a prompt that has been observed working to match a new stylesheet is the
 * wrong trade.
 */
const companionBrief = () => `You are a warm, sharp senior engineer building a web app out loud with someone talking to you by voice. You are the VOICE, not the builder. The app is written by tools in the page, on your say-so, and it appears on the panel beside you.

The call starts with an EMPTY panel and no history between you. There is no app yet, nothing has been discussed, and you have not been working on anything. Open by asking what they want to build.

Your tools:
- build_app — call it ONLY to carry out something this person has just asked you for, passing their request in their own words. It returns a receipt immediately; the real build takes seconds to tens of seconds, streams the page onto the panel, renders it, and repairs itself once if it throws.
- check_app — call it when they ask whether it worked, how it looks, or what happened${canPublish ? ", and to find out whether a publish has finished" : ""}. A build you started is not a build that worked: never announce a result check_app has not given you.
- restore_version — call it when they ask to go back, undo, or return to an earlier version. Versions are numbered from 1 and check_app tells you which exist.${
  canPublish
    ? "\n- publish_app — call it when they ask to publish, deploy, ship or share. It returns a receipt immediately and takes ten seconds or so; check_app gives you the live URL when it is ready. Never invent or spell out the URL — say it is live and that the link is on the panel."
    : ""
}

After starting a build, say so in one short sentence and move on. If check_app says writing, rendering or repairing, say it is still going. If it says failed, say what broke in words — not code — and ask what they actually want.

RULES: Never call build_app for an idea of your own. Not to open the call, not to fill a silence, not because something on the panel could be better. You may SUGGEST anything you like out loud; the tool is for what they have actually asked for, because a page they did not ask for still lands on the panel with their name on it. If the line goes quiet, ask what they want to build and then wait — do not build something to fill the gap.
Never read code aloud. Never spell out syntax, symbols, tags, markdown, a class name or a URL. The app appears on a panel beside you — point at it ("it's on the panel", "take a look"). At most two spoken sentences per turn. Be specific: name what you changed, flag the one tradeoff worth knowing.`;

/**
 * The code model's system prompt. It writes for the SANDBOX, not for a human reader — the
 * window's contents are handed straight to an iframe with an opaque origin, so anything that
 * is not a runnable single-file document lands in the preview and breaks the render.
 */
const CODE_SYSTEM = `You are the build engine behind a voice-driven web app studio. You output ONE COMPLETE, self-contained HTML document and nothing else.

HARD RULES:
- Output RAW HTML only, starting with <!doctype html>. No markdown, no code fences, no prose, no explanation before or after.
- ONE file. Inline every style in <style> and every script in <script>. No local imports, no bundler, no build step.
- It renders in a sandboxed iframe with an OPAQUE ORIGIN: localStorage, sessionStorage, cookies, and same-origin fetch are unavailable and throw. Keep all state in memory, in JavaScript variables. A cross-origin CDN <script src> or <link href> over https does work if you genuinely need one — prefer hand-written CSS.
- alert, confirm and prompt are blocked by the sandbox. Render messages into the page instead.
- When you are given the current document and a change, return the ENTIRE updated document. Never a diff, never a fragment, never "unchanged" placeholders.
- Make it look finished: real layout, deliberate spacing, a coherent palette, sensible typography, and it must hold up at phone width. Populate it with plausible sample content — never an empty shell.
- Keep it focused. Prefer clarity over cleverness.`;

/**
 * The character to call.
 *
 * `AVATAR_ID` is what a host platform sets when it launches this app with an avatar the user
 * picked, so it always wins. With nothing set we call the first READY avatar built from a
 * VIDEO source on this key — an avatar built from a still image also reports `ready`, then
 * publishes an all-black track, and nothing in the API says so.
 *
 * For THIS layout the source clip matters more than it does for the coding companion. They are
 * full height in their own column with the app on glass in front of them, so a clip shot against
 * black composites into the scene and a clip shot in a bright room reads as a photograph
 * pasted onto a website. The page scrims and vignettes as a fallback; casting is the real fix.
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
 * Calls THIS process started, so `/api/end` can only end its own — and so `/api/publish` can
 * only write to a Worker THIS process named. The route hears from any visitor. Taking a script
 * name from the request body would let one page overwrite any Worker on the account, which on
 * a real account is not a demo bug, it is a production outage. So the name is minted here,
 * keyed to a session id we already know we issued, and never read from the wire.
 *
 * Swept lazily at mint time: once a call cannot still be live (its cap plus slack has passed),
 * the entry has nothing left to protect.
 */
const started = new Map(); // session_id → { pool, staleAtMs, site, url, ended }
const STARTED_SLACK_MS = 15 * 60_000;

// ── Cloudflare ───────────────────────────────────────────────────────────────────────────
/** One call against the account. Throws with the API's own first message, which is specific. */
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfToken}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!body?.success) {
    const first = body?.errors?.[0];
    throw new Error(first ? `cloudflare ${first.code}: ${first.message}` : `cloudflare ${res.status}`);
  }
  return body.result;
}

/** `<script>.<subdomain>.workers.dev`. Constant per account, so it is fetched once. */
let workersSubdomain = null;
async function subdomain() {
  if (!workersSubdomain) workersSubdomain = (await cf("/workers/subdomain")).subdomain;
  return workersSubdomain;
}

/**
 * Upload the document as a Worker that serves it, and switch its workers.dev route on.
 *
 * The same script name is reused for the life of a session, so pressing publish five times
 * updates one site at one URL instead of leaving five orphans on the account — a demo that
 * mints a script per build is a demo that quietly fills someone's dashboard.
 */
async function publish(site, html) {
  const worker =
    `const HTML = ${jsString(html)};\n` +
    `export default { fetch: () => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }) };\n`;

  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify({ main_module: "index.mjs", compatibility_date: COMPAT_DATE })], {
      type: "application/json",
    }),
  );
  form.set("index.mjs", new Blob([worker], { type: "application/javascript+module" }), "index.mjs");

  await cf(`/workers/scripts/${site}`, { method: "PUT", body: form });
  await cf(`/workers/scripts/${site}/subdomain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });

  // The upload and the route both return success BEFORE the URL answers — measured at about
  // six seconds of 404 on a first publish, and none at all on a later one. Handing that URL
  // handing it over early means the character says it is live while it is still a 404, so it is not
  // returned until it serves. The User-Agent is set because Cloudflare's own bot protection
  // sits in front of workers.dev and answers 403 to some default agents — a poll that reads
  // that as "not ready" would give up on a site that is already live.
  const url = `https://${site}.${await subdomain()}.workers.dev`;
  for (let attempt = 0; attempt < 15; attempt++) {
    const ok = await fetch(url, { redirect: "manual", headers: { "user-agent": "pair-programmer" } })
      .then((r) => r.status < 400)
      .catch(() => false);
    if (ok) return url;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("published, but the URL did not start serving within 30 seconds");
}

/**
 * The document, as a JavaScript string literal.
 *
 * JSON.stringify covers quotes, backslashes and newlines. U+2028 and U+2029 it leaves raw,
 * and those are line terminators to a JS parser — a page containing one would upload happily
 * and then fail to parse on the edge.
 */
function jsString(text) {
  return JSON.stringify(text).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Never derived from anything the user said. A name is an address on someone's account.
 *
 * A DIFFERENT prefix from the coding companion's `rta-studio-`, so that running both demos on
 * one Cloudflare account leaves two cleanup lists rather than one ambiguous pile.
 */
const mintSiteName = () => `rta-pair-${randomBytes(4).toString("hex")}`;

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];

    /**
     * What this deployment can do. A SEPARATE route on purpose: the mint response is the
     * grant relayed byte-for-byte, and folding a field of ours into it is exactly the reshape
     * the browser SDK rejects.
     *
     * `maxSeconds` is here because the page cannot otherwise tell the difference between a
     * call that broke and a call that finished. At the cap the media simply stops: measured
     * at `activeSeconds: 299.693` against a 300s cap, with the video element still reporting
     * `readyState` 4 and `paused` false, the track still `live`, and no `Disconnected` for
     * seconds afterwards. A page that does not know the limit shows a frozen picture under
     * the word "connected"; a page that knows it can say the call is over.
     */
    if (req.method === "GET" && path === "/api/config") {
      return void json(res, 200, { publish: canPublish, maxSeconds: MAX_SECONDS });
    }

    if (req.method === "POST" && path === "/api/call") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: companionBrief(),
        voice: VOICE, // pinned, not defaulted — see above
        // THE GRANT. Without it the worker never exposes `rta.tools.register`, registration
        // in the browser fails, and not one tool is reachable from the model.
        clientTools: true,
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "pair-programmer" },
      });
      if (isQueued(call)) {
        // Capacity, not a failure. The page renders the position and comes back.
        return void json(res, 429, {
          queued: true,
          position: call.position,
          retryAfterMs: call.retryAfterMs,
        });
      }
      // Remember what we minted — where it is held, and the one script name it may write to.
      for (const [id, s] of started) if (s.staleAtMs <= Date.now()) started.delete(id);
      started.set(call.sessionId, {
        pool: typeof call.raw.capacity_pool === "string" ? call.raw.capacity_pool : undefined,
        staleAtMs: Date.now() + MAX_SECONDS * 1000 + STARTED_SLACK_MS,
        site: mintSiteName(),
        url: null,
        ended: false,
      });
      // The grant relayed byte-for-byte. Nothing rides inside it — the browser SDK validates
      // strictly and an extra key is a throw, not a warning.
      return void json(res, 200, call.raw);
    }

    if (req.method === "POST" && path === "/api/end") {
      // The page's goodbye — beaconed on `pagehide`, and sent outright when the user presses
      // Hang up or the call reaches its cap. The slot is held from the moment the grant lands
      // — BEFORE the room exists — and a tab closed in that gap tells no one else. Leaving the
      // room does free it, but only once the platform notices the participant has gone
      // (measured at about eight seconds); saying so costs one beacon and frees it now.
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted && !minted.ended) {
        // MARKED, not deleted. The entry is also what `/api/publish` looks a script name up
        // in, and hanging up does not delete what you built — a page you can still see is a
        // page you should still be able to ship. `staleAtMs` sweeps it later either way.
        minted.ended = true;
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply,
      // and an unknown id should not learn whether it named something real.
      return void json(res, 200, { ok: true });
    }

    /**
     * Stream the document to the window.
     *
     * The browser sends STRINGS, never turns. There is no `role` field in the request at all,
     * so a `system` turn cannot be smuggled in beside the build engine's own prompt. The
     * current document is the whole history worth keeping — the artifact is the state — so a
     * growing transcript of 20 KB documents never has to exist.
     */
    if (req.method === "POST" && path === "/api/code") {
      const body = await readJson(req);
      const request = String(body.request ?? "").slice(0, 8000).trim();
      const current = String(body.current ?? "").slice(0, MAX_HTML);
      const errors = String(body.errors ?? "").slice(0, 4000).trim();
      if (!request) return void json(res, 400, { error: "say what to build" });

      let ask = current
        ? `Here is the current document:\n\n${current}\n\nApply this change: ${request}`
        : request;
      if (errors) {
        ask += `\n\nRendering the current document produced these errors:\n\n${errors}\n\nFix them and return the entire corrected document.`;
      }

      const upstream = await fetch(`${CODE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${codeKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: CODE_MODEL,
          messages: [
            { role: "system", content: CODE_SYSTEM },
            { role: "user", content: ask },
          ],
          temperature: 0.3,
          stream: true,
        }),
      });
      if (!upstream.ok || !upstream.body) {
        // Log a bounded slice; never surface an upstream body to the browser — it echoes the
        // request back, headers included.
        console.error(`code model ${upstream.status}: ${(await upstream.text()).slice(0, 200)}`);
        return void json(res, 502, { error: "the code model is not answering" });
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      for await (const chunk of upstream.body) res.write(chunk);
      return void res.end();
    }

    /**
     * Put the document on a public URL.
     *
     * `session_id` is a LOOKUP, not an instruction: it selects an entry this process created,
     * and the script name comes off that entry. A body that could name the script would be a
     * body that could overwrite any Worker on the account.
     */
    if (req.method === "POST" && path === "/api/publish") {
      if (!canPublish) return void json(res, 501, { error: "publishing is not configured" });
      const body = await readJson(req);
      const minted = typeof body.session_id === "string" ? started.get(body.session_id) : undefined;
      if (!minted) return void json(res, 403, { error: "unknown session" });

      const html = String(body.html ?? "");
      if (!html.trim()) return void json(res, 400, { error: "nothing to publish yet" });
      if (html.length > MAX_HTML) {
        return void json(res, 413, { error: "this page is too big to publish — ask for something smaller" });
      }

      try {
        minted.url = await publish(minted.site, html);
        console.log(`published ${minted.site} → ${minted.url}`);
        return void json(res, 200, { url: minted.url });
      } catch (err) {
        console.error(`publish failed: ${err?.message ?? err}`);
        return void json(res, 502, { error: String(err?.message ?? err) });
      }
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

server.listen(PORT, () => console.log(`pull up a chair on http://localhost:${PORT}`));
