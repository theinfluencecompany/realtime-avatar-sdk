/**
 * Math Studio — one tutor, four manipulatives, and six tools that never grow.
 *
 * The thing this example exists to show is a **registry**. A client tool plane makes it tempting
 * to give the model a tool per thing on screen, and that dies on arithmetic: `MAX_TOOLS` is 32,
 * so at three actions apiece you run out at the eleventh manipulative. Long before that ceiling
 * you run out of the thing that actually binds, which is her attention — `instructions` caps at
 * 4000 characters and every tool needs a sentence explaining when to reach for it.
 *
 * So the manipulatives register with a CURRICULUM in the page, and she is given six generic verbs.
 * Four manipulatives or four hundred, this file does not change and her brief does not change.
 * What she is looking at is decided by the task; she learns what it is from the tool's return
 * value rather than from the tool's name.
 *
 * Two other things worth copying:
 *
 * THE BRIEF IS COMPOSED HERE, IN ONE ORDER. Persona first, then the invariant base — the page
 * never contributes a character of it. Ordering is load-bearing and the reason is below.
 *
 * THE VOICE IS PINNED ONLY WHEN PROVEN. Voice ids are not discoverable, and a wrong one fails in
 * whichever of three ways it feels like — 422 at mint, a worker that never joins, or a call that
 * joins, talks, fires tools and renders silence. So a preset reaches the mint only once its audio
 * has been checked, which is what the registry below is for. All three of this cast have been.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const PORT = Number(process.env.PORT ?? 4199);
const MAX_SECONDS = Number(process.env.MAX_CALL_SECONDS ?? 420);

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  console.error("Missing REALTIME_AVATAR_API_KEY — copy .env.example to .env and fill it in.");
  process.exit(1);
}
const rta = new RealtimeAvatar({ apiKey, userAgent: "demo-math-studio" });

/**
 * The cast, and where their avatars come from.
 *
 * Each character owns a persona line and a voice preset; neither is a request parameter. The
 * avatar ids are read from the environment because an example that only runs on the author's key
 * teaches nothing — set one per character to get all three, set none and this resolves a single
 * avatar the way every other example here does and the picker collapses to that one.
 *
 * Her face before the video track exists is `characters/<slug>.webp`, and `hue` is what is drawn
 * instead when there is no such file — see the /portrait route below. A character costs one
 * object; the picture is optional.
 *
 * `clips` is a state map: the character reads each `when` and switches herself between them.
 * Optional too — with none, the platform renders her without one.
 */
const CAST = [
  {
    slug: "lin", name: "Ms. Lin", blurb: "warm and patient", hue: 38, env: "AVATAR_ID_LIN",
    voice: "lin-warm-female",
    persona: "You are Ms. Lin, a woman in her thirties, and a warm, patient teacher. "
      + "Speak as a woman, in a warm female voice.",
    /* Clips must open and close on the same rest pose or the switch is a jump, and `when` is read
       by her rather than evaluated by anything — so it is written as direction, not as a rule. */
    clips: {
      idle: {
        when: "the normal resting state: you have set a task and are waiting for them to work on it",
        url: "https://v3b.fal.media/files/b/0aa6455b/rHM1C6v-v0EMeD7hU8XTA_video.mp4",
      },
      happy: {
        when: "they got it right and you are praising them",
        url: "https://v3b.fal.media/files/b/0aa64692/xhIppRYGlm2gmWwONkyAQ_video.mp4",
      },
      gentle: {
        when: "they got it wrong and you are about to demonstrate the method again",
        url: "https://v3b.fal.media/files/b/0aa64690/6zGC7Of_2oUnZv5V5VuR2_video.mp4",
      },
      cheer: {
        when: "the run is finished and the report card is showing",
        url: "https://v3b.fal.media/files/b/0aa6468f/idw2cqUu4Ec_H1e-hlzK7_video.mp4",
      },
    },
  },
  {
    slug: "wang", name: "Mr. Wang", blurb: "brisk and encouraging", hue: 208, env: "AVATAR_ID_WANG",
    voice: "wang-brisk-male",
    persona: "You are Mr. Wang, a man in his thirties, and a brisk, encouraging teacher. "
      + "Speak as a man.",
  },
  {
    slug: "wukong", name: "Monkey King", blurb: "playful and brave", hue: 14, env: "AVATAR_ID_WUKONG",
    voice: "wukong-playful",
    persona: "You are the Monkey King - playful, brave and mischievous. Speak as a young man.",
  },
];

