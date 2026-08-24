# Terminal tutor

**What this shows:** a character who draws on the screen — and never once sends a coordinate.
He teaches vim and tmux from behind a sheet of glass, and every box, circle and arrow is aimed
by NAME (`text:delay`, `line:14`, `pane:right`) because a model cannot see the page it is
pointing at.

## Setup

From the repo root, once, so the published SDK this example imports is present and built:

```bash
npm install && npm run build
```

Then, in this folder:

```bash
cp .env.example .env      # add your key; AVATAR_ID is optional
node --env-file=.env server.mjs
```

Open <http://localhost:4194> and press **Call**. He opens, takes the first lesson,
demonstrates it while narrating and drawing on what he is naming, then hands you the keyboard.
Type into the terminal — it is a real editor with real vim modes. `Esc` leaves the text box
beside the Call button and gives the keyboard back to vim.

Nine lessons: modes, word motions, `dd`/`p`, `ciw`, `/` search, `u` and `:w`, then tmux splits,
panes and windows.

## The character

Kit is a hoodie engineer shot against a black void, and the black is the point: the page
background is `#05070a`, the clip's corners measure between `(1,1,1)` and `(11,11,11)` across
every frame, so there is no rectangle where the video ends and the page begins. Cast against a
bright room instead and the composite is a photograph pasted onto a website.

Two things that are easy to get wrong and were checked rather than assumed:

- **The hood shadows the face, and the face is what gets rendered.** The iconic hood-up look
  puts the eyes and mouth in shade, which is exactly what the lip-sync render needs to see. The
  prompt carries a hard frontal key light for that reason, and the candidate chosen was the one
  with the evenest face, not the most cinematic.
- **The clip opens and closes on the same rest pose.** The image-to-video model takes a
  `tail_image_url`, so the first and last frame are the same still — mean absolute difference
  between them is `3.2/255`. A loop that ends somewhere else visibly jumps every few seconds.

**The voice is pinned, and it is not a guess.** With `voice` omitted the platform chooses, and
it reads neither the face nor the persona — a male-presenting character will answer in a
woman's voice on some fraction of calls. The id here is the one `apps/demo/math-studio`
measured through a pitch estimator on a live call: median F0 99 Hz, every voiced frame below the
155 Hz boundary. See that demo's README for why a voice id that merely *looks* right is the
expensive failure — a real-shaped id the engine cannot resolve gives you a call that joins,
fires tools, renders video and is silent.

Set `AVATAR_ID` to him. With nothing set the app falls back to the first ready, video-sourced
avatar on the key, which will not be shot on black and will not be this character.

## What to look at

- **He names things; the page owns where they are.** This is the whole demo. Hand a language
  model `{x1,y1,x2,y2}` for a screen it cannot see and it draws somewhere confident and wrong,
  every time, and never finds out. So `highlight` takes `text:delay` or `line:14`, and
  `Screen.resolve` — running in the only place that can actually see — turns that into a
  rectangle. The failure path carries as much of the design as the happy one: a miss returns
  the list of what *is* addressable, so his second attempt is a pick rather than a second guess.
- **`contain` in a column sized to him, not `cover` full-bleed.** The first version put him
  behind everything at `object-fit: cover`, which crops to fill — a portrait clip in a landscape
  window is scaled until it covers, and what covers is a fraction of a face. He came out
  enormous, off-centre and cut in half by the terminal. His aspect ratio is not knowable from
  the page (it is whatever the source clip was, and this demo ships to people whose avatar is
  not this one), so it is read off the video element at `loadedmetadata` and his column is made
  exactly as wide as a full-height frame needs. Then `contain` fills it with no crop and no
  letterbox, and the left edge is masked to a fade so the video's own rectangle does not read as
  a pasted-on box.
- **The terminal is composed, not pinned.** It is capped at 780px — eighty columns of 13px
  monospace is about 700 — and centred in whatever space his column leaves, with an aspect
  rather than a stretch to the available height. Pinned to the left margin instead, a portrait
  avatar on a wide monitor leaves a 480px hole in the middle of the shot; stretched to full
  height it is a narrow box two thirds empty under eleven lines of code. Both read as a broken
  layout rather than as a roomy terminal.
- **The transparency is on the panel's BACKGROUND, never on the panel.** `opacity: .4` on the
  terminal takes the glyphs down with it and code over a moving face is unreadable. The glass is
  `background: rgb(8 11 14 / .74)` with text at full opacity. One property, and it is the
  difference between the look and an unusable screen.
- **A target name is an argument, not a word.** He will say one out loud unless told not to —
  the first live call opened with *"we are starting with tmux:status today"*, which means
  nothing to anyone listening. The brief now carries that sentence as the example of the failure
  it exists to prevent: say "the green bar along the bottom", pass `tmux:status`.
