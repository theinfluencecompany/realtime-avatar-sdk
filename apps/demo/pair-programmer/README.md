# Pair programmer

**What this shows:** the coding companion in a different room. The character is composited
into the scene at full height and the app floats in front of them on a sheet of glass, the way
[`terminal-tutor`](../terminal-tutor) teaches from behind one — same brief, same four tools,
same build engine, so the only variable is the composite.

If you are reading one of these to learn the tool plane, read
[`coding-companion`](../coding-companion) first: it carries the measurements behind the
receipt-and-poll shape, the superseded-build rule, and the two lines of the brief that stop
the model inventing work. This one carries the layout.

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

Open <http://localhost:4196>, press **Call**, and say *"build me a pomodoro timer"*. The
document streams onto the glass in the Code tab, renders in Preview, and lands as **v1**. Then
say *"make the ring thicker and add a long-break mode"* — v2 is edited from v1, not written
from nothing. Say *"go back to the first one"* and it is restored.

**Publishing is optional.** Leave `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` unset and
everything above works with no share link. Set both and a **Publish** button appears, along
with a tool the model can call. `.env.example` says how to mint the token and what it can do
— read that paragraph before you set it, because publishing puts model-generated HTML on a
public URL under a subdomain you own.

## The layout

Four fixed layers over one scene: the avatar column on the right, the app on glass to its
left, a rail of cards bottom-right, and the dock bottom-left.

- **Cast against black.** The character is full height in their own column with the app in
  front of them, so a clip shot against a dark background drops into the scene and a clip shot
  in a bright room reads as a photograph pasted onto a website. The page scrims and vignettes
  as a fallback; casting is the real fix. This demo ships cast with **Kit** — the hoodie
  engineer [`terminal-tutor`](../terminal-tutor) teaches from, shot against a black void — and
  `.env.example` names him. Point `AVATAR_ID` at anyone shot the same way.
- **The voice is pinned, and it must be recast with the face.** Omitting `voice` does not
  mean "default", it means the platform chooses — and it reads neither the face nor the
  persona, so a male-presenting character answers in a woman's voice on some fraction of
  calls. The id here is not a guess: it is the one `math-studio` measured through a pitch
  estimator on a live call, median F0 99 Hz with every voiced frame below the 155 Hz boundary.
  Change `VOICE` and `AVATAR_ID` together, or delete both and take what you are given —
  changing one of them is the version that looks fine until someone hears it.
- **Nothing the user reads asserts a gender.** The avatar is a config choice, so the page
  labels the transcript from one `CHARACTER` constant and every status line names the video,
  the renderer or the tools rather than a person — "the video has stopped moving", not "her
  video". Recasting is two lines, not a pass over the prose. The coding companion hardcodes
  "she" throughout and that is the one place this pair is not a fair comparison.
- **The Code tab is what the glass is for.** A rendered page is opaque — it has to be, it is
  the real document — so on Preview the panel is a window with a page in it. On Code the
  document sits on `rgb(6 9 12 / .5)` over the scene, and that is the screen this layout
  exists to show.
- **The panel fills its band; the tutor's terminal does not.** There, eighty columns of
  monospace in a full-height box is two thirds empty under eleven lines of code, so the
  terminal gets an aspect ratio. Here the panel is a rendered web page, which uses whatever
  height it is given — and a preview that is shorter than the viewport is a preview that lies
  about the layout it is previewing.

## What to look at

Everything under this heading is about the composite. The tool plane, the brief, the build
engine and the security of `/api/publish` are `coding-companion`'s, unchanged, and its README
is where their reasoning lives.

- **The panel is allowed to overlap the avatar, but only into the fade.** The column is masked
  `transparent → opaque` across its first 18%, so its left edge has no rectangle. The panel is
  sized to land inside that band rather than short of it, which buys back the width that a
  hard gutter between two boxes would cost. Measured across 1280×800, 1440×620, 1680×1050 and
  2560×1440: the panel's right edge sits 0–24px into a fade 84–194px wide — always in the
  ghost region, never on the face.
- **A width cap on the panel is a strip of dead scene on a big monitor.** The cap exists so a
  2560px display does not hand a web page more width than it has any use for. At 1180 it was
  too tight to be that: measured at 2560×1440 the panel wanted 1449px, got 1180, and left
  269px of empty background between itself and the character. 1400 leaves 49px and it reads
  as deliberate.