for (const c of CAST) c.avatarId = process.env[c.env] || null;
if (!CAST.some((c) => c.avatarId)) {
  /* Nothing named per character, so fall back to the single-avatar convention the other examples
     use. An avatar built from a still image also reports `ready` and then publishes a black
     track, so the source kind is checked rather than assumed. */
  const single = process.env.AVATAR_ID || process.env.REALTIME_AVATAR_ID
    || (await rta.listAvatars()).find((a) => a.status === "ready" && a.sourceKind === "video")?.id;
  if (!single) {
    console.error("No avatar. Set AVATAR_ID (or AVATAR_ID_LIN / _WANG / _WUKONG for the full cast),");
    console.error("or make one with createAvatarFromVideo().");
    process.exit(1);
  }
  CAST[0].avatarId = single;
  /* Her clips are footage of the author's Ms. Lin. On somebody else's avatar they are footage of
     somebody else, so they go rather than travel — and so does the picture, below. */
  delete CAST[0].clips;
  console.log(`no per-character avatar set — the cast is ${CAST[0].name} on ${single}`);
}
const TEACHERS = Object.fromEntries(CAST.filter((c) => c.avatarId).map((c) => [c.slug, c]));
function pickTeacher(slug) {
  return TEACHERS[slug] ?? Object.values(TEACHERS)[0];
}

/**
 * Clips are prepared once and cached by URL hash; the serve path only ever LOADS that cache, so a
 * clip that was never prepared does nothing at all on the first call after you add it — no error,
 * just an avatar that ignores its state map. `syncClips` is idempotent, which is why it belongs at
 * boot rather than behind a flag, and it is not fatal: a studio that cannot reach the sync endpoint
 * should still open, with her rendered the way an avatar with no state map is rendered.
 */
async function syncClips() {
  const withClips = Object.values(TEACHERS).filter((c) => c.clips);
  if (!withClips.length) return;
  console.log("  clips:");
  for (const c of withClips) {
    try {
      await rta.syncClips(c.avatarId, Object.values(c.clips).map((s) => s.url));
      console.log(`    ${c.slug.padEnd(7)} ${Object.keys(c.clips).length} states prepared`);
    } catch (err) {
      console.warn(`    ${c.slug.padEnd(7)} sync failed (${err?.message ?? err}) — `
        + "she will render without her state map");
      delete c.clips;
    }
  }
}

/** Drawn rather than fetched, for a cast with no picture beside it. Two letters and one hue. */
function monogram({ name, hue }) {
  const initials = name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean)
    .slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue} 58% 64%)"/>`
    + `<stop offset="1" stop-color="hsl(${(hue + 22) % 360} 52% 38%)"/></linearGradient></defs>`
    + `<rect width="200" height="200" fill="url(#g)"/>`
    + `<text x="100" y="104" text-anchor="middle" dominant-baseline="central" `
    + `font-family="ui-rounded,system-ui,sans-serif" font-size="78" font-weight="700" `
    + `fill="rgba(255,255,255,.94)">${initials}</text></svg>`;
}

