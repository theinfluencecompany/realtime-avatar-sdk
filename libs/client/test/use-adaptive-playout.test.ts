import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Run the actual hook's effect against controlled LiveKit tracks and an interval clock.
// The controller and stats reduction are real; only React and playout writes are stubbed.
const bundle = await build({
  stdin: {
    contents: `import {useAvatarAdaptivePlayoutDelay} from './use-adaptive-playout';
      export const mount = () => useAvatarAdaptivePlayoutDelay(
        globalThis.fixture.video, globalThis.fixture.audio, globalThis.fixture.enabled);`,
    resolveDir: new URL("../src/react", import.meta.url).pathname,
  },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "controlled-playout", setup(builder) {
    builder.onResolve({ filter: /^(react|\.\/livekit)$/ }, ({ path }) => ({ path, namespace: "controlled" }));
    builder.onLoad({ filter: /.*/, namespace: "controlled" }, ({ path }) => ({ contents: path === "react"
      ? `export const useState = (v) => [v, (next) => {globalThis.fixture.depth = next;}];
         export const useEffect = (setup) => {globalThis.fixture.cleanup = setup();};`
      : `export const DEFAULT_AVATAR_PLAYOUT_DELAY_SECONDS = 0.5;
         export const applyAvatarPlayoutDelay = (video, audio, seconds) => globalThis.fixture.writes.push({video, audio, seconds});` }));
  } }],
});

function fixture(enabled = true) {
  let privateReads = 0, publicReads = 0;
  const timers = new Set<() => void>();
  function track(kind: "video" | "audio") {
    let packetsReceived = 0;
    const state = { jitter: 0, read: async (): Promise<RTCStatsReport | undefined> => {
      publicReads += 1;
      packetsReceived += 100;
      return new Map([[kind, { type: "inbound-rtp", kind, jitter: state.jitter, packetsReceived, packetsLost: 0 }]]);
    } };
    return {
      state,
      publication: { track: {
        isLocal: false,
        get receiver() { privateReads += 1; return undefined; },
        getRTCStatsReport() { return state.read(); },
      } },
    };
  }
  const controlled: {
    enabled: boolean;
    video: ReturnType<typeof track>;
    audio: ReturnType<typeof track>;
    depth: number;
    cleanup?: void | (() => void);
    writes: { video: unknown; audio: unknown; seconds: number }[];
  } = {
    enabled, video: track("video"), audio: track("audio"), depth: 0.5,
    writes: [],
  };
  const module: { exports: { mount?: () => number } } = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    fixture: controlled, module, exports: module.exports, require: createRequire(import.meta.url),
    setInterval(callback: () => void) { timers.add(callback); return callback; },
    clearInterval(callback: () => void) { timers.delete(callback); },
  });
  const mount = module.exports.mount;
  if (!mount) throw new Error("missing hook fixture");
  return {
    controlled, mount,
    async tick() {
      for (const callback of timers) callback();
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    },
    reads() { return { privateReads, publicReads, timers: timers.size }; },
    dispose() { controlled.cleanup?.(); },
  };
}

test("adaptive playout reads public LiveKit reports and keeps audio/video at one depth", async () => {
  const f = fixture();
  assert.equal(f.mount(), 0.5);
  assert.equal(f.reads().privateReads, 0, "LiveKit's receiver field is internal");
  for (let index = 0; index < 200; index++) await f.tick();
  assert.equal(f.reads().publicReads, 400);
  assert.equal(f.controlled.depth, 0.15);
  f.controlled.audio.state.jitter = 0.1;
  for (let index = 0; index < 5; index++) await f.tick();
  assert.equal(f.controlled.depth, 0.5, "the worse audio path must deepen both streams");
  for (const write of f.controlled.writes) {
    assert.equal(write.video, f.controlled.video.publication.track);
    assert.equal(write.audio, f.controlled.audio.publication.track);
  }
  f.dispose();
  assert.equal(f.reads().timers, 0);
});

test("disabled, missing, or rejected public reports preserve the flat cushion", async () => {
  const disabled = fixture(false); disabled.mount(); await disabled.tick();
  assert.deepEqual(disabled.reads(), { privateReads: 0, publicReads: 0, timers: 0 });
  for (const reject of [false, true]) {
    const f = fixture();
    const read = async () => { if (reject) throw new Error("stats unavailable"); return undefined; };
    f.controlled.video.state.read = f.controlled.audio.state.read = read;
    f.mount();
    for (let index = 0; index < 10; index++) await f.tick();
    assert.equal(f.controlled.depth, 0.5);
    assert.equal(f.controlled.writes.length, 0);
    f.dispose();
  }
});

test("unmount fences a pending public stats read", async () => {
  const f = fixture();
  let resolve: (report: RTCStatsReport) => void = () => { throw new Error("missing promise"); };
  const pending = new Promise<RTCStatsReport>((settle) => { resolve = settle; });
  f.controlled.video.state.read = () => pending;
  f.mount(); await f.tick(); f.dispose();
  resolve(new Map([["video", { type: "inbound-rtp", jitter: 0, packetsReceived: 100, packetsLost: 0 }]]));
  await f.tick();
  assert.equal(f.controlled.writes.length, 0);
  assert.equal(f.controlled.depth, 0.5);
  assert.equal(f.reads().timers, 0);
});
