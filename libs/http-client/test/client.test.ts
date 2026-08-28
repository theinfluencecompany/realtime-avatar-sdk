import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar, SDK_VERSION } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";
import { isQueued } from "../src/types.ts";

/** A fetch stub that records the request and replays a canned response. */
function stub(response: { status?: number; body?: unknown }) {
  const seen: { url?: string; method?: string; body?: Record<string, unknown> } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.method = init.method;
    if (typeof init.body === "string") seen.body = JSON.parse(init.body);
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const GRANT = {
  status: "ready", session_id: "s1", room_name: "r1", livekit_url: "wss://x",
  participant_token: "tok", participant_identity: "id", max_session_seconds: 600,
  idle_timeout_seconds: 120, reservation_expires_at: "2026-08-07T00:00:00Z",
};

test("startCall translates camelCase policy to the strict snake_case wire", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.startCall({
    avatarId: "ava_1",
    instructions: "be kind",
    context: [{ role: "user", content: "hi" }],
    maxSeconds: 300,
    metadata: { userId: "u1" },
  });
  assert.equal(seen.body?.avatar_id, "ava_1");
  assert.equal(seen.body?.instructions, "be kind");
  assert.equal(seen.body?.max_session_seconds, 300);
  assert.deepEqual(seen.body?.initial_context, [{ role: "user", content: "hi" }]);
  assert.deepEqual(seen.body?.client_metadata, { userId: "u1" });
  // camelCase must never reach the wire — the schema is strict and would reject it.
  assert.ok(!("maxSeconds" in (seen.body ?? {})));
});

test("startCall preserves the grant verbatim for relay", async () => {
  const { fetchImpl } = stub({ body: { ...GRANT, future_field: "unknown" } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const call = await rta.startCall({ avatarId: "ava_1" });
  assert.ok(!isQueued(call));
  if (isQueued(call)) return;
  // A field this SDK does not model must still survive to the client.
  assert.equal(call.raw.future_field, "unknown");
  assert.equal(call.livekitUrl, "wss://x");
});

test("a busy pool is a queue, not a throw", async () => {
  const { fetchImpl } = stub({
    status: 429,
    body: { queue_position: 3, queue_size: 5, recommended_retry_ms: 4000 },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const call = await rta.startCall({ avatarId: "ava_1" });
  assert.ok(isQueued(call));
  if (!isQueued(call)) return;
  assert.equal(call.position, 3);
  assert.equal(call.retryAfterMs, 4000);
});

test("a state map compiles into clip_library with the cue under its public name", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.startCall({
    avatarId: "ava_1",
    video: { states: { happy: { when: "when the user is happy", url: "https://x/h.mp4", weight: 0.3 } } },
  });
  assert.deepEqual(seen.body?.clip_library, [{
    clip_id: "happy", source_video_url: "https://x/h.mp4",
    trigger: "directive", when: "when the user is happy", weight: 0.3,
  }]);
});

test("a call never carries its own media — the rest clip belongs to the avatar", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.startCall({
    avatarId: "ava_1",
    video: { states: { happy: { when: "when the user is happy", url: "https://x/h.mp4" } } },
  });
  // The session endpoint rejects a body carrying media outright (422), so emitting any of
  // these is not a degraded call — it is no call at all. Clip URLs ride inside
  // `clip_library` entries, which is a different thing from the session's own source.
  assert.equal(seen.body?.source_kind, undefined);
  assert.equal(seen.body?.source_video_url, undefined);
  assert.equal(seen.body?.portrait_url, undefined);
  assert.equal(seen.body?.video_cache_id, undefined);
});

test("edits carries the clip AND the instruction, and drops no other policy", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.startCall({
    avatarId: "ava_1",
    video: {
      edits: {
        instruction: "turn the room into a snowy cabin at night",
        referenceUrl: "https://x/scarf.png",
      },
      // `states` is mapped AFTER the edits block inside videoToWire. This is the field an
      // edits branch that returned early would silently drop — the character would simply
      // never switch states, for exactly the calls using the newest feature — so this test
      // pins edits AND states surviving together.
      states: { happy: { when: "when the user is happy", url: "https://x/h.mp4" } },
    },
    transcript: { url: "https://app.example/hook", secret: "0123456789abcdef" },
    metadata: { user_id: "u1" },
  });
  assert.deepEqual(seen.body?.support_edits, {
    instruction: "turn the room into a snowy cabin at night",
    reference_url: "https://x/scarf.png",
  });
  // Edits rewrite the avatar's STORED source video — a call still carries no media of its
  // own, so no source keys ride the wire. (The old `loop` URL field is gone from the
  // surface for exactly that reason.)
  assert.equal(seen.body?.source_kind, undefined);
  assert.equal(seen.body?.source_video_url, undefined);
  const clips = seen.body?.clip_library as Array<Record<string, unknown>>;
  assert.equal(clips?.length, 1);
  assert.equal(clips?.[0]?.clip_id, "happy");
  assert.ok(seen.body?.transcript_webhook);
  assert.deepEqual(seen.body?.client_metadata, { user_id: "u1" });
});

test("live rides the edits block; its ABSENCE is what fixes the look", async () => {
  const reactive = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: reactive.fetchImpl }).startCall({
    avatarId: "ava_1",
    video: {
      edits: {
        instruction: "a warm study at golden hour",
        live: {
          rules: "Re-edit the room when the user says where they'd rather be. Never change her.",
          cooldownSeconds: 45,
          renderer: "generative",
        },
      },
    },
  });
  // Nested in, nested out. The fields are only meaningful together, so they travel as
  // one object rather than as siblings a caller could half-set. `renderer` rides along
  // untranslated — the wire name and the public name are the same word.
  assert.deepEqual(reactive.seen.body?.support_edits, {
    instruction: "a warm study at golden hour",
    live_edit: {
      rules: "Re-edit the room when the user says where they'd rather be. Never change her.",
      cooldown_seconds: 45,
      renderer: "generative",
    },
  });

  // No live ⇒ the key is absent entirely, not an empty object. Absence is the switch;
  // an empty object would read as "enabled, permitting nothing", which is a different and
  // much more confusing thing to debug.
  const fixed = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: fixed.fetchImpl }).startCall({
    avatarId: "ava_1",
    video: { edits: { instruction: "a warm study at golden hour" } },
  });
  assert.deepEqual(fixed.seen.body?.support_edits, { instruction: "a warm study at golden hour" });
});