/**
 * ══ THE VOICE REGISTRY ═══════════════════════════════════════════════════════════════════════
 *
 * `CallPolicy.voice` is typed `unknown` and forwarded verbatim to the mint, so the SDK needs no
 * change to carry a voice — that passthrough is the whole hook. What it cannot tell you is
 * whether what you sent was real, and the platform will not either:
 *
 *   - no catalogue endpoint (/voices, /tts/voices, /voice-catalog, /tts/providers all 404)
 *   - every avatar reports `defaultVoiceId: null`
 *   - the mint response carries no voice field at all
 *   - a well-shaped spec with a nonexistent id returns 200 and then sounds like someone else
 *
 * That last one, measured: `{provider:"cartesia", voice_id:"not-a-real-voice-id"}` mints a
 * session. So does the same nonsense under `breezeblue` and under `fish`. A wrong id is
 * indistinguishable from a right one until a human listens, and this layer's job is to remove
 * every OTHER way of being wrong.
 *
 * WHAT THE PROVIDER FIELD ACCEPTS, and it is not what the contracts package says. The mint
 * rejects `provider:"qwen"` outright:
 *
 *     422 voice.provider: Invalid discriminator value. Expected 'cartesia' | 'breezeblue' | 'fish'
 *
 * `libs/contracts` still carries `qwenVoiceSpecSchema` in the `voiceSpecSchema` union, so a spec
 * that typechecks against the SDK can still be refused on the wire. Three presets here used to be
 * qwen, which meant this registry could not have worked at all — every one of them was a 422
 * waiting for someone to verify it, and the only reason nothing broke is that the gate below
 * meant none of them was ever sent.
 */
const VOICE_PRESETS = {
  /**
   * Fish, because it is the provider this key can actually reach — see the table above
   * VOICE_UNVERIFIED for what the other one does.
   *
   * WHERE THE ID COMES FROM. Fish calls a voice a "model", and its console never shows you a
   * field called `voice_id` — it puts the id in the address bar. Open the voice and read
   * `modelId` out of the URL:
   *
   *     https://fish.audio/app/text-to-speech/?modelId=933563129e564b19a115bedd57b7406a
   *                                                    └──────── voice_id ────────────┘
   *
   * The name beside it ("Sarah") is a label and is not accepted anywhere.
   */
  "lin-warm-female": {
    provider: "fish", voice_id: "933563129e564b19a115bedd57b7406a", language: "en",
  },
  /* The shape a real id goes in. Both are flagged at boot, in /api/voices and in red in the
     picker, because a placeholder that fails quietly is the same class of bug as a wrong id
     that fails quietly. */
  "wang-brisk-male": {
    provider: "fish", voice_id: "536d3a5e000945adb7038665781a4aca", language: "en",
  },
  "wukong-playful": {
    provider: "fish", voice_id: "1efa8ccc674947ccb9b62ab01bdac058", language: "en",
  },
};

/**
 * NOTHING IN HERE IS SENT until its audio has been checked and its name taken out of this set.
 *
 * A WRONG VOICE DOES NOT JUST SOUND WRONG. Measured on this key, against the same avatar and the
 * same brief, with only the `voice` field changing:
 *
 *   voice                                     worker joins?  audio
 *   ────────────────────────────────────────  ─────────────  ─────────────────────────────────
 *   omitted entirely                          yes            speaks; gender is the platform's
 *                                                            coin toss, and it landed MALE on
 *                                                            a persona that says "a woman"
 *   {provider:"cartesia", voice_id:<real>}    NO             nothing to join, call dies at 15s
 *   {provider:"cartesia", voice_id:<fake>}    NO             identical failure
 *   {provider:"fish",     voice_id:<foreign>} yes            SILENT — totalAudioEnergy 9e-8 and
 *                                                            11 kB of RTP in 90s: comfort noise
 *   {provider:"fish",     voice_id:<real>}    yes            speaks — energy 1.09, 131 kB in 30s
 *
 * Read the two Cartesia rows together: it fails the same way with an id that cannot possibly
 * exist, which says the integration is not reachable from this key rather than that the id is
 * wrong. Then read the two Fish rows together. Same provider, same shape, same 200 at the mint,
 * same worker joining, same transcripts, same tools firing — and one renders no speech at all.
 * Nothing on the page distinguishes them except the audio itself.
 *
 * So there are three ways to be wrong here and only one of them announces itself:
 *
 *   1. a provider the wire does not take        → 422 at mint, loud, cheap
 *   2. a provider the key cannot reach          → worker never joins, call dies at the deadline
 *   3. a real-shaped id the engine cannot use   → 200, joins, talks, and is silent
 *
 * WHAT WAS MEASURED. Voiced frames off a live call, through a YIN estimator. Male speech sits
 * around 85-155 Hz and female around 165-255, so pitch settles the question the brief kept
 * losing — with `voice` omitted the platform reads neither the face nor the persona.
 *
 *   lin-warm-female   147 voiced   median 193 Hz   p10-p90 151-255   74% above 165   FEMALE
 *   wang-brisk-male    78 voiced   median  99 Hz   p10-p90  86-128  100% below 155   MALE
 *   wukong-playful    122 voiced   median 158 Hz   p10-p90 104-249   48/44% split    see below
 *
 * The Monkey King does not classify, and that is a real result rather than a broken one: a
 * playful young character voice has an expressive range, and his sits across the boundary
 * instead of on one side of it. What the measurement DOES establish for him is the thing this
 * gate exists for — he renders audio rather than silence. Whether he sounds right for the part
 * is a casting question, and the ear that picked the id is the authority on it.
 */
