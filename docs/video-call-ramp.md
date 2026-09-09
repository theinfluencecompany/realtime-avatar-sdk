# Quality ramp and receiver latency reproduction

## Production browser evidence (2026-09-09)

The consumer's Playwright harness drives its real video-call UI, with metered test
accounts and the production RTX6000 pool. This app-specific UI/account adapter is
kept with the private integration evidence, outside the public SDK. It does not
deploy anything. Both arms use the same captured production JavaScript;
Playwright substitutes the draft reducer and frame observer only in the candidate
browser. The adapter pins the deployed bundle SHA and fails if production changes.
The candidate observer is compiled directly from `avatar-video-surface.ts`.

The production traces exposed three additional reasons a recovered link stayed soft:

- Delayed JavaScript observations were treated as frozen frames while the video
  counter kept advancing. A completed multi-frame interval is now treated as
  ambiguous, not a proven freeze. An ongoing stall with no counter progress and
  native WebRTC freeze statistics remain actionable.
- A 100ms callback gap was enough to keep restarting the clean window at the 20fps
  lower layer. The callback floor is now 200ms, approximately the native WebRTC
  freeze bar for 15–25fps. This tolerates short callback gaps; it does not change the
  receive buffer, SFU pause response, or native freeze probation threshold.
- Even with no new native freezes and excellent connection quality, the receive
  buffer could repeatedly rise and drain. Eight uninterrupted seconds of unpaused,
  unfrozen playback now permit a guarded probe despite that buffer-only signal.
  Actual freezes, poor/lost quality, hidden time, and pauses clear this evidence.
  Failed probes still back off exponentially.

The test constrains actual WebRTC/P2P traffic using Chromium's
[`Network.emulateNetworkConditionsByRule`](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-emulateNetworkConditionsByRule),
with a global empty URL pattern: 450kbps downstream for six seconds, then
unrestricted. Received RTP bytes, decoded dimensions, presentation counters, native
freezes, buffer time, and long tasks are recorded. An HTTP-only throttle is not
used. The source is a live production avatar, not a fixture video.

For an authorized production evaluation, the consumer adapter must:

1. Pin the deployed JavaScript fingerprint and compile the candidate reducer and
   frame observer directly from this source tree.
2. Use identical observation adapters in production/draft/draft/production order,
   record the source hashes and actual received dimensions, and end every call.
3. Capture first-frame, throttle and restoration timestamps on the browser clock;
   retain the raw frame/stat/cap timelines and all failed attempts.

`scripts/summarize-prod-video-recovery.py <report-directory>` computes the
per-window results from those captures.

Each call ends in `finally`. Credentials/grants stay in the private output
directory; never publish it. The page screenshots and received-track recordings
contain only the test call. Screen recording is off by default because a large
Playwright screencast substantially delayed callbacks on the shared runner.

This is a small sequential comparison, not simultaneous subscribers to one room.
Worker load and initial dispatch time can vary. Full resolution means the top
declared layer actually presented for at least five seconds, not a HIGH request.
The avatar's ladder in these calls is 624×360 / 832×480. No 1080p, encoder-speed,
dispatch-time, end-to-end latency, or device-specific mobile claim follows.
The recordings re-encode the received track and are approximately aligned to
restoration; timing and dimensions come from browser frame metadata, not the
recording's clock or file header. Receive-to-display time excludes
inference, encoding, and the trip to the browser.

Final verification order was production → draft → draft → production. Both final
draft runs used the same source hashes and all four used the same deployed bundle:

| Run | Sustained top after bandwidth restored | Final 20s top share | Presented fps | Receive-to-display median |
| --- | --- | --- | --- | --- |
| Production 1 | Not sustained within 56.2s | 0% | 17.96 | 151ms |
| Draft 1 | 29.02s | 100% | 24.37 | 272ms |
| Draft 2 | 27.57s | 100% | 24.10 | 347ms |
| Production 2 | Not sustained within 55.7s | 1.75% | 20.05 | 129ms |

