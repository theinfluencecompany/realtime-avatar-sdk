import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, Fragment, useEffect, type ComponentType, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { build } from "esbuild";
import type { RealtimeAvatarLiveKitRoomProps } from "../src/react/index.ts";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const require = createRequire(import.meta.url);

for (const platform of ["react/livekit", "react-native/room"]) {
  test(`${platform}: a replacement grant unmounts the old room and its observers`, async () => {
    const mounts: string[] = [];
    const leaves: string[] = [];
    function Room({ token, children }: { token: string; children?: ReactNode }) {
      useEffect(() => { mounts.push(token); return () => { leaves.push(token); }; }, []);
      return createElement(Fragment, null, children);
    }
    const bundle = await build({
      entryPoints: [new URL(`../src/${platform}.ts`, import.meta.url).pathname],
      bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    });
    const module: { exports: { RealtimeAvatarLiveKitRoom?: ComponentType<RealtimeAvatarLiveKitRoomProps> } } = { exports: {} };
    runInNewContext(bundle.outputFiles[0].text, {
      module, exports: module.exports,
      require: (name: string) => name === "@livekit/components-react" || name === "@livekit/react-native"
        ? { ...require("@livekit/components-react"), LiveKitRoom: Room,
          AudioSession: { startAudioSession() {}, stopAudioSession() {} } } : require(name),
    });
    const Wrapper = module.exports.RealtimeAvatarLiveKitRoom;
    assert.ok(Wrapper);
    const grant = (id: string): NonNullable<RealtimeAvatarLiveKitRoomProps["grant"]> => ({
      status: "ready", session_id: id, room_name: id, livekit_url: "wss://test.invalid",
      participant_token: id, participant_identity: "user", max_session_seconds: 600,
      idle_timeout_seconds: 120, join_timeout_seconds: 75, reservation_expires_at: "2026-10-10T00:00:00Z",
      stt_mode: "server", room_created: true, dispatch_created: true,
    });
    const render = (id: string) => createElement(Wrapper, { grant: grant(id), renderRoomAudio: false, playoutDelaySeconds: false });
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(render("first")); });
    await act(async () => renderer.update(render("first")));
    assert.deepEqual(mounts, ["first"], "a re-render or same-grant reconnect replaced a live room");
    await act(async () => renderer.update(render("replacement")));
    assert.deepEqual(mounts, ["first", "replacement"]);
    assert.deepEqual(leaves, ["first"], "old-room observers survived into the replacement grant");
    await act(async () => renderer.unmount());
    assert.deepEqual(leaves, ["first", "replacement"]);
  });
}