test("live without a cooldown omits the key and takes the server default", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).startCall({
    avatarId: "ava_1",
    video: { edits: { instruction: "a beach", live: { rules: "follow the user" } } },
  });
  assert.deepEqual((seen.body?.support_edits as Record<string, unknown>)?.live_edit, {
    rules: "follow the user",
  });
});

test("a fractional cooldown is floored, not sent as a float the wire rejects", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).startCall({
    avatarId: "ava_1",
    video: {
      edits: {
        instruction: "a beach",
        live: { rules: "follow the user", cooldownSeconds: 12.7 },
      },
    },
  });
  // The wire is `.int()`. A caller computing this from a duration would otherwise 422 on
  // an arithmetic detail that has nothing to do with what they asked for.
  const liveEdit = (seen.body?.support_edits as Record<string, unknown>)?.live_edit;
  assert.equal((liveEdit as Record<string, unknown>)?.cooldown_seconds, 12);
});

test("edits without a reference omits the key rather than sending null", async () => {
  const { seen, fetchImpl } = stub({ body: GRANT });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.startCall({
    avatarId: "ava_1",
    video: { edits: { instruction: "make it snow" } },
  });
  // The wire is .strict() and reference_url is `.url()` — an explicit null or ""
  // would 422 the whole mint. Omitting a loop is also fine: the avatar's stored
  // source video is the clip we edit.
  assert.deepEqual(seen.body?.support_edits, { instruction: "make it snow" });
  assert.ok(!("source_kind" in (seen.body ?? {})));
});

