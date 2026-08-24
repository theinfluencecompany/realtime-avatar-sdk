# `realtime-avatar-browser`

Browser audio for a Realtime Avatar call: start the microphone, play the character, and say
what went wrong when either does not happen.

```bash
npm install realtime-avatar-browser
```

No React. No `livekit-client` dependency — both helpers are structural, so they work with
whatever version you already have and pin nothing.

## Why this is a package and not four lines in your app

Those four lines are `await room.localParticipant.setMicrophoneEnabled(true)`, and the reason
they are not enough is that **the failure path is invisible until a real person is on a real
machine**. The call is already connected when it fails, the page is mid-`await`, and the
rejection becomes an unhandled promise nobody is watching. What gets reported is one sentence
— *"the mic won't start"* — covering at least six unrelated causes, one of which is not in the
browser at all.

```ts
import { enableMicrophone, attachRemoteAudio } from "realtime-avatar-browser";

const audio = attachRemoteAudio(room, {
  onPlaybackBlocked: (unblock) => {
    enableSound.hidden = unblock === null;
    enableSound.onclick = () => unblock?.();
  },
});

await room.connect(grant.livekit_url, grant.participant_token);

const mic = await enableMicrophone(room);
if (!mic.ok) {
  status.textContent = mic.message;   // what the browser said
  help.textContent = mic.hint;        // what to actually do about it
}
```

## `enableMicrophone(room, { timeoutMs? })`

Returns a result; never throws. A person declining a device is an ordinary outcome, not a
programmer error, so it belongs in the return type.

| `reason` | What actually happened | The fix it names |
| --- | --- | --- |
| `insecure-origin` | `navigator.mediaDevices` is undefined | https, or `http://localhost` — a LAN IP will not do |
| `no-answer` | The prompt was never answered | Per spec getUserMedia may *never settle*; we time out instead of hanging |
| `denied-by-browser` | This site is blocked | The address-bar permission |
| `denied-by-os` | The OS is blocking the browser | macOS System Settings → Privacy & Security → Microphone, **then restart the browser** |
| `no-device` | Nothing to record with | Connect one; check Bluetooth headphones are in a mode that has a mic |
| `device-in-use` | Something else holds it | Another tab or app — including a call from this page you did not hang up |

The two denials are separated deliberately. Chromium reports a macOS denial as
`NotAllowedError` with `"Permission denied by system"`, which is *not* fixable from the
address bar — telling the user to click there is a dead end, and it is the most common wrong
answer to this failure.

`enableMicrophone` does **not** hang up on failure. The call is still live and still billing,
and only you know whether a text-only session is worth keeping. If it is not, disconnect in
the `!ok` branch — leaving a room connected against a device the user never granted is how
the retry ends up contending with the call still holding it.

## `attachRemoteAudio(room, { container?, onPlaybackBlocked? })`

Plays every remote audio track, and tells you when a user gesture is required.

**Call it before `room.connect()`.** A track subscribed during connect is missed otherwise —
a race that only shows up on a fast connection.

It exists because two silent failures look identical:

1. `track.attach()` returns a **detached** `<audio>`. Left out of the document there is no
   node to fall back to and nothing to click. Nothing errors; the call is connected, the
   track is subscribed, and it is silent.
2. Autoplay is blocked until a gesture. `room.startAudio()` fixes it but must be called
   *from* the gesture — so the page needs a button, so the page must know it is blocked.
   That signal is an event nobody subscribes to.

`onPlaybackBlocked` hands you the closure rather than a boolean, so it cannot be called too
late; it is invoked again with `null` once audio is playing.

Call `detach()` when the call ends.
