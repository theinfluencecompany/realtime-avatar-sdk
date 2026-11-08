// ---------------------------------------------------------------------------
// External performance: what the worker says about each generation of an opt-in external-LLM
// call (`llm.performance: "v1"`) — admitted, refused, released to the audio gate, cancelled.
//
// It is NOT a playout clock. The producer declares `audible_checkpoint` and `audio_mapping`
// unavailable, and public LiveKit exposes no receiver sample position per generation, so
// nothing here says when a sound was heard. A data-channel arrival is not playback.
// ---------------------------------------------------------------------------
import { externalPerformanceFrameSchema, type ExternalPerformanceFrame } from "../../http-client/src/generated/external-performance.ts";

export type { ExternalPerformanceFrame };

/** What a player may take from these frames: admission and cancellation, never playout timing. */
export const EXTERNAL_PERFORMANCE_TIMING = Object.freeze({
  receiverPlayout: "unsupported",
  audibleCheckpoint: externalPerformanceFrameSchema.shape.audible_checkpoint.value,
  audioMapping: externalPerformanceFrameSchema.shape.audio_mapping.value,
} as const);

/**
 * Why every pending generation is void. `connection_lost` pauses observation: after the call
 * reconnects, frames resume for generations first seen since, never the earlier ones. `ended`
 * and `binding_changed` (the grant was replaced, or observation was turned off) are final.
 */
export type ExternalPerformanceInvalidation = "connection_lost" | "ended" | "binding_changed";

export type ExternalPerformanceObserver = {
  onFrame: (frame: ExternalPerformanceFrame) => void;
  onInvalidated: (reason: ExternalPerformanceInvalidation) => void;
};

type Status = ExternalPerformanceFrame["status"];
type Ledger = Status | "unseen" | "retired";

// The worker's own transitions, as the platform documents them: admission or a refused draft
// first, release only after admission, cancellation only of admitted work, and a terminal status
// wins over anything later. Every other frame is a duplicate or stale.
const NEXT: Readonly<Record<Ledger, ReadonlySet<Status>>> = {
  unseen: new Set(["accepted", "dropped"]),
  accepted: new Set(["audio_released", "cancelled"]),
  audio_released: new Set(["cancelled"]),
  dropped: new Set(),
  cancelled: new Set(),
  retired: new Set(),
};

// A generation that finishes normally never gets a terminal frame, so the ledger forgets the
// oldest generation instead of refusing a long call.
const LEDGER_LIMIT = 4096;

function deliver(callback: () => unknown): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    /* An observer must not interrupt the call. */
  }
}

/** One grant's observer. Frames reach it already validated against the canonical schema. */
export function createExternalPerformanceObserver(sessionId: string, callbacks: ExternalPerformanceObserver) {
  const generations = new Map<string, Ledger>();
  let state: "live" | "paused" | "closed" = "live";
  return {
    receive(frame: ExternalPerformanceFrame): void {
      if (state !== "live" || frame.session_id !== sessionId) return;
      const previous = generations.get(frame.generation_id) ?? "unseen";
      if (!NEXT[previous].has(frame.status)) return;
      if (previous === "unseen" && generations.size >= LEDGER_LIMIT) {
        const oldest = generations.keys().next();
        if (!oldest.done) generations.delete(oldest.value);
      }
      generations.set(frame.generation_id, frame.status);
      deliver(() => callbacks.onFrame(frame));
    },
    invalidate(reason: ExternalPerformanceInvalidation): void {
      if (state === "closed" || (state === "paused" && reason === "connection_lost")) return;
      state = reason === "connection_lost" ? "paused" : "closed";
      if (state === "closed") generations.clear();
      else for (const id of generations.keys()) generations.set(id, "retired");
      deliver(() => callbacks.onInvalidated(reason));
    },
    /** The call is connected to its agent again. Only a connection loss can be resumed. */
    resume(): void {
      if (state === "paused") state = "live";
    },
  };
}

export type ExternalPerformanceObserverHandle = ReturnType<typeof createExternalPerformanceObserver>;
