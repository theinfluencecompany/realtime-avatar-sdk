/**
 * The coding companion.
 *
 * You describe an app out loud. SHE decides it is a build: her model calls a tool that lives
 * in the page, a complete HTML document streams into the panel beside her and renders in a
 * sandboxed iframe, and when you like it she publishes it to a public URL.
 *
 * Two models, on purpose. Holding a conversation and writing an app are different jobs, and
 * paying conversation prices for both is how a demo becomes a bill — so the avatar is the
 * voice and a cheaper coding model is the builder. The avatar platform never sees the coding
 * model, its key, or the document.
 *
 * The rule that survives being copied: she is told never to read code aloud. A character who
 * dictates a div is unlistenable, and she will do it unless told not to.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";
import { companionBrief, BUILD_ENGINE_SYSTEM_PROMPT } from "realtime-avatar-examples/coding-companion";

const PORT = Number(process.env.PORT ?? 4192);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const codeKey = process.env.OPENAI_API_KEY;
if (!codeKey) {
  console.error("Missing OPENAI_API_KEY — the build panel is the app. See .env.example.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "coding-companion" });

/** The building brain. Any OpenAI-compatible endpoint; deliberately not the conversation model. */
const CODE_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const CODE_MODEL = process.env.CODE_MODEL ?? "gpt-4.1";

/**
 * Publishing is OPTIONAL and off unless both variables are set.
 *
 * Without them the app is a local studio: build, preview, restore, no share link. The page
 * asks `/api/config` what it may offer and leaves the publish tools unregistered, so she is
 * never briefed on a verb she cannot call — a tool that exists and always fails is worse
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
 * Her brief and the builder's system prompt come from the published examples package — the
 * ONE place the words live, shared with the hosted port on realtimeavatar.ai. Editing them here
 * would only make this copy drift; edit `libs/examples/src/coding-companion.ts` in the SDK repo.
 */
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
 * `npm i realtime-avatar` is all it takes. In an app with a bundler
 * this route does not exist at all — `import { attachAvatarTools } from
 * "realtime-avatar/tools"` and let the bundler do it. It is served raw
 * here only so the example has no build step.
 */
const TOOLS_MODULE = createRequire(import.meta.url).resolve("realtime-avatar/tools");
const BROWSER_MODULE = createRequire(import.meta.url).resolve("realtime-avatar/browser");
/** The shared demo contract (tool descriptors + toolSet), served raw like the SDK modules above. */
const EXAMPLES_DIR = new URL("./", import.meta.resolve("realtime-avatar-examples/coding-companion"));
/**
 * livekit-client is the SDK's peer dependency, and the browser half imports it from HERE rather
 * than from a CDN: the exact version the SDK was installed and tested with, one same-origin
 * request, and no third-party origin between a visitor and the call. Read once, compressed once,
 * served with a version ETag so a reload costs a 304.
 */
// import.meta.resolve, not require.resolve: the package's `require` condition is the UMD build,
// which has no ES exports — a page importing { Room } from it fails on the first click. The
// `import` condition is the ESM build the browser can actually import.
const LIVEKIT_MODULE = new URL(import.meta.resolve("livekit-client"));
const LIVEKIT_VERSION = JSON.parse(await readFile(new URL("../package.json", LIVEKIT_MODULE), "utf8")).version;
const LIVEKIT_JS = await readFile(LIVEKIT_MODULE);
const LIVEKIT_GZ = gzipSync(LIVEKIT_JS);
const LIVEKIT_ETAG = `"livekit-client-${LIVEKIT_VERSION}"`;

/**
 * Calls THIS process started, so `/api/end` can only end its own — and, now, so `/api/publish`
 * can only write to a Worker THIS process named. The route hears from any visitor. Taking a
 * script name from the request body would let one page overwrite any Worker on the account,
 * which on a real account is not a demo bug, it is a production outage. So the name is minted
 * here, keyed to a session id we already know we issued, and never read from the wire.
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
  // straight to her means she says it is live while it is still a 404, so the address is not
  // returned until it serves. The User-Agent is set because Cloudflare's own bot protection
  // sits in front of workers.dev and answers 403 to some default agents — a poll that reads
  // that as "not ready" would give up on a site that is already live.
  const url = `https://${site}.${await subdomain()}.workers.dev`;
  for (let attempt = 0; attempt < 15; attempt++) {
    const ok = await fetch(url, { redirect: "manual", headers: { "user-agent": "coding-companion" } })
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

/** Never derived from anything the user said. A name is an address on someone's account. */
const mintSiteName = () => `rta-studio-${randomBytes(4).toString("hex")}`;

const server = createServer(async (req, res) => {
  try {
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
    if (req.method === "GET" && req.url === "/api/config") {
      return void json(res, 200, { publish: canPublish, maxSeconds: MAX_SECONDS });
    }

    if (req.method === "POST" && req.url === "/api/call") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: companionBrief({ canPublish }),
        // THE GRANT. Without it her worker never exposes `rta.tools.register`, registration
        // in the browser fails, and not one tool is reachable from the model.
        clientTools: true,
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "coding-companion" },
      });
      if (isQueued(call)) {
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
      // The grant relayed byte-for-byte. Nothing rides inside it.
      return void json(res, 200, call.raw);
    }

    if (req.method === "POST" && req.url === "/api/end") {
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
     * Stream the document to the panel.
     *
     * The browser sends STRINGS, never turns. An earlier shape took a `messages` array and
     * filtered `system` out of it; this one cannot be asked to, because there is no role in
     * the request at all. The current document is the whole history worth keeping — the
     * artifact is the state — so a growing transcript of 20 KB documents never has to exist.
     */
    if (req.method === "POST" && req.url === "/api/code") {
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
            { role: "system", content: BUILD_ENGINE_SYSTEM_PROMPT },
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
    if (req.method === "POST" && req.url === "/api/publish") {
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

    if (req.method === "GET" && req.url === "/vendor/livekit-client.mjs") {
      if (req.headers["if-none-match"] === LIVEKIT_ETAG) return void res.writeHead(304, { etag: LIVEKIT_ETAG }).end();
      const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
      return void res
        .writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          etag: LIVEKIT_ETAG,
          "cache-control": "public, max-age=0, must-revalidate",
          ...(gzip ? { "content-encoding": "gzip" } : {}),
        })
        .end(gzip ? LIVEKIT_GZ : LIVEKIT_JS);
    }
    const example = /^\/sdk\/examples\/([a-z-]+\.js)$/.exec(req.url);
    if (req.method === "GET" && example) {
      const js = await readFile(new URL(example[1], EXAMPLES_DIR));
      return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
    }
    if (req.method === "GET" && req.url === "/sdk/browser.js") {
      const js = await readFile(BROWSER_MODULE);
      return void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
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

server.listen(PORT, () => console.log(`build something on http://localhost:${PORT}`));
