import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { DisconnectReason } from "livekit-client";
import type {
  AvatarCallHandle,
  AvatarSessionClient,
  RealtimeSessionApi,
  useAvatarCall as UseAvatarCall,
  useRealtimeSession as UseRealtimeSession,
} from "../src/react/index.ts";

/**
 * Hanging up is terminal, from every phase, on the RENDERED hooks of the shipped
 * `realtime-avatar/react` entry (built by `pretest`).
 *
 * `end()` used to publish `request_graceful_close` and reset the in-memory lifecycle, and nothing
 * else. Queued, the place in line was kept and the auto-retry went on minting every few seconds,
 * so a call the user had hung up on later STARTED and billed. Live, the reset cleared `connected`
 * while the room stayed up, so the status read "connecting" and the 12s connect watchdog released
 * the session and asked for a FRESH grant: hanging up started a new paid session.
 */
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
globalThis.fetch = async () => new Response(null, { status: 204 });
// The hooks schedule through `window`; node has none.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {}, removeEventListener: () => {},
  },
});

const sdk: { useAvatarCall: typeof UseAvatarCall; useRealtimeSession: typeof UseRealtimeSession } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// In slices: React flushes the updates a timer schedules only when the act() scope closes, so one
// long act would hide every effect a watchdog or retry timer chains off its own state change.
async function settle(ms: number): Promise<void> {
  for (let waited = 0; waited < ms; waited += 50) await act(async () => { await sleep(50); });
}

type Ledger = { mints: number; releases: string[]; ticketReleases: string[] };

function fakeClient(answer: (mint: number) => "busy" | "ready"): { client: AvatarSessionClient; ledger: Ledger } {
  const ledger: Ledger = { mints: 0, releases: [], ticketReleases: [] };
  const client: AvatarSessionClient = {
    createLiveKitSessionOrBusy: async () => {
      ledger.mints += 1;
      if (answer(ledger.mints) === "busy") {
        return {
          status: "busy",
          busy: {
            message: "all slots busy",
            capacity: {
              max_sessions: 1, worker_count: 1, active_sessions: 1, reserved_sessions: 0,
              observed_worker_active_sessions: 1, available_sessions: 0, queue_size: 1,
              admission_open: false, recommended_retry_ms: 250, load: 1,
            },
            queue_size: 1,
            queue_position: 1,
            queue_ticket_id: "qt_1",
            recommended_retry_ms: 250,
          },
        };
      }
      return {
        status: "ready",
        grant: {
          status: "ready", session_id: `sess_${ledger.mints}`, room_name: "room", livekit_url: "wss://test.invalid",
          participant_token: "token", participant_identity: "user", max_session_seconds: 600,
          idle_timeout_seconds: 120, join_timeout_seconds: 75, reservation_expires_at: "2026-10-05T00:00:00Z",
          stt_mode: "server", room_created: true, dispatch_created: true,
        },
      };
    },
    releaseLiveKitSession: async (sessionId, reason) => { ledger.releases.push(`${sessionId}:${reason}`); return true; },
    releaseLiveKitSessionBeacon: () => false,
    releaseLiveKitQueueTicket: async (ticket, reason) => { ledger.ticketReleases.push(`${ticket}:${reason}`); return true; },
    releaseLiveKitQueueTicketBeacon: () => false,
  };
  return { client, ledger };
}

