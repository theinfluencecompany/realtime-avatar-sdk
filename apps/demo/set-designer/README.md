# Set designer

**What this shows:** one clip, many worlds. The `video.edits` surface made pressable: the
avatar's stored source video is the plate, a fixed `instruction` opens the call in a different
set — a snowy cabin, golden hour, rain at dusk — and ticking **Live** hands the re-edit to the
conversation itself, under `live.rules` the server owns. Tell her you'd rather be somewhere
warm, and the room behind her follows.

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

Open <http://localhost:4201>, pick a set, and press **Call**. Hang up and redial to open in a
different world; tick **Live** first and you can skip the redial — just tell her where the two
of you should be instead.

## What to look at

- **Ids cross the wire; prose stays on the server.** The browser sends `{ set: "cabin",
  live: true }` and nothing else. The sentences those ids map to — and `LIVE_RULES`, the policy
  about what a conversation may do to the picture — live in `server.mjs`, next to the key. This
  is the docs' rule 1 with a sharper consequence: a request body that could write
  `edits.instruction` or `live.rules` could redress the character into anything.

- **The negative clause does the work.** `LIVE_RULES` spends one line on what may change and
  two on what must not — never her face, her hair, her clothes, the framing — plus what does
  *not* count as a reason to change it. "Small talk is not a shift" is the line that keeps the
  set from chasing every sentence.

- **`live`'s presence is the switch.** There is no `enabled` flag; an object whose only job is
  to carry rules already answers "should this change?". The live lane rides the opening
  `instruction`, because a re-edit needs a look to depart from.

- **"As built" sends no `video` key at all.** Not `video: {}`, not an empty `edits` — the key
  is absent, so the call is byte-identical to one minted before edits existed. Off is the
  default, and asking is the only way to turn it on.

- **The cooldown is a floor, not a preference.** Every re-edit reprocesses the clip and lands
  as a visible cut, so this app holds each look for 30 seconds. Edits that cannot run show the
  plain clip — the call still happens and she still talks, just in the room she was shot in.

- **Her behavior and her picture never share a field.** Who Kestrel is lives in
  `instructions`; what the room looks like lives in `video.edits`. The instruction is read by a
  video editing model, not by her — she finds out the set changed the way you do, by looking.

- **`metadata` values are strings.** The wire is strict: `live: String(live)`, because a
  boolean there is a 422.

- **The page says goodbye.** On `pagehide` it beacons `/api/end`; the server ends only ids it
  minted itself, so the route cannot be used to hang up someone else's call.

- **`AVATAR_ID`** is read first so a host can launch this with an avatar the user picked. With
  nothing set, the app picks the first `ready` avatar whose `sourceKind` is `video` — edits
  need a clip to edit, and an image-sourced avatar publishes a black track anyway.

## Cost

Each call bills by the second while it is live (under $5/hour) and is capped at
`MAX_CALL_SECONDS` (240 by default). The first loop of an edited call is the expensive one —
the clip is edited once and then replayed, so a fixed instruction costs one pass over the
plate, not a GPU for the length of the call.
