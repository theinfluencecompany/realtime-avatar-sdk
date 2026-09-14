import { useMaybeRoomContext, useVoiceAssistant } from "@livekit/components-react";
import { ConnectionQuality, ConnectionState, RoomEvent, Track, isRemoteTrack } from "livekit-client";
import type { DisconnectReason, Participant, RemoteTrack, RemoteTrackPublication } from "livekit-client";
import { useEffect, useRef } from "react";
import {
  createNetworkEvidenceSession,
  monotonicNowMs,
  networkEvidenceSchemaVersion,
  summarizeRtcStatsReports,
  type AvatarNetworkEvidenceObserver,
  type LiveKitEvidenceIdentity,
  type NetworkEvidenceTrigger,
  type PresentationEvidence,
} from "./network-evidence.ts";

export type UseAvatarNetworkEvidenceInput = {
  /** Explicit opt-in. With no observer, this hook installs no listeners or timer. */
  observer?: AvatarNetworkEvidenceObserver;
  /** Browser: decoded-frame state from the existing surface. Native supplies only facts it
   * can actually observe (publication dimensions are not evidence of RTCView decoding). */
  presentation?: PresentationEvidence;
};

/** Observe one LiveKit room without ever changing media, reconnect, or billing behavior.
 * The same hook runs on web and React Native. The browser surface passes rVFC presentation
 * facts; native passes only the evidence it can actually observe. The app owns upload and
 * retention, and a throwing callback cannot interrupt a call. */
