import assert from "node:assert/strict";
import { test } from "node:test";
import { attachAvatarTools, MAX_RESULT_CHARS } from "../src/index.ts";

function fakeRoom() {
  const state: { handler?: (d: { payload: string }) => Promise<string>; registered?: unknown } = {};
  const room = {
    localParticipant: {
      registerRpcMethod: (_m: string, h: (d: { payload: string }) => Promise<string>) => { state.handler = h; },
      performRpc: async ({ payload }: { payload: string }) => {
        state.registered = JSON.parse(payload);
        const names = (state.registered as { tools: { name: string }[] }).tools.map((t) => t.name);
        return JSON.stringify({ accepted: names, rejected: [] });
      },
    },
    remoteParticipants: new Map([["a", { identity: "agent-1" }]]),
  };
  return { room, state };
}

const ok = {
  description: "Look up an order.",
  parameters: { type: "object", properties: { order_id: { type: "string" } } },
  execute: async ({ order_id }: { order_id: string }) => ({ order_id, status: "shipped" }),
};

test("registers a manifest and arms the tools", async () => {
  const { room, state } = fakeRoom();
  const r = await attachAvatarTools(room, { check_order: ok });
  assert.deepEqual(r.accepted, ["check_order"]);
  assert.equal((state.registered as { tools: unknown[] }).tools.length, 1);
});

test("a bad tool is dropped with a reason, not silently ignored", async () => {
  const { room } = fakeRoom();
  const r = await attachAvatarTools(room, {
    "bad name!": ok,
    no_desc: { description: "", parameters: {}, execute: async () => 1 },
    check_order: ok,
  });
  assert.deepEqual(r.accepted, ["check_order"]);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0]!.reason, /a-zA-Z0-9_-/);
});

test("an invocation runs the tool and returns its result", async () => {
  const { room, state } = fakeRoom();
  await attachAvatarTools(room, { check_order: ok });
  const out = JSON.parse(await state.handler!({
    payload: JSON.stringify({ name: "check_order", args: '{"order_id":"A1"}', call_id: "c1" }),
  }));
  assert.equal(out.ok, true);
  assert.equal(out.call_id, "c1");
  assert.deepEqual(JSON.parse(out.result), { order_id: "A1", status: "shipped" });
});

test("a throwing tool becomes an error result, never an RPC throw", async () => {
  const { room, state } = fakeRoom();
  await attachAvatarTools(room, {
    boom: { description: "x", parameters: {}, execute: async () => { throw new Error("upstream is down"); } },
  });
  // If this threw, livekit substitutes "An internal error occurred" — which she says out loud.
  const out = JSON.parse(await state.handler!({
    payload: JSON.stringify({ name: "boom", args: "{}", call_id: "c2" }),
  }));
  assert.equal(out.ok, false);
  assert.match(out.error, /upstream is down/);
});

test("an oversize result is refused rather than truncated", async () => {
  const { room, state } = fakeRoom();
  await attachAvatarTools(room, {
    big: { description: "x", parameters: {}, execute: async () => "z".repeat(MAX_RESULT_CHARS + 10) },
  });
  const out = JSON.parse(await state.handler!({
    payload: JSON.stringify({ name: "big", args: "{}", call_id: "c3" }),
  }));
  // Truncating would hand the model a broken JSON fragment to reason over.
  assert.equal(out.ok, false);
  assert.match(out.error, /over the/);
});

test("an unknown tool name is answered, not thrown", async () => {
  const { room, state } = fakeRoom();
  await attachAvatarTools(room, { check_order: ok });
  const out = JSON.parse(await state.handler!({
    payload: JSON.stringify({ name: "nope", args: "{}", call_id: "c4" }),
  }));
  assert.equal(out.ok, false);
});

test("a tool gets an abort signal at the worker's own deadline", async () => {
  const { room, state } = fakeRoom();
  let sawSignal = false, aborted = false;
  await attachAvatarTools(room, {
    slow: {
      description: "x", parameters: {},
      execute: async (_args, ctx) => {
        sawSignal = ctx.signal instanceof AbortSignal;
        ctx.signal.addEventListener("abort", () => { aborted = true; });
        return "fast enough";
      },
    },
  });
  const out = JSON.parse(await state.handler!({
    payload: JSON.stringify({ name: "slow", args: "{}", call_id: "c9" }),
  }));
  assert.equal(out.ok, true);
  assert.ok(sawSignal, "every tool receives a signal it can cooperate with");
  // The guarantee is ASYMMETRIC: an ignoring handler can still finish late and commit a side
  // effect — only its result is discarded. Slow side effects must be idempotent.
  assert.equal(aborted, false, "a fast tool is never aborted");
});