- **The terminal is built, not shelled into.** A real PTY would put a live shell on an open
  port in a folder people copy verbatim, and a canvas emulator would mean digging cell metrics
  out of someone's renderer to find line 14. A DOM line is a div and a div has a rectangle for
  free — which is also how `check` can read whether they really pressed `dd`. You only get to
  read editor state you own.
- **`demonstrate` returns while it is still going.** The keys play for about eight seconds and
  a tool is abandoned at 2.5; awaiting the animation would be dead air followed by a failure.
  It answers "playing now, takes about eight seconds" and he narrates over the top — which is
  the format anyway.
- **The quiet gate.** The page cannot talk to him — the tool plane has two RPCs and neither runs
  page → agent — so the learner's keystrokes ride home on his next tool call. Handed over raw,
  he interrupts halfway through `ciw` to say it is wrong. Nothing goes over until they have
  stopped for 1.1s; until then he is told `still_typing`, which his brief says means stay quiet.
- **A repeat count is capped, and that cap is what stops the tab freezing.** vim takes a number
  before a motion — `5j` moves five lines — so digits accumulate into a count. Uncapped, the OS
  key-repeat does the rest: a held `5` fires about thirty times a second, a second and a half of
  it builds a forty-digit number, and `for (n = 0; n < 5e39; n++)` is not a slow motion, it is a
  tab that never comes back. It read as a *random* freeze while typing because the number row
  sits directly above the keys this app spends its whole time teaching. Capped at four digits,
  plus a second, independent guard: a motion already wedged against an edge stops counting,
  because no number of further repeats can move it.
- **One render per frame, however many keys arrived in it.** `render()` rebuilds the panes
  wholesale and then relays every ink mark, which forces a synchronous layout — and a held key
  was paying for all of it thirty times a second. Coalescing a burst into one animation frame
  took a two-hundred-key storm from 0.10ms per key to 0.006. Tools flush the pending render
  first, because `highlight` resolves a target against the live DOM and must not be handed the
  frame before last.
- **Everything that only ever reads its own tail is bounded.** The transcript, the key log he
  is handed on his next tool call, and the keys since hand-over all grew without limit over a
  seven-minute call — and each transcript append read `scrollHeight`, forcing a layout per node.
- **Insert-mode typing collapses to one token.** `sinceHandover` records `<text>`, not the
  letters. Recording them raw makes "did they press `i`?" pass for anyone who *typed* an i
  inside insert mode — a check that is satisfied by the thing it was meant to detect.
- **Seven verbs, and the list does not grow with the curriculum.** `next_lesson` · `demonstrate`
  · `hand_over` · `highlight` · `clear_marks` · `check` · `progress`. Not one names a lesson, a
  key, a pane or a file. A tenth lesson is a tenth entry in `LESSONS` — no new tool, and not one
  character added to his brief.
- **Every lesson's demonstration is tested against its own check.** A lesson whose demo does not
  pass its own check is a lesson where he shows you the answer and then marks you wrong for
  copying it. Three of the nine failed that the first time it was run — one motion demo never
  reached the word it asked for, one toggled zoom off at the end of a task that asked for zoom
  on. This is why `check` is handed a state object instead of reaching for the live `Tmux`: it
  makes the test runnable outside a browser.
- **He spells keystrokes out loud, and does not read the file.** The exact inversion of
  `coding-companion`, whose brief forbids reading code aloud because a dictated function
  signature is unlistenable. Here "press d, d" *is* the lesson. Same rule underneath: say the
  part that is the teaching, point at the part that is the scenery.
- **Tools register before the microphone is asked for.** His brief tells him to open the moment
  he connects, so he is reaching for `next_lesson` while a permission prompt is a human
  deciding — and that human can hold the await for fifteen seconds. Anything waited on before
  the manifest is armed is time he spends calling tools that are not there, which from the
  outside is a terminal that stays blank while he talks.

## Trying it without a call

The two interesting halves — the ink and the marking — are both reachable only through a live
session, which makes "does this look right" a question you have to pay to ask. So the page keeps
a handle on it. From the console:

```js
tutor.play("ciw")                     // watch a lesson demonstrate itself
tutor.handOver()                      // take the keyboard, as he would hand it over
tutor.check()                         // what he would be told about what you just did
tutor.draw("text:delay", "circle")    // box · circle · underline · arrow · strike
tutor.screen()                        // every target that resolves right now
tutor.lessons                         // the nine ids
```

## Cost

A real call, billed by the second. `MAX_CALL_SECONDS` defaults to **420**, so a full run of nine
lessons is roughly **35¢** at ~$5/hour — demonstrate-then-your-turn is a slow format, and a
learner hunting for the colon key is not a learner talking. **End** releases the session
immediately.

A call that is never joined still holds its slot until the join timeout notices, so the page says
goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with `endCall`. The
server keeps the ids it minted and only ends those — a route that relayed an arbitrary id from
the request body would let any visitor hang up any call on your account.