export function useAvatarNetworkEvidence(input: UseAvatarNetworkEvidenceInput): void {
  const room = useMaybeRoomContext();
  const { agent, videoTrack, audioTrack } = useVoiceAssistant();
  const observerRef = useRef(input.observer);
  const presentationRef = useRef(input.presentation);
  const tracksRef = useRef({ agent, videoTrack, audioTrack });
  observerRef.current = input.observer;
  presentationRef.current = input.presentation;
  tracksRef.current = { agent, videoTrack, audioTrack };
  const evidenceId = input.observer?.context.evidenceId;
  const sessionId = input.observer?.context.sessionId;
  const firstVideoFrame = Boolean(input.presentation?.liveFrameSeen);
  const firstVideoFrameCallback = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!room || !evidenceId || !observerRef.current) return;
    const observer = observerRef.current;
    const correlation = { ...observer.context };
    const startedAt = monotonicNowMs();
    const createdAtUnixMs = Date.now();
    const requestedInterval = observer.intervalMs ?? 5_000;
    const intervalMs = Number.isFinite(requestedInterval) ? Math.min(30_000, Math.max(2_000, requestedInterval)) : 5_000;
    let disposed = false;
    let reading = false;
    let connectionEpoch = 0;
    let roomSid: string | undefined;
    let manifestSent = false;
    let quality = tracksRef.current.agent?.connectionQuality ?? tracksRef.current.videoTrack?.participant?.connectionQuality ?? tracksRef.current.audioTrack?.participant?.connectionQuality ?? ConnectionQuality.Unknown;
    let disconnectReason: DisconnectReason | undefined;
    let firstVideoFrameSent = false;
    const identity = (): LiveKitEvidenceIdentity => {
      const current = tracksRef.current;
      const avatarSid = current.agent?.sid ?? current.videoTrack?.participant?.sid ?? current.audioTrack?.participant?.sid;
      return {
        ...(roomSid ? { roomSid } : {}),
        ...(room.localParticipant?.sid ? { localParticipantSid: room.localParticipant.sid } : {}),
        ...(avatarSid ? { avatarParticipantSid: avatarSid } : {}),
        ...(current.audioTrack?.publication?.trackSid ? { audioTrackSid: current.audioTrack.publication.trackSid } : {}),
        ...(current.videoTrack?.publication?.trackSid ? { videoTrackSid: current.videoTrack.publication.trackSid } : {}),
        ...(room.serverInfo?.region ? { region: room.serverInfo.region } : {}),
      };
    };
    const manifest = {
      schemaVersion: networkEvidenceSchemaVersion,
      correlation,
      livekit: identity(),
      createdAtUnixMs,
    };
    const segmentObserver = (): AvatarNetworkEvidenceObserver => {
      const current = observerRef.current;
      // Queued terminal evidence belongs to its original sink after a remint.
      return current?.context.evidenceId === evidenceId && current.context.sessionId === sessionId ? current : observer;
    };
    const session = createNetworkEvidenceSession(manifest, (sample) => {
      return segmentObserver().onSample(sample);
    });
    const publishManifest = (): void => {
      if (manifestSent || disposed || !roomSid) return;
      manifestSent = true;
      const capturedManifest = { ...manifest, livekit: identity() };
      queueMicrotask(() => {
        try {
          void Promise.resolve(segmentObserver().onManifest?.(capturedManifest)).catch(() => {});
        } catch {
          // Evidence callbacks are never permitted to affect media.
        }
      });
    };
    const readReports = async (): Promise<RTCStatsReport[]> => {
      const reports: RTCStatsReport[] = [];
      const publications = [tracksRef.current.videoTrack?.publication, tracksRef.current.audioTrack?.publication];
      // A full subscriber PC report contains transport/candidate-pair facts. Keep the
      // receiver reports too: the PC report may contain several participants, while the
      // receiver report is scoped to the bound avatar track.
      try {
        const pcReport = await room.engine.pcManager?.subscriber?.getStats();
        if (pcReport) reports.push(pcReport);
      } catch {
        // Native shims and rooms without a subscriber PC may not expose this report.
      }
      for (const publication of publications) {
        try {
          const track = publication?.track;
          const report = track && isRemoteTrack(track) ? await track.getRTCStatsReport() : undefined;
          if (report) reports.push(report);
        } catch {
          // A missing or failed receiver is not a clean zero-valued report.
        }
      }
      return reports;
    };
    const trackIdentifier = (publication: { track?: { mediaStreamTrack?: MediaStreamTrack } } | undefined): string | undefined => {
      const track = publication?.track;
      return track?.mediaStreamTrack?.id;
    };
    const emit = async (trigger: NetworkEvidenceTrigger): Promise<void> => {
      if (disposed || !observerRef.current) return;
      const current = tracksRef.current;
      const state = {
        connectionState: room.state,
        quality: current.agent?.connectionQuality ?? current.videoTrack?.participant?.connectionQuality ?? current.audioTrack?.participant?.connectionQuality ?? quality,
        videoStreamState: current.videoTrack?.publication?.track?.streamState ?? Track.StreamState.Unknown,
        audioStreamState: current.audioTrack?.publication?.track?.streamState ?? Track.StreamState.Unknown,
        ...(disconnectReason !== undefined ? { disconnectReason } : {}),
      };
      const presentation = presentationRef.current;
      const evidenceIdentity = identity();
      const capturedAtUnixMs = Date.now();
      const elapsedMs = Math.max(0, monotonicNowMs() - startedAt);
      const turnId = (() => {
        try { return observerRef.current?.getTurnId?.(); } catch { return undefined; }
      })();
      // State events must be emitted immediately with an explicit unavailable marker;
      // waiting for an async getStats read can lose the final disconnect on unmount.
      if (trigger !== "interval") {
        session.sample({
          trigger,
          elapsedMs,
          capturedAtUnixMs,
          ...(turnId ? { turnId } : {}),
          statsStatus: "unavailable",
          livekit: state,
          identity: evidenceIdentity,
          stats: { source: "none" },
          ...(presentation ? { presentation } : {}),
        });
        return;
      }
      if (reading || !roomSid || room.state !== ConnectionState.Connected) return;
      reading = true;
      const observedEpoch = connectionEpoch;
      const observedVideoTrackId = trackIdentifier(current.videoTrack?.publication);
      const observedAudioTrackId = trackIdentifier(current.audioTrack?.publication);
      try {
        const reports = await readReports();
        if (disposed || room.state !== ConnectionState.Connected || connectionEpoch !== observedEpoch) return;
        const currentAfter = tracksRef.current;
        if (trackIdentifier(currentAfter.videoTrack?.publication) !== observedVideoTrackId ||
          trackIdentifier(currentAfter.audioTrack?.publication) !== observedAudioTrackId) return;
        const stats = summarizeRtcStatsReports(reports, {
          videoTrackId: observedVideoTrackId ?? null,
          audioTrackId: observedAudioTrackId ?? null,
        });
        const stateAfter = {
          connectionState: room.state,
          quality: currentAfter.agent?.connectionQuality ?? currentAfter.videoTrack?.participant?.connectionQuality ?? currentAfter.audioTrack?.participant?.connectionQuality ?? quality,
          videoStreamState: currentAfter.videoTrack?.publication?.track?.streamState ?? Track.StreamState.Unknown,
          audioStreamState: currentAfter.audioTrack?.publication?.track?.streamState ?? Track.StreamState.Unknown,
          ...(disconnectReason !== undefined ? { disconnectReason } : {}),
        };
        session.sample({
          trigger,
          elapsedMs: Math.max(0, monotonicNowMs() - startedAt),
          capturedAtUnixMs: Date.now(),
          ...(turnId ? { turnId } : {}),
          statsStatus: stats.source === "none" ? "unavailable" : "available",
          livekit: stateAfter,
          identity: identity(),
          stats,
          ...(presentationRef.current ? { presentation: presentationRef.current } : {}),
        });
      } catch {
        // Stats are best-effort, and a failed read must not affect media.
      } finally {
        reading = false;
      }
    };
    firstVideoFrameCallback.current = () => {
      if (firstVideoFrameSent || disposed) return;
      firstVideoFrameSent = true;
      void emit("first_video_frame");
    };
    if (firstVideoFrame) firstVideoFrameCallback.current();
    const onQuality = (value: ConnectionQuality, participant: Participant): void => {
      const current = tracksRef.current;
      const avatarSid = current.agent?.sid ?? current.videoTrack?.participant?.sid ?? current.audioTrack?.participant?.sid;
      if (!avatarSid || participant.sid !== avatarSid) return;
      quality = value;
      void emit("quality");
    };
    const onStreamState = (publication: RemoteTrackPublication): void => {
      if (publication !== tracksRef.current.videoTrack?.publication && publication !== tracksRef.current.audioTrack?.publication) return;
      void emit("stream_state");
    };
    const onTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication): void => {
      const wantedVideo = tracksRef.current.videoTrack?.publication;
      const wantedAudio = tracksRef.current.audioTrack?.publication;
      if (publication !== wantedVideo && publication !== wantedAudio) return;
      if (!track) return;
      void emit("track_subscribed");
    };
    const onState = (state: ConnectionState): void => {
      connectionEpoch += 1;
      if (state === ConnectionState.Connected) {
        disconnectReason = undefined;
        if (!roomSid) void readRoomSid();
        void emit("reconnected");
      } else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        void emit("reconnecting");
      }
    };
    const onDisconnected = (reason?: DisconnectReason): void => {
      connectionEpoch += 1;
      disconnectReason = reason;
      void emit("disconnected");
    };
    const readRoomSid = async (): Promise<void> => {
      try {
        const sid = await room.getSid();
        if (disposed || !sid) return;
        roomSid = sid;
        publishManifest();
        void emit("connected");
      } catch {
        // A room that never joined has no LiveKit SID; its app-level attempt still exists.
      }
    };
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    room.on(RoomEvent.TrackStreamStateChanged, onStreamState);
    room.on(RoomEvent.ConnectionStateChanged, onState);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    if (room.state === ConnectionState.Connected) void readRoomSid();
    const timer = setInterval(() => void emit("interval"), intervalMs);
    return () => {
      disposed = true;
      clearInterval(timer);
      session.close();
      firstVideoFrameCallback.current = null;
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      room.off(RoomEvent.TrackStreamStateChanged, onStreamState);
      room.off(RoomEvent.ConnectionStateChanged, onState);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    };
  }, [room, evidenceId, sessionId]);

  useEffect(() => {
    // The web surface's existing rVFC/currentTime watchdog is the only proof that a
    // decoded frame reached the screen. Subscription or publication dimensions are not.
    if (firstVideoFrame) firstVideoFrameCallback.current?.();
  }, [firstVideoFrame]);
}
