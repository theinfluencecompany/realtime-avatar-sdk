# Mira source material

Mira is the host used while developing the live-shopping demo. These files preserve the
generated inputs and idle clips behind the framing lesson documented in the parent README.
They are reference material; the runnable demo selects a prepared avatar through `AVATAR_ID`.

| Variant | Avatar | Result |
| --- | --- | --- |
| `1-SHIPPED-*` | `ava_dc6b692eb95443fcbd20575058b485f7` | Shipped. Tight 9:16 head-and-shoulders source; 6.04-second idle clip. |
| `2-works-*` | `ava_c5995e0de2c64f1fad16c937a4b92ecc` | Also works. Tight square headshot; 6.04-second idle clip. |
| `3-FAILED-*` | `ava_915f85c27a1d463883073293a36099e2` | Failed live. The medium shot reached `ready`, but no remote participant joined the call. |

The useful comparison is face size, not aspect ratio: both tight crops worked, while the
medium shot placed the face at roughly one sixth of the frame and failed silently at runtime.

Generation pipeline: `openai/gpt-image-2` → `bytedance/seedance-2.0/image-to-video` →
`createAvatarFromVideo`.
