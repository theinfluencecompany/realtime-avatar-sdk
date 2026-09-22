import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordingArtifact } from "../../../http-client/src/generated/recording.ts";
import { recordingPositions, recordingTimeline } from "../../../browser/src/recording-playback.ts";

export type RecordingPlaybackAsset = { recording: RecordingArtifact; url: string };

function exhausted(element: HTMLMediaElement, seconds: number): boolean {
  return (Number.isFinite(element.duration) && seconds >= element.duration) ||
    (element.ended && seconds >= element.currentTime);
}

/** Each participant file carries only its own voice; one clock drives both files. */
export function RecordingPlayer({ assets, className }: { assets: readonly RecordingPlaybackAsset[]; className?: string }) {
  const timeline = useMemo(() => {
    try { return recordingTimeline(assets.map((asset) => asset.recording)); }
    catch { return null; }
  }, [assets]);
  const media = useRef(new Map<string, HTMLMediaElement>());
  const position = useRef(0);
  const anchor = useRef<{ sessionId: string; originMs: number } | null>(null);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const sourceKey = assets.map((asset) => `${asset.recording.recordingId}:${asset.url}`).join("|");

  useEffect(() => {
    if (!timeline) return;
    const sessionId = timeline.entries[0].recording.sessionId;
    if (anchor.current?.sessionId === sessionId) {
      position.current = Math.min(timeline.durationMs, Math.max(0, position.current + anchor.current.originMs - timeline.originMs));
    } else if (anchor.current) {
      position.current = 0;
      setPlaying(false);
    }
    anchor.current = { sessionId, originMs: timeline.originMs };
    setDisplayPosition(position.current);
    let cancelled = false;
    let frame = 0;
    let last = performance.now();
    let painted = last;
    const starting = new Set<string>();
    const stopMedia = () => { for (const element of media.current.values()) element.pause(); };
    const fail = () => {
      if (cancelled) return;
      stopMedia();
      setPlaying(false);
      setError("Playback is unavailable. Refresh access and try again.");
    };
    const update = (now: number) => {
      if (cancelled) return;
      const proposed = Math.min(timeline.durationMs, position.current + (playing ? now - last : 0));
      last = now;
      const states = recordingPositions(timeline, proposed);
      const waiting = playing && states.some((state) => {
        const element = media.current.get(state.recordingId);
        return state.active && (!element || (!exhausted(element, state.timeSeconds) && (element.readyState < 2 || element.seeking)));
      });
      setBuffering(waiting);
      if (!waiting) position.current = proposed;
      for (const state of recordingPositions(timeline, position.current)) {
        const element = media.current.get(state.recordingId);
        if (!element) continue;
        if (!state.active || exhausted(element, state.timeSeconds)) { element.pause(); continue; }
        if (element.readyState >= 1 && Math.abs(element.currentTime - state.timeSeconds) > 0.08) {
          element.currentTime = state.timeSeconds;
        }
        if (!playing || waiting) { element.pause(); continue; }
        if (element.paused && !starting.has(state.recordingId)) {
          starting.add(state.recordingId);
          void element.play().catch((cause: unknown) => {
            if (!(cause instanceof Error && cause.name === "AbortError")) fail();
          }).finally(() => { starting.delete(state.recordingId); });
        }
      }
      if (now - painted >= 100 || !playing || position.current >= timeline.durationMs) {
        setDisplayPosition(position.current);
        painted = now;
      }
      if (position.current >= timeline.durationMs) { stopMedia(); setPlaying(false); }
      frame = requestAnimationFrame(update);
    };
    if (playing) frame = requestAnimationFrame(update);
    else {
      stopMedia();
      setBuffering(false);
    }
    return () => { cancelled = true; cancelAnimationFrame(frame); stopMedia(); };
  }, [timeline, playing, sourceKey]);

  const activeIds = new Set(timeline ? recordingPositions(timeline, displayPosition).filter((state) => state.active).map((state) => state.recordingId) : []);
  const seek = (value: number) => {
    position.current = value;
    setDisplayPosition(value);
    if (timeline) for (const state of recordingPositions(timeline, value)) {
      const element = media.current.get(state.recordingId);
      if (!element) continue;
      if (element.readyState >= 1) element.currentTime = state.timeSeconds;
      if (!state.active) element.pause();
    }
  };
  const toggle = () => {
    setError("");
    if (playing) { setPlaying(false); return; }
    if (!timeline) return;
    if (position.current >= timeline.durationMs) seek(0);
    // Call play in the click gesture so audible tracks receive browser activation.
    for (const state of recordingPositions(timeline, position.current)) {
      const element = media.current.get(state.recordingId);
      if (state.active && element && !exhausted(element, state.timeSeconds)) {
        if (element.readyState >= 1) element.currentTime = state.timeSeconds;
        void element.play().catch((cause: unknown) => {
          if (cause instanceof Error && cause.name === "AbortError") return;
          for (const current of media.current.values()) current.pause();
          setPlaying(false);
          setError("Your browser could not play this recording. Try again or download the original.");
        });
      }
    }
    setPlaying(true);
  };

  return <div className={className}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 12 }}>
      {assets.map(({ recording, url }) => {
        if (!recording.participant) return null;
        const label = recording.participant.role === "user" ? "User" : "Character";
        const ref = (element: HTMLMediaElement | null) => {
          if (element) media.current.set(recording.recordingId, element);
          else media.current.delete(recording.recordingId);
        };
        const onError = () => { for (const current of media.current.values()) current.pause(); setPlaying(false); setError("A recording could not load. Refresh access and try again."); };
        return recording.mode !== "audio"
          ? <figure key={recording.recordingId} hidden={!activeIds.has(recording.recordingId)} style={{ margin: 0 }}>
              <figcaption>{label}</figcaption>
              <video ref={ref} src={url} playsInline preload="auto" onError={onError}
                hidden={!activeIds.has(recording.recordingId)} style={{ width: "100%", maxHeight: 360, objectFit: "contain" }} />
              {!activeIds.has(recording.recordingId) ? <p>No recording at this time.</p> : null}
            </figure>
          : <audio key={recording.recordingId} ref={ref} src={url} preload="auto" onError={onError} aria-label={`${label} audio`} />;
      })}
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button type="button" onClick={toggle} disabled={!timeline} style={{ minHeight: 44, minWidth: 44 }}>{playing ? "Pause" : "Play"}</button>
      <input type="range" aria-label="Call playback position" min={0} max={timeline?.durationMs ?? 0} step={100}
        value={displayPosition} aria-valuetext={`${Math.floor(displayPosition / 1000)} seconds`} disabled={!timeline} onChange={(event) => seek(Number(event.currentTarget.value))}
        style={{ minHeight: 44, flex: 1 }} />
      <span>{Math.floor(displayPosition / 1000)} / {Math.ceil((timeline?.durationMs ?? 0) / 1000)} s</span>
    </div>
    <p role="status">{error || (!timeline ? "Media timing is unavailable. Individual recordings can still be downloaded." : buffering ? "Buffering…" : "")}</p>
  </div>;
}