const VOICE_UNVERIFIED = new Set();

/**
 * Mirrors the mint's voice schema. A hand-written mirror rather than an import, because a stale
 * mirror that rejects something valid is a far better failure than a missing check that lets a
 * typo through to a silent wrong voice. The platform's schema is `.strict()`, so `voiceId`
 * instead of `voice_id` is a 422 on the whole call — worth catching once at boot rather than
 * once per call.
 *
 * These three are what the wire accepts, verified against it rather than copied from
 * `libs/contracts` — which also lists `qwen`, and the mint 422s on `qwen`.
 */
const VOICE_SHAPES = {
  cartesia:   { required: ["voice_id"], optional: ["model", "speed", "emotion", "language"] },
  breezeblue: { required: ["voice_id"], optional: ["model", "guidance_scale", "instructions", "language"] },
  fish:       { required: ["voice_id"], optional: ["model", "speed", "emotion", "language"] },
};
const PLACEHOLDER = /^REPLACE_WITH_/;
const placeholders = (spec) =>
  Object.entries(spec).filter(([, v]) => typeof v === "string" && PLACEHOLDER.test(v)).map(([k]) => k);

function validateVoice(name, spec) {
  const bad = [];
  const shape = VOICE_SHAPES[spec?.provider];
  if (!shape) return [`${name}: provider must be one of ${Object.keys(VOICE_SHAPES).join(", ")}`];
  const allowed = new Set(["provider", ...shape.required, ...shape.optional]);
  for (const k of Object.keys(spec)) if (!allowed.has(k)) bad.push(`${name}: unknown key "${k}"`);
  for (const k of shape.required) if (!spec[k]) bad.push(`${name}: "${k}" is required`);
  for (const [k, values] of Object.entries(shape.enums ?? {})) {
    if (spec[k] !== undefined && !values.includes(spec[k])) bad.push(`${name}: "${k}" must be one of ${values}`);
  }
  return bad;
}

const voiceProblems = Object.entries(VOICE_PRESETS).flatMap(([n, s]) => validateVoice(n, s));
for (const c of CAST) {
  if (c.voice && !VOICE_PRESETS[c.voice]) voiceProblems.push(`${c.slug}: no preset named "${c.voice}"`);
}
if (voiceProblems.length) {
  console.error("voice registry is not valid:");
  for (const p of voiceProblems) console.error(`  ${p}`);
  process.exit(1);
}

/**
 * Is this preset fit to send on a real call?
 *
 * TWO gates, not one. `VOICE_UNVERIFIED` is a human saying "I have not checked this one's audio
 * yet"; the placeholder check is the machine saying "this is not even an id". They are separate
 * because taking a name out of the set is a one-line edit somebody will make before pasting the
 * id in — and a `voice_id` still reading `REPLACE_WITH_…` is accepted at the mint like any other
 * string, then joins and renders nothing. Exactly the failure this registry exists to prevent.
 */
