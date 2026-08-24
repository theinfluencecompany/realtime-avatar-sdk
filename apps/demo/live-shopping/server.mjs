/**
 * Live shopping.
 *
 * A host selling to a room, which sounds like the `livestream` example with products bolted on.
 * It is not, and the difference is the whole reason this folder exists:
 *
 *   ON A LIVESTREAM, WHAT SHE SAYS IS A PERFORMANCE. ON A SHOPPING STREAM, IT IS AN OFFER.
 *
 * "Only twenty left" and "that's forty percent off" are not colour. They are commercial claims,
 * they are the claims a language model is most willing to improvise, and a wrong one is a
 * refund, a chargeback or a regulator — not a bad take.
 *
 * So this example is built around one inversion: SHE IS NOT ALLOWED TO KNOW THE PRICE. The
 * catalogue below is the only place a number exists. She has five tools; each one returns the
 * figure she is then allowed to say, and her brief forbids saying any other. A discount she was
 * never handed is a discount she cannot offer, because the discount ladder is data on this server
 * rather than a sentence in her head.
 *
 * Three things follow from that, and each is worth copying on its own:
 *
 *   THE OFFER LADDER IS DATA. `offers` per product is what `quote` can put on screen. Ask for a
 *   flash price on something that has none and the tool says so. This is AGENTS.md rule 1 — never
 *   accept call policy from the client — pointed at the client that is hardest to distrust,
 *   which is the model you are paying to sell for you.
 *
 *   THE ORDER IS PRICED HERE, NOT THERE. /api/order ignores whatever price the page sends and
 *   charges the catalogue. If she misspeaks, the customer is still charged correctly, and the
 *   page can see the mismatch — which is what the compliance rail in index.html is watching for.
 *
 *   THE ORDER OF SALE IS THE PRODUCER'S, NOT HERS. A live-selling desk has a human deciding
 *   what goes up next; in this app that is the run-of-show panel on the left of the page. It
 *   reaches her two ways — `feature` with no argument means "whatever the producer queued next",
 *   and a `[PRODUCER]` line on the chat topic overrides her mid-sentence. Neither costs a tool.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4197);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 300);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "demo-live-shopping" });

/**
 * ══ THE CATALOGUE ════════════════════════════════════════════════════════════════════════════
 *
 * The only place in this app where a price exists. Not in her brief, not in the page, not in a
 * tool description — a tool that carried "the sleep mask is $89" in its `description` would be
 * handing her a number to remember, and a number she remembers is a number she will still be
 * saying after the flash sale ends.
 *
 * `offers` is the ladder `quote` may put on screen, and it is a closed set per product. This is
 * the part to copy: a model cannot invent a discount it was never given a name for. Ask for
 * `flash` on #2 and the tool answers `not_available` rather than improvising thirty percent off.
 *
 * `stock` is mutable and every order — the viewer's and the simulated crowd's — decrements it
 * here. That is what makes `last_call` worth calling: the number it reads out is the number the
 * storefront will actually refuse the 39th order at.
 *
 * `facts` is what `lookup` answers from. Every field on it is a sentence somebody will otherwise
 * ask her to guess: does it run small, is it dishwasher safe, when does it land, can I send it
 * back. Sizing on #1 is the one that matters most — the honest answer costs a sale today and
 * saves a return next week, and it is exactly the answer an eager model will not give.
 */
