"use client";

import { useCallback, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";

export default function Page() {
  const [status, setStatus] = useState<"idle" | "connecting" | "waiting" | "live" | "ended">("idle");
  /** Set when the call is up but the microphone is not — the two are independent outcomes. */
  const [micProblem, setMicProblem] = useState<string | null>(null);
  /** Autoplay is blocked until a gesture; this renders the button that spends one. */
  const [needsSoundGesture, setNeedsSoundGesture] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const call = useCallback(async () => {
    setStatus("connecting");
    setMicProblem(null);
    const res = await fetch("/api/call", { method: "POST" });

    if (res.status === 429) { setStatus("waiting"); return; }   // queue, not failure
    if (res.status === 402) { setStatus("idle"); openPaywall(); return; }
    if (!res.ok) { setStatus("idle"); return; }

    // The payload is opaque. Read only what you need to join.
    const grant = await res.json();
    const room = new Room();
    roomRef.current = room;
    room.on(RoomEvent.Disconnected, () => setStatus("ended"));

    // SUBSCRIBE BEFORE CONNECT. A track that arrives during connect is missed otherwise —
    // a race that only reproduces on a fast connection, and it presents as a black, silent
    // call rather than as an error.
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video && videoRef.current) track.attach(videoRef.current);
      if (track.kind === Track.Kind.Audio && audioRef.current) track.attach(audioRef.current);
    });
    // Blocked autoplay is silence with no error. `startAudio()` clears it but must be called
    // from a user gesture, so the page has to know it is blocked in order to offer one.
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsSoundGesture(!room.canPlaybackAudio));

    try {
      await room.connect(grant.livekit_url, grant.participant_token);
    } catch {
      setStatus("idle");
      return;
    }

    // The join succeeded; the microphone is a separate question with its own failures.
    setStatus("live");
    const mic = await startMicrophone(room);
    if (!mic.ok) setMicProblem(mic.why);
  }, []);

  return (
    <main>
      {/* Rendered always, so the refs exist before the first track arrives. */}
      <video ref={videoRef} autoPlay playsInline muted={false} />
      <audio ref={audioRef} autoPlay />

      <button onClick={call} disabled={status === "connecting" || status === "live"}>
        {status === "idle" ? "Call Rin" : status}
      </button>

      {needsSoundGesture && (
        <button onClick={() => roomRef.current?.startAudio().then(() => setNeedsSoundGesture(false))}>
          Tap to enable sound
        </button>
      )}

      {micProblem && <p role="alert">Connected, but the microphone did not start. {micProblem}</p>}
    </main>
  );
}

/**
 * Why the microphone did not start. The published version of this is
 * `realtime-avatar-browser`; it is inlined here so this example stays
 * standalone.
 *
 * It returns a reason rather than throwing because "the mic won't start" is one sentence
 * covering six causes with six different fixes — and one of them is not in the browser.
 */
async function startMicrophone(room: Room): Promise<{ ok: true } | { ok: false; why: string }> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return { ok: false, why: "This page is not a secure context. Use https, or http://localhost — a LAN address will not do." };
  }
  try {
    // Per spec getUserMedia may neither resolve nor reject if the prompt is never answered.
    // Without a deadline that is a permanent hang with nothing to render.
    const noAnswer = new Promise<"no-answer">((r) => setTimeout(() => r("no-answer"), 15_000));
    const started = room.localParticipant.setMicrophoneEnabled(true).then(() => "ok" as const);
    if ((await Promise.race([started, noAnswer])) === "no-answer") {
      return { ok: false, why: "The microphone prompt was not answered — look for it in the address bar." };
    }
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      // Chromium reports a macOS system denial as NotAllowedError too — and that one the
      // address bar cannot fix, so the two must not share a message.
      return /by system|system permission/i.test(message)
        ? { ok: false, why: "macOS is blocking the browser itself: System Settings > Privacy & Security > Microphone, then RESTART the browser." }
        : { ok: false, why: "This site is blocked from the microphone — allow it from the address-bar icon and reload." };
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") return { ok: false, why: "No microphone is available." };
    if (name === "NotReadableError" || name === "TrackStartError") return { ok: false, why: "Another app or tab is holding the microphone." };
    return { ok: false, why: message };
  }
}

declare function openPaywall(): void;