const sendable = (name) =>
  Boolean(name) && !VOICE_UNVERIFIED.has(name) && placeholders(VOICE_PRESETS[name] ?? {}).length === 0;

/** The spec to send for a character — or undefined, which is currently the answer for all three. */
const voiceFor = (slug) => {
  const name = TEACHERS[slug]?.voice;
  return sendable(name) ? VOICE_PRESETS[name] : undefined;
};
/** The preset NAME actually being sent — null when we deliberately send nothing. */
const presetNameFor = (slug) => {
  const name = TEACHERS[slug]?.voice;
  return sendable(name) ? name : null;
};
/** Whitelisted lookup for the lab. Never trust a spec off the wire; only a name. */
const presetByName = (name) =>
  typeof name === "string" && Object.hasOwn(VOICE_PRESETS, name) ? { name, spec: VOICE_PRESETS[name] } : null;

const listPresets = () => Object.entries(VOICE_PRESETS).map(([name, spec]) => ({
  name, provider: spec.provider,
  summary: spec.voice_id ?? "-",
  placeholder: placeholders(spec).length > 0,
  verified: !VOICE_UNVERIFIED.has(name),
  assignedTo: CAST.filter((c) => c.voice === name && c.avatarId).map((c) => c.slug),
}));

/**
 * Her brief, minus the persona line the character carries.
 *
 * Read the tool list carefully: there is nothing subject-specific in it. `show` and `demonstrate`
 * do the right thing for whatever task is current, which is precisely what lets the page add a
 * Pythagoras rearrangement or a Bézier curve without touching a character of this string. Telling
 * her the list is closed is load-bearing in itself: a model that believes more tools might exist
 * goes looking for them, and narrates the search.
 */
const BASE = `You are teaching one learner, one to one. The screen beside you is a workspace:
whatever the current task needs appears there, and your tools move it.

OPENING. The moment the call connects, without waiting: say hello and who you are in one line,
ask if they are ready, and go straight on to the first task. The invitation hands them the
lesson; it is not a question you stop for. Their microphone may be broken. You start.

HOW YOU SPEAK. Short lines - twenty words is long. Say numbers out loud and do not read symbols
out. They can cut in mid-sentence and they will; the moment they do, stop and follow them.
Whatever you were going to say next matters less than what they just said. Never apologise for
being interrupted.

You do not do the arithmetic, you do not choose what to ask, and you do not decide whether an
answer is right. All of it goes through tools:
- next_task    the next thing to work on (the system sets the difficulty; never invent your own).
               If they ask for a topic, or for easier or harder, pass their words as want
- show         put the current task on the workspace
- demonstrate  show the method - things actually move on screen
- answer       submit and check their answer (fill in heard if you caught it; leave it out and
               the tool will tell you whether they worked it out on screen instead)
- progress     how far they have got
- celebrate    feedback at the clear moments: correct / levelup / finished

These six are the whole list and it never grows. What the workspace shows changes from task to
task; which tool you call does not. You never need to know which picture is on screen - show and
demonstrate do the right thing for the current task, and their result tells you what they did in
an explain field. Use its words.

Never say right or wrong before calling answer. Never state a number a tool did not give you.

MOST IMPORTANT: everything you produce is spoken aloud exactly as written. There is no aside, no
stage direction, no bracket the learner does not hear. Never describe what you are doing - write
only the words to be said. Tool names especially: next_task, show, demonstrate, answer, progress
and celebrate must never appear in your speech.

This is the one that catches you out, and it is the one that happened:
    (calling for the next task, then showing it) Right, what is five plus two?
All that should have been said is:
    Right, what is five plus two?

Every turn: call the tool first, then speak.

WHILE THEY WORK. What they do on the workspace does not reach you unless you ask, with one
exception: a line starting WORKSPACE: is the screen, never the learner. Never read it out. If it
says there is an answer, call answer at once, react in one line and go straight on to next_task.
Otherwise call answer with no heard value every eight to ten seconds: it tells you whether the
workspace holds an answer yet, and its result carries since_last_call, a summary of what they
have been doing. Name what they did and say one short thing about it - never read the field out.
If you get still_working instead, their hand is on it: say nothing about it and look again next
time. After two silent checks, remind them they can work on screen or type into the box.

What they TYPE arrives on its own, as if they had said it out loud - it can land in the middle of
your sentence. Stop and deal with it: they interrupted for a reason. If what they typed is a
number it is their answer, so call answer as you would for one you heard.

Right answer: call celebrate correct, praise briefly, then next_task. Wrong answer: never say
the word wrong - say you will show it, call demonstrate, then let them try again.`;