test("402 surfaces as a billing error the caller can branch on", async () => {
  const { fetchImpl } = stub({ status: 402, body: { code: "insufficient_credits" } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await assert.rejects(
    () => rta.startCall({ avatarId: "ava_1" }),
    (err: unknown) => err instanceof RealtimeAvatarHttpError && err.isBilling && err.code === "insufficient_credits",
  );
});

test("assets map the wire's publicUrl, and refuse to hand back a broken one", async () => {
  const { fetchImpl } = stub({
    body: { id: "ast_1", kind: "image", status: "ready", contentType: "image/png", sizeBytes: 12,
            publicUrl: "https://realtimeavatar.ai/api/assets/x.png" },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const asset = await rta.createRemoteAsset({ kind: "image", remoteUrl: "https://x/y.png" });
  // Reading `url` instead of `publicUrl` produced the string "undefined" — no throw, and the
  // failure only appeared when something tried to fetch it.
  assert.equal(asset.url, "https://realtimeavatar.ai/api/assets/x.png");
  assert.equal(asset.contentType, "image/png");

  const missing = stub({ body: { id: "ast_2", kind: "image" } });
  const rta2 = new RealtimeAvatar({ apiKey: "k", fetch: missing.fetchImpl });
  await assert.rejects(() => rta2.createRemoteAsset({ kind: "image", remoteUrl: "https://x/y.png" }),
    /without a public URL/);
});

test("clientTools is sent as a capability, and only when asked for", async () => {
  const on = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: on.fetchImpl })
    .startCall({ avatarId: "ava_1", clientTools: true });
  assert.deepEqual(on.seen.body?.capabilities, ["client_tools"]);

  // Absent by default: granting tool access is a decision, never an accident.
  const off = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: off.fetchImpl }).startCall({ avatarId: "ava_1" });
  assert.ok(!("capabilities" in (off.seen.body ?? {})));
});

test("mode picks the renderer and NEVER pins a capacity pool", async () => {
  // The default is video. This SDK used to rewrite mode to "voice" and pin a named pool
  // here, on the belief that full duplex was a separate audio-only path reachable only that
  // way. It no longer is — both modes are full duplex — so pinning aimed the default call
  // at a pool serving no traffic AND threw away the video track. Both are asserted below.
  const dflt = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: dflt.fetchImpl }).startCall({ avatarId: "ava_1" });
  assert.equal(dflt.seen.body?.mode, "avatar");
  assert.ok(!("capacity_pool" in (dflt.seen.body ?? {})));

  const video = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: video.fetchImpl })
    .startCall({ avatarId: "ava_1", mode: "avatar" });
  assert.equal(video.seen.body?.mode, "avatar");
  assert.ok(!("capacity_pool" in (video.seen.body ?? {})));

  // Render-free is a mode, not a duplex setting: it stays "voice" and still pins nothing.
  const voice = stub({ body: GRANT });
  await new RealtimeAvatar({ apiKey: "k", fetch: voice.fetchImpl })
    .startCall({ avatarId: "ava_1", mode: "voice" });
  assert.equal(voice.seen.body?.mode, "voice");
  assert.ok(!("capacity_pool" in (voice.seen.body ?? {})));
});

test("endCall sends the strict release wire — exactly session_id and reason", async () => {
  const { seen, fetchImpl } = stub({ body: { ok: true } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  assert.equal(await rta.endCall("sess_1", { reason: "page_hide" }), true);
  assert.match(seen.url ?? "", /\/realtime\/livekit\/session\/release$/);
  // The schema is strict — an extra or renamed key is a 400, so the body is exactly this.
  assert.deepEqual(seen.body, { session_id: "sess_1", reason: "page_hide" });
});

test("endCall omits reason when none is given — absent, not null", async () => {
  const { seen, fetchImpl } = stub({ body: { ok: true } });
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).endCall("sess_1");
  assert.deepEqual(seen.body, { session_id: "sess_1" });
});

test("endCall carries the grant's capacity_pool when the caller has it", async () => {
  const { seen, fetchImpl } = stub({ body: { ok: true } });
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl })
    .endCall("sess_1", { capacityPool: "pool-a" });
  assert.deepEqual(seen.body, { session_id: "sess_1", capacity_pool: "pool-a" });
});

test("endCall is best-effort: a non-2xx is false, never a throw", async () => {
  // A beacon-triggered route has nowhere useful to put an exception, and the join timeout
  // reclaims a slot whose release was dropped — a failed release is a slower one.
  const { fetchImpl } = stub({ status: 404, body: "<!DOCTYPE html>" });
  assert.equal(await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).endCall("sess_1"), false);
});

test("endCall swallows a dead connection into false, after the usual retries", async () => {
  const { attempts, fetchImpl } = scripted(["network"]);
  assert.equal(await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).endCall("sess_1"), false);
  assert.equal(attempts.length, 3, "transient handling is shared with every other request");
});

