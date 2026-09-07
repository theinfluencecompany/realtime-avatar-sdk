# Browser regression: live/idle replay on interrupted delivery

`AvatarVideoSurface` used to return to idle after 800ms without a frame, seek the
idle clip to zero, and reveal live again on any single recovered frame. A weak
connection repeatedly replayed the idle opening.

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

The source runs at 25fps, then alternates five 1,250ms interruptions with 180ms
bursts before returning to sustained delivery. The current-tree run asserts one
fallback, no idle seeks, recovery after sustained frames, immediate hiding on
disconnect, recovery on a replacement track, and hysteresis across same-track
mute/unmute. The pure recovery tests additionally pin immediate first-frame
presentation and recovery using throttled frame-clock polling.

Each run prints an artifact directory containing `report.json`, a browser video,
and a screenshot. The baseline defaults to the published 0.9.0 revision; override
it with `STALL_BASELINE_REF`. `STALL_REPORT_DIR` and `PLAYWRIGHT_MODULE` optionally
select an existing artifact directory and Playwright installation.

Measured locally in Chromium: baseline 5 live-to-idle transitions and 4 idle seeks;
fixed 1 transition and 0 seeks. The fixed player returns after approximately
500ms of sustained progress. It does not reconstruct missing live frames or
eliminate the pose change at a genuine outage.
