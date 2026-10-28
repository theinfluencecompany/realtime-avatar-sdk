import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";
import type { components } from "../src/generated/openapi.ts";
import type { CreateRenderInput, ListRendersResponse, Render, RenderAccessResponse, RenderShot, ShotTiming } from "../src/types.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type WireCreateRender = components["schemas"]["CreateRenderRequest"];
type WireRenderVoice = NonNullable<WireCreateRender["voice"]>;
type InputRenderVoice = NonNullable<CreateRenderInput["voice"]>;
const contractParity: [
  Equal<Render, components["schemas"]["Render"]>,
  Equal<ShotTiming, NonNullable<components["schemas"]["Render"]["timeline"]>[number]>,
  Equal<Omit<CreateRenderInput, "voice" | "voiceId">, Omit<WireCreateRender, "voice" | "voiceId">>,
  Equal<NonNullable<CreateRenderInput["voiceId"]>, NonNullable<WireCreateRender["voiceId"]>>,
  Equal<Required<InputRenderVoice>, Required<WireRenderVoice>>,
  Equal<WireRenderVoice, NonNullable<components["schemas"]["LiveKitSessionRequest"]["voice"]>>,
  Equal<RenderShot, WireCreateRender["shots"][number]>,
  Equal<RenderAccessResponse, components["schemas"]["RenderAccessResponse"]>,
  Equal<ListRendersResponse, components["schemas"]["ListRendersResponse"]>,
] = [true, true, true, true, true, true, true, true, true];
void contractParity;

const fishVoice = { provider: "fish", voice_id: "fish_voice_test", speed: 1.1 } satisfies InputRenderVoice;
// @ts-expect-error The platform refuses voice with voiceId (422 "send voice or voiceId, not both").
const bothVoices: CreateRenderInput = { avatarId: "ava_0123456789abcdef0123456789abcdef", shots: [{ say: "hi" }], voiceId: "voice_test", voice: fishVoice };
void bothVoices;

const renderId = "rnd_0123456789abcdef0123456789abcdef";
const queued: Render = {
  id: renderId, object: "render", status: "queued", avatarId: "ava_0123456789abcdef0123456789abcdef",
  voiceId: "voice_test", durationMs: null, width: null, height: null, timeline: null, error: null,
  createdAt: "2026-10-28T12:00:00.000Z", completedAt: null,
};
// An assumed timeline for the founder's script, not one observed from a render. It assumes both
// clips play once: a once clip that outlasts its speech, a once clip that the speech plus pause
// outlasts (the body continues on the loop from before), and a shot that keeps that loop.
const timeline: ShotTiming[] = [
  {
    index: 0, startMs: 400, endMs: 5_000, clipId: "gesture_send_flower", playback: "once",
    speechStartMs: 400, speechEndMs: 3_900, clipEndMs: 5_000, afterClipId: null,
  },
  {
    index: 1, startMs: 5_000, endMs: 8_200, clipId: "idle_touch_collar", playback: "once",
    speechStartMs: 5_000, speechEndMs: 7_300, clipEndMs: 7_000, afterClipId: "primary",
  },
  {
    index: 2, startMs: 8_200, endMs: 10_000, clipId: "primary", playback: "loop",
    speechStartMs: 8_200, speechEndMs: 9_900, clipEndMs: null, afterClipId: null,
  },
];
const ready: Render = {
  ...queued, status: "ready", durationMs: 10_600, width: 512, height: 512, timeline,
  completedAt: "2026-10-28T12:01:00.000Z",
};
const failed: Render = {
  ...queued, status: "failed",
  error: { code: "too_long", message: "The rendered video would be longer than the maximum length. Shorten the script." },
  completedAt: "2026-10-28T12:01:00.000Z",
};
const script: CreateRenderInput = {
  avatarId: "ava_0123456789abcdef0123456789abcdef",
  shots: [
    { clipId: "gesture_send_flower", say: "你终于来了。今天……我有话想对你说。" },
    { clipId: "idle_touch_collar", say: "别笑，我是认真的。", pauseAfterMs: 800 },
    { say: "所以，今晚留下来。" },
  ],
};

function client(fetchImpl: (request: Request) => Response | Promise<Response>) {
  return new RealtimeAvatar({ apiKey: "test-key", fetch: async (input, init) => fetchImpl(new Request(input, init)) });
}