- **CSS cannot guess a height that JavaScript can measure, and every wrong guess draws one
  element on top of another.** The narrow layout stacks four fixed layers in one column —
  panel, rail, caption, dock — and the first version pinned each one a fixed distance off the
  bottom. Both guesses were wrong, and neither is visible until you make the window small:

  | measured | what happened |
  | --- | --- |
  | 720×900 | the rail's top was 637 and the panel's bottom 687 — the panel drawn 50px through the rail |
  | 400×850 | the dock wraps to two rows and is 90px tall; the caption, pinned 60px up, landed inside it, so "Hang up" was drawn over the status line |

  `fit()` now measures the dock, the caption and the rail and writes `--caption-bottom`,
  `--rail-bottom` and `--pane-bottom` from what is actually there. The stack is checked the
  same way it broke — three booleans, at every size — rather than by eye.
- **A log that grows moves the panel above it.** On the narrow path the panel is sized against
  the rail's height, so `max-height` on the transcript would walk the panel up the screen one
  turn at a time. It is a fixed `height` there, and `fit()` re-runs when the card is collapsed.
  The wide path has the opposite problem and the same cause — `coding-companion`'s README has
  the measurement, where 25 lines walked the avatar through eleven distinct heights.
- **`contain` in a column sized to the clip, not `cover` full-bleed.** The aspect ratio is not
  knowable from the page — it is whatever the source clip was — so it is read off the video
  element at `loadedmetadata` and the column is made exactly as wide as a full-height frame
  needs. `object-fit: cover` crops to FILL, and what covers a landscape window with a portrait
  clip is a fraction of a face.
- **The transparency is on the panel's BACKGROUND, never on the panel.** `opacity: .4` on the
  panel takes the document down with it, and code over a moving face is unreadable either way.
  No `backdrop-filter` either: what is behind the glass is a flat gradient, so it would buy
  nothing and charge the compositor for a snapshot-and-blur every time a build repaints.
- **The build card must not contradict the screen.** It read `job.status`, so a page put on
  screen by `restore_version` — or by hand from the console — showed "nothing built yet"
  directly above "v1 of 1". With no job running, the versions decide the wording.
- **The countdown is a pill in the corner, not a badge on the avatar.** The call has a hard
  cap and hitting it does not look like an ending — it looks like a frozen picture under the
  word "connected". `coding-companion` puts the clock on the avatar stage; there is no stage here,
  so it goes top-right where a screen recorder would put it, and it is on screen the whole call
  so the freeze arrives already explained.
- **The audio elements are off-screen, not `display: none`.** A hidden media element is subject
  to the same autoplay rules and only loses the browser's own affordance. `attachRemoteAudio`
  takes the container, so they land there and go with the call.
- **This page uses `realtime-avatar-browser`; the coding companion inlines
  the same logic.** That is the one functional difference between the two, and it is not a
  behaviour change — `enableMicrophone` returns the same six causes as a value, and
  `attachRemoteAudio` attaches into the DOM before `connect` and surfaces the autoplay block.
  Reading them side by side is the shortest explanation of what that package is for.

## Trying it without a call

The layout is the thing worth looking at here and all of it is reachable without spending a
call. From the console:

```js
studio.load("<!doctype html>…")     // a document straight onto the panel, free
studio.build("a pomodoro timer")    // the tool the model calls, by hand — costs a completion
studio.check()                      // what check_app would report
studio.restore(1)                   // go back to v1
studio.versions()                   // what exists, and how big it is
```

`studio.load` is the one that costs nothing, which makes "does this layout hold a real
document" a question you can ask at every window size. `studio.publish()` needs a session id
and is refused without one — the server only writes to a Worker it named for a call it minted.

## Cost

Three meters, and they are the coding companion's. The call bills by the second while it is
live (under $5/hour) and is capped at `MAX_CALL_SECONDS` — 300 by default, so a full call is
about **25¢**. Every build **and its repair round** is a separate completion on your
`OPENAI_API_KEY`. Publishing is free on any Cloudflare plan that includes Workers, but the
scripts persist until you remove them — they are all named `rta-pair-<8 hex>`, so that prefix
is the whole cleanup list. It is deliberately not the coding companion's `rta-studio-` prefix:
running both demos on one account should leave two cleanup lists, not one ambiguous pile.

A call that is never joined still holds its slot until the join timeout notices, so the page
says goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with `endCall`
— the slot frees the moment the user leaves, even if the tab closes before the room exists.
**Hang up beacons it too.** Leaving the room does free the slot on its own, but only once the
platform notices the participant has gone — measured at about eight seconds, on a meter that
bills by the second. The server keeps the ids it minted and only ends those, so the route
cannot be used to hang up someone else's call.
