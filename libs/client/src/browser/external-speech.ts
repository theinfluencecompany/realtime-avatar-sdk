import {
  externalSpeechStateFrameSchema,
  RTA_EXTERNAL_SPEECH_STATE_TOPIC,
  type ExternalSpeechStateFrame,
} from "../wire";

type DataHandler = (
  payload: Uint8Array,
  participant?: { identity?: string } | null,
  kind?: unknown,
  topic?: string,
) => void;

/** Structural subset of a LiveKit Room, so this helper does not force a second SDK copy. */
export interface ExternalSpeechStateRoom {
  on(event: "dataReceived", handler: DataHandler): unknown;
  off(event: "dataReceived", handler: DataHandler): unknown;
}

/** Observe external-speech playback state. Returns an unsubscribe function. */
export function observeExternalSpeech(
  room: ExternalSpeechStateRoom,
  onState: (frame: ExternalSpeechStateFrame) => void,
): () => void {
  const decoder = new TextDecoder();
  const handler: DataHandler = (payload, participant, _kind, topic) => {
    if (topic !== RTA_EXTERNAL_SPEECH_STATE_TOPIC) return;
    // Viewers can publish room data too. Only the worker's agent participant is authoritative.
    const identity = participant?.identity;
    if (identity && !identity.startsWith("agent-")) return;
    try {
      const parsed = externalSpeechStateFrameSchema.safeParse(JSON.parse(decoder.decode(payload)));
      if (parsed.success) onState(parsed.data);
    } catch {
      // A malformed or unrelated room packet is not a call failure.
    }
  };
  room.on("dataReceived", handler);
  return () => { room.off("dataReceived", handler); };
}

export type { ExternalSpeechStateFrame };