test("createRender posts the camelCase shots unchanged with one idempotency key across a retry", async () => {
  const requests: Request[] = [];
  const bodies: unknown[] = [];
  const rta = client(async (request) => {
    requests.push(request);
    bodies.push(await request.json());
    return requests.length === 1
      ? Response.json({ code: "service_unavailable" }, { status: 503, headers: { "retry-after": "0" } })
      : Response.json(queued, { status: 202 });
  });
  assert.deepEqual(await rta.createRender(script), queued);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/api/v1/renders");
    assert.equal(request.headers.get("authorization"), "Bearer test-key");
    assert.equal(request.headers.get("content-type"), "application/json");
  }
  const key = requests[0].headers.get("idempotency-key");
  assert.ok(key);
  assert.equal(requests[1].headers.get("idempotency-key"), key);
  assert.deepEqual(bodies, [script, script]);
});

test("createRender refusals stay typed HTTP errors carrying the platform code", async () => {
  const rta = client(() => Response.json(
    { code: "render_clip_unavailable", message: "Clip gesture_send_flower is not ready.", details: { clipId: "gesture_send_flower" } },
    { status: 422, headers: { "x-request-id": "0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" } },
  ));
  await assert.rejects(rta.createRender(script), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarHttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "render_clip_unavailable");
    assert.equal(error.requestId, "0b8a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
    return true;
  });
});

test("createRender sends an inline voice as the live call's snake_case object, and the render reports voiceId null", async () => {
  const bodies: unknown[] = [];
  const inline: Render = { ...queued, voiceId: null };
  const rta = client(async (request) => {
    bodies.push(await request.json());
    return Response.json(inline, { status: 202 });
  });
  const input: CreateRenderInput = { avatarId: script.avatarId, shots: script.shots, voice: fishVoice };
  const render = await rta.createRender(input);
  assert.equal(render.voiceId, null);
  assert.deepEqual(bodies, [{
    avatarId: script.avatarId,
    shots: script.shots,
    voice: { provider: "fish", voice_id: "fish_voice_test", speed: 1.1 },
  }]);
});

test("createRender surfaces a voice the platform cannot render as a typed 422 voice_unavailable, not retried", async () => {
  let requests = 0;
  const rta = client(() => {
    requests++;
    return Response.json(
      { code: "voice_unavailable", message: "This avatar's own voice cannot render a video. Pass voice or voiceId." },
      { status: 422 },
    );
  });
  await assert.rejects(rta.createRender(script), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarHttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "voice_unavailable");
    return true;
  });
  assert.equal(requests, 1);
});

test("getRender and getRenderAccess read the encoded render paths", async () => {
  const seen: string[] = [];
  const access: RenderAccessResponse = {
    id: renderId, url: "https://media.example.test/render.mp4?signature=test", expiresAt: "2026-10-28T13:00:00.000Z",
  };
  const rta = client((request) => {
    seen.push(new URL(request.url).pathname);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("idempotency-key"), null);
    return Response.json(request.url.endsWith("/access") ? access : ready);
  });
  assert.deepEqual(await rta.getRender(renderId), ready);
  assert.deepEqual(await rta.getRenderAccess(renderId), access);
  await rta.getRender("rnd_x/../y");
  assert.deepEqual(seen, [
    `/api/v1/renders/${renderId}`,
    `/api/v1/renders/${renderId}/access`,
    "/api/v1/renders/rnd_x%2F..%2Fy",
  ]);
});

test("listRenders forwards limit and cursor, and iterateRenders follows every cursor", async () => {
  const queries: string[] = [];
  const rta = client((request) => {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/api/v1/renders");
    queries.push(url.search);
    return Response.json(url.searchParams.get("cursor") === "page+2="
      ? { data: [failed], nextCursor: null }
      : { data: [queued, ready], nextCursor: "page+2=" });
  });
  assert.deepEqual(await rta.listRenders(), { data: [queued, ready], nextCursor: "page+2=" });
  await rta.listRenders({ limit: 10, cursor: "page+2=" });
  const all: Render[] = [];
  for await (const render of rta.iterateRenders({ limit: 2 })) all.push(render);
  assert.deepEqual(all, [queued, ready, failed]);
  assert.deepEqual(queries, ["", "?limit=10&cursor=page%2B2%3D", "?limit=2", "?limit=2&cursor=page%2B2%3D"]);
  await assert.rejects(rta.listRenders({ limit: 500 }));
});

