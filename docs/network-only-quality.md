# Network-Only Quality

`AvatarVideoSurface adaptiveQuality="network-only"` is opt-in. Boolean modes keep
their existing behavior, with a HIGH release when disabled. One adapter
owns the publication cap. SFU bandwidth adaptation, A/V playout and the live/idle
fallback remain enabled and unchanged.

## Thresholds

`NETWORK_QUALITY_POLICY` is the implementation's source of truth:

| Condition | Value |
| --- | --- |
| Receiver subscription startup grace | 3 seconds |
| Sampling | 1 second, discard gaps over 1.5 seconds |
| Network evidence | Loss >=5% over the last 3 fresh receiver intervals (at least 20 packets), or RTP jitter >=100ms with at least 20 newly received packets |
| Concurrent impact | Decoded video <12fps; rendering callback jitter alone does not qualify |
| Alternative direct signal | Bound track currently SFU-paused, with fresh receiver statistics |
| First cap reduction | Evidence and impact persist for 2 seconds |
| Lowest declared layer | Another 2 seconds of network-evidenced zero decoded frames after reducing |
| Poor-network callback | Evidence and impact persist for another 5 seconds after a cap reduction |
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

Version 0.13.0 publishes the network-only policy previously carried in a consumer
patch, including the five-second delay after a downgrade before notifying. This
allows consumers to remove their distribution patches without changing policy.

Controlled policy and browser-hook tests validate decisions, notification timing,
teardown and normal-network invariance. They do not establish end-to-end freeze
reduction, startup improvement or absolute A/V alignment. Those measurements
depend on the rendering service, SFU, receiver and actual network conditions.
Consumers enabling this mode for the first time should evaluate paired calls and
their app's voice handoff before rollout.