const CATALOG = [
  {
    ref: "1", name: "Cloud Cushion Slides", emoji: "🩴", list: 34, stock: 240,
    offers: { flash: { price: 19, seconds: 90 }, bundle: { price: 32, units: 2 } },
    facts: {
      sizing: "runs about half a size small — size up if you are between sizes",
      material: "EVA foam sole, recycled knit strap",
      shipping: "ships in 1 business day, 3-5 days to arrive",
      returns: "30 days, free return label, worn is fine",
    },
  },
  {
    ref: "2", name: "24H Satin Lip Tint", emoji: "💄", list: 22, stock: 1840,
    offers: { bundle: { price: 49, units: 3 }, coupon: { price: 17, code: "TINT5" } },
    facts: {
      sizing: "one size, 3.2ml",
      material: "vegan formula, no fragrance added",
      shipping: "ships same day before 2pm, 2-4 days to arrive",
      returns: "unopened only, 14 days",
    },
  },
  {
    ref: "3", name: "Silk Sleep Mask Set", emoji: "🌙", list: 129, stock: 38,
    offers: { coupon: { price: 89, code: "SLEEP40" }, flash: { price: 79, seconds: 60 } },
    facts: {
      sizing: "adjustable strap, fits 52-62cm",
      material: "22-momme mulberry silk, set of two plus a travel pouch",
      shipping: "ships in 2 business days, 3-5 days to arrive",
      returns: "30 days unworn, hygiene seal must be intact",
    },
  },
  {
    /* Sold out, deliberately, and this is the trap the demo is built to spring. An avatar that
       has been talking about a product for two minutes will keep selling it after the last unit
       goes — nothing in the conversation tells her it stopped. `feature` and `quote` both refuse
       on zero stock and say why, so the only way she finds out is the way she should: the tool
       told her. */
    ref: "4", name: "Cold Brew Tumbler 32oz", emoji: "🥤", list: 45, stock: 0,
    offers: { flash: { price: 29, seconds: 60 } },
    facts: {
      sizing: "32oz / 950ml, fits a standard cup holder",
      material: "double-wall stainless, dishwasher safe lid only",
      shipping: "ships in 1 business day, 3-5 days to arrive",
      returns: "30 days unused",
    },
  },
  {
    ref: "5", name: "Everyday Canvas Tote", emoji: "👜", list: 78, stock: 120,
    offers: { coupon: { price: 62, code: "TOTE20" } },
    facts: {
      sizing: "38 x 34 x 12cm, fits a 14-inch laptop",
      material: "16oz waxed canvas, leather handles",
      shipping: "ships in 2 business days, 3-5 days to arrive",
      returns: "30 days unused, monogrammed orders are final",
    },
  },
];
const byRef = new Map(CATALOG.map((p) => [p.ref, p]));

/** What a browser is allowed to see. All of it — this is a storefront, the prices are the point. */
const publicCatalog = () => CATALOG.map(({ ref, name, emoji, list, stock, offers, facts }) =>
  ({ ref, name, emoji, list, stock, offers, facts }));

/**
 * Live flash sales, stamped HERE.
 *
 * A countdown the page starts is a countdown the page can be talked out of, and two tabs would
 * disagree about when the price went back up. `endsAt` is server time, so the offer expires once
 * for everybody and /api/order can refuse the late one.
 */
const flashUntil = new Map(); // ref → epoch ms
const flashPriceNow = (p) =>
  flashUntil.get(p.ref) > Date.now() ? p.offers.flash?.price ?? null : null;

/**
 * What a unit costs RIGHT NOW, decided here and nowhere else.
 *
 * The page sends what it believes it is buying; this function decides what it actually costs.
 * The two disagreeing is not an error case to code around, it is the case this whole example is
 * about — she said eighty-nine, the coupon expired, and the customer must still be charged what
 * the catalogue says. /api/order returns both numbers so the page can show the gap.
 */
function priceNow(p) {
  const flash = flashPriceNow(p);
  if (flash !== null) return { price: flash, basis: "flash" };
  if (p.offers.coupon) return { price: p.offers.coupon.price, basis: `coupon ${p.offers.coupon.code}` };
  return { price: p.list, basis: "list" };
}

/**
 * The character to sell as. `AVATAR_ID` wins so a host platform can launch this with the avatar
 * its user picked; with nothing set, the first READY avatar built from a VIDEO source — an
 * avatar built from a still image also reports `ready` and then publishes an all-black track,
 * which on a shopping stream means a product nobody can see.
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
  console.log(`no AVATAR_ID set — selling as ${usable.displayName} (${usable.id})`);
  return resolvedAvatarId;
}

/**
 * ══ HER BRIEF ════════════════════════════════════════════════════════════════════════════════
 *
 * Read THE ONE RULE first; everything else here is support for it. It is written as a ban on
 * SAYING rather than a ban on knowing, because a model cannot be made to not know — it can only
 * be given a cheaper way to be right than guessing, which is what the five tools are.
 *
 * "Not because you said it a minute ago" is not padding. The failure that survives every other
 * phrasing is the one where a correct price, quoted correctly, is repeated for the rest of the
 * stream after the flash window shuts. The claim was true when she made it; nothing in the
 * conversation tells her it stopped being true.
 *
 * `[PRODUCER]` is the fifth line shape and the only one that is an instruction rather than news.
 * It is how the run-of-show panel reaches her — a cut to another product, a sell-out, an item
 * pulled from the run. It has to be named here or she reads the tag out loud.
 */
