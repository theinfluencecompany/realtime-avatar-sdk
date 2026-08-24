# AGENTS.md — building with Realtime Avatar

You are a coding agent. This file is the contract for using this SDK correctly. Read it
before writing code; it is short because the surface is small.

`CLAUDE.md` is a symlink to this file. Codex, Claude Code, Cursor and Copilot all read it.

---

## What this is

A live character your users can talk to — voice, or voice and video. You start a call from
your **server**, and your **client** joins it and renders her.

```
your client  ──▶  your backend  ──▶  Realtime Avatar
                  (holds the key,      (capacity, listening,
                   decides the call)    thinking, speaking, rendering)
     ◀────────── live audio + video, and she is listening ──────────
```

Two facts that shape every integration:

1. **The API key is server-only.** A browser holding it can start unlimited calls on the
   account. `new RealtimeAvatar()` throws in a browser runtime to make that fail loudly.
2. **The connection payload is opaque.** Relay it to the client byte-for-byte.

---

## The 30-second version

```ts
import { RealtimeAvatar, isQueued } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

const call = await rta.startCall({
  avatarId: "ava_…",
  instructions: "You are Rin. Short, warm, specific sentences.",
  maxSeconds: 600,
});

if (isQueued(call)) return { queued: true, position: call.position };
return call.raw;          // ← relay THIS to the browser, untouched
```

---

## Rules that are not negotiable

These are the ones that cost real time when broken. Each has been observed, not theorised.

### 1. Never accept call policy from the client

`instructions`, `context`, `maxSeconds`, `voice`, `video` are **your server's decisions**.
A request body that supplies them is a request body that owns your character and your bill.

```ts
// ✗ WRONG — the caller now writes your system prompt and sets their own time limit
const call = await rta.startCall({ avatarId, ...req.body });

// ✓ RIGHT — the client picks WHO to call; you decide everything about the call
const character = await db.character(req.body.avatarId);
const call = await rta.startCall({
  avatarId: character.avatarId,
  instructions: character.prompt,
  maxSeconds: secondsTheBalanceAffords(user),
});
```

`maxSeconds` is the one to get right on day one — it is what stops a call the balance cannot
cover.

### 2. Relay `call.raw`, not a reshaped object

```ts
return call.raw;                     // ✓
return { ...call.raw, mine: 1 };     // ✗ throws in the browser SDK
return { data: call.raw };           // ✗ same
```

The browser SDK validates strictly and throws
`RealtimeAvatarValidationError: LiveKit session grant did not match the SDK contract`. If you
need to send your own data alongside, put it in a sibling field the client unwraps *before*
handing the payload to the SDK.

### 3. Use a video source for any avatar that will be called live

An avatar built from a still image reaches `ready`, starts calls, and publishes a **black
video track**. Nothing in the API tells you — the status is `ready` and the track has
plausible dimensions. Only the pixels are wrong.

```ts
await rta.createAvatarFromVideo({ displayName: "Rin", videoUrl: "https://…/idle.mp4" });
```

If you are checking this yourself: read a frame onto a canvas and look at the mean. Track
size proves nothing.

**Frame the source tight on the face.** A video-sourced avatar shot as a medium — a presenter
standing in a dressed set, face a sixth of the frame — preprocesses, reports `ready`, and mints
calls; then **the render worker never joins the room**. There is no error and no failed status,
just a call that connects to nobody, so the tools never register and the page can only report a
timeout. The same footage re-cropped to head-and-shoulders works first time. Aspect ratio is not
the variable — 1:1 and 9:16 both work — and the renderer crops to the face regardless, so frame
for a close-up rather than for a set.

### 4. Every call is full duplex; `mode` only picks the renderer

She listens the whole time she speaks, so a user can cut her off mid-sentence. That is true
of **both** modes — it is not a setting. `mode` chooses whether you also get a video track.

```ts
await rta.startCall({ avatarId });                    // video + audio, full duplex (default)
await rta.startCall({ avatarId, mode: "avatar" });    // the same thing, said explicitly
await rta.startCall({ avatarId, mode: "voice" });     // audio only, cheaper — still full duplex
```

There is no `duplex` option, and passing one is a type error. Until 2026-08 this SDK had one,
and `{ mode: "avatar", duplex: "full" }` silently rewrote `mode` to `"voice"`, because full
duplex was then served by a separate audio-only path. Both modes are full duplex now, so the
trade-off it forced no longer exists. If you wrote code around it, delete the workaround.

If you are drawing your own visuals on `mode: "voice"`, render from the audio level.