test("hanging up while QUEUED gives the place back, stops the retry, and ends once", async () => {
  const { client, ledger } = fakeClient(() => "busy");
  const ended: string[] = [];
  let call: AvatarCallHandle | undefined;
  function Call(): null {
    call = sdk.useAvatarCall({ client, avatarId: "ava_test", onEnded: ({ reason }) => ended.push(reason) }).call;
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(700);
  assert.equal(call?.status, "waiting");
  assert.ok(ledger.mints >= 2, "the queue should be re-asking on its hint before the hang-up");

  await act(async () => call?.end());
  const mintsAtEnd = ledger.mints;
  await settle(1_000);

  assert.equal(ledger.mints, mintsAtEnd, "the queue kept minting after the user hung up — that call would start and bill");
  assert.equal(ledger.ticketReleases[0], "qt_1:manual", "the place in line was not given back");
  // A retry already in flight at the hang-up may land after it and is released again; the
  // release is idempotent, so the only requirement is that every one names this ticket.
  assert.ok(ledger.ticketReleases.every((r) => r.startsWith("qt_1:")), ledger.ticketReleases.join());
  assert.equal(call?.status, "ended");
  assert.deepEqual(ended, ["user_ended"]);
  await act(async () => renderer?.unmount());
  assert.deepEqual(ended, ["user_ended"], "onEnded must fire exactly once");
});

test("hanging up while LIVE releases the session and no watchdog or ladder ever mints again", async () => {
  const { client, ledger } = fakeClient(() => "ready");
  const ended: string[] = [];
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({
      client,
      session: SESSION,
      connectWatchdogSeconds: 1,
      reconnectBackoffMs: [50],
      onEnded: ({ reason }) => ended.push(reason),
    });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(20);
  await act(async () => { session?.onConnected(); session?.setAgentPresent(true); });
  assert.equal(phaseOf(session), "live");
  assert.equal(ledger.mints, 1);

  await act(async () => session?.end("user_ended"));
  assert.equal(phaseOf(session), "ended", "a hung-up call read as connecting while its room stayed up");
  // The room the grant fed then leaves; LiveKit reports that as a client-initiated disconnect.
  await act(async () => session?.onDisconnected(DisconnectReason.CLIENT_INITIATED));
  await settle(1_600);

  assert.equal(ledger.mints, 1, "hanging up started a new paid session");
  assert.deepEqual(ledger.releases, ["sess_1:manual"]);
  assert.equal(phaseOf(session), "ended");
  assert.deepEqual(ended, ["user_ended"]);
  await act(async () => renderer?.unmount());
  assert.equal(ledger.mints, 1);
});

test("hanging up while a mint is in flight releases the grant that lands after it", async () => {
  let land: (() => void) | undefined;
  const { client: base, ledger } = fakeClient(() => "ready");
  const client: AvatarSessionClient = {
    ...base,
    createLiveKitSessionOrBusy: (input, options) =>
      new Promise((resolve) => { land = () => resolve(base.createLiveKitSessionOrBusy(input, options)); }),
  };
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({ client, session: SESSION });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(10);
  assert.equal(phaseOf(session), "requesting");
  await act(async () => session?.end());
  assert.equal(phaseOf(session), "ended");
  await act(async () => { land?.(); await sleep(10); });
  assert.deepEqual(ledger.releases, ["sess_1:superseded"], "a grant that landed after the hang-up was stranded");
  assert.equal(phaseOf(session), "ended");
  await act(async () => renderer?.unmount());
});

test("reconnect() after a hang-up is the one way to start again", async () => {
  const { client, ledger } = fakeClient(() => "ready");
  const ended: string[] = [];
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({ client, session: SESSION, onEnded: ({ reason }) => ended.push(reason) });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(20);
  // As AvatarCall does: an explicit label.
  await act(async () => session?.end("user_ended"));
  await act(async () => session?.reset());
  await settle(50);
  assert.equal(ledger.mints, 1, "reset() is not a redial");
  assert.equal(phaseOf(session), "ended");
  await act(async () => session?.reconnect());
  await settle(50);
  assert.equal(ledger.mints, 2);
  assert.equal(phaseOf(session), "connecting");
  // The redialled call ends for its own reason, not the hang-up that ended the one before it.
  await act(async () => { session?.onConnected(); session?.setAgentPresent(true); });
  await act(async () => session?.onDisconnected(DisconnectReason.ROOM_DELETED));
  assert.deepEqual(ended, ["user_ended", "disconnected"]);
  await act(async () => renderer?.unmount());
});

test("a redialled call ends with its own reason, not the hang-up before it", async () => {
  const { client } = fakeClient(() => "ready");
  const ended: string[] = [];
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({ client, session: SESSION, onEnded: ({ reason }) => ended.push(reason) });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(20);
  await act(async () => session?.end("user_ended"));
  await act(async () => session?.reconnect());
  await settle(50);
  await act(async () => { session?.onConnected(); session?.setAgentPresent(true); });
  assert.equal(phaseOf(session), "live");
  await act(async () => session?.onDisconnected(DisconnectReason.ROOM_DELETED));
  assert.deepEqual(ended, ["user_ended", "disconnected"]);
  await act(async () => renderer?.unmount());
});

const SESSION = { avatarId: "ava_test" };

// Read through a call: `assert.equal` narrows a property read, and TypeScript cannot see that
// act() changes it between two assertions.
function phaseOf(session: RealtimeSessionApi | undefined): string | undefined {
  return session?.phase.kind;
}

test("a double-tapped redial after a hang-up mints once, like every other reconnect", async () => {
  const { client: base, ledger } = fakeClient(() => "ready");
  const pending: Array<() => void> = [];
  const client: AvatarSessionClient = {
    ...base,
    createLiveKitSessionOrBusy: (input, options) =>
      new Promise((resolve) => { pending.push(() => resolve(base.createLiveKitSessionOrBusy(input, options))); }),
  };
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({ client, session: SESSION });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(20);
  await act(async () => { pending.shift()?.(); await sleep(5); });
  await act(async () => session?.end());
  await act(async () => session?.reconnect());
  await settle(20);
  await act(async () => session?.reconnect());
  await settle(20);
  while (pending.length) await act(async () => { pending.shift()?.(); await sleep(5); });
  await settle(50);
  assert.equal(ledger.mints, 2, "the second tap minted a third session");
  assert.deepEqual(ledger.releases, ["sess_1:manual"]);
  assert.notEqual(phaseOf(session), "reconnectable");
  await act(async () => renderer?.unmount());
});

test("deactivating starts a new call: the next one ends with its own reason", async () => {
  const { client } = fakeClient(() => "ready");
  const ended: string[] = [];
  let session: RealtimeSessionApi | undefined;
  function Call({ active }: { active: boolean }): null {
    session = sdk.useRealtimeSession({ client, session: SESSION, active, onEnded: ({ reason }) => ended.push(reason) });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call, { active: true })); });
  await settle(20);
  await act(async () => session?.end("user_ended"));
  await act(async () => renderer?.update(createElement(Call, { active: false })));
  await act(async () => renderer?.update(createElement(Call, { active: true })));
  await settle(50);
  await act(async () => { session?.onConnected(); session?.setAgentPresent(true); });
  assert.equal(phaseOf(session), "live");
  await act(async () => session?.onDisconnected(DisconnectReason.ROOM_DELETED));
  assert.deepEqual(ended, ["user_ended", "disconnected"]);
  await act(async () => renderer?.unmount());
});

test("end() on a call that already ended is a no-op: its reason and error survive", async () => {
  const failing: AvatarSessionClient = {
    ...fakeClient(() => "ready").client,
    createLiveKitSessionOrBusy: async () => { throw new Error("plan wall"); },
  };
  let session: RealtimeSessionApi | undefined;
  function Call(): null {
    session = sdk.useRealtimeSession({ client: failing, session: SESSION });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Call)); });
  await settle(20);
  assert.deepEqual(session?.phase, { kind: "ended", reason: "error" });
  await act(async () => session?.end());
  assert.deepEqual(session?.phase, { kind: "ended", reason: "error" }, "end() rewrote a failed call as a hang-up");
  assert.equal(session?.capacity.kind, "error", "end() dropped the grant error the app routes on");
  await act(async () => renderer?.unmount());
});