// ── registration: the join/arm race, and who we address ────────────────────────────────────
// Both defects below produced the SAME error as a missing `client_tools` grant, which is the
// reason they were expensive: the message points at the server, the cause was the client.

class MissingMethod extends Error {
  code = "UNSUPPORTED_METHOD";
  constructor() { super("Method not supported at destination"); }
}

test("retries while the agent is present but has not armed the method yet", async () => {
  let attempts = 0;
  const room = {
    localParticipant: {
      registerRpcMethod: () => {},
      performRpc: async ({ payload }: { payload: string }) => {
        attempts += 1;
        if (attempts < 3) throw new MissingMethod(); // joined, not yet serving
        const names = (JSON.parse(payload) as { tools: { name: string }[] }).tools.map((t) => t.name);
        return JSON.stringify({ accepted: names, rejected: [] });
      },
    },
    remoteParticipants: new Map([["a", { identity: "agent-1" }]]),
  };
  const r = await attachAvatarTools(room, { check_order: ok }, { timeoutMs: 4000 });
  assert.deepEqual(r.accepted, ["check_order"]);
  assert.equal(attempts, 3, "kept trying instead of reporting a grant problem");
});

test("waits for an agent that has not joined yet", async () => {
  const remoteParticipants = new Map<string, { identity: string }>();
  const room = {
    localParticipant: {
      registerRpcMethod: () => {},
      performRpc: async ({ payload }: { payload: string }) => {
        const names = (JSON.parse(payload) as { tools: { name: string }[] }).tools.map((t) => t.name);
        return JSON.stringify({ accepted: names, rejected: [] });
      },
    },
    remoteParticipants,
  };
  setTimeout(() => remoteParticipants.set("a", { identity: "agent-late" }), 300);
  const r = await attachAvatarTools(room, { check_order: ok }, { timeoutMs: 4000 });
  assert.deepEqual(r.accepted, ["check_order"]);
});

test("addresses the agent, not whichever participant happens to be first", async () => {
  const seen: string[] = [];
  const room = {
    localParticipant: {
      registerRpcMethod: () => {},
      performRpc: async ({ destinationIdentity, payload }: { destinationIdentity: string; payload: string }) => {
        seen.push(destinationIdentity);
        if (destinationIdentity !== "agent-1") throw new MissingMethod();
        const names = (JSON.parse(payload) as { tools: { name: string }[] }).tools.map((t) => t.name);
        return JSON.stringify({ accepted: names, rejected: [] });
      },
    },
    // A human is first in insertion order — the old code addressed them and gave up.
    remoteParticipants: new Map([["h", { identity: "human-viewer" }], ["a", { identity: "agent-1" }]]),
  };
  const r = await attachAvatarTools(room, { check_order: ok }, { timeoutMs: 4000 });
  assert.deepEqual(r.accepted, ["check_order"]);
  assert.equal(seen[0], "agent-1", "agent-looking identities are tried first");
});

test("a real error is surfaced at once, not retried until the deadline", async () => {
  const room = {
    localParticipant: {
      registerRpcMethod: () => {},
      performRpc: async () => { throw new Error("connection reset"); },
    },
    remoteParticipants: new Map([["a", { identity: "agent-1" }]]),
  };
  await assert.rejects(
    () => attachAvatarTools(room, { check_order: ok }, { timeoutMs: 4000 }),
    /connection reset/,
  );
});

test("the give-up error names the race as well as the grant", async () => {
  const room = {
    localParticipant: {
      registerRpcMethod: () => {},
      performRpc: async () => { throw new MissingMethod(); },
    },
    remoteParticipants: new Map([["a", { identity: "agent-1" }]]),
  };
  await assert.rejects(
    () => attachAvatarTools(room, { check_order: ok }, { timeoutMs: 300 }),
    (err: Error) => /client_tools/.test(err.message) && /armed registration/.test(err.message),
  );
});
