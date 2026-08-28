# Dating rehearsal

**What this shows:** upload a photo of anyone, and go on a live first date you can practice on.
Two ideas worth copying:

- **The date is made from a photo you upload.** A live avatar needs a VIDEO source — an avatar built
  from a still image reaches `ready` and then publishes a *black* track. So the server turns the photo
  into a short seamless idle loop first, then registers the avatar from that. See "How the photo
  becomes a date" below.
- **Four client tools that are all *his* call.** He rates his own interest (`rate_interest` drives a
  live meter), pins the beats that turned it (`mark_moment`), walks out if it dies (`end_date`), and
  writes the after-the-date debrief (`write_debrief`). Nobody in the page asks him for a tool; the
  same model being charming is the one deciding how it's going.

## Setup

From the repo root, once, so the published SDK this example imports is present and built:

```bash
npm install && npm run build
```

Then, in this folder:

```bash
cp .env.example .env      # add REALTIME_AVATAR_API_KEY and FAL_KEY; AVATAR_ID is optional
node --env-file=.env server.mjs
```

Open <http://localhost:4195>, drop in a photo (or tap **blind date**), wait ~2 minutes while it comes
to life, then **go on the date** and just talk. Your silences are silences he actually sits through;
the meter and the debrief are earned, not scripted.

## How the photo becomes a date

The realtime-avatar API takes a hosted looping **video**, not a still image — so the photo→loop step
is the one piece the example does itself, and it leans on the SDK for the rest:

1. **`uploadAsset(photo, { kind: "image" })`** — the SDK hosts the photo and hands back a public URL.
   No second bucket to wire up.
2. **image → seamless loop** (`generateLoop`, `server.mjs`) — a fal image-to-video model with
   `end_image_url` pinned to the first frame, so the clip closes on itself (first ≈ last ⇒ a
   seamless idle loop). `FAL_KEY` never leaves the server. ~1 minute.
3. **`createAvatarFromVideo({ videoUrl })`** — registers a **video**-sourced avatar from that loop.
   ⚠️ **This lane is now closed** (422 for any tenant not already on it), so this demo runs only
   on a grandfathered key. Steps 2 and 3 have also become redundant: `createAvatarFromImage`
   takes the uploaded photo directly and the platform renders the loop itself — the same
   image-to-video step this server does by hand, minus the fal key and a minute of wall clock.
4. **poll `getAvatar(id)` until `status === "ready"`** — the realtime cache builds off the loop. ~1
   more minute.
5. **`startCall({ avatarId })`** — a live, full-duplex date with the face you uploaded.

Because that chain takes ~2 minutes — far longer than one HTTP request should hang — `POST /api/cast`
starts it and returns a job id the page polls at `GET /api/cast/status`. The **blind date** button
skips all of it and calls the fallback `AVATAR_ID` (or the first ready video avatar on the key).

## What to look at

- **Image sources are a black track live.** The whole reason for the loop step: an avatar with an
  `image` source reaches `ready` and mints calls, then publishes a black video track. Only a `video`
  source renders live. This example makes the video from your photo instead of assuming one exists.
- **Nobody scores the date but him.** There is no sentiment pass and no keyword list. The RIZZ meter
  and the moment reel are his live read of the conversation, via `rate_interest` / `mark_moment` — not
  the page's guess about it.
- **State rides tool calls, never the transcript.** His speech reaches the page through speech
  recognition, which drops punctuation and re-spells contractions — a meter driven off matching a
  sentence would twitch at random. A tool call arrives exactly once, exactly as sent; each `execute`
  returns a short string that grounds his next spoken turn.
- **`clientTools: true` is decided at the mint.** The worker only exposes tool registration for a
  session granted the capability, and a browser cannot grant it to itself.
- **The client can only call a date it cast.** `/api/date` accepts a `jobId` this process minted, or
  none (the fallback) — never an arbitrary avatar id relayed from the body, which would let one page
  call on another's behalf.

## Cost

Two meters. **The photo→loop render** costs one image-to-video generation per date (a few cents to a
quarter, depending on `FAL_MODEL`). **The call** bills by the second while live (under $5/hour),
capped at `MAX_CALL_SECONDS` (300 by default), so a date you walk away from cannot run up a bill.

A date that is never joined still holds its slot until the join timeout notices, so the page says
goodbye: on `pagehide` it beacons `/api/end`, and the server ends the call with `endCall`. The server
keeps the ids it minted and only ends those; an id it does not recognise is ignored, so the route
cannot be used to hang up someone else's call.
