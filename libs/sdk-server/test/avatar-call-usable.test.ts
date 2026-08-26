import test from "node:test";
import assert from "node:assert/strict";

// Against the react entry's OWN dist — the bytes a consumer installs, not the carry it is
// built from. The defect this guards only existed from the consumer side, so only dist can show it.
import * as pkg from "../dist/react.js";
import type { AvatarSessionClient } from "../dist/react.js";

/**
 * `AvatarCall` was exported at runtime and required `client: RealtimeAvatarClient` — a class this
 * package deliberately does not export, because it carries an API-key path and keeping it out is
 * what took `apiKey`/`Bearer` to zero occurrences in the shipped browser bundles. The result was a
 * flagship component that typechecked, shipped, and could not be used by anyone: there was no way
 * to produce a value for its required prop.
 *
 * Nothing caught it because both halves were individually correct. The component exported fine and
 * the class was correctly withheld; only the PAIR was broken, and no test looked at the pair.
 */
test("the component a consumer is told to use is exported at runtime", () => {
  assert.equal(typeof (pkg as Record<string, unknown>).AvatarCall, "function", "AvatarCall is not exported");
  assert.equal(typeof (pkg as Record<string, unknown>).useAvatarCall, "function", "useAvatarCall is not exported");
});

test("its client prop is satisfiable without the API-key-bearing class", () => {
  // A plain object — no class, no key, no import from the server package. If `AvatarSessionClient`
  // ever renames a method or narrows a signature, this stops compiling, which is the point.
  const client: AvatarSessionClient = {
    createLiveKitSessionOrBusy: async () => ({ status: "busy", busy: {} as never }),
    releaseLiveKitSession: async () => true,
    releaseLiveKitSessionBeacon: () => true,
    releaseLiveKitQueueTicket: async () => true,
    releaseLiveKitQueueTicketBeacon: () => true,
  };

  assert.equal(typeof client.createLiveKitSessionOrBusy, "function");
  assert.equal(client.releaseLiveKitSessionBeacon("s_1"), true);
});

test("the package ships something that can actually produce that client", () => {
  // The interface being satisfiable was only half the fix. Until this export existed a consumer
  // had to hand-write a fetch wrapper against their own proxy routes before AvatarCall would
  // render at all — the component was exported, typechecked, and unusable.
  const factory = (pkg as Record<string, unknown>).createProxyClient;
  assert.equal(typeof factory, "function", "createProxyClient is not exported");

  const client = (factory as (o: { proxyUrl: string }) => AvatarSessionClient)({
    proxyUrl: "/api/realtime-avatar",
  });
  for (const method of [
    "createLiveKitSessionOrBusy",
    "releaseLiveKitSession",
    "releaseLiveKitSessionBeacon",
    "releaseLiveKitQueueTicket",
    "releaseLiveKitQueueTicketBeacon",
  ]) {
    assert.equal(typeof (client as unknown as Record<string, unknown>)[method], "function", `missing ${method}`);
  }
  // No beacon in this runtime: it must answer false rather than throw, so the caller falls
  // back to the awaited release instead of losing the slot.
  assert.equal(client.releaseLiveKitSessionBeacon("sess_1"), false);
});

test("no API-key path reaches the browser half", () => {
  // The reason the class is withheld in the first place. If a future edit re-imports it as a
  // VALUE — which is how the deleted provider dragged it in — this catches it.
  const names = Object.keys(pkg);
  assert.equal(
    names.some((n) => /^RealtimeAvatarClient$/.test(n)),
    false,
    "the key-bearing client is exported from the browser package again",
  );
});