**Clarity recovery improved; the latency-first rollout gate is not met.** The draft
had 1.49–2.99s of native reported freezes after restoration, versus 0–0.25s in the
baselines. Both draft runs had no native freezes in the final 20s, but still had
higher receive-to-display delay. This is a small sequential production sample,
not proof that the client caused every delay difference. Initial dispatch and
buffer spikes remain unresolved; do not describe it as an end-to-end latency win.

[Production gallery and all attempts](https://drag-reader-dip-via.trycloudflare.com/video-startup-20260909/)
includes the earlier failed candidates and the unsuccessful synthetic fixture.
Private grants/accounts are excluded. The faster 5.61s result from an intermediate
candidate is retained as historical evidence, not substituted for the final
candidate's 27.57–29.02s results.

## Recovery after an opening bandwidth dip (2026-09-09)

The additional regression cell starts HIGH, injects a pause at 1s, then restores a
healthy link. Measure the time from the LOW action to permission to request HIGH.
This is a controller measurement, not proof of delivered resolution or GPU speed.

Before this change, the first failed opening increments `failures` to 1 and pays
`8s * 2^1`, then starts a separate 3s clean window: **19s pinned below the top
layer after a single transient**. The intended first-failure hold is the base 8s.
Healthy observations during that hold should count toward the clean window.

The gate also covers repeated failed upgrades (8/16/32/64/120s holds), congestion
near the end of a hold, hidden/local-stall time, persistent poor quality, and
unchanged clean HIGH/default LOW openings. An ongoing poor link must never pass
this recovery gate. The SFU still decides which layer fits the actual bandwidth.

```sh
node --test --experimental-transform-types libs/client/test/quality-recovery.test.ts
```

The real React hook replay (`npm run eval:quality`) records 19s → 8s for the first
failed opening and 35s → 16s for a repeated failed probe. Use
`QUALITY_SOURCE_REF=2e0b323bd3ed87cef2167b2102754ff5c599f8d5` to replay the baseline
through the same adapter, events, and virtual browser clock.

The UDP fixture can also constrain downstream media to 450kbps during seconds
5–11, with a finite 125ms queue and counted overflow drops:

```sh
RAMP_RECOVERY=1 RAMP_ARMS=before,after RAMP_TRIALS=2 \
  RAMP_DURATION_MS=40000 RAMP_BANDWIDTH_BPS=450000 \
  RAMP_REPORT_DIR=/tmp/video-recovery npm run eval:video-ramp
```

Recovery mode gives both arms one governor and identical playout settings; only
the reducer differs. `RAMP_BASELINE_REF` selects the comparison revision.
`RAMP_SERVER_UDP_PORT` and `RAMP_PROXY_PORT` select isolated fixture ports.
Do not infer recovered resolution from a HIGH cap: each trial must first deliver
the publisher's top layer on the clean link. The initial four runs on September 9
were **INCONCLUSIVE as a paired recovery comparison**: before-1 and after-2 never
delivered that layer, and long freezes persisted. The other runs and all failures
are retained in the gallery. These runs do not establish a network performance
improvement or qualify the tuning for production.

## Opening policy and subscription identity (previous fix)

`useAvatarQualityGovernor` initialized every subscription with LOW, even when the
caller configured `openingCap: "high"`. Its effect also depended on config,
freeze-getter, and TrackReference object identity. A consumer rendering a new
equivalent object could repeatedly actuate LOW and restart the clean dwell.

The adapter now honors opening policy and binds to the actual room, participant,
publication, and track. Equivalent policy values and replacement callbacks keep
the controller alive. Actual policy/subscription changes rebind it. Per-binding
stats cursors prevent an old asynchronous read from contaminating a replacement
track. The existing downgrade thresholds, probation, default LOW opening, and
recovery dwell were unchanged by that earlier fix; the recovery tuning above is
a separate draft.

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
