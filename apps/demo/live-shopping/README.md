# Live shopping

**What this shows:** she is not allowed to know the price. A live shopping room — product card,
flash windows, a moving stock counter, a cart and a checkout — where every commercial figure comes
from a catalogue on the server, reaches her only as a tool's return value, and is checked against
what she actually said. Because on a shopping stream a sentence is not a performance, it is an
offer.

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

Open <http://localhost:4197> and tap **Go live**. She opens the room, picks up the first product
in the run of show and starts selling. Ask her things out loud — *does it run small? how many are
left? what's the return policy?* — and watch the right-hand rail: every number she is allowed to
say appears there the moment a tool hands it to her, with the clock it dies on.

The generated Mira source images, idle clips, and the failed medium-shot comparison are preserved
under [`characters/mira`](./characters/mira). They are reference material; the runnable demo uses
the prepared avatar selected by `AVATAR_ID`.

Two things to actually try:

- **Let a flash window expire, then ask her the price again.** That is the failure the whole
  demo is built around.
- **Drive her from the run of show on the left.** Reorder it, drop a product in, and hit **Now**
  on something else mid-sentence — the card cuts immediately and she catches up in words.

Pass `?name=Rin` to set the host display name.

> If she is disclosed as an AI host in your market, that is a badge on the video and a line in
> her brief; this demo keeps only the brief line (she says so if asked). China's live-commerce
> measures, in force February 2026, want it on screen for the whole broadcast — Douyin at no
> less than 5% of frame height, not a splash at the start.

## The one idea

`livestream` gives a character a crowd, and everything she says to it is a performance. Put a cart
in the room and that stops being true. "Only twenty left" and "that's forty percent off" are
claims — they are the claims a language model is most willing to improvise, and a wrong one is a
refund, a chargeback or a regulator rather than a bad take.

So the inversion: **the catalogue in `server.mjs` is the only place a number exists.** Her brief
carries no prices. The tool *descriptions* carry no prices either — a description reading "the
sleep mask is $89" would be handing her a number to remember, and a number she remembers is a
number she is still saying after the window shuts. Each of her five tools returns the figure she
is then allowed to say, and her brief forbids every other one.

## What to look at

- **The offer ladder is data, so she cannot invent a discount.** Each product carries an `offers`
  map, and `quote` can only run what is in it. Ask for a flash price on a product that has none
  and the tool answers `not_available` and hands back the list of what *is* — so the retry is a
  pick rather than a second guess. This is AGENTS.md rule 1 — never accept call policy from the
  client — aimed at the client hardest to distrust, which is the model you are paying to sell.

- **A figure's licence expires when the fact behind it does.** Every tool result is scanned for
  numbers on its way back to her and each is written into a ledger with a deadline taken from its
  source: a flash price dies with its server-stamped window, a stock count goes stale in 45
  seconds, a shipping time never expires. That needs no per-tool bookkeeping — the rule is just
  *whatever a tool returned, she may repeat*. Watch the ledger and you can see `19` counting down
  and `240` already struck through.

- **The storefront may put figures in her mouth; the audience may not.** Tools are not the only
  legitimate source — `[ORDER] Chloe bought #1 x2` is the page saying *two*, so "that's two more
  pairs heading your way" is her repeating it, and the ledger takes numbers from the page's own
  bracketed lines too. Viewer comments ride that same channel and are deliberately excluded: a
  stranger typing *"it's only 5 dollars right?"* must never license her to say five dollars. The
  bracket is the whole test, and it is rule 1 again — trust your server, not the room.

- **The failure this catches is not invention, it is repetition.** A model quoting a price out of
  nowhere is rare. A model quoting the flash price correctly, and then still quoting it ninety
  seconds later, is the normal case: the claim was true when she made it and nothing in the
  conversation told her it stopped. That is why the ledger is a clock and not a set.

