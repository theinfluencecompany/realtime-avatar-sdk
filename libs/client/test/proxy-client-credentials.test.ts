import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createProxyClient } from "../src/proxy-client.ts";

/**
 * Every request `createProxyClient` makes carries ONE credentials policy, the page-hide release
 * included.
 *
 * Measured in Chromium 148 against a route on another port of the same site (the
 * `app.example.com` page, `api.example.com` route shape):
 * - `fetch`'s default `credentials: "same-origin"` reaches that route with no cookie, so a route
 *   that authorizes on the session cookie refuses every connect unless the app swaps `fetch`.
 * - `sendBeacon` is always `credentials: "include"` and cannot carry a header. Against a route
 *   whose CORS does not allow credentials (`Access-Control-Allow-Origin: *`) its JSON preflight
 *   fails and the release never arrives, while the connect that started the call succeeded.
 *   Against a route that does allow credentials it arrives with the cookie.
 * So the release went out under different credentials from the request that started the call,
 * and which of the two failed depended on the route's CORS. A keepalive `fetch` outlives the page
 * like a beacon does and carries the same policy as every other request; the beacon is now only a
 * fallback where its fixed `include` cannot differ from that policy.
 *
 * These CALL the client with a fake transport. They are not source pins.
 */

type Seen = { url: string; init: RequestInit };

function recordingFetch(seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

function fakePage(origin: string): string[] {
  const beacons: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon: (url: string) => { beacons.push(url); return true; } },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(`${origin}/call`) });
  return beacons;
}

test("without the option the client sets no credentials, so your fetch wrapper's choice stands", async () => {
  // A wrapper written `fetch(url, { credentials: "include", ...init })` is how apps carried a
  // cookie cross-origin before the option existed. An explicit `credentials` in `init` overrode it.
  const seen: Seen[] = [];
  const wrapper = recordingFetch(seen);
  const client = createProxyClient({
    proxyUrl: "https://api.example.test/realtime-avatar",
    fetch: (url, init) => wrapper(url, { credentials: "include", ...init }),
  });
  await client.createLiveKitSessionOrBusy({ avatarId: "ava_1" }).catch(() => undefined);
  await client.releaseLiveKitSession("s1", "manual");
  await client.releaseLiveKitQueueTicket("qt_1", "manual");
  assert.equal(seen.length, 3);
  for (const { url, init } of seen) assert.equal(init.credentials, "include", `${url}: the wrapper's cookie was overridden`);
});

test("credentials: include reaches every request, so a cross-origin route sees its cookie", async () => {
  const seen: Seen[] = [];
  const client = createProxyClient({
    proxyUrl: "https://api.example.test/realtime-avatar",
    credentials: "include",
    fetch: recordingFetch(seen),
  });
  await client.createLiveKitSessionOrBusy({ avatarId: "ava_1" }).catch(() => undefined);
  await client.releaseLiveKitSession("s1", "manual");
  for (const { url, init } of seen) assert.equal(init.credentials, "include", url);
});

test("a same-origin page-hide release is a beacon, the send every browser keeps alive", () => {
  const beacons = fakePage("https://app.example.test");
  const seen: Seen[] = [];
  const client = createProxyClient({ proxyUrl: "/api/realtime-avatar", fetch: recordingFetch(seen) });
  assert.equal(client.releaseLiveKitSessionBeacon("s1", "page_hide"), true);
  assert.deepEqual(beacons, ["https://app.example.test/api/realtime-avatar/end"]);
  assert.equal(seen.length, 0, "keepalive is ignored by older Firefox; a same-origin beacon is not");
  const cross = createProxyClient({ proxyUrl: "https://api.example.test/realtime-avatar", credentials: "include", fetch: recordingFetch(seen) });
  assert.equal(cross.releaseLiveKitSessionBeacon("s1"), true);
  assert.equal(beacons.length, 2, "credentials: include is the beacon's own mode; it matches");
  assert.equal(seen.length, 0);
});

test("a cross-origin page-hide release whose credentials a beacon cannot match is a keepalive fetch", () => {
  const beacons = fakePage("https://app.example.test");
  const seen: Seen[] = [];
  const client = createProxyClient({
    proxyUrl: "https://api.example.test/realtime-avatar",
    fetch: recordingFetch(seen),
  });
  assert.equal(client.releaseLiveKitSessionBeacon("s1", "page_hide"), true);
  assert.equal(client.releaseLiveKitQueueTicketBeacon("qt_1"), true);
  assert.deepEqual(beacons, [], "sendBeacon is always credentials: include and cannot carry a header");
  assert.equal(seen.length, 2);
  const [session, ticket] = seen;
  assert.equal(session!.url, "https://api.example.test/realtime-avatar/end");
  assert.equal(session!.init.keepalive, true);
  assert.equal(session!.init.credentials, undefined, "the release must not override the wrapper's choice either");
  assert.equal(session!.init.signal, undefined, "a deadline would abort the release the page is leaving behind");
  assert.deepEqual(JSON.parse(String(session!.init.body)), { session_id: "s1", reason: "page_hide" });
  assert.deepEqual(JSON.parse(String(ticket!.init.body)), { queue_ticket_id: "qt_1", reason: "page_hide" });
});

test("with no fetch, the beacon is used only where its fixed credentials match the policy", () => {
  const noFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Reflect.deleteProperty(globalThis, "fetch");
  try {
    const beacons = fakePage("https://app.example.test");
    const crossOrigin = createProxyClient({ proxyUrl: "https://api.example.test/realtime-avatar" });
    assert.equal(crossOrigin.releaseLiveKitSessionBeacon("s1"), false, "include would differ from same-origin here");
    const sameOrigin = createProxyClient({ proxyUrl: "/api/realtime-avatar" });
    assert.equal(sameOrigin.releaseLiveKitSessionBeacon("s1"), true);
    const included = createProxyClient({ proxyUrl: "https://api.example.test/realtime-avatar", credentials: "include" });
    assert.equal(included.releaseLiveKitSessionBeacon("s1"), true);
    assert.deepEqual(beacons, [
      "https://app.example.test/api/realtime-avatar/end",
      "https://api.example.test/realtime-avatar/end",
    ]);
  } finally {
    if (noFetch) Object.defineProperty(globalThis, "fetch", noFetch);
  }
});
