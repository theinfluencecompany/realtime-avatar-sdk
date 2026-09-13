# Network-Only Quality Canary

`AvatarVideoSurface adaptiveQuality="network-only"` is opt-in. Boolean modes keep
their existing behavior (including #81's HIGH release when disabled). One adapter
owns the publication cap. SFU bandwidth adaptation, A/V playout and the live/idle
fallback remain enabled and unchanged.

## Candidate Thresholds

`NETWORK_QUALITY_POLICY` is the implementation's source of truth:

| Condition | Candidate value |
| --- | --- |
| Receiver subscription startup grace | 3 seconds |
| Sampling | 1 second, discard gaps over 1.5 seconds |
| Network evidence | Loss >=5% over the last 3 fresh receiver intervals (at least 20 packets), or RTP jitter >=100ms with at least 20 newly received packets |
| Concurrent impact | Decoded video <12fps; rendering callback jitter alone does not qualify |
| Alternative direct signal | Bound track currently SFU-paused, with fresh receiver statistics |
| First cap reduction | Evidence and impact persist for 2 seconds |
| Lowest declared layer | Another 2 seconds of network-evidenced zero decoded frames after reducing |
| Poor-network callback | Evidence and impact persist for 5 seconds |
| Release cap to HIGH | 5 seconds of healthy receiving/decoding |
| Clear poor status | 10 seconds of healthy receiving/decoding |

Times start when the measured condition qualifies, not when impairment is
injected. Loss-window fill, startup grace and polling add detection delay.
Healthy means fresh packets, windowed loss <5%, jitter <100ms, decoding >=12fps,
and no SFU pause. Small rVFC freeze-estimate residue is not an input and cannot
reset recovery.

Hidden/muted/inhibited tracks, delayed polls, missing fields, duplicate timestamps,
receiver replacement and counter resets break measurement continuity. They do not
count as healthy or poor. The cap is retained until positive recovery evidence;
an unsupported browser stays at the opening HIGH ceiling.

`onNetworkStatusChange` emits `unknown`, `poor`, or `healthy`. These are receiver
observations, not a diagnosis of Wi-Fi, the ISP, or the rendering worker.
Callback faults cannot stop adaptation. Effects fence in-flight reads and remove
their timer on replacement, mode changes and unmount.

## Verification Limits

Controlled policy and browser-hook tests validate decisions, teardown and normal
network invariance. Replaying the earlier candidate traces finds no cap reduction
for normal/light-jitter calls; the weak trace requests reduced quality at +5.46s,
emits poor at +8.44s and requests the floor at +10.44s relative to the observation
start. It requests HIGH again at +26.44s. Recorded stats lacked RTC report timestamps
and SFU stream-state samples: replay uses the recorded monotonic poll times and
does not invent pause events.

This is **offline, open-loop replay**, not an after measurement: applying a cap
would change subsequent RTP, so neither the freeze reduction nor the recovery
timing is proven by replay. Keep the feature in canary until new paired calls
measure actual freezes, first-frame time, genuine low-tier time, A/V delay,
notification false positives and the voice handoff.
