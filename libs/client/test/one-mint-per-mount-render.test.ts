import assert from "node:assert/strict";
import { test } from "node:test";
import { StrictMode, createElement } from "react";
import { act, create } from "react-test-renderer";
import type { useLiveKitAvatarGrant as UseGrant, UseLiveKitAvatarGrantInput } from "../src/react/index.ts";

/**
 * One call, one mint: the RENDERED hook, not its source.
 *
 * Runs the SHIPPED `realtime-avatar/react` entry (built by `pretest`) under React's real
 * scheduler and counts mint POSTs for one mounted call. StrictMode is on by default in a new
 * Next.js or Vite app while developing, and it runs every effect, its cleanup, and the effect
 * again on mount. Before this fix that sent two mints for one call (the first released as
 * `superseded`); a plain render, which is what a production build does, sent one and must still.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
// No network: a fresh request pre-warms the LiveKit host it last landed on with a HEAD.
globalThis.fetch = async () => new Response(null, { status: 204 });

const sdk: { useLiveKitAvatarGrant: typeof UseGrant } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

type GrantInput = UseLiveKitAvatarGrantInput;

async function mountOneCall(strict: boolean): Promise<{ mints: number; status: string; releases: string[] }> {
  let mints = 0;
  const releases: string[] = [];
  const client = {
    createLiveKitSessionOrBusy: async () => {
      mints += 1;
      return {
        status: "ready" as const,
        grant: { session_id: `sess_${mints}`, livekit_url: "wss://test.invalid", participant_token: "token", room_name: "room" },
      };
    },
    releaseLiveKitSession: async (sessionId: string, reason: string) => {
      releases.push(`${sessionId}:${reason}`);
    },
    releaseLiveKitSessionBeacon: () => false,
    releaseLiveKitQueueTicket: async () => {},
    releaseLiveKitQueueTicketBeacon: () => false,
  } as unknown as GrantInput["client"];
  // A stable session object: the hook keys its mint on the request's structure.
  const session: GrantInput["session"] = { avatarId: "ava_test" };

  let status = "unmounted";
  function Call(): null {
    status = sdk.useLiveKitAvatarGrant({ client, session, active: true }).status;
    return null;
  }
  const call = createElement(Call);
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(strict ? createElement(StrictMode, null, call) : call);
  });
  // Let the deferred mint and its grant land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const settled = status;
  await act(async () => renderer?.unmount());
  return { mints, status: settled, releases };
}

test("a production render mints once and holds the grant", async () => {
  const result = await mountOneCall(false);
  assert.equal(result.mints, 1);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.releases, ["sess_1:unmount"]);
});

test("StrictMode's mount, cleanup, mount still mints exactly once", async () => {
  const result = await mountOneCall(true);
  assert.equal(result.mints, 1, "StrictMode sent a second mint: a twin room, dispatch and session seat for one call");
  assert.equal(result.status, "ready");
  // The only release is the real unmount. A `superseded` release here is the twin being freed.
  assert.deepEqual(result.releases, ["sess_1:unmount"]);
});
