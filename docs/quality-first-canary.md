# Quality-first opt-out (experimental)

The default remains `adaptiveQuality={true}`. This experiment removes only the
subscriber-side fast-down/sticky-up governor, not LiveKit's bandwidth controller,
simulcast, receiver buffer, or the player's live/idle fallback:

```tsx
<AvatarVideoSurface adaptiveQuality={false} />
```

With this patch, disabling the governor requests `VideoQuality.HIGH` on the current
publication and each replacement subscription. This releases an existing LOW cap;
it does not force the SFU to send HIGH. No governor timer, stats polling, or
congestion listeners run while disabled. Re-enabling restores the configured
opening policy. `openingCap` still applies only when the governor is enabled.

Previously, opting out stopped the governor but could leave its last LOW cap
applied indefinitely. This also means that a consumer intentionally combining
`adaptiveQuality={false}` with a separate manual cap controller must choose a
single owner: the surface now requests HIGH when its subscription binds.

## Bounded evaluation

Compare two fresh, concurrent sessions on the same RTX6000 worker, swap the test
accounts, and record the actual inbound frame dimensions separately from requested
caps. Keep receiver buffering, stream layers, GPU settings, and prompts unchanged.
Include natural playback, callback jitter, and a validated weak-link fixture.

Report first-frame wait separately, plus native frozen time, native freeze events,
frame gaps, live-hidden time, receive-to-display latency, and cap changes. A HIGH
request or a sharp screenshot alone is not evidence of better whole-call quality.
Browser callback blocking is a synthetic client-side fixture, not injected GPU or
network jitter.

The proposed product tolerance is occasional 100-200ms pauses. It is an acceptance
target, not a guarantee. Greater-than-500ms pauses, live-hidden time, and playback
latency must be examined before any production rollout. Weak-link regressions
must remain visible in the comparison.

## Verification

```bash
npm run check
node scripts/eval-quality-governor.mjs
```

The browser checks exercise the real React hook with controlled LiveKit
publications, including opt-out after LOW, stale in-flight stats, replacement
tracks, re-enabling, absent room/track, and a detached publication. No release,
default-policy change, or production rollout is part of this draft.
