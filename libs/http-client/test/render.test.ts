import assert from "node:assert/strict";
import { test } from "node:test";
import { RealtimeAvatar } from "../src/client.ts";
import { RealtimeAvatarError, RealtimeAvatarHttpError } from "../src/errors.ts";
import type { components } from "../src/generated/openapi.ts";
import type { CreateRenderInput, ListRendersResponse, Render, RenderAccessResponse } from "../src/types.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const contractParity: [
  Equal<Render, components["schemas"]["Render"]>,
  Equal<RenderAccessResponse, components["schemas"]["RenderAccessResponse"]>,
  Equal<ListRendersResponse, components["schemas"]["ListRendersResponse"]>,
  Equal<CreateRenderInput, components["schemas"]["CreateRenderRequest"]>,
] = [true, true, true, true];
void contractParity;

const renderId = "rnd_0123456789abcdef0123456789abcdef";
const queued: Render = {
  id: renderId, object: "render", status: "queued", avatarId: "ava_test",
  durationMs: null, width: null, height: null, error: null,
  createdAt: "2026-10-28T12:00:00.000Z", completedAt: null,
};
const succeeded: Render = {
  ...queued, status: "succeeded", durationMs: 4_200, width: 512, height: 512,
  completedAt: "2026-10-28T12:01:00.000Z",
};
const failed: Render = {
  ...queued, status: "failed",
  error: { code: "too_long", message: "The rendered video would be longer than the maximum length. Shorten the script." },
  completedAt: "2026-10-28T12:01:00.000Z",
};
const script: CreateRenderInput = {
  avatarId: "ava_test",
  voiceId: "voice_test",
  segments: [
    { type: "speech", text: "Hello there.", clipId: "wave_hi" },
    { type: "pause", durationMs: 400 },
    { type: "speech", text: "Here is the plan." },
  ],
  lipGain: 1.2,
};

function client(fetchImpl: (request: Request) => Response | Promise<Response>) {
  return new RealtimeAvatar({ apiKey: "test-key", fetch: async (input, init) => fetchImpl(new Request(input, init)) });
}

test("createRender posts the camelCase script unchanged with one idempotency key across a retry", async () => {
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
    { code: "render_clip_unavailable", message: "Clip wave_hi is not ready.", details: { clipId: "wave_hi" } },
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

test("getRender and getRenderAccess read the encoded render paths", async () => {
  const seen: string[] = [];
  const access: RenderAccessResponse = {
    id: renderId, url: "https://media.example.test/render.mp4?signature=test", expiresAt: "2026-10-28T13:00:00.000Z",
  };
  const rta = client((request) => {
    seen.push(new URL(request.url).pathname);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("idempotency-key"), null);
    return Response.json(request.url.endsWith("/access") ? access : succeeded);
  });
  assert.deepEqual(await rta.getRender(renderId), succeeded);
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
      : { data: [queued, succeeded], nextCursor: "page+2=" });
  });
  assert.deepEqual(await rta.listRenders(), { data: [queued, succeeded], nextCursor: "page+2=" });
  await rta.listRenders({ limit: 10, cursor: "page+2=" });
  const all: Render[] = [];
  for await (const render of rta.iterateRenders({ limit: 2 })) all.push(render);
  assert.deepEqual(all, [queued, succeeded, failed]);
  assert.deepEqual(queries, ["", "?limit=10&cursor=page%2B2%3D", "?limit=2", "?limit=2&cursor=page%2B2%3D"]);
  await assert.rejects(rta.listRenders({ limit: 500 }));
});

test("waitForRender returns the settled render, failures included, and throws only on timeout", async () => {
  const sequence = [queued, { ...queued, status: "rendering" }, succeeded];
  const polling = client(() => Response.json(sequence.shift()));
  assert.deepEqual(await polling.waitForRender(renderId, { pollMs: 1_000 }), succeeded);
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

test("render responses that break the contract throw one fixed error without the body", async () => {
  const bodies = [
    JSON.stringify({ ...succeeded, durationMs: "secret-response-value" }),
    JSON.stringify({ ...succeeded, status: "done" }),
    JSON.stringify({ ...succeeded, extra: "secret-response-value" }),
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
