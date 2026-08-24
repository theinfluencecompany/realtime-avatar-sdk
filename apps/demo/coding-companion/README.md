# Coding companion

**What this shows:** a Lovable-shaped app builder you talk to. She is the conversation, a
cheaper model is the builder, and she drives it through the client tool plane: `build_app`
starts a build, `check_app` is how she learns what it did, `publish_app` puts it on a public
URL. What gets built is one standalone HTML document — it renders in a sandboxed iframe beside
her, and it ships to Cloudflare Workers as the same bytes.

## Setup

From the repo root, once, so the published SDK this example imports is present and built:

```bash
npm install && npm run build
```

Then, in this folder:

```bash
cp .env.example .env      # REALTIME_AVATAR_API_KEY + OPENAI_API_KEY; AVATAR_ID is optional
node --env-file=.env server.mjs
```

Open <http://localhost:4192>, press **Call**, and say *"build me a pomodoro timer"*. The
document streams into the Code tab, renders in Preview, and lands as **v1**. Then say *"make
the ring thicker and add a long-break mode"* — v2 is edited from v1, not written from nothing.
Say *"go back to the first one"* and she restores it.

**Publishing is optional.** Leave `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` unset and
everything above works with no share link. Set both and a **Publish** button appears, along
with a tool she can call when you ask her to ship it. `.env.example` says how to mint the
token and what it can do — read that paragraph before you set it, because publishing puts
model-generated HTML on a public URL under a subdomain you own.

## The layout

The left rail is her, the conversation, and the box you type in. The right pane is the app.
The transcript is open by default — what she says while she builds is worth watching, and a
panel you have to discover is a panel nobody reads — but it collapses, because the app is the
output and sometimes it should have the room.

## What to look at

- **The split.** The avatar platform never sees the build model, its key, or the document.
  Holding a conversation and writing an app are different jobs; paying conversation prices for
  both is how a demo becomes a bill.
- **"Never read code aloud"** is the load-bearing line in `instructions`. Without it she
  narrates div structure, and a character spelling out a class name is unlistenable. The panel
  is where the app goes; her job is the one sentence next to it. The same line now covers the
  published URL — she says it is live and points at the link rather than reciting it.
- **"Never build something they did not ask for"** is the other one, and it was missing.
  Briefed to be "a senior engineer building a web app out loud", she opens the call *mid
  project*: on a silent line, before a word was said, "I've been staring at that navigation
  bar and I think we should swap it for a sidebar" — and then she CALLS `build_app` on it.
  Measured: **three invented builds in four minutes of silence**, each narrated as though it
  had been requested. No tool description prevents this, because from the model's side
  inventing the request and carrying it out are the same move. It has to be forbidden in the
  brief, and the state she is wrong about — nothing is built, you have no history with this
  person — has to be *stated* rather than implied by a verb like "extend".
- **A build already running is superseded, not refused.** `build_app` used to answer
  `{status:'busy'}`, which is the right trade when every build is one the user asked for. It
  stops being right the moment a build can be one *she* started: an invented build takes tens
  of seconds, and a real request arriving inside that window got "busy" and never reached the
  build engine at all. She then says a build is running — true, about a page nobody asked
  for. Now the later request wins and the superseded stream is aborted, so it also stops
  costing tokens it can no longer spend. `runBuild` re-checks `job === j` after every await,
  or a superseded build's version lands on top of the newer one.
- **Her tools are armed BEFORE the microphone is asked for.** `setMicrophoneEnabled` is a
  permission prompt, and a permission prompt is a human deciding — this page waits up to
  fifteen seconds for one. She starts talking the moment she connects, so every second spent
  waiting on the mic first is a second she can call a tool that is not armed yet, and the
  failure is silent on both sides: she gets an error the user never hears, and the panel
  stays empty while she talks.
