import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { AvatarCallHandle, AvatarCallProps } from "../src/react/index.ts";

/**
 * `AvatarCall` offers the gesture blocked audio needs, unless the app draws its own.
 *
 * An app that never reads `call.audio` — the common case, and every integration written before it
 * existed — would otherwise sit in a "live" call with her voice muted by the browser. So the
 * default is a button over the video while playback is blocked, wired to `startAudio()`.
 *
 * Executes the real `useAvatarCall` against a controlled React and session (the lifecycle, room
 * and surface are stubbed); it inspects the element tree the hook produces.
 */
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
         export const createElement = (type, props, ...children) => {
           const node = { type, props, children }; globalThis.fixture.elements.push(node); return node;
         };`
      : path === "./use-realtime-session"
        ? "export const useRealtimeSession = () => globalThis.fixture.session;"
        : path === "./session-lifecycle"
          ? "export const SessionLifecycleRoomBridge = () => null;"
          : path === "./livekit"
            ? "export const RealtimeAvatarLiveKitRoom = () => null;"
            : "export const AvatarVideoSurface = () => null;" }));
  } }],
});

type Node = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

function run(audio: AvatarCallHandle["audio"], props: Partial<AvatarCallProps> = {}, extra: { microphoneMuted?: boolean } = {}) {
  let unlocks = 0;
  const fixture = {
    elements: [] as Node[],
    session: {
      phase: { kind: "live" }, clocks: { sessionRemainingMs: null },
      microphone: { status: "on" }, audioPlayback: audio,
      startAudio: async () => { unlocks += 1; return false; },
      setMicrophoneEnabled: async () => {},
      microphoneMuted: extra.microphoneMuted ?? false,
    },
  };
  const module: { exports: { render?: (props: AvatarCallProps) => { call: AvatarCallHandle } } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { fixture, module, exports: module.exports, require: createRequire(import.meta.url) });
  const { call } = module.exports.render!({ client: {} as AvatarCallProps["client"], avatarId: "ava_test", ...props });
  const button = fixture.elements.find((node) => node.props?.["data-testid"] === "avatar-audio-unlock");
  const named = (name: string) => fixture.elements.find((node) => typeof node.type === "function" && node.type.name === name);
  return { call, button, unlocks: () => unlocks, elements: fixture.elements, named };
}

test("blocked audio renders a tap-to-unlock button that calls startAudio", async () => {
  const { call, button, unlocks } = run("blocked");
  assert.equal(call.audio, "blocked");
  assert.ok(button, "a call whose audio the browser blocked offered the user no way to hear her");
  assert.equal(button.type, "button");
  const onClick = button.props?.onClick;
  assert.equal(typeof onClick, "function");
  if (typeof onClick === "function") onClick();
  await Promise.resolve();
  assert.equal(unlocks(), 1);
});

test("no button while audio is allowed or not yet known", () => {
  assert.equal(run("allowed").button, undefined);
  assert.equal(run("unknown").button, undefined);
});

test("audioUnlockPrompt={false} leaves the affordance to the app", () => {
  assert.equal(run("blocked", { audioUnlockPrompt: false }).button, undefined);
});

test("the built-in prompt is announced, and sits at the top, clear of a bottom-centre End button", () => {
  const { elements, button } = run("blocked");
  const region = elements.find((node) => node.props?.["data-testid"] === "avatar-audio-unlock-region");
  assert.ok(region, "no live region: a screen-reader user is never told why she is silent");
  assert.equal(region.props?.role, "status");
  assert.equal(region.props?.["aria-live"], "polite");
  assert.ok(region.children.includes(button), "the button is not inside the live region");
  const style = region.props?.style as Record<string, unknown> | undefined;
  assert.equal(style?.bottom, undefined, "placed over the bottom-centre, where apps put End");
  assert.equal(typeof style?.top, "number");
  assert.ok(Number(style?.zIndex) > 0, "the prompt must stack above the app's own overlay");
});

test("audioUnlockPrompt can render your own affordance, with your own words", () => {
  const custom = run("blocked", {
    audioUnlockPrompt: (call) => ({ type: "mine", props: { onClick: call.startAudio }, children: [] }) as never,
  });
  assert.equal(custom.button, undefined, "the built-in button rendered alongside the custom one");
  assert.ok(custom.elements.some((node) => node.props?.["data-testid"] === "avatar-audio-unlock-region"));
});

test("a mute chosen while waiting reaches the room's connect-time capture", () => {
  assert.equal(run("unknown", {}, { microphoneMuted: true }).named("RealtimeAvatarLiveKitRoom")?.props?.audio, false);
  assert.equal(run("unknown").named("RealtimeAvatarLiveKitRoom")?.props?.audio, true);
  assert.equal(run("unknown", { listen: false }).named("RealtimeAvatarLiveKitRoom")?.props?.audio, false);
});

test("style reaches the surface, so a sizing class has somewhere to move", () => {
  const style = { height: 480 };
  assert.equal(run("allowed", { style }).named("AvatarVideoSurface")?.props?.style, style);
});

test("showLiveBadge reaches the surface, so an app with its own status can turn the badge off", () => {
  assert.equal(run("allowed", { showLiveBadge: false }).named("AvatarVideoSurface")?.props?.showLiveBadge, false);
  // Absent stays absent: the surface's own default (on) applies, as it did before the prop existed.
  assert.equal(run("allowed").named("AvatarVideoSurface")?.props?.showLiveBadge, undefined);
});
