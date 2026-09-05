/**
 * A tool as both hosts describe it to the platform: a name, what it is for, and the JSON
 * schema of its arguments. It is exactly the shape `attachAvatarTools` (vanilla) and the
 * hosted tool plane (React) build their manifests from; only the handler differs per host,
 * so the handler is deliberately not here.
 */
export interface ToolDescriptor {
  /** `^[a-zA-Z0-9_-]{1,64}$` — the one shape every LLM provider accepts for a function name. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** A descriptor married to its host's handler — the record `attachAvatarTools` takes. */
export interface ToolWithHandler<Args = Record<string, unknown>> {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Args, context: { signal: AbortSignal; callId: string }) => unknown | Promise<unknown>;
}

/**
 * Marry shared descriptors to a host's handlers. Every descriptor must get a handler and no
 * handler may name a tool the descriptors do not — both throw at build time, because a tool
 * she is briefed on but cannot call is the failure the descriptors exist to prevent.
 */
export function toolSet(
  descriptors: readonly ToolDescriptor[],
  handlers: Record<string, ToolWithHandler["execute"]>,
): Record<string, ToolWithHandler> {
  const out: Record<string, ToolWithHandler> = {};
  for (const d of descriptors) {
    const execute = handlers[d.name];
    if (typeof execute !== "function") throw new Error(`toolSet: no handler for tool "${d.name}"`);
    out[d.name] = { description: d.description, parameters: d.parameters, execute };
  }
  for (const name of Object.keys(handlers)) {
    if (!out[name]) throw new Error(`toolSet: handler "${name}" has no descriptor`);
  }
  return out;
}