- **A `ready`, video-sourced avatar can still publish a black track, and the page checks.**
  `AGENTS.md` rule 3 blames a still-image source for this; that is not the whole story. An
  avatar reporting `status: "ready"` and `sourceKind: "video"` was measured publishing a track
  that was live, decoding, and advancing — `readyState` 4, `videoWidth` 700, `paused` false —
  with every pixel of every frame at zero. The **same avatar id rendered normally on a later
  call**, so it is intermittent, which makes it worse: you cannot clear it by checking the
  avatar once. Nothing in the API reports it, so a 32×32 sample once a second turns a mystery
  black rectangle into a sentence naming the cause. It stops the moment it sees a picture —
  its job is to catch a track that is black for the whole call, and a GPU readback every
  second after that buys nothing. **Do not use `sourceKind` as the test; look at the pixels.**
- **The picture can also just stop, and nothing fires.** Not black — *frozen*. `readyState`
  stays 4, `paused` stays false, the `MediaStreamTrack` stays `live` and unmuted, and
  `TrackUnsubscribed` does not fire. Measured when a call reached its `maxSeconds` cap: the
  decoded-frame counter stopped dead at 7457 and the page went on saying "connected — say
  what you want to build" until the tab was closed. The one-shot black check retires after
  the first good frame, so after second one nothing was watching at all. So the picture is
  now watched for the whole call, and the two checks retire differently on purpose: black
  reads pixels and stops once it sees any, stall reads a frame *counter*, costs nothing, and
  therefore never stops. Four seconds of a still counter says so in the status line and the
  element is left alone — the frozen frame is still her, and blanking it throws away the only
  thing on screen.
- **The call has a hard cap and hitting it does not look like an ending.** It looks like the
  bug above. The grant carries `max_session_seconds`, so the page counts it down in the
  corner of the stage for the whole call: the freeze then arrives already explained, and the
  page hangs up itself instead of waiting to be told about an ending it could predict to the
  second. The grant's number is used rather than the one this server asked for — the grant is
  what will actually be enforced.
- **A call whose renderer never joined looks exactly like a call that has not started.**
  Connected, talking, tools armed, audio fine, and no video track at all — measured
  repeatedly on two different `ready`, video-sourced avatars, and it cleared on its own once
  the render pool had room. Nothing reports it. The page waits twelve seconds and then says
  **who is in the room and what they published** — `room holds: agent-AJ_QapDdftf7UU8[audio]`
  — because the two causes want different people: a room with no agent in it is capacity or
  dispatch, and an agent that joined and published only audio is the renderer.
- **`height: 100%` on the video silently became `auto`.** The stage sizes itself with
  `aspect-ratio`, which makes a percentage height on its child cyclic — so the video fell back
  to its intrinsic 1:1 and rendered 353×353 inside a 242px-tall box, overflowing by 111px and
  being clipped by the rounded corner on every frame. It is absolutely positioned to `inset: 0`
  instead, which has no such cycle.
- **The streaming panel appends; it never re-sets.** Three costs hide in one line, and each
  fix only removes one. Painting per *chunk* read `scrollHeight` back after every delta — a
  forced synchronous layout on a growing, wrapping `<pre>`, about 1200 of them; throttling to
  once a frame took a build from 2762ms of main thread to 716ms. What survived is that
  `textContent = doc` **replaces** the text node, so the engine re-shapes all N characters
  from scratch on every repaint — O(n × repaints), and invisible as a long task because it is
  not one long task but a thousand medium ones landing on whatever you were typing. And a
  frame is the wrong cadence anyway: gpt-4.1 takes about half a minute over 14 KB, so once a
  frame is ~1500 repaints to show ~500 bytes a second, most of them adding eight characters.
  Measured in this page on a 14 KB document of distinct lines — repeated lines cache their
  shaping and flatter every option equally:

  | strategy | main thread |
  | --- | --- |
  | replace, 1500 repaints | 772ms |
  | append, 1500 repaints | 250ms |
  | append, 300 repaints (12Hz) | **49ms** |

  End to end, on a live call with video running and one 14 KB build, that is **3723ms of
  renderer main thread over 45s down to 1118ms** — `performLayout` 442ms → 35ms, accessibility
  tree 437ms → 50ms, `Paint` 351ms → 42ms, and text shaping out of the top twenty entirely.
  **It is not WebRTC.** An idle call costs 1.8% of the renderer main thread and 5.4% of the
  GPU thread; the preview iframe's own layout was 2.8ms against the page's 1184ms. If this
  demo feels slow, the pane streaming the code is why.

