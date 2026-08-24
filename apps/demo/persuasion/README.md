# Change her mind

**What this shows:** a game whose win condition is the character's own judgement — she
concedes by calling a `concede` tool that lives in the page, and nothing else in the app is
allowed to decide it.

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

Open <http://localhost:4200>, press **Start**, and argue. Repeating yourself louder does not
work; a new angle does.

## What to look at

- **The model is the arbiter.** There is no scorer and no keyword list. `instructions` tell her
  to call `concede` only when a genuinely novel argument defeats her position. A separate judge
  would have to be as good at the argument as she is, and it would be measuring a conversation
  it never had.
- **The win never rides the transcript.** Her speech reaches the page through speech
  recognition, which re-spells contractions and drops punctuation — a sentinel sentence to
  match against is a win condition that fails at random. A tool call arrives exactly once,
  exactly as sent, and its return value tells her to now admit, in her own words, that she was
  convinced — so the concession she speaks stays grounded.
- **`clientTools: true` is decided at the mint.** The worker only exposes tool registration for
  a session granted the capability, and a browser cannot grant it to itself.
- **The claim is chosen server-side.** Which hill she dies on is `instructions`, and
  `instructions` is policy. A client that picks the claim can hand her any belief at all.
- **`{ grant, claim }`.** `grant` is `call.raw` byte-for-byte; the field the page needs rides
  *beside* it, because a key added *inside* the grant makes the browser client reject the
  whole payload.
- **`AVATAR_ID`** is read first so a host platform can launch this with an avatar the user
  chose. With nothing set, the app picks the first `ready` avatar whose `sourceKind` is
  `video` — an image-sourced avatar reaches `ready` and then publishes an all-black track.

## Cost

Starting a call bills by the second while it is live (under $5/hour). Every call this app
starts is capped at `MAX_CALL_SECONDS` (240 by default), so an argument you walk away from
cannot run up a bill.

A call that is never joined still holds its slot until the join timeout notices, so the page
says goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with
`endCall` — the slot frees the moment the user leaves, even if the tab closes before the
room exists. The server keeps the ids it minted and only ends those; an id it does not
recognise is ignored, so the route cannot be used to hang up someone else's call.