test("endCall with no id makes no request — there is nothing to end", async () => {
  const { attempts, fetchImpl } = scripted([{ body: { ok: true } }]);
  assert.equal(await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).endCall(""), false);
  assert.equal(attempts.length, 0);
});


/** A fetch stub that replays a SCRIPT of responses and records every attempt. */
function scripted(script: Array<{ status?: number; body?: unknown } | "network">) {
  const attempts: Array<{ headers: Headers; body?: string; url: string }> = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const step = script[Math.min(i++, script.length - 1)] ?? { status: 200 };
    attempts.push({
      url: String(_url),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    if (step === "network") throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { attempts, fetchImpl };
}

test("setClipLibrary declares the full library and hands back the plan", async () => {
  const { seen, fetchImpl } = stub({ status: 202, body: {
    data: [{
      clipId: "wave", role: "gesture", status: "queued", url: null, whenHint: "when greeting",
      source: "generated", motionPrompt: "waves hello", durationSeconds: 5, anchorVersion: 1,
      poseCheck: null, error: null,
      createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
    }],
    avatarId: "ava_1", revision: 1, anchorVersion: 1,
    anchor: { url: "https://cdn.example/rest.png", source: "portrait", timeMs: null },
    clipLibraryEligible: true,
    plan: { kept: [], queued: ["wave"], retired: ["old_idle"] },
  } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });

  const update = await rta.setClipLibrary("ava_1", {
    expectedRevision: 0,
    clips: [{ clipId: "wave", role: "gesture", whenHint: "when greeting", source: { motionPrompt: "waves hello" } }],
  });

  assert.equal(seen.method, "PUT");
  assert.ok(seen.url?.endsWith("/avatars/ava_1/clips"));
  // This route's wire is already camelCase — the declaration passes through byte-for-byte.
  assert.deepEqual(seen.body, {
    expectedRevision: 0,
    clips: [{ clipId: "wave", role: "gesture", whenHint: "when greeting", source: { motionPrompt: "waves hello" } }],
  });
  assert.deepEqual(update.plan, { kept: [], queued: ["wave"], retired: ["old_idle"] });
  assert.equal(update.revision, 1);
});

test("setClipLibrary without expectedRevision omits the key — unconditional, not revision 0", async () => {
  const { seen, fetchImpl } = stub({ status: 202, body: {
    data: [], avatarId: "ava_1", revision: 2, anchorVersion: 1, anchor: null,
    clipLibraryEligible: true, plan: { kept: [], queued: [], retired: [] },
  } });
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).setClipLibrary("ava_1", { clips: [] });
  assert.ok(seen.body);
  assert.ok(!("expectedRevision" in seen.body));
});

test("listClips hands back the envelope: rows plus revision, anchor and eligibility", async () => {
  const { seen, fetchImpl } = stub({ body: {
    data: [{
      clipId: "wave", role: "gesture", status: "queued", url: null, whenHint: "when greeting",
      source: "generated", motionPrompt: "waves hello", durationSeconds: 5, anchorVersion: 1,
      poseCheck: null, error: null,
      createdAt: "2026-08-27T00:00:00Z", updatedAt: "2026-08-27T00:00:00Z",
    }],
    avatarId: "ava_1", revision: 3, anchorVersion: 2,
    anchor: { url: "https://cdn.example/rest.png", source: "source_frame", timeMs: 1200 },
    clipLibraryEligible: true,
  } });
  const library = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).listClips("ava_1");
  assert.equal(seen.method, "GET");
  assert.ok(seen.url?.endsWith("/avatars/ava_1/clips"));
  assert.equal(library.revision, 3);
  assert.equal(library.anchor?.timeMs, 1200);
  assert.equal(library.data[0]?.clipId, "wave");
});

test("a clip envelope without a revision throws instead of disarming CAS", async () => {
  // A missing `revision` flowing through would drop `expectedRevision` from the next
  // declare — CAS silently degrades to unconditional. The guard makes that loud.
  const { fetchImpl } = stub({ status: 202, body: { data: [], plan: { kept: [], queued: [], retired: [] } } });
  await assert.rejects(
    new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).setClipLibrary("ava_1", { clips: [] }),
    (err: unknown) => err instanceof RealtimeAvatarError && /did not match the contract/.test((err as Error).message),
  );
});