- **A build that produces nothing says so.** `writeDoc` used to return `""` for every
  failure — a refused request, an unreachable server, an empty answer — leaving an empty
  panel and no account of itself. That reads as the model having nothing to say rather than as
  an error. It now returns the status and the server's own message, and the panel shows it.
- **The page checks it is not newer than its server.** `index.html` is read from disk on every
  request, so a server left running across an edit serves a NEW page on OLD routes. Builds
  then fail on a field the old handler never reads, and the only symptom is a panel that never
  fills. A failed `/api/config` is that signal, and the page says so in the status line.
- **`aspect-ratio` can run backwards and take the width with it.** The stage is a stretching
  flex item, so its width looked settled — but once `max-height` clamps the height, an engine
  is free to derive the *width* from that clamped height instead of stretching it. Measured
  with stretch disabled: the stage collapsed to 194px beside 355px panels, leaving a strip of
  dead rail next to it. Which way a browser resolves this varies by version, so `width: 100%`
  is stated outright rather than inferred.
- **The transcript is not a `<details>`.** It looks like the element for the job, and it
  quietly breaks the layout: Chrome renders `<details>` content inside a `::details-content`
  box, so a child's `flex: 1 1 0` applies to nothing. The log took its content height, spilled
  past its own border, and would not scroll — with `overflow: hidden` on the parent hiding the
  evidence. Styling `::details-content` fixes it in Chrome 131+ and nowhere else, so it is a
  plain container with a `<button>`, which behaves the same everywhere and keeps the keyboard
  affordance `<summary>` was providing.
- **`flex: 1 1 auto` on the transcript made the avatar shrink when she talked.** With `auto`
  the thread's own content is its flex base, so each transcription that landed grew the log,
  grew the thread, and took the space out of the stage above it. Measured: 25 lines walked the
  stage from 242px down to its 130px floor through **eleven** distinct heights — eleven
  relayouts, each resizing a *playing* video element inside a clipped, rounded container. That
  is what "flickery and slow while typing" is. `flex: 1 1 0` fixes it: same 25 lines, one
  height, zero resizes.
- **`TrackUnsubscribed` is handled.** A track can end without the call ending. Unhandled, the
  element keeps the dead stream and the stage stays a black rectangle still claiming to be her
   — indistinguishable from a picture that merely went dark. It is the *clean* way to lose the
  picture, and the rarer one; the track going quiet while staying `live` fires nothing at all,
  which is what the stall check above is for. `Reconnecting` and `Reconnected` are handled for
  the same reason — a reconnect freezes the picture for as long as it takes, and a page that
  says nothing there trains you to reload a call that was coming back.
- **Her audio elements are not appended to `<body>`.** `body` is the page's two-column grid;
  media elements appended to it become grid items. They go in a dedicated hidden container and
  are removed when the call ends.
- **The preview is `sandbox="allow-scripts"` and nothing else.** Adding `allow-same-origin`
  beside it is not a smaller restriction, it is no sandbox at all: a `srcdoc` frame with both
  runs on this document's origin and can reach straight into `parent`. Everything awkward below
  follows from refusing that one attribute.
- **An opaque origin makes `localStorage` *throw*, not return null.** A model asked for a todo
  list reaches for it every time, and the whole page dies on line one. The preview preamble
  installs an in-memory stand-in, and the build prompt tells the model to keep state in memory
  anyway — so the preview behaves like the published page instead of being laxer than it.
- **The frame is identified by `event.source`, never by `event.origin`.** Its origin is the
  string `"null"` — that is what opaque means. Filtering on origin here either rejects every
  message or accepts every sender.
- **The preamble goes *inside* the document, after `<head>`.** Prepending it would push the
  doctype out of first position and drop the frame into quirks mode, so the preview would lay
  out differently from the published page — the one thing a preview may not do.
- **The preview is instrumented; the published page is not.** A page that throws on line 40
  still renders the first 39, so "did it work" cannot be read off the frame — the frame has to
  say so. Those reports drive one repair round and reach her through `check_app`. What goes on
  the public URL is the document the model wrote, byte for byte.
