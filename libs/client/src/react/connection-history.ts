import {
  MAX_CONNECTION_HISTORY_BATCH,
  MAX_CONNECTION_HISTORY_OBSERVATIONS,
  type ConnectionHistoryGrant,
  type ConnectionHistoryObservation,
  type ConnectionHistoryUpload,
} from "../../../http-client/src/generated/connection-history.ts";
import type { AvatarConnectionDetails } from "./session-lifecycle";

type Clock = { wallMs: () => number; monotonicMs: () => number };

/**
 * Capability-gated, best-effort connection history. It owns no LiveKit listeners:
 * the room bridge supplies its already-deduplicated native snapshot. Upload work is
 * queued in microtasks and bounded so it never delays a LiveKit event or call action.
 */
export function createConnectionHistoryCollector(input: {
  sessionId: string;
  grant: ConnectionHistoryGrant;
  fetch?: typeof fetch;
  clock?: Partial<Clock>;
  maxRetries?: number;
}) {
  const fetcher = input.fetch ?? ((request: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(request, init));
  const wallMs = input.clock?.wallMs ?? Date.now;
  const monotonicMs = input.clock?.monotonicMs ?? (() => globalThis.performance?.now() ?? Date.now());
  const startedAt = monotonicMs();
  const wallStartedAt = wallMs();
  const queue: ConnectionHistoryObservation[] = [];
  let sequence = 0;
  let scheduled = false;
  let flushing: Promise<void> | null = null;
  let disposed = false;
  let lastSnapshot: Pick<ConnectionHistoryObservation, "connectionState" | "localQuality" | "audioQuality" | "videoQuality"> | null = null;

  function enqueue(details: AvatarConnectionDetails | null): void {
    if (disposed || details === null || sequence >= MAX_CONNECTION_HISTORY_OBSERVATIONS) return;
    const elapsedMs = Math.max(0, Math.min(86_400_000, Math.round(monotonicMs() - startedAt)));
    const nextSnapshot: Pick<ConnectionHistoryObservation, "connectionState" | "localQuality" | "audioQuality" | "videoQuality"> = {
      connectionState: details.connectionState,
      localQuality: details.localQuality,
      audioQuality: details.audio?.publisherQuality ?? null,
      videoQuality: details.video?.publisherQuality ?? null,
    };
    const prior = lastSnapshot;
    if (prior && prior.connectionState === nextSnapshot.connectionState && prior.localQuality === nextSnapshot.localQuality
      && prior.audioQuality === nextSnapshot.audioQuality && prior.videoQuality === nextSnapshot.videoQuality) return;
    lastSnapshot = nextSnapshot;
    const value: ConnectionHistoryObservation = {
      sequence: sequence + 1,
      elapsedMs,
      clientObservedAt: new Date(wallStartedAt + elapsedMs).toISOString(),
      ...nextSnapshot,
    };
    sequence = value.sequence;
    queue.push(value);
    if (queue.length >= MAX_CONNECTION_HISTORY_BATCH) void flush();
    else scheduleFlush();
  }

  function scheduleFlush(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flush();
    });
  }

  async function send(batch: ConnectionHistoryObservation[]): Promise<void> {
    if (Date.parse(input.grant.expiresAt) <= wallMs()) return;
    const payload: ConnectionHistoryUpload = { sessionId: input.sessionId, observations: batch };
    const retries = Math.max(0, Math.min(2, input.maxRetries ?? 2));
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (Date.parse(input.grant.expiresAt) <= wallMs()) return;
        const response = await fetcher(input.grant.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${input.grant.token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return;
        if (response.status < 500 && response.status !== 429) return;
        await response.body?.cancel().catch(() => {});
      } catch {
        // Connection history is optional telemetry; a failed request never reaches the call.
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }

  async function flush(): Promise<void> {
    if (queue.length === 0) return;
    if (flushing) return flushing;
    flushing = (async () => {
      try {
        while (queue.length) {
          const batch = queue.splice(0, MAX_CONNECTION_HISTORY_BATCH);
          await send(batch);
        }
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    await flush();
    queue.length = 0;
  }

  return { enqueue, flush, dispose };
}