- **The checker reads her captions and it is a detector, not a gate.** The audio already left. Two
  severities on purpose: an unsourced *figure* is checkable, so it is hard and the page posts a
  correction into chat — the job a human control operator does in a real room — and sends it to
  her too, so the next thing she says is right. A banned *phrase* is a keyword match, "best for
  travel" is a legal sentence, so it is soft. Calling that a violation trains whoever reads the
  pane to stop reading it.
  It reads spelled-out numbers first (`"eighty nine dollars"` → `89`), because a checker that only
  understands digits passes everything spoken naturally. It anchors on the noun and never on a
  lead-in word: `only|last (\d+)` reads beautifully and flags *"the last one"* and *"just one
  second"*, so recall loses to precision here deliberately. Both keyword entries that were
  narrowed — `treats` keeps the verb and drops the noun — were narrowed by watching this pane cry
  wolf on a live run. A pane that is wrong twice stops being read, which costs more than the
  claim it might have caught.

- **The server prices the order, not the page and not her.** `/api/order` ignores the price the
  page sends and charges the catalogue, returning both numbers. So a misquote never reaches the
  customer's card — it surfaces as a `mispriced` flag instead. An endpoint that charged what the
  client asked for would let a hallucinated discount become a real one, and would let anyone with
  the console open set their own.

- **Sold out is a trap she cannot see.** #4 opens with zero stock and the crowd sells #3 out from
  under her while she talks. Nothing in the conversation announces either. `feature`, `quote` and
  `last_call` all refuse on empty stock and say why, so the only way she learns is the way she
  should — the tool told her.

- **None of her five tools spends money.** She features, prices and closes; the tap is the
  customer's. That is the right boundary anyway, and it is the one the 2.5s tool deadline would
  force regardless — a real checkout does not fit inside it.

- **The producer is a person, and the run of show is theirs.** The panel on the left is the
  desk job every live-selling operation has: reorder the queue and she works down it, drop a
  product in mid-stream, pull one out, or hit **Now** to cut to something immediately. None of
  it costs a tool. `feature` with no argument means "whatever the producer queued next", so the
  word *next* resolves against the panel at the moment she asks it — which is why the order can
  change while she is mid-sentence about the last item.

- **"Now" changes the card on the tap, and tells her afterwards.** This is a third clock, and
  the fastest of the three. Making her the gate — cut only once she has called `feature` — puts
  a whole turn between the click and the screen, and the button reads as broken. So the page
  switches, then forces a `[PRODUCER]` line past the sampler; she catches up in words a beat
  later. Her brief names that tag alongside `[STORE]`, or she reads the brackets out loud.

- **The avatar's face has to be big in frame, and getting that wrong fails silently.** The host
  here was generated (`gpt-image-2` → `seedance` → `createAvatarFromVideo`). The first attempt
  was a medium shot — a presenter standing in a dressed set, face maybe a sixth of the frame.
  It preprocessed, reported `status: "ready"` and `sourceKind: "video"`, minted calls happily,
  and then **her worker never joined the room**: 15 seconds of nothing to register tools with,
  which the page can only report as a timeout. Re-cropped to a tight head-and-shoulders it
  worked first time. Aspect ratio was not the variable — a square 1:1 source and a 9:16 source
  both work once the face is large; note the renderer crops tight to the face either way, so
  frame for that rather than for a wide set.

- **The five verbs do not grow with the catalogue.** Adding a sixth product is a row in
  `CATALOG` — not a tool, and not a line of her brief. That is `math-studio`'s registry lesson;
  this example leans on it rather than re-teaching it, and points it at facts that expire.

- **Comments, cart adds, orders and follows are one channel**, and the room forwards her a
  *sample* of it — both straight from `livestream`, which is where they are explained. Questions
  are sampled, orders and sell-outs are forced through, hearts never reach her.

## Cost

Going live starts a call and bills by the second while it is live (under $5/hour), capped at
`MAX_CALL_SECONDS` (300 by default) so a tab you walk away from cannot run up a bill. Nothing in
the cart costs money — the catalogue, the coins and the orders are all local to this app.

A call that is never joined still holds its slot until the join timeout notices, so the page says
goodbye: on `pagehide` it beacons `/api/end` and the server ends the call with `endCall`. The
server keeps the ids it minted and only ends those, so the route cannot be used to hang up someone
else's stream.