### 5. The browser half is not free: the mic can fail six ways, and none of them throw where you are looking

`await room.localParticipant.setMicrophoneEnabled(true)` is one line, so it gets written with
no catch — and its failure is then INVISIBLE. The call is already connected, the page is
mid-`await`, and the rejection becomes an unhandled promise nobody is watching. What gets
reported back is one sentence, "the mic won't start", covering causes with different fixes.

```ts
import { enableMicrophone, attachRemoteAudio } from "realtime-avatar-browser";

const audio = attachRemoteAudio(room, {                 // BEFORE connect — see below
  onPlaybackBlocked: (unblock) => { btn.hidden = unblock === null; btn.onclick = () => unblock?.(); },
});
await room.connect(grant.livekit_url, grant.participant_token);
const mic = await enableMicrophone(room);
if (!mic.ok) show(mic.message, mic.hint);               // never throws; the cause is a value
```

The four that are expensive to guess:

- **A macOS denial is not a browser denial.** Chromium reports both as `NotAllowedError`, but
  `"Permission denied by system"` means System Settings > Privacy & Security > Microphone, and
  the browser must then be **restarted**. Telling that user to click the address bar is a dead
  end, and it is the most common wrong answer to this failure.
- **A prompt that is never answered may never settle.** Per spec `getUserMedia` can "neither
  resolve nor reject". Awaited in a connect path that is a permanent hang with no error —
  always race it against a deadline.
- **Attach remote audio INTO the DOM, before `connect`.** `track.attach()` returns a detached
  element; left out of the document there is nothing to play and nothing to click. Subscribing
  after `connect` also loses tracks that arrive during it — a race that only shows on a fast
  connection, and it presents as a silent call rather than an error.
- **Autoplay is blocked until a gesture.** `room.startAudio()` clears it but must be called
  *from* the gesture, so the page has to know it is blocked in order to offer a button.
  `RoomEvent.AudioPlaybackStatusChanged` is that signal.

Mic capture needs a secure origin: https, or `http://localhost`. A LAN address over plain
HTTP leaves `navigator.mediaDevices` undefined, which surfaces as a `TypeError` naming a
property rather than the reason.

### 6. A tool has 2.5 seconds, and the abort is cooperative

The platform abandons a tool call after **2.5s** and tells her it failed. That is a
conversational floor, not a tunable: past a couple of seconds of dead air the call stops
feeling live.

So a tool that calls a model, or your database across a region, does not fit. Return
immediately and deliver the real answer another way:

```ts
// ✗ she waits, the deadline passes, and she apologises for a tool that then succeeds
execute: async ({ spec }) => await model.generate(spec),

// ✓ acknowledge inside the deadline, put the result on screen when it lands
execute: ({ spec }) => { void generateAndStream(spec); return "Working on it — watch the pane."; },
```

`AbortSignal` is passed to every tool, but the guarantee is **asymmetric**: a handler that
ignores it still runs to completion and can commit a side effect — only its *result* is
discarded. Make anything slow idempotent, or check `signal.aborted` before you write.

### 7. Transient failures are retried for you; `429` is not one of them

Every request carries a `User-Agent` and, if it mutates anything, an `Idempotency-Key` that is
**reused across retries** — so a 503 on a call that upstream actually started replays the
original result instead of billing you twice. Two extra attempts by default:

```ts
new RealtimeAvatar({ apiKey, maxRetries: 0, userAgent: "acme-web/2.1" });
```

`429` is deliberately **not** retried. On a call it is the queue, not a rate limit — retrying
would burn the backoff and hand you the same queued answer, having destroyed `isQueued()`.

What that is worth, measured against an upstream that fails the way that hurts — it starts the
session, *then* loses the response, so the call has already been charged for:

| Run | Config | Connected | Billed for 12 calls |
| --- | --- | --- | --- |
| Before | `maxRetries: 0` | 9/12 | 12 |
| Retry, no key | `maxRetries: 2`, key ignored | 12/12 | **17** |
| After | `maxRetries: 2`, key honoured | 12/12 | **12** |

No-retry is not no-charge: the first row bills 12 while connecting 9 — you pay for calls your
user never got. And retrying *without* an idempotency key is worse than not retrying: it buys
the missing calls back and overbills by ~40% doing it. The key is what makes the retry safe,
which is why every mutating request carries one and reuses it across attempts.

The numbers move run to run — the failure injection is random — but the ordering does not.

### 8. `creditBalance` is a balance, not a bill

To reconcile an invoice — or to re-bill your own users — you need per-session detail, and
that is `listSessions`. Billing is **per second**, and `activeSeconds` is the billable wall
time, not a rounded-up minute.