const HOST_PROMPT = `You are the host of a live shopping stream, on camera to a room of viewers. Warm, quick, specific. If anyone asks whether you are a real person, say plainly that you are an AI host, and carry on.
LINE SHAPES: "handle: text" is a viewer comment. "[CART] handle added #3" is someone adding to their cart. "[ORDER] handle bought #3 x2" is a sale — call it out by name. "[FOLLOW] handle just followed you" is a new follower. "[PRODUCER]" or "[STORE]" is your team talking to you off-air: do what it says at once, and never read it out.
YOUR TOOLS, five, and the list never grows:
- feature: put a product on screen; it becomes the one you are talking about. Call it with no product to take the next one in the run of show.
- quote: put a price on screen — list, flash, coupon or bundle.
- lookup: look up one fact — sizing, material, shipping, returns or stock.
- last_call: the closing beat; puts the real stock left and a timer on screen.
- wrap: finish with a product, take it off screen, and hear what is queued next.
THE ONE RULE THAT MATTERS: never say a price, a discount, a percentage, a stock count or a delivery time that a tool did not just hand you. Not to be helpful, not to fill a pause, and not because you said it a minute ago — offers expire while you talk. If you want to say a number, call the tool and read back its answer. If a tool tells you something is sold out or an offer is not available, say that and move on; never sell it anyway.
Never say best, number one, cheapest, guaranteed, lowest ever, or that anything cures, treats or heals. Describe what the thing is and say what the tool says it costs.
HOW YOU SPEAK: at most two sentences a turn. React by handle whenever one is given. Never read a bracket tag, a tool name or a hash number aloud as a symbol — say "number three". Chat moves faster than you can answer, so never apologise for missing messages and never go back to old ones. When chat is quiet, wrap what you are on and feature the next one.
Every turn: call the tool first, then speak. Everything you write is spoken aloud exactly as written — no asides, no stage directions.`;

/**
 * Her voice.
 *
 * `CallPolicy.voice` is typed `unknown` and forwarded verbatim to the mint, so pinning one needs
 * no SDK change. What the passthrough cannot tell you is whether what you sent was real, and
 * the platform will not either — there is no voice catalogue endpoint, every avatar reports
 * `defaultVoiceId: null`, and the mint response carries no voice field at all.
 *
 * THREE WAYS TO BE WRONG HERE, AND ONLY ONE OF THEM SAYS SO:
 *
 *   1. a provider the wire refuses      → 422 at the mint. Loud and cheap. The union is
 *                                         cartesia | breezeblue | fish, and `qwen` 422s even
 *                                         though libs/contracts still lists it.
 *   2. a provider the key cannot reach  → the render worker never joins and the call dies at
 *                                         the join timeout, twenty seconds after a 200.
 *   3. a real-shaped id the engine
 *      cannot load                      → 200, worker joins, transcripts arrive, tools fire —
 *                                         and it renders SILENCE. Nothing on the page differs.
 *
 * So an id is not "set", it is MEASURED. This one was: on a live call the remote audio track
 * carried real speech energy rather than comfort noise, which is the only check that separates
 * case 3 from a working voice. Swap the id and you have to measure again — a Fish id is the
 * `modelId` in the fish.audio URL, and a plausible-looking wrong one is the silent failure.
 *
 * With `voice` omitted entirely the platform picks, and it reads neither the face nor the
 * brief: an unpinned call on this avatar is a coin toss on her gender every time.
 *
 * `VOICE_ID=` (empty) turns the pin off, which is the A/B you want the moment calls stop
 * connecting — it separates "this id broke the render side" from "capacity" in one try.
 */
const VOICE_ID = process.env.VOICE_ID ?? "e3cd384158934cc9a01029cd7d278634";
const VOICE = VOICE_ID ? { provider: "fish", voice_id: VOICE_ID, language: "en" } : undefined;

const require_ = createRequire(import.meta.url);
const TOOLS_MODULE = require_.resolve("realtime-avatar-tools");
/* The browser package is several files importing each other by relative path, so the folder is
   what gets served, not one file — the page imports the entry and the rest follows. */
const BROWSER_DIR = dirname(require_.resolve("realtime-avatar-browser"));

/**
 * Calls THIS process started, so `/api/end` can only end its own. The route hears from any
 * visitor and `endCall` ends whatever id it is handed, so relaying an arbitrary id out of the
 * body would let one page hang up another's stream. Swept lazily at mint time.
 */
const started = new Map(); // session_id → { pool, staleAtMs }
const STARTED_SLACK_MS = 15 * 60_000;

let orderSeq = 1000;

