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

/** The frame's `kind`, for the room bridge's sender check before full validation. */
export const EXTERNAL_PERFORMANCE_KIND = externalPerformanceFrameSchema.shape.kind.value;

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

const statusSchema = externalPerformanceFrameSchema.shape.status;
/**
 * The statuses whose transitions this SDK knows: the enum arm of the contract's open `status`.
 * A status a newer worker adds still parses, and the observer skips it rather than guessing.
 */
export const KNOWN_EXTERNAL_PERFORMANCE_STATUSES = Object.freeze([...statusSchema.options[0].options]);
export type KnownExternalPerformanceStatus = (typeof KNOWN_EXTERNAL_PERFORMANCE_STATUSES)[number];
/** What `onFrame` receives: a contract frame whose status is one this SDK knows. */
export type ObservedExternalPerformanceFrame = ExternalPerformanceFrame & { status: KnownExternalPerformanceStatus };

export type ExternalPerformanceObserver = {
  onFrame: (frame: ObservedExternalPerformanceFrame) => void;
  onInvalidated: (reason: ExternalPerformanceInvalidation) => void;
};

const knownStatuses = new Set<string>(KNOWN_EXTERNAL_PERFORMANCE_STATUSES);
function isObservable(frame: ExternalPerformanceFrame): frame is ObservedExternalPerformanceFrame {
  return knownStatuses.has(frame.status);
}

type Status = KnownExternalPerformanceStatus;
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
      if (state !== "live" || frame.session_id !== sessionId || !isObservable(frame)) return;
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
