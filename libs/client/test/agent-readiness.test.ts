import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { ConnectionState, DisconnectReason } from "livekit-client";
import type { AvatarSessionClient, RealtimeSessionApi, useRealtimeSession as UseRealtimeSession } from "../src/react/index.ts";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    addEventListener() {}, removeEventListener() {},
  },
});
globalThis.fetch = async () => new Response(null, { status: 204 });
const sdk: { useRealtimeSession: typeof UseRealtimeSession } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);
const SESSION = { avatarId: "ava_readiness" };

async function fixture(t: TestContext, options: { readyTimeoutSeconds?: number; connectWatchdogSeconds?: number; maxReconnectAttempts?: number } = { readyTimeoutSeconds: 3, connectWatchdogSeconds: 1 }) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const ledger = { mints: 0, releases: [] as string[], leaves: 0, ended: [] as string[] };
  let nextAnswer: "ready" | "pending" = "ready";
  let complete: (() => void) | undefined;
  const client: AvatarSessionClient = {
    async createLiveKitSessionOrBusy() {
      ledger.mints += 1;
      const mint = ledger.mints;
      if (nextAnswer === "pending") await new Promise<void>((resolve) => { complete = resolve; });
      return { status: "ready", grant: {
        status: "ready", session_id: `readiness_${mint}`, room_name: "room", livekit_url: "wss://test.invalid",
        participant_token: "token", participant_identity: "user", max_session_seconds: 600,
        idle_timeout_seconds: 120, join_timeout_seconds: 75, reservation_expires_at: "2026-10-10T00:00:00Z",
        stt_mode: "server", room_created: true, dispatch_created: true,
      } };
    },
    async releaseLiveKitSession(id, reason) { ledger.releases.push(`${id}:${reason}`); return true; },
    releaseLiveKitSessionBeacon: () => false,
    releaseLiveKitQueueTicket: async () => true,
    releaseLiveKitQueueTicketBeacon: () => false,
  };
  let current: RealtimeSessionApi | undefined;
  let active = true;
  let target = SESSION;
  function Call(): null {
    current = sdk.useRealtimeSession({ client, session: target, active, ...options,
      reconnectBackoffMs: [100], onEnded: ({ reason }) => ledger.ended.push(reason) });
    return null;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(Call)); });
  const read = () => { assert.ok(current); return current; };
  await act(async () => { read().registerLeaveRoom(() => {
    ledger.leaves += 1;
    read().onDisconnected(DisconnectReason.CLIENT_INITIATED);
  }); });
  const tick = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); };
  const connected = async () => { await act(async () => read().onConnected()); };
  const agent = async () => { await act(async () => read().setAgentPresent(true)); };
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => renderer.unmount()); } };
  t.after(unmount);
  return { read, tick, connected, agent, ledger, unmount,
    holdNextGrant() { nextAnswer = "pending"; },
    async landGrant() { await act(async () => complete?.()); },
    async changeTarget() { target = { avatarId: "ava_replacement" }; await act(async () => renderer.update(createElement(Call))); },
    async deactivate() { active = false; await act(async () => renderer.update(createElement(Call))); },
  };
}

test("a connected room without its agent fails within ONE budget, across fresh grants and signal reconnects", async (t) => {
  const f = await fixture(t);
  await f.connected();
  assert.equal(f.read().phase.kind, "connecting");
  await f.tick(1_000);
  assert.equal(f.read().phase.kind, "reconnectable", "the absent agent left the room waiting forever");
  assert.equal(f.ledger.leaves, 1, "a failed startup must stop microphone capture and leave its room");
  await f.tick(100);
  assert.equal(f.ledger.mints, 2);
  await f.connected();
  await f.tick(500);
  await act(async () => f.read().onConnectionStateChange(ConnectionState.SignalReconnecting));
  await f.tick(300);
  await f.connected();
  await f.tick(200);
  await f.tick(100);
  assert.equal(f.ledger.mints, 3);
  await f.connected();
  await f.tick(800);
  assert.deepEqual(f.read().phase, { kind: "ended", reason: "error", code: "agent_timeout" });
  assert.deepEqual(f.ledger.ended, ["failed"]);
  const atFailure = f.ledger.mints;
  await act(async () => { f.read().onConnected(); f.read().setAgentPresent(true); f.read().onDisconnected(); });
  await f.tick(60_000);
  assert.equal(f.ledger.mints, atFailure, "late room callbacks restarted a failed call");
  assert.equal(f.read().phase.kind, "ended");
  assert.equal(f.read().grant, null);
  assert.equal(new Set(f.ledger.releases.map((r) => r.split(":")[0])).size, atFailure);
});

test("an agent arriving before the deadline makes the call live and established in-place recovery keeps its grant", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.tick(900);
  await f.agent();
  assert.equal(f.read().phase.kind, "live");
  await act(async () => f.read().onConnectionStateChange(ConnectionState.SignalReconnecting));
  await f.tick(10_000);
  assert.equal(f.ledger.mints, 1);
  assert.deepEqual(f.ledger.releases, []);
  await f.connected();
  assert.equal(f.read().phase.kind, "live");
});

test("transport connection alone does not reset the bounded retry count", async (t) => {
  const f = await fixture(t, { readyTimeoutSeconds: 3, connectWatchdogSeconds: 1 });
  await f.connected();
  await f.tick(1_000);
  await f.tick(100);
  await f.connected();
  assert.equal(f.read().attempt, 1);
  await f.agent();
  assert.equal(f.read().attempt, 0, "only usable room + agent readiness resets the retry budget");
});