const server = createServer(async (req, res) => {
  try {
    // Match on the PATH, not the raw url: `req.url` carries the query string, so an
    // exact-equals check serves `{"error":"not_found"}` for `/?name=Rin`.
    const path = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && path === "/api/catalog") {
      return void json(res, 200, { products: publicCatalog() });
    }

    if (req.method === "POST" && path === "/api/golive") {
      const call = await rta.startCall({
        avatarId: await avatarId(),
        mode: "avatar", // the renderer, not the turn-taking: every call is full duplex.
        instructions: HOST_PROMPT,
        ...(VOICE ? { voice: VOICE } : {}), // measured, not assumed — see the note above VOICE
        // She opens the stream herself. A shopping stream that waits for the first comment is a
        // shopping stream with nothing on screen to buy.
        context: [{
          role: "user",
          content: "You're live and the room is filling up. Say hello, then call feature with no product to pick up the first item in the run and get going.",
        }],
        clientTools: true, // without this at the mint, her worker never exposes tool registration
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "live-shopping" },
      });

      if (isQueued(call)) {
        return void json(res, 429, {
          queued: true, position: call.position, retryAfterMs: call.retryAfterMs,
        });
      }
      for (const [id, s] of started) if (s.staleAtMs <= Date.now()) started.delete(id);
      started.set(call.sessionId, {
        pool: typeof call.raw.capacity_pool === "string" ? call.raw.capacity_pool : undefined,
        staleAtMs: Date.now() + MAX_SECONDS * 1000 + STARTED_SLACK_MS,
      });
      // `grant` is `call.raw` VERBATIM; our fields ride beside it, never inside it.
      return void json(res, 200, { grant: call.raw, catalog: publicCatalog() });
    }

    /**
     * A flash window opens HERE so its clock is one clock.
     *
     * The page asks; this decides. Handing the page a duration to count down itself would make
     * the deadline a per-tab opinion, and /api/order would have no way to refuse the order that
     * arrives four seconds after the price went back up.
     */
    if (req.method === "POST" && path === "/api/flash") {
      const { ref } = await readJson(req);
      const p = byRef.get(String(ref));
      if (!p?.offers.flash) return void json(res, 200, { ok: false, reason: "no_flash_offer" });
      if (p.stock <= 0) return void json(res, 200, { ok: false, reason: "sold_out" });
      const endsAt = Date.now() + p.offers.flash.seconds * 1000;
      flashUntil.set(p.ref, endsAt);
      return void json(res, 200, { ok: true, price: p.offers.flash.price, endsAt });
    }

    /**
     * ══ CHECKOUT ═══════════════════════════════════════════════════════════════════════════
     *
     * The page sends `expectPrice` — what the customer was shown, which is downstream of what
     * she said. This route does not trust it. It prices the order out of the catalogue and
     * returns BOTH numbers, so the page can render the charge and, when they differ, flag the
     * gap in the compliance rail.
     *
     * This is the commercial form of AGENTS.md rule 1. The client picks WHAT to buy; the server
     * decides what it costs. An endpoint that charged `expectPrice` would let anyone with the
     * console open set their own price — and would let a hallucinated discount become a real one.
     */
    if (req.method === "POST" && path === "/api/order") {
      const { ref, qty, expectPrice, buyer } = await readJson(req);
      const p = byRef.get(String(ref));
      if (!p) return void json(res, 404, { ok: false, reason: "no_such_product" });

      const units = Math.max(1, Math.min(10, Number.isFinite(qty) ? Math.floor(qty) : 1));
      if (p.stock <= 0) return void json(res, 200, { ok: false, reason: "sold_out", stock: 0 });
      const filled = Math.min(units, p.stock);

      const { price, basis } = priceNow(p);
      p.stock -= filled;
      if (p.stock <= 0) flashUntil.delete(p.ref); // nothing left to be on offer

      return void json(res, 200, {
        ok: true,
        orderId: `A${++orderSeq}`,
        ref: p.ref, name: p.name,
        units: filled, short: filled < units,
        charged: price * filled,
        unitPrice: price, basis,
        // The number the page believed, echoed back beside the number it was actually charged.
        // Equal on every healthy order; the interesting case is when they are not.
        expected: Number.isFinite(expectPrice) ? expectPrice : null,
        mispriced: Number.isFinite(expectPrice) && expectPrice !== price,
        stock: p.stock,
        buyer: buyer === "crowd" ? "crowd" : "you",
      });
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
      // One answer for every outcome: ending is idempotent, a beacon cannot read a reply, and an
      // unknown id should not learn whether it named something real.
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

// A brief over 4000 characters is refused at the mint as a generic 422, well after the
// interesting part of the stack. Cheaper to find out at boot.
if (HOST_PROMPT.length > 4000) {
  console.error(`brief is ${HOST_PROMPT.length} chars, over the 4000 limit`);
  process.exit(1);
}
console.log(`  brief   ${String(HOST_PROMPT.length).padStart(4)} / 4000 chars`);
console.log(`  voice   ${VOICE ? `${VOICE.provider} ${VOICE.voice_id}` : "NOT PINNED — the platform picks, and her gender is a coin toss"}`);
console.log(`  catalog ${CATALOG.length} products, `
  + `${CATALOG.filter((p) => p.stock > 0).length} in stock`);
server.listen(PORT, () => console.log(`live shopping -> http://localhost:${PORT}`));