```ts
for await (const s of rta.iterateSessions({ from: "2026-08-01T00:00:00Z" })) {
  // s.startedAt / s.endedAt   — when your user was on the call
  // s.activeSeconds           — how long it was billable for
  // s.billedCreditMicros      — what it cost
  // s.metadata                — what YOU set on startCall, e.g. { userId }
}
```

**Attributing a session to one of your users is optional.** With no setup you get every
session with its times, duration and cost. If you also want to know *whose* session it was,
tag the call when you start it — use the key `user_id`, which is what `endUserId` filters on:

```ts
await rta.startCall({ avatarId, metadata: { user_id: user.id } });   // optional
// ...
await rta.listSessions({ endUserId: user.id });                       // just that user
```

Values are strings, at most 16 entries. Nothing degrades if you skip it.

Requires a key with the `usage:read` scope. The window defaults to the trailing 30 days and
is clamped to 90 — a wider range is served narrowed, not refused, so read back `page.from`
and `page.to` rather than assuming you got what you asked for.

### 9. `queued` is not an error

Every slot busy → `{ queued: true, position, retryAfterMs }`. Render the position and retry.
Showing a failure here is the most common bad first impression.

### 10. Sync clips after you change them

Clips are prepared once and cached by URL hash; the serve path only *loads* that cache. A
clip that was never prepared silently does nothing on the first call after you add it.

```ts
await rta.syncClips(avatarId, Object.values(states).map((s) => s.url));
```

Idempotent, so call it on every write.

### 11. Verify transcripts over the RAW bytes

Parsing and re-serializing changes the whitespace and the signature will never match.

```ts
const raw = Buffer.from(await request.arrayBuffer());
const transcript = await verifyTranscript(raw, request.headers, secret);
```

### 12. End a call the moment your user abandons it

The slot is held from the moment `startCall` returns — **including the window before the
client has joined the room**. A user who closes the tab right there leaves the call running
until the join timeout reclaims it (measured: over a minute of held slot for a page that
lived seconds). Give the page a same-origin route that ends the call, and hit it with
`navigator.sendBeacon` on `pagehide` — the one send that outlives a closing page:

```ts
// server — remember what YOU minted; only ever end those. A route that relays an
// arbitrary id from the request body lets any visitor hang up any call on your account.
started.set(call.sessionId, true);                                   // at mint time
if (started.delete(session_id)) await rta.endCall(session_id, { reason: "page_hide" });
```

```js
// page
addEventListener("pagehide", () => {
  if (sessionId) navigator.sendBeacon("/api/end", JSON.stringify({ session_id: sessionId }));
});
```

`endCall` is best-effort and idempotent: `true` when acknowledged, `false` for anything
else, never a throw. A beacon and a disconnect handler may both fire for the same call
without error, and a release that is lost is a slower release — the join timeout is the
backstop. Every app in `apps/demo/` carries the full pattern end to end.

---

## Deciding how she looks

`video` on a call. Three shapes, in increasing order of effort:

```ts
video: { loop: "https://…/idle.mp4" }        // one clip she rests in
video: { mode: "generative" }                 // no clips at all; synthesized
video: {                                      // a state map we switch between
  states: {
    happy:    { when: "when the user is happy",                    url: "…/happy.mp4" },
    thinking: { when: "when she is considering something",         url: "…/thinking.mp4" },
    shy:      { when: "when she is flustered", weight: 0.3,        url: "…/shy.mp4" },
  },
}
```

`when` is read **by the character**, not by a rules engine you write. Brief it like an actor.
`sentiment > 0.7` does nothing — nothing evaluates it.

### The one rule that decides whether multi-clip looks good

**Every clip must start and end on the same frame** — the same rest pose, the same position,
the same expression, the same lighting. Not "similar". The same.

This is what makes a switch a *splice* instead of a *jump*. Playback moves between clips at
whatever moment the conversation turns, so the last frame of the clip she is leaving lands
directly against the first frame of the clip she is entering. If those two frames match, the
cut is invisible. If they don't, every state change is a visible snap — and because the
switch is driven by conversation, it happens most often at exactly the moments a viewer is
paying closest attention.

The same rule applies *within* a clip: the last frame has to match its own first frame, or a
clip that repeats before a switch will hitch every time it wraps.

Practical version:

- **Shoot from and return to one neutral pose.** Start recording in it, do the motion, come
  back to it, stop recording. One rest pose across the whole set, not one per clip.
