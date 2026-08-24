/**
 * The browser tool plane, without React.
 *
 * The platform's own `useAvatarTools` is a React hook. This is the same wire protocol for
 * anyone driving `livekit-client` directly — a plain page, Svelte, Vue, a game canvas.
 *
 * Two things decide the shape and are worth stating, because both are easy to get wrong:
 *
 * 1. The manifest is registered over **RPC after connect**, never on the mint. The mint
 *    request schema is strict and 422s on an unknown key, so a tools[] field there fails the
 *    whole call.
 * 2. The **grant** is the gate. The worker only exposes the registration method for a session
 *    minted with the `client_tools` capability, which your server decides. If registration
 *    reports the method is missing, the mint did not grant it — the fix is server-side.
 */

/** Caps the wire enforces. Exceeding them is a rejection, not a truncation. */
export const MAX_TOOLS = 32;
export const MAX_MANIFEST_BYTES = 12_000;
export const MAX_RESULT_CHARS = 8_192;

/**
 * The worker abandons a tool call after this long and tells her it failed.
 *
 * It is a conversational floor, not a config knob: past a couple of seconds of silence the
 * call stops feeling live. Anything slower than this must return immediately and deliver its
 * real answer another way — put the result on screen, or hand it back on a later turn.
 */
export const TOOL_DEADLINE_MS = 2_500;

const REGISTER_METHOD = "rta.tools.register";
const INVOKE_METHOD = "rta.tool.invoke";
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * One tool. Structurally the Vercel AI SDK's `tool()` object, so an AI SDK tool passes
 * straight through — but nothing is imported, so you do not need the AI SDK to use this.
 */
/** Passed to every tool. `signal` aborts when the worker gives up on this call. */
export interface ToolContext {
  signal: AbortSignal;
  callId: string;
}

export interface AvatarTool<Args = Record<string, unknown>> {
  description: string;
  /** JSON Schema for the arguments object. With the AI SDK use `z.toJSONSchema(schema)`. */
  parameters: Record<string, unknown>;
  execute: (args: Args, context: ToolContext) => Promise<unknown> | unknown;
}

/**
 * A tool as held in the registry.
 *
 * `never` in the argument position is deliberate: under `strictFunctionTypes` a narrowly
 * typed `execute({ order_id }: { order_id: string })` is NOT assignable to one taking
 * `Record<string, unknown>` (parameters are contravariant), and writing the narrow type is
 * exactly how a developer will author a tool. `never` is assignable to any parameter type,
 * so authoring stays natural and the one unsafe step is the single documented cast below.
 */
export type RegisteredTool = {
  description: string;
  parameters?: Record<string, unknown>;
  execute: (args: never, context: ToolContext) => Promise<unknown> | unknown;
};

export interface ToolRegistration {
  accepted: string[];
  rejected: Array<{ name: string; reason: string }>;
}

/** The subset of a LiveKit Room this needs — kept structural so it is trivial to fake. */
interface RoomLike {
  localParticipant: {
    registerRpcMethod(method: string, handler: (data: { payload: string }) => Promise<string>): void;
    performRpc(options: {
      destinationIdentity: string;
      method: string;
      payload: string;
    }): Promise<string>;
  };
  remoteParticipants: Map<string, { identity: string }>;
}

/** Every remote participant worth trying, agent-looking identities first.
 *
 *  Ordering is a heuristic on the identity string rather than `ParticipantKind`, because this
 *  module imports nothing from `livekit-client` and comparing against an enum's numeric value
 *  would be a worse dependency than a name check. It is only an ORDER: if the guess is wrong we
 *  still try everyone, so a room whose agent is named something else costs one extra round-trip
 *  and nothing else. */
function candidateIdentities(room: RoomLike): string[] {
  const all = Array.from(room.remoteParticipants.values(), (p) => p.identity).filter(Boolean);
  const agents = all.filter((id) => /^agent[-_]/i.test(id));
  return [...agents, ...all.filter((id) => !agents.includes(id))];
}

/** Did this RPC fail because the method is not there (yet), as opposed to a real error?
 *
 *  Matched on the shape livekit-client produces rather than by importing `RpcError`, to keep
 *  this module dependency-free. Both codes mean "try again / try someone else", never "give up". */
function methodMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "UNSUPPORTED_METHOD" || code === "RECIPIENT_NOT_FOUND" || code === 1401 || code === 1402) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not supported|unsupported_method|recipient_not_found|recipient not found/i.test(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Drop bad tools with a reason rather than failing the whole manifest. */
function buildManifest(tools: Record<string, RegisteredTool>): {
  descriptors: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  rejected: Array<{ name: string; reason: string }>;
} {
  const descriptors = [];
  const rejected = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!NAME_RE.test(name)) {
      rejected.push({ name, reason: "name must match [a-zA-Z0-9_-]{1,64}" });
      continue;
    }
    if (!tool?.description) {
      rejected.push({ name, reason: "description is required — it is how she knows when to call it" });
      continue;
    }
    if (typeof tool.execute !== "function") {
      rejected.push({ name, reason: "execute must be a function" });
      continue;
    }
    if (descriptors.length >= MAX_TOOLS) {
      rejected.push({ name, reason: `over the ${MAX_TOOLS}-tool limit for one session` });
      continue;
    }
    descriptors.push({ name, description: tool.description, parameters: tool.parameters ?? {} });
  }
  return { descriptors, rejected };
}

