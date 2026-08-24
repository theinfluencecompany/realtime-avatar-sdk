# Math Studio

**What this shows:** the tool plane staying the same size as the app grows — she gets six generic
verbs, the things on screen register with a curriculum in the page, and adding one costs zero
tools and zero characters of her brief.

## Setup

From the repo root, once, so the published SDK this example imports is present and built:

```bash
npm install && npm run build
```

Then, in this folder:

```bash
cp .env.example .env      # add your key; the AVATAR_ID_* are optional
node --env-file=.env server.mjs
```

Open <http://localhost:4199>, pick a level, and press **Start the lesson**. She opens, sets a
task, and the workspace under her question is the thing you answer with.

Set `AVATAR_ID_LIN` / `AVATAR_ID_WANG` / `AVATAR_ID_WUKONG` to get all three characters in the
picker. Set none and it resolves a single avatar the way the other examples do, and the picker
collapses to one.

A character's face for the moment before her video track arrives is `characters/<slug>.webp`.
The avatar record carries no portrait, so that file is the only place one can come from — and
with no file for a slug, `/portrait/<slug>` draws a monogram from the name instead, which is
what a cast that is not this one will get.

## What to look at

- **Six verbs, and the list never grows.** `next_task` · `show` · `demonstrate` · `answer` ·
  `progress` · `celebrate`. None of them names a thing on screen. A tool per manipulative is the
  obvious design and it dies on arithmetic: `MAX_TOOLS` is 32, so at three actions apiece you
  fail to register at the eleventh. Long before that you run out of the thing that actually
  binds — `instructions` caps at 4,000 characters and every tool needs a sentence saying when to
  reach for it. When a new capability is needed, it goes on an existing verb as a parameter: that
  is what `next_task(want)` is, and it is why letting the conversation choose the topic cost no
  tool slot.
- **So the manipulatives register with the curriculum, not with the avatar.** Two plain objects
  in `index.html`: a plug point with five methods, and a level that names one by id. Adding a
  Bézier curve is a key in one table and an id in the other. `server.mjs` does not change and
  neither does her brief.
- **What she is looking at reaches her through the RESULT, not the tool name.** `demonstrate`
  tells the model less than `show_bezier_control_points` would; every result carries an `explain`
  field in the words she should use, which buys the difference back.
- **Every call is full duplex, and `mode` only picks the renderer.** Her microphone is open the
  whole time she is speaking, so a learner mid-drag can cut in and she stops — that is how calls
  work, not a setting to spend. So there is no trade here between her face and being able to
  interrupt her: the call is `mode: "avatar"` and the brief tells her plainly that they will cut
  in and that she should follow them when they do.
- **Her clips are synced at boot, not just declared.** Ms. Lin carries a four-state `video` map —
  idle, happy, gentle, cheer — and `when` on each one is read by *her*, so it is written as
  direction rather than as a rule an engine evaluates. Clips are prepared once and cached by URL
  hash and the serve path only loads that cache, so a map that was never synced is silently
  ignored on the first call after you add it. `syncClips` is idempotent, which is why it runs on
  every boot and not behind a flag.
- **All three voices are pinned, and each one was measured before it was.** With `voice` omitted
  the platform chooses, and it reads neither the face nor the persona — so a character's gender
  was a coin toss on every call, and it had been landing male on a brief that opens "a woman in
  her thirties … speak as a woman". Composing the persona first helps and does not settle it.
  A verified voice id settles it. Getting one accepted is harder than it looks:

  | `voice` sent | worker joins? | audio |
  | --- | --- | --- |
  | omitted | yes | speaks; gender is the platform's coin toss |
  | `{provider:"cartesia", voice_id:<real>}` | **no** | call dies at the 15s deadline |
  | `{provider:"cartesia", voice_id:<fake>}` | **no** | identical — so it is the integration, not the id |
  | `{provider:"fish", voice_id:<foreign>}` | yes | **silent** — `totalAudioEnergy` 9e-8, 11 kB of RTP in 90s |
  | `{provider:"fish", voice_id:<real>}` | yes | speaks — energy 1.09, 131 kB in 30s |

  Three ways to be wrong and only the first announces itself: a provider the wire refuses is a
  **422** at mint; a provider the key cannot reach never starts the worker; and a real-shaped id
  the engine cannot resolve gives you a call that joins, talks, fires tools and renders nothing.
  The two Fish rows are indistinguishable from the page — same 200, same worker, same transcripts
  — which is why `VOICE_UNVERIFIED` gates on the audio rather than the response code.

  What the audio said, from voiced frames off a live call through a YIN pitch estimator (male
  speech ≈ 85–155 Hz, female ≈ 165–255 Hz):

  | preset | voiced | median F0 | p10–p90 | verdict |
  | --- | --- | --- | --- | --- |
  | `lin-warm-female` | 147 | 193 Hz | 151–255 | female |
  | `wang-brisk-male` | 78 | 99 Hz | 86–128 | male |
  | `wukong-playful` | 122 | 158 Hz | 104–249 | does not classify |

  The Monkey King straddling the boundary is a real result, not a broken one — a playful young
  character voice has range, and his sits across the line rather than on one side. What the
  measurement does establish for him is the thing the gate is for: he renders audio, not silence.
  Whether he sounds right for the part is a casting question and belongs to whoever picked the id.
