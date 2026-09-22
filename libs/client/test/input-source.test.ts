import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { DeclaredInputSource, RealtimeSessionApi, SendTurnOptions, TranscriptSenderOptions } from "../src/react/index.ts";
import type { RealtimeSessionApi as NativeSessionApi, DeclaredInputSource as NativeDeclaredInputSource } from "../src/react-native/index.ts";

// Exercise the real session hook, including serialization, adapters, and its watchdog.
// Only React scheduling, the surrounding lifecycle, clock, and room transport are controlled.
const bundle = await build({
  stdin: {
    contents: `import { useRealtimeSession } from './use-realtime-session';
      export const mount = () => useRealtimeSession(globalThis.fixture.input);`,
    resolveDir: new URL("../src/react", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "controlled-session", setup(builder) {
    builder.onResolve({ filter: /^(react|[.][/]session-lifecycle)$/ }, ({ path }) => ({ path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, ({ path }) => ({ contents: path === "react"
      ? `export const { useState, useRef, useEffect, useMemo, useCallback } = globalThis.fixture.hooks;`
      : `export const DEFAULT_TURN_TIMEOUT_SECONDS = 20;
         export const useSessionLifecycle = () => globalThis.fixture.lifecycle;` }));
  } }],
});

function fixture() {
  type Slot = { value?: unknown; deps?: unknown[]; cleanup?: void | (() => void) };
  const slots: Slot[] = [];
  const effects: (() => void)[] = [];
  const timers = new Set<() => void>();
  const messages: { text: string; attributes: Record<string, string> }[] = [];
  const timeouts: (string | null)[] = [];
  let cursor = 0, now = 1_000_000, activity = 0;
  const nextSlot = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  const changed = (slot: Slot, deps: unknown[]) => !slot.deps || deps.some((dep, index) => !Object.is(dep, slot.deps?.[index]));
  const memo = (get: () => unknown, deps: unknown[]) => {
    const slot = nextSlot();
    if (changed(slot, deps)) { slot.value = get(); slot.deps = deps; }
    return slot.value;
  };
  const controlled = {
    input: { session: null, turnTimeoutSeconds: 2, onTurnTimeout: ({ turnId }: { turnId: string | null }) => timeouts.push(turnId) },
    lifecycle: {
      phase: { kind: "live" }, timeToDisconnectMs: null,
      markActivity: () => { activity += 1; }, stayConnected() {}, reset() {},
    },
    hooks: {
      useRef(value: unknown) {
        const slot = nextSlot();
        if (!("value" in slot)) slot.value = { current: value };
        return slot.value;
      },
      useState(value: unknown) {
        const slot = nextSlot();
        if (!("value" in slot)) slot.value = value;
        return [slot.value, (next: unknown) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
      },
      useMemo: memo,
      useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
      useEffect(setup: () => void | (() => void), deps: unknown[]) {
        const slot = nextSlot();
        if (changed(slot, deps)) {
          slot.deps = deps;
          effects.push(() => { slot.cleanup?.(); slot.cleanup = setup(); });
        }
      },
    },
  };
  const module: { exports: { mount?: () => RealtimeSessionApi } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    fixture: controlled, module, exports: module.exports, require: createRequire(import.meta.url),
    // No crypto: also exercises unique attempt IDs when native randomUUID is unavailable.
    Date: class extends Date { static now() { return now; } },
    window: {
      setInterval(callback: () => void) { timers.add(callback); return callback; },
      clearInterval(callback: () => void) { timers.delete(callback); },
    },
    setTimeout, clearTimeout,
  });
  const mount = module.exports.mount;
  if (!mount) throw new Error("missing session fixture");
  const render = () => {
    cursor = 0;
    const session = mount();
    for (const effect of effects.splice(0)) effect();
    return session;
  };
  const session = render();
  const sender: Parameters<RealtimeSessionApi["registerTurnSender"]>[0] = async (text, options) => {
    messages.push({ text, attributes: { ...options?.attributes } });
  };
  session.registerTurnSender(sender);
  return {
    session, messages, timeouts, render, sender, activity: () => activity,
    setPhase(kind: "live" | "ended") { controlled.lifecycle.phase.kind = kind; return render(); },
    tick(ms = 1000) { now += ms; for (const callback of timers) callback(); },
  };
}

test("normal sends observe text, transmit distinct IDs, and preserve instructions", async () => {
  const f = fixture();
  await f.session.sendTurn("  Hello  ");
  await f.session.sendTurn("Again", { instructions: "Keep it brief" });
  const [first, second] = f.messages;
  assert.equal(first.text, "Hello");
  assert.ok(first.attributes["rta.turn_id"]);
  assert.deepEqual(first.attributes, {
    "rta.input_source_version": "1", "rta.observed_input_source": "text",
    "rta.turn_id": first.attributes["rta.turn_id"],
  });
  assert.notEqual(second.attributes["rta.turn_id"], first.attributes["rta.turn_id"]);
  assert.equal(second.attributes["rta.turn_instructions"], "Keep it brief");
  assert.equal(f.activity(), 2);
  await f.session.sendTurn("  ");
  f.session.registerTurnSender(null);
  await f.session.sendTurn("Disconnected");
  assert.equal(f.messages.length, 2);
});

test("each adapter captures its default and per-send overrides take precedence without leaking", async () => {
  const f = fixture();
  const options: TranscriptSenderOptions = { inputSource: "client_stt" };
  const speech = f.session.createTranscriptSender(options);
  options.inputSource = "text";
  const typed = f.session.createTranscriptSender(options);
  await speech("Speech");
  await speech("Correction", { inputSource: "text", instructions: "Use the correction" });
  // A once-bound callback still works after a render and transport replacement.
  f.render().registerTurnSender(f.sender);
  await speech("More speech");
  await typed("Text");
  await f.session.sendTurn("One-off speech", { inputSource: "client_stt" });
  await f.session.sendTurn("Plain text");
  assert.deepEqual(f.messages.map(({ attributes: a }) => [a["rta.declared_input_source"], a["rta.input_source_declaration_scope"]]), [
    ["client_stt", "adapter"], ["text", "turn"], ["client_stt", "adapter"],
    ["text", "adapter"], ["client_stt", "turn"], [undefined, undefined],
  ]);
  assert.equal(f.messages[1].attributes["rta.turn_instructions"], "Use the correction");
  assert.ok(f.messages.every(({ attributes }) => attributes["rta.observed_input_source"] === "text"));
});

test("invalid runtime declarations never reach the room or claim server recognition", async () => {
  const f = fixture();
  const sender = f.session.createTranscriptSender();
  for (const value of ["server_stt", "unknown", "", null, 1, {}]) {
    const options = { inputSource: value } as SendTurnOptions;
    await assert.rejects(f.session.sendTurn("Invalid", options), /inputSource must be/);
    await assert.rejects(sender("Invalid", options), /inputSource must be/);
    assert.throws(() => f.session.createTranscriptSender(options), /inputSource must be/);
  }
  assert.equal(f.messages.length, 0);
  assert.equal(f.activity(), 0);
});

test("timeout retains resolved source and instructions for retries with linked new attempt IDs", async () => {
  for (const route of ["normal", "turn", "adapter", "adapter-override"] as const) {
    const f = fixture();
    const adapterOptions: TranscriptSenderOptions = { inputSource: "client_stt" };
    const options: SendTurnOptions = { instructions: "Original instruction" };
    if (route === "turn") options.inputSource = "client_stt";
    if (route === "adapter-override") options.inputSource = "text";
    const send = route.startsWith("adapter") ? f.session.createTranscriptSender(adapterOptions) : f.session.sendTurn;
    await send("Retry me", options);
    const original = f.messages[0].attributes;
    options.inputSource = "text";
    options.instructions = "Changed instruction";
    adapterOptions.inputSource = "text";
    f.tick(2000);
    f.tick();
    assert.deepEqual(f.timeouts, [original["rta.turn_id"]]);
    f.session.retryTurn();
    const retry = f.messages[1].attributes;
    assert.notEqual(retry["rta.turn_id"], original["rta.turn_id"]);
    assert.deepEqual(retry, { ...original,
      "rta.turn_id": retry["rta.turn_id"], "rta.retry_of_turn_id": original["rta.turn_id"],
    });
    f.session.retryTurn();
    const next = f.messages[2].attributes;
    assert.notEqual(next["rta.turn_id"], retry["rta.turn_id"]);
    assert.equal(next["rta.retry_of_turn_id"], retry["rta.turn_id"]);
    f.tick(2000);
    assert.deepEqual(f.timeouts, [original["rta.turn_id"], next["rta.turn_id"]]);
  }
});

test("default adapters declare client_stt and call termination clears retained retry state", async () => {
  for (const action of ["reset", "end", "worker-ended"] as const) {
    const f = fixture();
    await f.session.createTranscriptSender()("Recognized text");
    assert.equal(f.messages[0].attributes["rta.declared_input_source"], "client_stt");
    assert.equal(f.messages[0].attributes["rta.input_source_declaration_scope"], "adapter");
    f.tick(2000);
    if (action === "worker-ended") f.setPhase("ended");
    else f.session[action]();
    f.session.retryTurn();
    assert.equal(f.messages.length, 1, action);
    const nextCall = f.setPhase("live");
    nextCall.retryTurn();
    assert.equal(f.messages.length, 1, "a new call cannot retry input from an ended call");
    await nextCall.sendTurn("Fresh turn");
    assert.equal(f.messages[1].attributes["rta.retry_of_turn_id"], undefined);
    assert.equal(f.messages[1].attributes["rta.declared_input_source"], undefined);
  }
});

test("closing turns keep their control attributes and do not overwrite user retry provenance", async () => {
  const f = fixture();
  await f.session.createTranscriptSender()("Last user input");
  f.session.onLifecycleData({ kind: "session_clock", started_at_unix_ms: 1_000_000, max_session_seconds: 10, idle_timeout_seconds: 0 });
  f.render();
  f.tick();
  const session = f.render();
  const result = session.sendClosingTurn("  Goodbye  ", { instructions: "Say it verbatim" });
  assert.ok(result.ok);
  assert.deepEqual(f.messages[1], { text: "Goodbye", attributes: {
    "rta.closing_turn": "1", "rta.turn_id": result.turnId, "rta.turn_instructions": "Say it verbatim",
  } });
  session.onLifecycleData({ kind: "closing_turn_done", turn_id: result.turnId });
  const spent = f.render();
  assert.equal(spent.graceWindow.kind, "spent");
  assert.equal(spent.sendClosingTurn("Again").ok, false);
  spent.retryTurn();
  assert.equal(f.messages[2].text, "Last user input");
  assert.equal(f.messages[2].attributes["rta.closing_turn"], undefined);
  assert.equal(f.messages[2].attributes["rta.declared_input_source"], "client_stt");
});

// Compile-time consumer contracts for both public entries. Never invoked.
function publicTypes(web: RealtimeSessionApi, native: NativeSessionApi) {
  const clientSource: DeclaredInputSource = "client_stt";
  const nativeSource: NativeDeclaredInputSource = clientSource;
  const same: RealtimeSessionApi = native;
  void same.createTranscriptSender({ inputSource: nativeSource })("Recognized speech");
  void web.sendTurn("Typed text", { inputSource: "text" });
  // @ts-expect-error Clients cannot declare server recognition.
  void web.sendTurn("Text", { inputSource: "server_stt" });
  // @ts-expect-error Clients can only declare text or client STT.
  native.createTranscriptSender({ inputSource: "unknown" });
}
