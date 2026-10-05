import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { RoomContext } from "@livekit/components-react";
import { ConnectionState, Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import type { useCharacterTools as UseCharacterTools } from "../src/react/index.ts";

/**
 * Tool registration recovers from a transient failure while the room stays connected, and a
 * re-render does not re-register.
 *
 * `useCharacterTools` ran `attachAvatarTools` once per (room, tools object, connection state). A
 * failed registration was terminal for as long as the room stayed connected: one RPC timeout at
 * the wrong moment and her tools were gone for the call, with only a `status` field nobody reads
 * to say so. And because the effect keyed on the `tools` object's identity, an app passing an
 * inline object re-registered on every render of its component.
 *
 * Renders the shipped `realtime-avatar/react` hook against a real, unconnected LiveKit Room whose
 * RPC methods the test answers.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
// LiveKit's room-event observables subscribe only where `window` exists; node has none.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {}, removeEventListener: () => {} },
});

const sdk: { useCharacterTools: typeof UseCharacterTools } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function settle(ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) await act(async () => { await sleep(50); });
}

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function scriptedRoom(failures: Error[]) {
  const room = new Room();
  let registrations = 0;
  room.remoteParticipants.set("agent-1", { identity: "agent-1" } as unknown as RemoteParticipant);
  room.localParticipant.registerRpcMethod = () => {};
  room.localParticipant.unregisterRpcMethod = () => {};
  room.localParticipant.performRpc = async () => {
    registrations += 1;
    const failure = failures.shift();
    if (failure) throw failure;
    return JSON.stringify({ accepted: ["lookup"], rejected: [] });
  };
  return { room, registrations: () => registrations };
}

type ToolsState = ReturnType<typeof UseCharacterTools>;

async function mount(room: Room, makeTools: () => Parameters<typeof UseCharacterTools>[0]) {
  let state: ToolsState | undefined;
  let rerender: () => void = () => {};
  function Tools(): null {
    state = sdk.useCharacterTools(makeTools());
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  const tree = () => createElement(RoomContext.Provider, { value: room }, createElement(Tools));
  await act(async () => { renderer = create(tree()); });
  rerender = () => renderer?.update(tree());
  await act(async () => { room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected); });
  return { get: () => state, rerender: () => act(async () => rerender()), unmount: () => act(async () => renderer?.unmount()) };
}

const lookup = { description: "Look something up.", execute: () => "found" };

test("a transient registration failure is retried while the room stays connected", async () => {
  const { room, registrations } = scriptedRoom([rpcError(1502, "Response timeout")]);
  const tools = { lookup };
  const call = await mount(room, () => tools);
  await settle(100);
  assert.notEqual(call.get()?.status, "error", "one RPC timeout ended her tools for the whole call");
  await settle(1_500);
  assert.equal(call.get()?.status, "ready");
  assert.deepEqual(call.get()?.registered, ["lookup"]);
  assert.equal(registrations(), 2);
  await call.unmount();
});

test("a refusal that cannot change is final, and says so", async () => {
  const { room, registrations } = scriptedRoom([rpcError(1500, "Application error in method handler")]);
  const tools = { lookup };
  const call = await mount(room, () => tools);
  await settle(1_500);
  assert.equal(call.get()?.status, "error");
  assert.equal(registrations(), 1, "a deterministic refusal was retried");
  await call.unmount();
});

test("an inline tools object does not re-register on every render", async () => {
  const { room, registrations } = scriptedRoom([]);
  const call = await mount(room, () => ({ lookup: { description: "Look something up.", execute: () => "found" } }));
  await settle(50);
  assert.equal(call.get()?.status, "ready");
  await call.rerender();
  await call.rerender();
  await settle(50);
  assert.equal(registrations(), 1, "each render of the app's component re-registered her tools");
  assert.equal(call.get()?.status, "ready");
  await call.unmount();
});