- **Hold still for a beat at both ends.** A held frame gives you something exact to cut on
  and hides small drift.
- **Lock the camera, the framing and the light.** A zoom, a re-frame, or a cloud moving
  across a window between takes will read as a jump even with a matched pose.
- **6–8 seconds each.** Three or four of them give ~30–50s of non-repeating motion.

If you have footage where the ends nearly match, trim to the matching frames rather than
using the whole take. A shorter clip that splices cleanly beats a longer one that snaps.

### You don't have to author any of this

Matched-endpoint clips are the highest-effort option, and they're optional. Two lower-effort
paths produce the loop for you:

```ts
video: { mode: "generative" }                 // no clips at all — motion is synthesized
video: { loop: "https://…/idle.mp4" }         // one clip she rests in
video: {}                                     // omit `loop` to use the avatar's stored source
```

The same applies at avatar creation: give a **single looping video** and the rest pose is
taken from it, or a **single still image** and the motion is generated around it. Either way
you get a usable resting loop without cutting anything by hand.

So treat the state map as an upgrade, not a prerequisite. Ship on `generative` or a single
loop, then author clips for the states that are actually worth directing — and only then does
the matched-frame rule apply to you.

---

## What is NOT here

Say so plainly rather than working around it:

- **No hosted tool execution.** The platform never runs your tools. They run in YOUR page —
  the client tool plane: `clientTools: true` at mint, `attachAvatarTools` in the browser —
  and a call has 2.5s to answer.
- **No Python SDK.** The live call is rendered by a browser or native client, so Python's
  half is plain HTTP — see `apps/quickstart/python-fastapi`.

---

## Errors worth branching on

```ts
import { RealtimeAvatarHttpError } from "realtime-avatar";

try {
  await rta.startCall({ avatarId, instructions, maxSeconds });
} catch (err) {
  if (err instanceof RealtimeAvatarHttpError && err.isBilling) {
    return paywall();                    // 402 insufficient_credits / spend_limit_exceeded
  }
  throw err;
}
```

| Status | Means | Do |
| --- | --- | --- |
| 401 | Bad/missing/revoked key | Check the bearer and the environment tag |
| 402 | Out of credits or over the key's spend limit | Paywall, not an error screen |
| 403 | Key lacks the scope | Mint a key with it; do not widen to `*` |
| 422 | Schema rejection | An unknown or mis-cased field — the wire is strict |
| 429 | Capacity full **or** rate limited | For a call, that is the queue: retry. Not auto-retried |
| 503 | Transient upstream | Retried for you, up to `maxRetries` |

---

## Working in this repo

```bash
npm install
npm run check          # typecheck + tests + build, all of it
```

Layout follows the fal-js convention — libraries in `libs/`, runnable demos in `apps/`:

```
libs/http-client  realtime-avatar            the server client, zero deps
libs/proxy        realtime-avatar-proxy      Next.js / Hono / Express adapters
libs/tools        realtime-avatar-tools      browser tool plane
libs/browser      realtime-avatar-browser    browser audio: mic + playback
libs/contracts    realtime-avatar-contracts  runtime schemas for the wire
libs/mcp          realtime-avatar-mcp        MCP server (not published)
libs/client       realtime-avatar-react      React facade (published)
apps/quickstart/* the smallest correct integration per stack
apps/demo/*       showcases — larger, read these second
```

> **Source of truth:** every `libs/` package is a scrubbed carry from an upstream source, not
> hand-authored here. An edit to `libs/*/src` will not survive the next sync — take the change
> upstream, or it lands twice and diverges.

- `libs/http-client/src/types.ts` is the whole public surface. Read it first.
- `libs/http-client/src/client.ts` owns the only camelCase → snake_case translation. Never add a
  second one — that is how a wire drifts.
- `libs/proxy` is the shortest correct way to mount a route: `authorize` gates, `session`
  decides. Prefer it over hand-rolling; the hand-rolled version is where policy leaks in.
- Example apps are standalone — no shared local imports, so one can be copied out and still
  run. `apps/README.md` says which tier a new one belongs in. There is no archive: a
  superseded example is deleted rather than parked, so everything under `apps/` is current.
- **Adding a schema field is a product decision, not a sync task.** The surface here is
  deliberately narrower than what the API can express — if a field is not in `libs/contracts`,
  a caller has no reason to set it. `npm run boundary` fails the build if an internal
  identifier reaches shipped output, sourcemaps included.

When you add a capability, add it to `src/types.ts` and `src/client.ts` **and** to the rules
above if it has a trap in it. A rule that is only in someone's head is not a rule.