test("setClipLibrary is mutating, so the PUT carries an idempotency key", async () => {
  const { attempts, fetchImpl } = scripted([{ status: 202, body: {
    data: [], avatarId: "ava_1", revision: 1, anchorVersion: 1, anchor: null,
    clipLibraryEligible: true, plan: { kept: [], queued: [], retired: [] },
  } }]);
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).setClipLibrary("ava_1", { clips: [] });
  assert.match(attempts[0]?.headers.get("idempotency-key") ?? "", /.{16,}/);
});

test("SDK_VERSION tracks package.json, so the User-Agent cannot go stale", async () => {
  const pkg = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SDK_VERSION, pkg.version);
});

test("a transient 503 is retried, and the SAME idempotency key is replayed", async () => {
  const { attempts, fetchImpl } = scripted([{ status: 503 }, { status: 503 }, { body: GRANT }]);
  const call = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).startCall({ avatarId: "a" });
  assert.equal(isQueued(call), false);
  assert.equal(attempts.length, 3);

  // Key reuse is the whole point: without it a 503 that DID start a call bills twice.
  const keys = attempts.map((a) => a.headers.get("idempotency-key"));
  assert.equal(new Set(keys).size, 1, "one key across all attempts");
  assert.match(keys[0] ?? "", /.{16,}/);
  // The replayed body must be byte-identical too, or dedupe upstream cannot match it.
  assert.equal(new Set(attempts.map((a) => a.body)).size, 1);
});

test("429 is NOT retried — on a call it is the queue, not a rate limit", async () => {
  const { attempts, fetchImpl } = scripted([{ status: 429, body: { queue_position: 3 } }]);
  const call = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).startCall({ avatarId: "a" });
  assert.equal(attempts.length, 1, "retrying would burn the backoff and still return queued");
  assert.ok(isQueued(call) && call.position === 3);
});

test("a 4xx is final — retrying a rejected schema just wastes time", async () => {
  const { attempts, fetchImpl } = scripted([{ status: 422, body: { code: "bad" } }]);
  await assert.rejects(
    new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).startCall({ avatarId: "a" }),
    RealtimeAvatarHttpError);
  assert.equal(attempts.length, 1);
});

test("a dropped connection is retried; exhausting retries reports the attempt count", async () => {
  const ok = scripted(["network", { body: GRANT }]);
  await new RealtimeAvatar({ apiKey: "k", fetch: ok.fetchImpl }).startCall({ avatarId: "a" });
  assert.equal(ok.attempts.length, 2);

  const dead = scripted(["network"]);
  await assert.rejects(
    new RealtimeAvatar({ apiKey: "k", fetch: dead.fetchImpl }).startCall({ avatarId: "a" }),
    /failed after 3 attempt\(s\)/);
  assert.equal(dead.attempts.length, 3);
});

test("maxRetries:0 restores the old single-shot behaviour", async () => {
  const { attempts, fetchImpl } = scripted([{ status: 503 }, { body: GRANT }]);
  await assert.rejects(
    new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl, maxRetries: 0 }).startCall({ avatarId: "a" }),
    RealtimeAvatarHttpError);
  assert.equal(attempts.length, 1);
});

test("every request identifies the SDK, and a caller can name their app", async () => {
  const { attempts, fetchImpl } = scripted([{ body: { data: [] } }]);
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl, userAgent: "acme-web/2.1" }).listAvatars();
  const first = attempts[0];
  assert.ok(first, "the request was made");
  const ua = first.headers.get("user-agent") ?? "";
  assert.match(ua, /^realtime-avatar-sdk\/\d+\.\d+\.\d+ /);
  assert.match(ua, /acme-web\/2\.1$/);
  // A read carries no idempotency key — there is nothing to deduplicate.
  assert.equal(first.headers.get("idempotency-key"), null);
});

