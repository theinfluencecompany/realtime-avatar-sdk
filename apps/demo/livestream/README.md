# Go live

**What this shows:** an audience is not a new primitive. A full TikTok-Live-style room — host bar
with a Follow button, scrolling comments with badges, gift cards with combo multipliers, joins,
floating hearts, a gift sheet, a live viewer count — drives one avatar, and every bit of it rides
the same `lk.chat` topic a one-to-one call uses. The character performs to a crowd it cannot see,
and thanks gifters by name, without any broadcast API on either side.

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

Open <http://localhost:4198>, tap **Go live**, and start the stream. Type a comment, tap the gift
box and send a Rose — tap **Send again** a few times to build a combo — hit **+ Follow**, tap the
video for hearts, and watch her react. Talk out loud too; your mic is live. Lurkers keep the room
moving on their own between your messages.

Pass `?name=Rin` to set the host display name — that is the shape a host platform launches with.

## What to look at

- **Comments, gifts and follows are one channel.** All three are sent with
  `room.localParticipant.sendText(text, { topic: "lk.chat" })` — a plain `handle: text` line for a
  comment, `"[GIFT] <handle> sent a <thing> xN"` for a gift, `"[FOLLOW] <handle> just followed you"`
  for a follow. `instructions` name those three shapes so she reacts to them instead of reading the
  brackets aloud. There is no viewer role, no fan-out, no second API: a live room is a UI over an
  ordinary conversation.

- **The room runs on two clocks, and keeping them apart is the whole trick.** The UI paints every
  event the instant it happens, because that churn *is* what a live room looks like. She does not
  work that way — she answers one turn at a time and a turn costs seconds. Forward every line and
  she does not "keep up", she builds a backlog and narrates it, answering a comment from forty
  seconds ago while the room has moved on twice. So the page forwards a **sample**, floored to one
  line every `FORWARD_FLOOR_MS` (3.6s), and drops the rest on the floor. Her brief also tells her
  never to apologise for missing messages, because a performer who keeps flagging the backlog is
  worse than one who simply rides the present.

- **What the viewer does themselves is never sampled away.** Your comment, your gift and your
  follow all pass `{ force: true }`. The sampler exists to thin out simulated crowd noise, and a
  demo where your own message is the one silently dropped teaches the wrong lesson.

- **A combo is one gift event, not thirty-three.** Tapping *Send again* stacks onto the same card
  and counts the multiplier up locally; the chat line is sent once, after `COMBO_SETTLE_MS` of
  quiet, with the count folded in as `x33`. Sending thirty-three lines would spend her entire turn
  budget on the same rose. The multiplier is called out in `instructions` too — without it she
  thanks a viewer for one rose they spent thirty-three on.

- **Not every crowd event deserves a turn.** Joins, hearts and share taps are UI-only and never
  reach her; comments are sampled; gifts and follows are forced through. That ladder — ambient /
  sampled / always — is the editorial decision this demo is really about, and it is three lines of
  code, not a feature of the platform.

- **She opens the stream herself.** The mint seeds one `context` message ("you're live — greet
  chat"), so she performs the moment the video lands instead of waiting for the first viewer to
  type into a silent room.

- **Chat is the audience; she is a caption.** Her transcript renders in a `LIVE CAPTION` strip, not
  in the comment column. Mixing the performer into the audience feed is the one thing no live app
  does, and it makes the room read as a group chat instead of a broadcast.

- **The audience is the page's.** Lurker chatter, joins, hearts and small gifts are simulated in
  the browser to keep the room alive; each simulated gift is still a real `lk.chat` line, so she
  reacts to it exactly as she reacts to yours. Swap the simulation for real viewers — a websocket
  fan-in from your own audience — and nothing about the avatar side changes.

- **`{ grant }`.** `grant` is `call.raw` byte-for-byte; a key added *inside* the grant makes the
  browser client reject the whole payload, so anything of ours rides *beside* it.

- **Routes match on the path, not `req.url`.** `req.url` carries the query string, so an
  exact-equals check serves `{"error":"not_found"}` for `/?name=Rin` — the documented launch shape.

- **`AVATAR_ID`** is read first so a host platform can launch this with an avatar the user chose.
  With nothing set, the app picks the first `ready` avatar whose `sourceKind` is `video` — an
  image-sourced avatar reaches `ready` and then publishes an all-black track.

## Cost

Going live starts a call and bills by the second while it is live (under $5/hour). Every stream
this app starts is capped at `MAX_CALL_SECONDS` (300 by default), so a tab you walk away from
cannot run up a bill. Coins in the gift sheet are a local counter — nothing about a gift costs
money here beyond the seconds the call is already spending.

A call that is never joined still holds its slot until the join timeout notices, so the page
says goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with `endCall` —
the slot frees the moment the user leaves, even if the tab closes before the room exists. The
server keeps the ids it minted and only ends those; an id it does not recognise is ignored, so
the route cannot be used to hang up someone else's stream.