test("manual retry starts a fresh readiness budget after terminal failure", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.tick(3_000);
  assert.equal(f.read().phase.kind, "ended");
  await act(async () => f.read().reconnect());
  await f.connected();
  await f.agent();
  assert.equal(f.read().phase.kind, "live");
  await f.tick(4_000);
  assert.equal(f.read().phase.kind, "live");
});

test("a user hang-up cancels the readiness deadline and cannot mint a recovery", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.tick(500);
  await act(async () => f.read().end("user_ended"));
  await f.tick(60_000);
  assert.equal(f.ledger.mints, 1);
  assert.equal(f.read().phase.kind, "ended");
  assert.deepEqual(f.ledger.ended, ["user_ended"]);
});

test("deactivating cancels the deadline and releases its held grant", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.deactivate();
  await f.tick(60_000);
  assert.equal(f.ledger.mints, 1);
  assert.equal(f.read().phase.kind, "idle");
  assert.equal(f.ledger.releases.length, 1);
});

test("unmounting cancels the readiness timers and never requests another session", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.unmount();
  await f.tick(60_000);
  assert.equal(f.ledger.mints, 1);
  assert.equal(f.ledger.releases.length, 1);
});

test("an in-flight replacement cannot extend the budget, and its late grant is released", async (t) => {
  const f = await fixture(t);
  await f.connected();
  f.holdNextGrant();
  await f.tick(1_000);
  await f.tick(100);
  assert.equal(f.ledger.mints, 2);
  await f.tick(1_900);
  assert.deepEqual(f.read().phase, { kind: "ended", reason: "error", code: "agent_timeout" });
  await f.landGrant();
  assert.equal(f.read().grant, null);
  assert.ok(f.ledger.releases.includes("readiness_2:superseded"));
  await f.tick(60_000);
  assert.equal(f.ledger.mints, 2);
});

test("no room connection produces a transport timeout, not a missing-agent claim", async (t) => {
  const f = await fixture(t, { readyTimeoutSeconds: 3, connectWatchdogSeconds: 0 });
  await f.tick(3_000);
  assert.deepEqual(f.read().phase, { kind: "ended", reason: "error", code: "connection_timeout" });
  assert.equal(f.ledger.mints, 1);
});

test("the default overall readiness limit is thirty seconds even with per-attempt recovery disabled", async (t) => {
  const f = await fixture(t, { connectWatchdogSeconds: 0 });
  await f.connected();
  await f.tick(29_999);
  assert.equal(f.read().phase.kind, "connecting");
  await f.tick(1);
  assert.deepEqual(f.read().phase, { kind: "ended", reason: "error", code: "agent_timeout" });
});

test("exhausting the configured retry count ends with an error before the overall budget", async (t) => {
  const f = await fixture(t, { readyTimeoutSeconds: 30, connectWatchdogSeconds: 1, maxReconnectAttempts: 1 });
  await f.connected();
  await f.tick(1_000);
  await f.tick(100);
  await f.connected();
  await f.tick(1_000);
  assert.deepEqual(f.read().phase, { kind: "ended", reason: "error", code: "agent_timeout" });
  assert.equal(f.ledger.mints, 2);
  await f.tick(60_000);
  assert.equal(f.ledger.mints, 2);
});

test("a deliberate server end during startup is not later rewritten as a readiness error", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await act(async () => f.read().onDisconnected(DisconnectReason.ROOM_DELETED));
  assert.deepEqual(f.read().phase, { kind: "ended" });
  await f.tick(60_000);
  assert.deepEqual(f.read().phase, { kind: "ended" });
  assert.equal(f.ledger.mints, 1);
  assert.deepEqual(f.ledger.ended, ["disconnected"]);
});

test("callbacks retained by an old room cannot ready or release its replacement grant", async (t) => {
  const f = await fixture(t);
  await f.connected();
  const oldRoom = f.read();
  await f.tick(1_000);
  await f.tick(100);
  assert.equal(f.read().grant?.session_id, "readiness_2");
  const released = [...f.ledger.releases];
  await act(async () => { oldRoom.onConnected(); oldRoom.setAgentPresent(true); });
  assert.notEqual(f.read().phase.kind, "live", "the retired room falsely readied the new call");
  await act(async () => oldRoom.onDisconnected(DisconnectReason.ROOM_DELETED));
  assert.deepEqual(f.ledger.releases, released, "the retired room released the replacement session");
  let newRoomLeft = 0;
  await act(async () => f.read().registerLeaveRoom(() => { newRoomLeft += 1; }));
  await act(async () => oldRoom.registerLeaveRoom(null));
  await f.connected();
  await f.tick(1_000);
  assert.equal(newRoomLeft, 1, "the old room's unmount erased the replacement room's cleanup");
});

test("changing the requested character does not inherit the old live room's readiness", async (t) => {
  const f = await fixture(t);
  await f.connected();
  await f.agent();
  assert.equal(f.read().phase.kind, "live");
  const oldRoom = f.read();
  await f.changeTarget();
  assert.equal(f.read().grant?.session_id, "readiness_2");
  assert.equal(f.read().phase.kind, "connecting");
  await act(async () => { oldRoom.onConnected(); oldRoom.setAgentPresent(true); });
  assert.equal(f.read().phase.kind, "connecting");
  await f.connected();
  await f.agent();
  assert.equal(f.read().phase.kind, "live");
});