test("listSessions returns when each session ran, how long, and what it cost", async () => {
  const { attempts, fetchImpl } = scripted([{ body: {
    data: [{
      sessionId: "518b8bad-3287-45f3-bf98-d91db29e2c4f", avatarId: "ava_1", status: "released",
      startedAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T10:01:02Z",
      activeSeconds: 61.5, billedCreditMicros: 2500,
      metadata: { userId: "u_42" }, createdAt: "2026-08-01T10:00:00Z",
    }],
    nextCursor: null, from: "2026-07-11T00:00:00Z", to: "2026-08-10T00:00:00Z",
  } }]);

  const page = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl })
    .listSessions({ from: "2026-07-11T00:00:00Z", limit: 50 });

  assert.equal(page.sessions.length, 1);
  const s = page.sessions[0];
  assert.ok(s);
  assert.equal(s.activeSeconds, 61.5);     // seconds — never rounded up to a minute
  assert.equal(s.billedCreditMicros, 2500);
  // Your own metadata comes back, so you can tell WHICH of your users this was.
  assert.deepEqual(s.metadata, { userId: "u_42" });
  assert.match(attempts[0]?.headers.get("user-agent") ?? "", /realtime-avatar-sdk\//);
});

test("a missing field becomes null, never the string 'undefined'", async () => {
  // A `String(x)` on an absent field is how `asset.url` once shipped the literal
  // "undefined" to callers. Read defensively and prove it.
  const { fetchImpl } = scripted([{ body: { data: [{ sessionId: "s1" }], nextCursor: null } }]);
  const page = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).listSessions();
  const s = page.sessions[0];
  assert.ok(s);
  assert.equal(s.activeSeconds, null);
  assert.equal(s.billedCreditMicros, null);
  assert.equal(s.avatarId, null);
  assert.deepEqual(s.metadata, {});
});

test("iterateSessions follows the cursor to the end, exactly once each", async () => {
  const row = (id: string) => ({ sessionId: id, status: "released", metadata: {}, createdAt: "x" });
  const { attempts, fetchImpl } = scripted([
    { body: { data: [row("a"), row("b")], nextCursor: "cur1", from: "f", to: "t" } },
    { body: { data: [row("c")], nextCursor: null, from: "f", to: "t" } },
  ]);

  const seen: string[] = [];
  for await (const s of new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).iterateSessions()) {
    seen.push(s.sessionId);
  }
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(attempts.length, 2);
  assert.match(attempts[1]?.url ?? "", /cursor=cur1/);
});

test("endUserId narrows to one of YOUR users", async () => {
  const { attempts, fetchImpl } = scripted([{ body: { data: [], nextCursor: null } }]);
  await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).listSessions({ endUserId: "u_42" });
  assert.match(attempts[0]?.url ?? "", /endUserId=u_42/);
});

test("an untagged session still bills, it just has no user on it", async () => {
  // Tagging is opt-in. The row must come back complete either way, or "billing by session"
  // would quietly depend on remembering to set metadata.
  const { fetchImpl } = scripted([{ body: { data: [{
    sessionId: "518b8bad-3287-45f3-bf98-d91db29e2c4f", status: "released",
    activeSeconds: 61.5, billedCreditMicros: 2500, createdAt: "2026-08-01T10:00:00Z",
  }], nextCursor: null } }]);
  const page = await new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl }).listSessions();
  const s = page.sessions[0];
  assert.ok(s);
  assert.deepEqual(s.metadata, {});
  assert.equal(s.activeSeconds, 61.5);
  assert.equal(s.billedCreditMicros, 2500);
});

