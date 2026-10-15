import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordingArtifact } from "../../../http-client/src/generated/recording.ts";
import { recordingPositions, recordingTimeline, recordingVideoVisible } from "../../../browser/src/recording-playback.ts";

export type RecordingPlaybackAsset = { recording: RecordingArtifact; url: string };

// A participant's voice and face can be separate elements, so nothing but this loop keeps them together.
// Chromium reports a starved file at readyState 2, which the buffering check does not catch: the master
// and the voice run on while the face freezes, and it resumes that far behind. An element that falls
// behind is re-seeked, which holds every element until it can play. One that runs ahead holds its frame
// until the clock reaches it, the way a recorded gap does, so a seek that lands past a blank MP4 interval
// is never chased by another. Smaller drift, such as one element starting later, is closed by rate.
const RESEEK_BEHIND_SECONDS = 0.25;
const RESEEK_INTERVAL_MS = 1_000;
const HOLD_AHEAD_SECONDS = 0.25;
const RATE_DEADBAND_SECONDS = 0.04;
const RATE_NUDGE = 0.05;

/** Participant files and separate track segments share one clock without mixing voices. */
export function RecordingPlayer({ assets, className }: { assets: readonly RecordingPlaybackAsset[]; className?: string }) {
  const timelineKey = JSON.stringify(assets.map((asset) => asset.recording));
  const timeline = useMemo(() => {
    try { return recordingTimeline(assets.map((asset) => asset.recording)); }
    catch { return null; }
  }, [timelineKey]);
  const media = useRef(new Map<string, HTMLMediaElement>());
  const seeks = useRef(new Map<string, { seconds: number; retries: number }>());
  const position = useRef(0);
  const anchor = useRef<{ sessionId: string; originMs: number } | null>(null);
  const [displayPosition, setDisplayPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState("");
  const sourceKey = assets.map((asset) => `${asset.recording.recordingId}:${asset.url}`).join("|");

  const seekMedia = (recordingId: string, element: HTMLMediaElement, seconds: number) => {
    if (element.readyState < 1 || Math.abs(element.currentTime - seconds) <= 0.02) return;
    seeks.current.set(recordingId, { seconds, retries: 0 });
    element.currentTime = seconds;
  };

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
    const active = new Set<string>();
    const held = new Set<string>();
    const reseekedAt = new Map<string, number>();
    const stopMedia = () => { for (const element of media.current.values()) { element.pause(); element.playbackRate = 1; } };
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
        return state.active && (!element || ((!element.ended || seeks.current.has(state.recordingId)) && (element.readyState < 2 || element.seeking)));
      });
      setBuffering(waiting);
      if (!waiting) position.current = proposed;
      for (const state of recordingPositions(timeline, position.current)) {
        const element = media.current.get(state.recordingId);
        if (!element) continue;
        if (!state.active) { element.pause(); active.delete(state.recordingId); continue; }
        if (!active.has(state.recordingId)) seekMedia(state.recordingId, element, state.timeSeconds);
        if (element.readyState >= 1) active.add(state.recordingId);
        if (element.ended && !seeks.current.has(state.recordingId)) { element.pause(); continue; }
        if (!playing || waiting) { element.pause(); continue; }
        const drift = element.currentTime - state.timeSeconds;
        if (held.has(state.recordingId)) {
          if (drift > 0.01) continue;
          held.delete(state.recordingId);
        } else if (!element.seeking && !seeks.current.has(state.recordingId) && element.readyState >= 2) {
          if (drift > HOLD_AHEAD_SECONDS) { element.pause(); element.playbackRate = 1; held.add(state.recordingId); continue; }
          if (drift < -RESEEK_BEHIND_SECONDS) {
            if (now - (reseekedAt.get(state.recordingId) ?? -Infinity) >= RESEEK_INTERVAL_MS) {
              reseekedAt.set(state.recordingId, now);
              element.playbackRate = 1;
              seekMedia(state.recordingId, element, state.timeSeconds);
            }
          } else element.playbackRate = Math.abs(drift) <= RATE_DEADBAND_SECONDS ? 1 : drift > 0 ? 1 - RATE_NUDGE : 1 + RATE_NUDGE;
        }
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

  const positions = new Map(timeline ? recordingPositions(timeline, displayPosition).map((state) => [state.recordingId, state]) : []);
  const seek = (value: number) => {
    position.current = value;
    setDisplayPosition(value);
    if (timeline) for (const state of recordingPositions(timeline, value)) {
      const element = media.current.get(state.recordingId);
      if (!element) continue;
      seekMedia(state.recordingId, element, state.timeSeconds);
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
      if (state.active && element) {
        seekMedia(state.recordingId, element, state.timeSeconds);
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
        const state = positions.get(recording.recordingId);
        const visible = Boolean(state?.active && recordingVideoVisible(recording, state.timeSeconds));
        const label = recording.participant.role === "user" ? "User" : "Character";
        const ref = (element: HTMLMediaElement | null) => {
          if (element) media.current.set(recording.recordingId, element);
          else media.current.delete(recording.recordingId);
        };
        const onError = () => { for (const current of media.current.values()) current.pause(); setPlaying(false); setError("A recording could not load. Refresh access and try again."); };
        const onLoadedMetadata = (event: { currentTarget: HTMLMediaElement }) => {
          const state = timeline && recordingPositions(timeline, position.current).find((item) => item.recordingId === recording.recordingId);
          if (state) seekMedia(recording.recordingId, event.currentTarget, state.timeSeconds);
        };
        const onSeeked = (event: { currentTarget: HTMLMediaElement }) => {
          const pending = seeks.current.get(recording.recordingId);
          if (!pending) return;
          // WebM duration can grow when the final packets decode. Its initial duration
          // must not permanently clamp a seek into that newly discovered tail.
          if (Math.abs(event.currentTarget.currentTime - pending.seconds) > 0.08 && pending.retries < 2) {
            pending.retries++;
            event.currentTarget.currentTime = pending.seconds;
          } else seeks.current.delete(recording.recordingId);
        };
        return recording.mode !== "audio"
          ? <figure key={recording.recordingId} hidden={!visible} style={{ margin: 0 }}>
              <figcaption>{label}</figcaption>
              <video ref={ref} src={url} muted={recording.mode === "video"} playsInline preload="auto" onError={onError} onLoadedMetadata={onLoadedMetadata} onSeeked={onSeeked}
                hidden={!visible} style={{ width: "100%", maxHeight: 360, objectFit: "contain" }} />
            </figure>
          : <audio key={recording.recordingId} ref={ref} src={url} preload="auto" onError={onError} onLoadedMetadata={onLoadedMetadata} onSeeked={onSeeked} aria-label={`${label} audio`} />;
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