- **One repair round, not three.** A page that renders is already on screen and already
  useful; a second repair mostly spends money re-deciding a layout the user can see. That is
  the opposite trade from a program whose only output was its exit state.
- **Receipt + poll, twice.** A tool call is abandoned after 2.5 seconds. A build is tens of
  seconds and a publish is about ten, so neither can return its result: both hand back
  `{status:"started"}` and keep their real promise on the panel. She is told never to announce
  an outcome `check_app` has not given her — a build she started reads, to a language model, a
  lot like a build that worked.
- **The server owns the script name.** `/api/publish` takes a `session_id` and looks it up in
  the map of calls this process minted; the Worker name comes off that entry. A route that
  took a name from the request body would let any visitor overwrite any Worker on the account,
  which is not a demo bug — it is someone's production outage. Same shape as `/api/end`, which
  has always refused to hang up a call it did not start.
- **`/api/end` marks the entry, it does not delete it.** That entry is also what
  `/api/publish` looks a script name up in, and hanging up does not delete what you built — a
  page you can still see is a page you should still be able to ship. The `ended` flag is what
  makes ending idempotent, and `staleAtMs` sweeps the entry either way.
- **One script per session, not per build.** Publishing five times updates one site at one
  URL. A demo that mints a script per build quietly fills a dashboard.
- **A successful deploy serves a 404.** The upload returns success, the workers.dev route
  returns success, and then the URL 404s for about six seconds — sometimes zero, so you will
  not see it in testing and your users will. The server polls until it serves before it hands
  the address back, or she announces a live site that isn't.
- **workers.dev sits behind bot protection.** It answers `403` to some default user agents —
  `Python-urllib` is one, measured. The poll sends an explicit `User-Agent`, because a poll
  that reads a 403 as "not ready yet" gives up on a site that is already live.
- **The browser sends strings, not turns.** `/api/code` takes a request, the current document
  and an error blob — there is no field with a `role` on it, so a `system` turn cannot be
  smuggled in beside the build engine's own prompt. The earlier version of this app filtered
  them out; not having somewhere to put one is better than filtering.
- **The current document is the whole history.** The artifact is the state, so there is no
  growing transcript of 20 KB documents to truncate — which is what a naive message array does
  here, silently, right at the point where the model needs the file most.
- **She decides when to build.** There is no keyword router in the page: a request reaches her
  as a normal turn, and calling `build_app` is her model's decision. The server's whole part in
  that is one field on the mint, `clientTools: true`; without the grant, registration fails and
  not one tool is reachable.
- **A tool that cannot work is not registered.** With no Cloudflare credentials, `publish_app`
  is absent from the tool plane *and* from her brief. Shipping it anyway means she offers it,
  fails, apologises, and tries again.
- **`sentByUs`.** Turns the page sends come back as transcriptions of ourselves. They are
  logged at the keystroke, so the echo is skipped — without that, every typed turn appears in
  the log twice.
- **`mode: "avatar"`** picks the renderer, not the turn-taking. She is listening the whole time
  she speaks either way, so you can cut her off mid-sentence — which is what makes a tool that
  takes seconds to answer bearable. Drop `mode` to save the GPU and lose the video.
- **`AVATAR_ID`** is read first so a host platform can launch this with an avatar the user
  chose. With nothing set, the app picks the first `ready` avatar whose `sourceKind` is
  `video` — an image-sourced avatar reaches `ready` and then publishes an all-black track.

## Cost

Three meters. The call bills by the second while it is live (under $5/hour) and is capped at
`MAX_CALL_SECONDS` (300 by default). Every build **and its repair round** is a separate
completion on your `OPENAI_API_KEY`. Publishing is free on any Cloudflare plan that includes
Workers, but the scripts persist until you remove them — they are all named
`rta-studio-<8 hex>`, so that prefix is the whole cleanup list.

A call that is never joined still holds its slot until the join timeout notices, so the page
says goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with `endCall`
— the slot frees the moment the user leaves, even if the tab closes before the room exists.
**Hang up beacons it too.** Leaving the room does free the slot on its own, but only once the
platform notices the participant has gone — measured at about eight seconds, on a meter that
bills by the second. The server keeps the ids it minted and only ends those, so the route
cannot be used to hang up
someone else's call.