test("waitForRender returns the settled render, failures included, and throws only on timeout", async () => {
  const sequence = [queued, { ...queued, status: "rendering" }, ready];
  const polling = client(() => Response.json(sequence.shift()));
  const settledReady = await polling.waitForRender(renderId, { pollMs: 1_000 });
  assert.deepEqual(settledReady, ready);
  assert.deepEqual(settledReady.timeline, timeline);
  assert.equal(sequence.length, 0);

  const failing = client(() => Response.json(failed));
  const settled = await failing.waitForRender(renderId);
  assert.equal(settled.status, "failed");
  assert.equal(settled.error?.code, "too_long");

  const stuck = client(() => Response.json({ ...queued, status: "rendering" }));
  await assert.rejects(stuck.waitForRender(renderId, { timeoutMs: 0 }), (error: unknown) => {
    assert.ok(error instanceof RealtimeAvatarError);
    assert.match(error.message, /still rendering.*timeout, not a failure/);
    return true;
  });
});

test("waitForRender treats a NaN pollMs or timeoutMs as absent, not as a tight loop with no end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  let polls = 0;
  const stuck = client(() => { polls++; return Response.json({ ...queued, status: "rendering" }); });
  let outcome: unknown;
  stuck.waitForRender(renderId, { pollMs: Number.NaN, timeoutMs: Number.NaN }).then(
    () => { outcome = "resolved"; },
    (error: unknown) => { outcome = error; },
  );
  await settle();
  t.mock.timers.tick(4_999);
  await settle();
  assert.equal(polls, 1, "the default 5 s interval, not setTimeout(NaN)");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(polls, 2);
  for (let i = 0; i < 400 && outcome === undefined; i++) {
    t.mock.timers.tick(5_000);
    await settle();
  }
  assert.ok(outcome instanceof RealtimeAvatarError, "the default 30 min timeout, not a NaN deadline");
  assert.match(outcome.message, /after 1800s/);
});

test("listRenders refuses a bad limit as a RealtimeAvatarError before any request", async () => {
  let requests = 0;
  const rta = client(() => { requests++; return Response.json({ data: [], nextCursor: null }); });
  for (const limit of [0, 101, 2.5]) {
    await assert.rejects(rta.listRenders({ limit }), (error: unknown) => {
      assert.ok(error instanceof RealtimeAvatarError);
      assert.match(error.message, /^Invalid listRenders options: limit/);
      return true;
    });
  }
  assert.equal(requests, 0);
});

test("getRender returns the timeline exactly as the contract types it", async () => {
  const rta = client(() => Response.json(ready));
  const render = await rta.getRender(renderId);
  assert.equal(render.status, "ready");
  assert.equal(render.voiceId, "voice_test");
  assert.deepEqual(render.timeline, timeline);
  assert.deepEqual(render.timeline?.map((shot) => [shot.clipId, shot.playback, shot.afterClipId]), [
    ["gesture_send_flower", "once", null],
    ["idle_touch_collar", "once", "primary"],
    ["primary", "loop", null],
  ]);
});

test("render responses that break the contract throw one fixed error without the body", async () => {
  const shot = timeline[1];
  const bodies = [
    JSON.stringify({ ...ready, durationMs: "secret-response-value" }),
    JSON.stringify({ ...ready, status: "succeeded" }),
    JSON.stringify({ ...ready, extra: "secret-response-value" }),
    JSON.stringify({ ...ready, timeline: [{ ...shot, playback: "secret-response-value" }] }),
    JSON.stringify({ ...ready, timeline: [{ ...shot, clipId: null }] }),
    JSON.stringify({ ...ready, timeline: [{ ...shot, extra: "secret-response-value" }] }),
    JSON.stringify({ ...ready, timeline: [Object.fromEntries(Object.entries(shot).filter(([key]) => key !== "afterClipId"))] }),
    "{ not json secret-response-value",
  ];
  for (const body of bodies) {
    const rta = client(() => new Response(body, { headers: { "content-type": "application/json" } }));
    for (const read of [() => rta.getRender(renderId), () => rta.createRender(script), () => rta.listRenders()]) {
      await assert.rejects(read(), (error: unknown) => {
        assert.ok(error instanceof RealtimeAvatarError);
        assert.equal(error.message, "Render response did not match the SDK contract");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(`${error}\n${error.stack}\n${JSON.stringify(error)}`, /secret-response-value|test-key/);
        return true;
      });
    }
  }
  const access = client(() => Response.json({ id: renderId, url: "not-a-url", expiresAt: "2026-10-28T13:00:00.000Z" }));
  await assert.rejects(access.getRenderAccess(renderId), /Render response did not match the SDK contract/);
});