/** Subject lines. Only used to compose `context`; the real curriculum lives in the page. */
const STRANDS = new Set(["geometry", "trigonometry", "signals"]);

/** Served raw so this example needs no build step. A real app imports the package and bundles it. */
const require_ = createRequire(import.meta.url);
const TOOLS_MODULE = require_.resolve("realtime-avatar-tools");
/* The browser package is several files that import each other by relative path, so the folder is
   what gets served, not one file — the page imports the entry and the rest follows. */
const BROWSER_DIR = dirname(require_.resolve("realtime-avatar-browser"));

/** Calls THIS process minted, so /api/end can only end its own. */
const started = new Map();
const STARTED_SLACK_MS = 15 * 60_000;

const server = createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  try {
    if (req.method === "POST" && path === "/api/call") {
      const body = await readJson(req);
      const teacher = pickTeacher(body.teacher);

      /* The voice lab sends a preset NAME, which must hit the registry — same rule as the
         teacher slug. The character's own assignment is the default. */
      const lab = presetByName(body.voicePreset);
      const voice = lab ? lab.spec : voiceFor(teacher.slug);
      const voiceName = lab ? lab.name : presetNameFor(teacher.slug);

      /**
       * `context` — where they got to last time.
       *
       * Numbers and whitelisted enums only, and the sentence is composed here. The page owns the
       * curriculum and the curriculum is meant to grow, so the server deliberately does not know
       * the level names: it takes a strand from a fixed set and a difficulty from 1-10, and can
       * therefore never be talked into putting a visitor's string into her memory.
       */
      const strand = STRANDS.has(body.lastStrand) ? body.lastStrand : null;
      const diff = Number.isInteger(body.lastDifficulty)
        ? Math.max(1, Math.min(10, body.lastDifficulty)) : null;
      const acc = Number.isFinite(body.lastAccuracy)
        ? Math.max(0, Math.min(1, body.lastAccuracy)) : null;
      const context = strand && diff !== null ? [{
        role: "system",
        content: `Returning learner. Last session: ${strand}, difficulty ${diff} of 10`
          + (acc === null ? "." : `, about ${Math.round(acc * 100)}% correct.`),
      }] : undefined;

      /**
       * WHO SHE IS + the base brief, in that order.
       *
       * The persona line is not decoration. math-buddy's brief opened "You are a teacher …
       * like a kindergarten teacher - slow, warm" and came out female; this one opened "You
       * are a maths tutor" — no "teacher", no "warm", nothing gendered anywhere — and came out
       * male, on the same avatar, in the same mode, with a byte-identical clip library. With
       * no `voice` pinned the persona text is the only thing left that could be deciding it.
       *
       * Which is why it now goes FIRST. It used to be appended after BASE, so the composed
       * brief opened on "You are a maths tutor" and did not reach "a woman in her thirties …
       * speak as a woman" until character 2,900 of 3,412 — and every time BASE grew, the one
       * line that carries her gender got pushed further down. She went male again after BASE
       * gained three hundred characters. Ordering is free; being 85% of the way into the
       * prompt is not.
       *
       * AND IT IS STILL NOT ENOUGH. The persona is first, it says "a woman in her thirties" and
       * "speak as a woman in a warm female voice", and she has been coming out male anyway. The
       * brief is the only lever left while `voice` is unpinned, and it is losing — which makes
       * the placeholder in `lin-warm-female` the actual bug, not a nicety. A real voice id in
       * there is what settles her gender; nothing in this string can be relied on to.
       *
       * (An older note here blamed `{provider:"qwen", mode:"design"}` for turning her male. It
       * cannot have: the mint 422s on qwen, so that spec never reached a call.)
       */
      const instructions = [teacher.persona, BASE].filter(Boolean).join("\n\n");
      if (instructions.length > 4000) {
        return void json(res, 500, { error: "composed brief over 4000 chars" });
      }

      const call = await rta.startCall({
        avatarId: teacher.avatarId,
        /**
         * `mode` picks the RENDERER and nothing else. Both modes run the same full-duplex loop —
         * her microphone is open the whole time she is speaking and she stops when the learner
         * cuts in — so there is no interruption budget to spend and nothing here to trade against
         * her face. `avatar` is the default; it is stated because this call wants the video track.
         */
        mode: "avatar",
        instructions,
        ...(context ? { context } : {}),
        /**
         * Her voice, from the registry above.
         *
         * Nothing else pins it: every avatar reports `defaultVoiceId: null`, so with `voice`
         * omitted the platform picks for itself and the face is not a signal it uses. Ms. Lin
         * came out male — that was never a regression, it was an unpinned coin that had been
         * landing the right way up.
         *
         * The lab override is a NAME, looked up against the registry, never a spec off the wire.
         * A visitor who could post a spec could post any JSON straight into the mint body.
         */
        ...(voice ? { voice } : {}),
        ...(teacher.clips ? { video: { states: teacher.clips } } : {}),
        clientTools: true, // without this grant her worker never exposes tool registration
        maxSeconds: MAX_SECONDS,
        metadata: { surface: "math-studio", teacher: teacher.slug,
                    voicePreset: voiceName ?? "none" },
      });

      if (isQueued(call)) {
        return void json(res, 429, { queued: true, position: call.position, retryAfterMs: call.retryAfterMs });
      }
      for (const [id, s] of started) if (s.staleAtMs <= Date.now()) started.delete(id);
      started.set(call.sessionId, {
        pool: typeof call.raw.capacity_pool === "string" ? call.raw.capacity_pool : undefined,
        staleAtMs: Date.now() + MAX_SECONDS * 1000 + STARTED_SLACK_MS,
      });
      // The grant is relayed byte-for-byte; our own metadata rides in sibling fields the page
      // strips before handing it to the SDK. `briefChars` is here so the trace rail can show how
      // close the composed brief is to the 4000-character ceiling.
      return void json(res, 200, {
        grant: call.raw, teacher: teacher.slug,
        briefChars: instructions.length,
        voice: voiceName
          ? `${voiceName} (${voice.provider}${lab ? ", lab" : ""})`
          : "platform default — nothing pinned",
      });
    }

    if (req.method === "POST" && path === "/api/end") {
      const { session_id: sessionId } = await readJson(req);
      const minted = typeof sessionId === "string" ? started.get(sessionId) : undefined;
      if (minted) {
        started.delete(sessionId);
        await rta.endCall(sessionId, { reason: "page_hide", capacityPool: minted.pool });
      }
      return void json(res, 200, { ok: true }); // idempotent, and tells an unknown id nothing
    }

    if (req.method === "GET" && path === "/api/spend") {
      const page = await rta.listSessions({ limit: 50 });
      const mine = page.sessions.filter((s) => s.metadata?.surface === "math-studio");
      return void json(res, 200, {
        calls: mine.length,
        seconds: Math.round(mine.reduce((a, s) => a + (s.activeSeconds ?? 0), 0)),
        credits: Math.round(mine.reduce((a, s) => a + (s.billedCreditMicros ?? 0), 0) / 1_000_000),
      });
    }

    if (req.method === "GET" && path === "/api/budget") {
      const b = await rta.creditBalance();
      const secondsLeft = Math.floor(b.availableCreditMicros / 1_000_000);
      return void json(res, 200, { secondsLeft, enough: secondsLeft > MAX_SECONDS });
    }

    if (req.method === "GET" && path === "/api/teachers") {
      /* Only what the page draws with — and the face is not in here, it is a URL the page builds
         from the slug. The persona is her brief and the avatar id is a capability; neither has
         any business in a response a browser can read. */
      return void json(res, 200, Object.values(TEACHERS).map(
        ({ slug, name, blurb }) => ({ slug, name, blurb })));
    }

    /** The voice registry, so the lab can offer exactly what is configured and nothing else. */
    if (req.method === "GET" && path === "/api/voices") {
      return void json(res, 200, listPresets());
    }

    /**
     * Her face for the window before there is a video track.
     *
     * The platform's avatar record carries no portrait — `{id, displayName, sourceKind, status,
     * defaultVoiceId}` — so a face is a file that ships beside the cast that names it, and only
     * ever matches the cast that named it. Hence the fallback: `characters/<slug>.webp` if it is
     * there, a monogram drawn from the name and `hue` if it is not, so somebody running this on
     * their own three avatars gets three distinguishable faces rather than three broken images.
     */
    if (req.method === "GET" && path.startsWith("/portrait/")) {
      const slug = path.slice("/portrait/".length).replace(/[^a-z0-9-]/gi, "");
      const teacher = TEACHERS[slug];
      if (!teacher) return void json(res, 404, { error: "no_such_teacher" });
      const cache = { "cache-control": "max-age=3600" };
      try {
        const webp = await readFile(new URL(`./characters/${slug}.webp`, import.meta.url));
        return void res.writeHead(200, { ...cache, "content-type": "image/webp" }).end(webp);
      } catch {
        return void res.writeHead(200, { ...cache, "content-type": "image/svg+xml; charset=utf-8" })
          .end(monogram(teacher));
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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

// A composed brief that overruns 4000 characters is rejected at mint time, which surfaces as a
// generic 422 well after the interesting part of the stack. Cheaper to find out at boot — and
// the persona line makes the longest character, not the average one, the one that matters.
const LONGEST_PERSONA = Math.max(0, ...CAST.map((c) => c.persona.length));
const LONGEST_BRIEF = BASE.length + LONGEST_PERSONA + 2;
if (LONGEST_BRIEF > 4000) {
  console.error(`composed brief is ${LONGEST_BRIEF} chars, over the 4000 limit`);
  process.exit(1);
}
console.log(`  brief ${String(LONGEST_BRIEF).padStart(4)} / 4000 chars`);
/* Say plainly, every boot, what will be sent — and what will deliberately NOT be. */
console.log("  cast:");
for (const c of Object.values(TEACHERS)) console.log(`    ${c.slug.padEnd(7)} ${c.name} · ${c.avatarId}`);
console.log("  voices:");
for (const c of Object.values(TEACHERS)) {
  const spec = VOICE_PRESETS[c.voice], ph = placeholders(spec);
  const why = ph.length ? `placeholder in ${ph.join(",")}`
            : VOICE_UNVERIFIED.has(c.voice) ? "unverified by ear" : null;
  console.log(`    ${c.slug.padEnd(7)} ${c.voice} (${spec.provider})  `
    + (why ? `NOT SENT — ${why}` : "✓ sent"));
}
/* A character with no voice pinned is not a neutral default — the platform picks, it reads
   neither the face nor the persona, and it has been landing MALE on a brief that says "a woman".
   So the absence gets the same billing at boot as a failure would. */
for (const c of Object.values(TEACHERS)) {
  if (presetNameFor(c.slug)) continue;
  console.log(`    → ${c.name} has NO VOICE PINNED, so the platform picks one and her gender is a`);
  console.log("      coin toss on every call. Put a Fish model id — the `modelId` in the fish.audio");
  console.log("      URL — in her preset, hear it in the lab picker, then take that preset's name");
  console.log("      out of VOICE_UNVERIFIED. Cartesia specs do not start the worker on this key.");
}
await syncClips();
server.listen(PORT, () => console.log(`studio is open -> http://localhost:${PORT}`));
