# Browser regression: live/idle replay on interrupted delivery

`AvatarVideoSurface` used to return to idle after 800ms without a frame, seek the
idle clip to zero, and reveal live again on any single recovered frame. A weak
connection repeatedly replayed the idle opening (#62 fixed the seek and the
single-frame reveal).

The 800ms threshold itself was the second half of the defect. Every fall-back is a
hard cut to a body at an unrelated pose and, ~500ms of frames later, a cut back; on
a link that delivers gaps of about a second every few seconds that is one visible
jump per gap. Measured on a prod rtx6000 call through a 900 kbit / 150 ms / 10 % loss
link (2026-09-09, an avatar built from a single source clip that is ALSO its idle
clip, so each cut is the same motion jumping phase — "it keeps replaying"):
after a rough opening the presented-frame gaps clustered at 650–1150 ms, and the
surface swapped bodies 12 times in a minute. The live frame is now held for
`frameStallMs` = 2 s, and once two stalls have landed inside 15 s the hold steps up
to 4 s until the window clears (`StallEscalation` in `frame-recovery.ts`), so an
unstable link converges on a briefly frozen face — what every video call does under
loss — instead of a body swap per gap. A disconnect still hides immediately.

Run the actual component in Chromium with a local canvas media stream:

```sh
npm ci
npx playwright install chromium
npm run eval:web-stall
npm run eval:web-stall -- --baseline
```

Requires `ffmpeg` on PATH. No API key, account, GPU, or production session is
used. LiveKit context and the transport/quality hooks are stubbed; this isolates
presentation behavior under interrupted frame delivery, not bandwidth or packet
loss on a real WebRTC connection.

Three delivery patterns run per arm, each recorded as a browser video:

- `harness` — the #62 pattern, 5 × (1250 ms off, 180 ms on). Every interruption is
  shorter than the hold, so the working tree must not swap at all (baseline: 5).
  The replacement-track and same-track mute/unmute checks from #62 run here too
  (the mute gap is 2.6 s, past the hold).
- `prod` — the gap train recorded on the prod call above: a 3.0 s and a 6.0 s
  outage around simulcast layer switches, then 650–1150 ms gaps. Exactly the two
  multi-second outages may swap.
- `flap` — three 2.6 s outages inside 12 s. The first two prove the link unstable;
  the third must be absorbed by the escalated 4 s hold.

Set `STALL_IDLE_CLIP=/path/to/clip.mp4` to paint the live layer from the SAME clip
the idle layer loops (at an unrelated cursor) — the self-created-character case —
so the recordings show what a swap looks like to a user. `STALL_BASELINE_REF`
(default: main before this change), `STALL_REPORT_DIR`, `PLAYWRIGHT_MODULE` and
`STALL_CHROMIUM_PATH` select the baseline revision, an artifact directory, and a
Playwright installation. Each run prints an artifact directory containing a
`report.json`, per-pattern reports, browser videos, and screenshots.

Measured locally in Chromium (live→idle swaps, baseline → working tree):
`harness` 5 → 0, `prod` 12 → 2, `flap` 3 → 2; 0 idle seeks in every arm. The fixed
player does not reconstruct missing live frames or eliminate the pose change at a
genuine outage; it only stops manufacturing one per short gap.