/**
 * Register your tools and start answering calls to them.
 *
 * ```ts
 * await attachAvatarTools(room, {
 *   check_order: {
 *     description: "Look up an order's delivery status. Call this whenever the user asks " +
 *       "where something is or when it will arrive.",
 *     parameters: { type: "object", properties: { order_id: { type: "string" } },
 *                   required: ["order_id"] },
 *     execute: async ({ order_id }) => api.order(order_id),
 *   },
 * });
 * ```
 *
 * Call it once the room is connected. It waits for the agent by itself, so you do not have to
 * time it: joining the room and ARMING the registration method are not the same instant, and
 * registering in that gap fails with "method not supported at destination" — the SAME error a
 * session without the `client_tools` grant produces. That collision is why this retries rather
 * than throwing: an ungranted session and a two-hundred-millisecond race are indistinguishable
 * from one attempt, and guessing wrong sends you to the wrong layer entirely.
 *
 * Returns what was armed and what was dropped — a tool in `rejected` is silently uncallable
 * otherwise, which reads exactly like the model ignoring it.
 */
export async function attachAvatarTools(
  room: RoomLike,
  tools: Record<string, RegisteredTool>,
  options: {
    onInvoke?: (name: string, args: unknown) => void;
    /** How long to keep waiting for the agent to arm its side. Default 8000ms. */
    timeoutMs?: number;
  } = {},
): Promise<ToolRegistration> {
  const { descriptors, rejected } = buildManifest(tools);
  const payload = JSON.stringify({ tools: descriptors });
  if (payload.length > MAX_MANIFEST_BYTES) {
    throw new Error(
      `tool manifest is ${payload.length} bytes, over the ${MAX_MANIFEST_BYTES} limit — ` +
        "shorten descriptions or register fewer tools",
    );
  }

  // Answer invocations. Registered BEFORE the manifest so a fast first call cannot race us.
  room.localParticipant.registerRpcMethod(INVOKE_METHOD, async ({ payload }) => {
    let name = "", callId = "";
    try {
      const req = JSON.parse(payload) as { name: string; args: string; call_id: string };
      name = req.name;
      callId = req.call_id;
      const tool = tools[name];
      if (!tool) return JSON.stringify({ ok: false, call_id: callId, error: `no tool named ${name}` });
      const args = req.args ? (JSON.parse(req.args) as Record<string, unknown>) : {};
      options.onInvoke?.(name, args);
      // The one unsafe step, isolated: the wire always hands us a parsed object, and the
      // registry type widened `execute` to accept it (see RegisteredTool).
      const run = tool.execute as (
        a: Record<string, unknown>, c: ToolContext,
      ) => Promise<unknown> | unknown;

      // Abort at the worker's own deadline so a slow tool stops burning work nobody will
      // read. NOTE the guarantee is asymmetric: AbortSignal is cooperative, so a handler
      // that ignores it can still finish late and commit a side effect — its RESULT just
      // cannot come back. Make slow side effects idempotent, or check the signal.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TOOL_DEADLINE_MS);
      let result: unknown;
      try {
        result = await run(args, { signal: controller.signal, callId });
      } finally {
        clearTimeout(timer);
      }
      const encoded = typeof result === "string" ? result : JSON.stringify(result ?? null);
      if (encoded.length > MAX_RESULT_CHARS) {
        // Truncating silently would hand the model a broken JSON fragment to reason over.
        return JSON.stringify({
          ok: false, call_id: callId,
          error: `result was ${encoded.length} chars, over the ${MAX_RESULT_CHARS} limit`,
        });
      }
      return JSON.stringify({ ok: true, call_id: callId, result: encoded });
    } catch (error) {
      // Never throw out of an RPC handler: livekit's fallback is the literal string
      // "An internal error occurred", which she would then say out loud.
      return JSON.stringify({
        ok: false, call_id: callId,
        error: error instanceof Error ? error.message : "tool failed",
      });
    }
  });

  // Publish the manifest. Two things can make an attempt fail without meaning failure: the
  // agent has not joined yet (no candidates at all), and the agent is here but has not armed
  // the method yet. Both are transient, both look terminal from one try, so poll until the
  // deadline. Candidates are re-read every round because the agent may arrive mid-wait.
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 8_000);
  let lastError: unknown = null;
  let sawCandidate = false;

  for (;;) {
    for (const identity of candidateIdentities(room)) {
      sawCandidate = true;
      try {
        const raw = await room.localParticipant.performRpc({
          destinationIdentity: identity,
          method: REGISTER_METHOD,
          payload,
        });
        const result = JSON.parse(raw) as ToolRegistration;
        return {
          accepted: result.accepted ?? [],
          rejected: [...rejected, ...(result.rejected ?? [])],
        };
      } catch (error) {
        lastError = error;
        // A real failure from the right participant is worth surfacing immediately; only
        // "the method is not there" earns another round.
        if (!methodMissing(error)) throw error;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(200);
  }

  // Deliberately names BOTH causes. The single most expensive failure in this plane is reading
  // this error as "my key is not entitled" when the agent simply had not armed the method.
  throw new Error(
    sawCandidate
      ? "no participant accepted the tool manifest — either this session was not minted with " +
        "the `client_tools` capability (a server-side grant), or the agent never armed " +
        `registration within ${options.timeoutMs ?? 8_000}ms` +
        (lastError instanceof Error ? ` (last error: ${lastError.message})` : "")
      : "no remote participant joined the room before the timeout — nothing to register with",
  );
}
