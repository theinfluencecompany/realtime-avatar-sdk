import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { lifecycleServerFrameSchema } from "../src/wire.ts";
import type {
  AvatarCallHandle,
  AvatarCallProps,
  AvatarSessionClient,
  RealtimeSessionApi,
  VoiceError,
  useRealtimeSession as UseRealtimeSession,
} from "../src/react/index.ts";
import type { VoiceError as NativeVoiceError, VoiceErrorCode as NativeVoiceErrorCode } from "../src/react-native/index.ts";

/**
 * A call minted with `voiceWebhook` speaks through the caller's endpoint. When that endpoint
 * fails, the worker says so on `rta.lifecycle` as a `voice_error` frame, and this is the only way
 * the app learns why she went quiet for a sentence (or, when `fatal`, why the call ended).
 *
 * The frame is decoded by the shared client, so the web and native entries get the same thing.
 */
const FRAME = {
  kind: "voice_error",
  code: "voice_webhook_timeout",
  message: "Your voice webhook sent no audio within 5000 ms.",
  fatal: false,
  request_id: "req_1",
};

test("the lifecycle decoder admits a voice_error frame", () => {
  const parsed = lifecycleServerFrameSchema.safeParse(FRAME);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.kind, "voice_error");
});

test("a code this SDK does not know yet still surfaces instead of being dropped", () => {
  const parsed = lifecycleServerFrameSchema.safeParse({ ...FRAME, code: "voice_webhook_rate_limited", status: 429 });
  assert.ok(parsed.success, "a newer worker's code made the whole frame disappear");
  assert.ok(parsed.data.kind === "voice_error" && parsed.data.code === "voice_webhook_rate_limited");
});

test("a frame missing what the contract requires is still refused", () => {
  const { fatal: _fatal, ...noFatal } = FRAME;
  assert.equal(lifecycleServerFrameSchema.safeParse(noFatal).success, false);
  assert.equal(lifecycleServerFrameSchema.safeParse({ ...FRAME, code: "" }).success, false);
});

test("the native entry names the same voice error types as the web one", () => {
  const known: NativeVoiceErrorCode = "voice_webhook_unauthorized";
  const future: NativeVoiceErrorCode = "voice_webhook_from_a_newer_worker";
  const same: NativeVoiceError = { code: known, message: "m", fatal: true } satisfies VoiceError;
  assert.equal(same.code, known);
  assert.equal(future.length > 0, true);
});

// ── the rendered hook, from the shipped `realtime-avatar/react` entry (built by `pretest`) ──
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
globalThis.fetch = async () => new Response(null, { status: 204 });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {}, removeEventListener: () => {},
  },
});

const sdk: { useRealtimeSession: typeof UseRealtimeSession } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

const client: AvatarSessionClient = {
  createLiveKitSessionOrBusy: async () => ({
    status: "ready",
    grant: {
      status: "ready", session_id: "sess_1", room_name: "room", livekit_url: "wss://test.invalid",
      participant_token: "token", participant_identity: "user", max_session_seconds: 600,
      idle_timeout_seconds: 120, join_timeout_seconds: 75, reservation_expires_at: "2026-10-05T00:00:00Z",
      stt_mode: "server", room_created: true, dispatch_created: true,
    },
  }),
  releaseLiveKitSession: async () => true,
  releaseLiveKitSessionBeacon: () => false,
  releaseLiveKitQueueTicket: async () => true,
  releaseLiveKitQueueTicketBeacon: () => false,
};

test("useRealtimeSession reports each voice error and keeps the last one", async () => {
  const seen: VoiceError[] = [];
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({
      client,
      session: { avatarId: "ava_test", mode: "voice" },
      onVoiceError: (error) => seen.push(error),
    });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  assert.equal(session?.voiceError, null);

  await act(async () => session?.onLifecycleData(FRAME));
  const first: VoiceError = { code: "voice_webhook_timeout", message: FRAME.message, fatal: false, requestId: "req_1" };
  assert.deepEqual(seen, [first]);
  assert.deepEqual(session?.voiceError, first);

  await act(async () => session?.onLifecycleData({
    kind: "voice_error", code: "voice_webhook_unauthorized", message: "Your voice webhook answered 401.", status: 401, fatal: true,
  }));
  const fatal: VoiceError = { code: "voice_webhook_unauthorized", message: "Your voice webhook answered 401.", status: 401, fatal: true };
  assert.deepEqual(seen, [first, fatal]);
  assert.deepEqual(session?.voiceError, fatal);

  await act(async () => session?.reset());
  assert.equal(session?.voiceError, null, "a reset call kept the previous call's voice error");
  await act(async () => renderer?.unmount());
});

// ── AvatarCall: the real `useAvatarCall` against a controlled session ──
const bundle = await build({
  stdin: {
    contents: `import {useAvatarCall} from './avatar-call';
      export const render = (props) => useAvatarCall(props);`,
    resolveDir: new URL("../src/react", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "controlled-avatar-call", setup(builder) {
    builder.onResolve({ filter: /^(react|\.\/livekit|\.\/avatar-video-surface|\.\/use-realtime-session|\.\/session-lifecycle)$/ }, ({ path }) => ({ path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, ({ path }) => ({ contents: path === "react"
      ? `export const useRef = (value) => ({ current: value });
         export const useEffect = () => {};
         export const Fragment = Symbol.for("react.fragment");
         export const createElement = (type, props, ...children) => ({ type, props, children });`
      : path === "./use-realtime-session"
        ? "export const useRealtimeSession = (input) => { globalThis.fixture.input = input; return globalThis.fixture.session; };"
        : path === "./session-lifecycle"
          ? "export const SessionLifecycleRoomBridge = () => null;"
          : path === "./livekit"
            ? "export const RealtimeAvatarLiveKitRoom = () => null;"
            : "export const AvatarVideoSurface = () => null;" }));
  } }],
});

test("AvatarCall hands voice errors to onVoiceError and exposes the last one on the handle", () => {
  const last: VoiceError = { code: "voice_webhook_http_error", message: "Your voice webhook answered 500.", status: 500, fatal: false };
  const fixture: { input?: { onVoiceError?: (error: VoiceError) => void }; session: unknown } = {
    session: {
      phase: { kind: "live" }, clocks: { sessionRemainingMs: null },
      microphone: { status: "on" }, audioPlayback: "allowed",
      startAudio: async () => true, setMicrophoneEnabled: async () => {}, microphoneMuted: false,
      voiceError: last,
    },
  };
  const module: { exports: { render?: (props: AvatarCallProps) => { call: AvatarCallHandle } } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0]!.text, { fixture, module, exports: module.exports, require: createRequire(import.meta.url) });
  const seen: VoiceError[] = [];
  const { call } = module.exports.render!({
    client, avatarId: "ava_test", onVoiceError: (error) => seen.push(error),
  });
  assert.deepEqual(call.voiceError, last);
  fixture.input?.onVoiceError?.(last);
  assert.deepEqual(seen, [last], "AvatarCall did not pass onVoiceError to the session");
});
