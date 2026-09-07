# Quality ramp and receiver latency reproduction

`useAvatarQualityGovernor` initialized every subscription with LOW, even when the
caller configured `openingCap: "high"`. Its effect also depended on config,
freeze-getter, and TrackReference object identity. A consumer rendering a new
equivalent object could repeatedly actuate LOW and restart the clean dwell.

The adapter now honors opening policy and binds to the actual room, participant,
publication, and track. Equivalent policy values and replacement callbacks keep
the controller alive. Actual policy/subscription changes rebind it. Per-binding
stats cursors prevent an old asynchronous read from contaminating a replacement
track. The existing downgrade thresholds, probation, default LOW opening, and
recovery dwell are unchanged.

This is a subscriber ceiling, not a request to bypass SFU congestion control:
[LiveKit setVideoQuality](https://docs.livekit.io/reference/client-sdk-js/classes/RemoteTrackPublication.html#setVideoQuality).
Even a HIGH opening can receive a lower layer until the SFU permits an upgrade.

## Hook regression

```sh
npm run eval:quality
npm run eval:quality -- --baseline
```

Requires Playwright Chromium. `CHROME_PATH` can select an installed Chrome;
`PLAYWRIGHT_MODULE` can select an existing Playwright module. `QUALITY_REPORT_DIR`
writes JSON evidence. `QUALITY_PACKAGE` optionally tests an installed SDK bundle
instead of the working-tree hook, including a consumer's dependency patch.

The script runs real React with controlled LiveKit events/stats and a virtual
browser clock. Ten checks cover HIGH opening, a LOW ramp through equivalent
renders, retained congestion downgrades, the current freeze getter, unrelated
publication events, inhibited readings, replacement during pending stats,
deliberate policy changes, disabled operation, and absent tracks. Listener cleanup
is also asserted. The baseline records the pre-fix failure rather than asserting
that broken behavior is correct.

## Actual WebRTC fixture

Start [a local LiveKit server](https://docs.livekit.io/transport/self-hosting/local/)
with this isolated configuration (the measured server was 1.13.6):

```yaml
port: 38980
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 38981
  udp_port: 38982
  use_external_ip: false
  node_ip: 127.0.0.1
  enable_loopback_candidate: true
keys:
  latency-local: latency-local-test-secret-at-least-32-characters
logging:
  level: warn
```

The credentials above are only for this loopback fixture. The harness refuses a
non-loopback signaling URL.

```sh
RAMP_REPORT_DIR=/tmp/video-ramp npm run eval:video-ramp
RAMP_REPORT_DIR=/tmp/video-loss RAMP_ARMS=before,after \
  RAMP_DURATION_MS=16000 RAMP_LOSS_EVERY=20 npm run eval:video-ramp
```

The publisher streams the repository's Mira idle clip through a 720×1280 canvas
at 25 fps, VP8 simulcast (360×640 lower layer), plus a quiet test tone. The receiver
uses the real LiveKit React bindings and SDK video surface. The three arms are:

| Arm | Quality owner/config | SDK adapter | Consumer playout policy |
| --- | --- | --- | --- |
| before | Two governors; fresh config each render | Baseline | Existing defaults |
| app-only | Surface governor; memoized config | Baseline | `shrinkAlpha: 0.25` |
| after | Surface governor; memoized config | Patched | `shrinkAlpha: 0.25` |

The faster playout policy is a **consumer experiment**, not a change to SDK
defaults in this PR. The fixture renders every 500 ms. It alternates arm order
between trials, records first presented frames, dimensions, frame timestamps,
quality actuations, requested buffer targets, and actual interval statistics.

By default both source arms use revision
`40b0b02850ff2a12ca349d40d11b34986aa51b6e`, with only the candidate hook replaced.
To compare a consumer's exact pinned package, set `RAMP_PACKAGE_BASELINE`,
`RAMP_PACKAGE_CANDIDATE`, and `RAMP_PEER_ROOT` to local package/dependency paths.
Both arms then use those installed bundles with one shared React/LiveKit runtime.
`RAMP_PUBLISHER_PEER_ROOT` can override the synthetic publisher independently;
otherwise it follows `RAMP_PEER_ROOT`. Verify that an upper stream was actually
received before interpreting a full-resolution ramp. Requested HIGH alone is not
proof that the publisher/SFU delivered it.
`RAMP_TRIALS`, `RAMP_DURATION_MS`, and `RAMP_ARMS` bound the workload.

Loss runs use a local UDP relay on port 39082. During seconds 5–11 it drops every
20th RTP/RTCP packet, preserving ICE/DTLS establishment. The report counts the
actual impaired packets and drops; the script asserts that the selected ICE pair
uses the relay and that it dropped media. This is packet loss, not an HTTP throttle.

Frame age is estimated from a millisecond timestamp encoded into the source
picture and decoded at the receiver's video-frame callback. Actual receiver
buffer delay uses interval deltas of `jitterBufferDelay/jitterBufferEmittedCount`,
as defined by [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/).

This fixture does not measure session minting, GPU cold start/inference, public
TURN paths, mobile devices, or production incidence. Keep final measurement runs
separate from local builds and test suites on a shared machine. Preserve all
trials, including freezes and slower results; do not select only clean runs.