- **Where a Fish voice id comes from.** Fish calls a voice a *model* and never shows a field named
  `voice_id`; the id is in the address bar. Open the voice and read `modelId` out of the URL —
  `https://fish.audio/app/text-to-speech/?modelId=933563129e564b19a115bedd57b7406a` — and that hex
  string is what `voice_id` takes. The display name beside it is a label and is accepted nowhere.
- **`provider` accepts three values, and the contracts package lists four.** The mint answers
  `provider: "qwen"` with `422 Invalid discriminator value. Expected 'cartesia' | 'breezeblue' |
  'fish'`, but `libs/contracts` still carries `qwenVoiceSpecSchema` in the union — so a spec that
  typechecks can still be refused on the wire. This demo's three presets used to be `qwen`, which
  meant the whole registry was a 422 waiting to happen and only the unverified gate hid it. The
  boot-time validator here mirrors what the wire actually takes, not what the schema says.
- **Two channels page → agent, and the question is which one has earned the floor.** A line on the
  `lk.chat` topic — `room.localParticipant.sendText(text, { topic: "lk.chat" })` — arrives as a turn,
  so it interrupts her mid-word and she answers it. That is what the box under the board sends, because a
  learner who is lost three seconds into an explanation should not have to wait out the other
  twenty. Most of the workspace deliberately does **not** use it: a drag emits an event per unit of travel
  and the Fourier mixer emitted fifteen in four seconds, which as turns is fifteen interruptions and
  a teacher who never finishes a sentence. Those ride home in `since_last_call` on her next tool
  call instead, gated so she is never handed a hand that is still moving.
- **Except finishing, which does earn it.** Everything ambient waits for her to ask, and her brief has
  her asking every eight to ten seconds. For "what have they been up to" that is fine; for "they
  have just solved it" it is not — the learner sits in front of a finished screen while the teacher
  talks about something else, and what that feels like is a teacher who is not watching. So the page
  detects the landing and pushes one line on `lk.chat`, prefixed `WORKSPACE:` so she knows it is the
  screen and not the learner. Three rules make it safe to interrupt her with:
  - **Correct only.** A learner sweeping the radius round to `sin θ = 0.5` pauses at 0.3 on the way,
    and a detector that fired on any settled value hands her a wrong answer to mark out of a gesture
    that was not finished. Landing on the right answer is unambiguous — it is the end of the task. A
    wrong one still reaches her on the next check, exactly as before.
  - **Settled for 650ms**, not the 1.8s the ambient queue waits: long enough to rule out passing
    through the answer mid-drag, short enough that the praise still belongs to what they just did.
  - **Marked once.** The push tells her to call `answer`, so `answer` refuses a second correct mark
    on the same task — otherwise one finish is two questions off a run of ten.

  A manipulative can also tag any single event `tell` to be pushed the same way, which is how
  completing a Pythagoras rearrangement gets a word even though its answer comes off the keypad.
- **The conversation steers the course — as a parameter, not a seventh tool.** `next_task` takes an
  optional `want`: the learner's own words, relayed by her, not interpreted by her. She has the
  conversation and the page has the curriculum, so the page stays the authority on what is next.
  Matching is data like everything else here — a level declares `aliases` for "move me to this
  level" and `hints` for "this level can do that itself", and the resolver knows what a sawtooth is
  only because the table says so. Three things it has to get right:
  - *"five circles"* on the Fourier level must not become Circle to sine. A level's own `hints` are
    checked **before** every other level's name, because what a level can do for itself outranks
    what another level is called.
  - *"this is too hard"* contains the word *hard*. The two complaints are matched before the two
    adjectives, or every one of them moves the learner the wrong way.
  - A difficulty word is **spent** on the move. Passing "harder" to the new level's `gen` as well
    makes its task harder too, so one request lands twice and the jump is double what was asked for.

  A phrase that names nothing changes nothing and the result says so, so she can tell them the
  course has no dinosaurs rather than inventing some.