test("updateAvatar PATCHes the curated patch and returns the avatar", async () => {
  const { seen, fetchImpl } = stub({
    body: { id: "ava_1", displayName: "Rin", sourceKind: "video", status: "ready", defaultVoiceId: "v2" },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const avatar = await rta.updateAvatar("ava_1", { defaultVoiceId: "v2" });
  assert.equal(seen.method, "PATCH");
  assert.ok(seen.url?.endsWith("/avatars/ava_1"));
  assert.deepEqual(seen.body, { defaultVoiceId: "v2" });
  assert.equal(avatar.defaultVoiceId, "v2");
});

test("swapSource sends ONLY the swap fields — the platform refuses them beside any other", async () => {
  const { seen, fetchImpl } = stub({
    body: {
      id: "ava_1", displayName: "Rin", sourceKind: "video", status: "ready",
      defaultVoiceId: null, sourceAssetId: "ast_old", error: null,
    },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const avatar = await rta.swapSource("ava_1", { sourceAssetId: "ast_new", anchorTimeMs: 1200 });
  assert.equal(seen.method, "PATCH");
  assert.ok(seen.url?.endsWith("/avatars/ava_1"));
  assert.deepEqual(seen.body, { sourceAssetId: "ast_new", anchorTimeMs: 1200 });
  // Accepted, not applied: the avatar still reads as the generation it is SERVING.
  assert.equal(avatar.sourceAssetId, "ast_old");
  assert.equal(avatar.status, "ready");
});

test("swapSource omits anchorTimeMs entirely when it was not asked for", async () => {
  const { seen, fetchImpl } = stub({
    body: { id: "ava_1", displayName: "Rin", sourceKind: "video", status: "ready", defaultVoiceId: null },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.swapSource("ava_1", { sourceAssetId: "ast_new" });
  assert.deepEqual(seen.body, { sourceAssetId: "ast_new" });
});

test("retimeAnchor moves the frame without naming a source", async () => {
  const { seen, fetchImpl } = stub({
    body: { id: "ava_1", displayName: "Rin", sourceKind: "video", status: "ready", defaultVoiceId: null },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.retimeAnchor("ava_1", 2000);
  assert.equal(seen.method, "PATCH");
  assert.deepEqual(seen.body, { anchorTimeMs: 2000 });
});

test("a failed swap reads as a READY avatar carrying the reason — the only channel it has", async () => {
  const { fetchImpl } = stub({
    body: {
      id: "ava_1", displayName: "Rin", sourceKind: "video", status: "ready", defaultVoiceId: null,
      sourceAssetId: "ast_old", error: "source swap rejected: never returns to rest",
    },
  });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  const avatar = await rta.getAvatar("ava_1");
  // Polling for `status === "failed"` would MISS this — she is still serving.
  assert.equal(avatar.status, "ready");
  assert.match(avatar.error ?? "", /never returns to rest/);
  assert.equal(avatar.sourceAssetId, "ast_old");
});

test("deleteAvatar sends DELETE, and a refusal throws like any other", async () => {
  const { seen, fetchImpl } = stub({ body: { ok: true } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: fetchImpl });
  await rta.deleteAvatar("ava_9");
  assert.equal(seen.method, "DELETE");
  assert.ok(seen.url?.endsWith("/avatars/ava_9"));

  const denied = stub({ status: 403, body: { code: "missing_scope" } });
  const rta2 = new RealtimeAvatar({ apiKey: "k", fetch: denied.fetchImpl, maxRetries: 0 });
  await assert.rejects(rta2.deleteAvatar("ava_9"), (err: unknown) => {
    assert.ok(err instanceof RealtimeAvatarHttpError);
    assert.equal(err.status, 403);
    return true;
  });
});

test("createAvatar forwards settings and metadata only when given", async () => {
  const bare = stub({ body: { id: "ava_1" } });
  const rta = new RealtimeAvatar({ apiKey: "k", fetch: bare.fetchImpl });
  await rta.createAvatar({ displayName: "Rin", sourceKind: "video", sourceAssetId: "as_1" });
  assert.ok(!("settings" in (bare.seen.body ?? {})));
  assert.ok(!("metadata" in (bare.seen.body ?? {})));

  const extras = stub({ body: { id: "ava_1" } });
  const rta2 = new RealtimeAvatar({ apiKey: "k", fetch: extras.fetchImpl });
  await rta2.createAvatar({
    displayName: "Rin",
    sourceKind: "video",
    sourceAssetId: "as_1",
    settings: { persona: "warm, specific" },
    metadata: { characterId: "c1" },
  });
  assert.deepEqual(extras.seen.body?.settings, { persona: "warm, specific" });
  assert.deepEqual(extras.seen.body?.metadata, { characterId: "c1" });
});

test("the default fetch survives a this-sensitive global (workerd)", async (t) => {
  // workerd's fetch throws "Illegal invocation" when called with any `this` other than
  // the global — which is exactly what a stored bare reference invoked as
  // `this.#fetch(...)` does. Replay that contract here so the default path can never
  // regress into it.
  const original = globalThis.fetch;
  globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    if (this !== globalThis && this !== undefined) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
    }
    void args;
    return Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  } as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const rta = new RealtimeAvatar({ apiKey: "k", maxRetries: 0 });
  assert.deepEqual(await rta.listAvatars(), []);
});