- **A level with one question in it is a level you do it once.** The Fourier series used to build
  the same square wave every time, with the harmonics, the amplitudes and the pass mark baked into
  the manipulative. They come off the task now, and the level holds a bank of four waves — square,
  sawtooth, pulse, and the square wave with a fifth circle — which vary the harmonic set, the number
  of sliders, the rule and the mark. The plugin draws a chain of circles and does not know what a
  square wave is. Two things the bank has to respect:
  - **The pass mark is per wave**, because they do not converge at the same rate. A square wave with
    three of its four circles right is still only 87% matched, so 88 forces all four; a pulse with
    three of four is 50%, and 90 is the same demand. Triangle waves are absent for exactly this
    reason — the fundamental alone already scores 88, so every slider after the first is decoration.
  - **The slider range is a way to leak the answer.** It used to be `1.35/k` against a target of
    `1/k`, so every target sat at 74% of its own slider and "drag them all three quarters up" solved
    the level without a thought. `1.2/√k` is still a statement about harmonics rather than about
    this task's answer, and the targets land at four different fractions.
- **The learner is on `TranscriptionReceived` too.** Their speech, and the echo of anything they
  type, arrive on the same event her captions do and nothing in the segment says which is which —
  only the participant identity does. Filtered on it, or the caption under her face shows the
  learner their own sentence with her name on it, and the "she is about to speak" latch trips on a
  line she never said.
- **The microphone reports a cause, not a failure.** Both the self-test and the in-call publish go
  through `enableMicrophone` from `realtime-avatar-browser`, so the panel says
  `denied-by-os` or `no-answer` or `device-in-use` rather than "failed", and the drawer carries the
  sentence naming the fix. Two of those are why it is worth the import: a macOS denial and a
  browser denial are the same `NotAllowedError` with completely different fixes, and an unanswered
  prompt may never settle at all — awaited without a deadline it hangs the connect path with
  nothing on screen.
- **The call uses the device the picker picked.** `setMicrophoneEnabled(true)` on its own takes the
  OS default input, which is not what the drawer is pointing at and not what the self-test proved.
  On a Mac with an iPhone paired that gap is the whole bug: the picker avoids Continuity
  deliberately, the OS default *is* Continuity, and the call then publishes a track that is live,
  plausible and silent — a mic test that passes and a lesson where she never hears a word.
- **Tools register before the microphone is asked for.** Her brief tells her to open the moment the
  call connects, so she is already reaching for `next_task` by the time `connect` returns. A
  permission prompt is a human deciding and can hold that await for fifteen seconds; anything
  waited on before the manifest is registered is time she spends calling tools that are not there,
  and from the outside that is a workspace that stays empty while she talks — which reads as a hung
  page rather than a race.
- **A page that fails to boot says so.** Everything is one `<script type="module">`, and a module
  that throws while evaluating takes every handler after it with it: the markup still renders, so
  you get a finished-looking page with a green button that does nothing. A classic script before it
  listens for `error` and `unhandledrejection` and writes the reason into the caption.

## What it does not show

The curriculum here is four levels of geometry, trigonometry and signals. The registry is the
point, and it is easier to see with four manipulatives than with forty — the number that matters
is that the tool count is six either way.

The steering is deliberately shallow, too. `want` is matched against a table of aliases, not
understood: it will move you to the Bézier level for "curve" and pick a sawtooth for "sawtooth",
and it will do nothing at all for "the one where the circles chase each other". Reaching for a
model to classify the request is the obvious next step and it is the wrong one at this size — a
tool has 2.5 seconds and the table answers in microseconds. What the table buys is that a level
teaches the resolver its own vocabulary by being added.

## Cost

A real call, billed by the second. `MAX_CALL_SECONDS` defaults to **420**, so one full run of ten
tasks is roughly **35¢** at ~$5/hour. The page shows calls, seconds on air and credits spent, and
`End` releases the session immediately.
