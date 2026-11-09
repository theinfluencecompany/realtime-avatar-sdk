import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as server from "../../sdk-server/src/index.ts";
import { liveKitSessionGrantSchema, capacityBusyResponseSchema } from "../../client/src/wire.ts";
import { proxyConnectRequestSchema, proxyEndRequestSchema } from "../../client/src/proxy-route.ts";
import type { components } from "../src/generated/openapi.ts";
import { avatarResponseSchema } from "../src/generated/avatar.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactAvatarOutput: Equal<z.output<typeof avatarResponseSchema>, components["schemas"]["Avatar"]> = true;
void exactAvatarOutput;

const voice = { provider: "fish", voice_id: "voice_live2d", model: "s2-pro" } as const;
const avatar: components["schemas"]["Avatar"] = {
  id: "av_live2d_123", tenantId: "tenant_123", displayName: "Rin", renderer: "live2d",
  sourceKind: "image", modelId: "realtime-avatar-live-v1", sourceAssetId: null,
  status: "ready", error: null, idleVideoStatus: "none", defaultVoiceId: "voice_live2d",
  llm: null, createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
};

function mock(response: unknown = avatar) {
  const requests: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.ok(typeof init?.body === "string");
    const body: unknown = JSON.parse(init.body);
    requests.push({ url: String(url), method: init.method, body });
    return Response.json(response);
  };
  return { requests, client: new server.RealtimeAvatar({ apiKey: "test", fetch: fetchImpl }) };
}

test("Live2D registration posts only its identity and explicit voice, then returns the full parsed avatar", async () => {
  const { client, requests } = mock();
  const created = await client.createLive2dAvatar({ displayName: "Rin", voice });
  assert.deepEqual(requests, [{
    url: "https://realtimeavatar.ai/api/v1/avatars", method: "POST",
    body: { displayName: "Rin", renderer: "live2d", sourceKind: "image", voice: { voice } },
  }]);
  assert.deepEqual(created, avatar);
  assert.equal(created.id, "av_live2d_123");
  assert.equal(created.renderer, "live2d");
  const canonical: components["schemas"]["Avatar"] = created;
  void canonical;
});

test("Live2D registration forwards provided settings and metadata without manufacturing assets", async () => {
  const { client, requests } = mock();
  const input = { displayName: "Rin", voice: { provider: "cartesia", voice_id: "voice_rin" } as const,
    settings: { rig: "rin-v1", nested: { visible: true } }, metadata: { characterId: "char_1" } };
  await client.createLive2dAvatar(input);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.body, { ...input, renderer: "live2d", sourceKind: "image", voice: { voice: input.voice } });
});

test("Live2D registration rejects source controls and malformed or automatic voices before network I/O", async () => {
  const { client, requests } = mock();
  const input = { displayName: "Rin", voice };
  for (const extra of [
    { sourceAssetId: "asset_123" }, { sourceKind: "video" }, { sourceKind: "image" },
    { renderer: "video" }, { motionPrompt: "blink" }, { imageUrl: "https://example.com/portrait.png" },
    { defaultVoiceId: "voice_123" }, { modelId: "realtime-avatar-video-v1" },
  ]) {
    await assert.rejects(client.createLive2dAvatar({ ...input, ...extra }), z.ZodError);
  }
  // @ts-expect-error explicit voice is mandatory
  await assert.rejects(client.createLive2dAvatar({ displayName: "Rin" }), z.ZodError);
  // @ts-expect-error automatic casting is not a Live2D voice
  await assert.rejects(client.createLive2dAvatar({ displayName: "Rin", voice: { auto_description: "warm" } }), z.ZodError);
  // @ts-expect-error provider vocabulary comes from the canonical creation request
  await assert.rejects(client.createLive2dAvatar({ displayName: "Rin", voice: { provider: "unknown", voice_id: "voice" } }), z.ZodError);
  for (const invalid of [
    { ...input, displayName: "" }, { ...input, voice: { ...voice, voice_id: "" } },
    { ...input, voice: { ...voice, speed: 3 } }, { ...input, voice: { ...voice, auto_description: "warm" } },
  ]) await assert.rejects(client.createLive2dAvatar(invalid), z.ZodError);
  assert.equal(requests.length, 0);
  const compileOnly = () => {
    // @ts-expect-error source assets cannot accompany Live2D registration
    void client.createLive2dAvatar({ ...input, sourceAssetId: "asset_123" });
    // @ts-expect-error the helper owns the renderer selection
    void client.createLive2dAvatar({ ...input, renderer: "video" });
    // @ts-expect-error image URLs cannot trigger hidden staging
    void client.createLive2dAvatar({ ...input, imageUrl: "https://example.com/portrait.png" });
  };
  void compileOnly;
});

test("Live2D registration validates the entire response rather than coercing a partial legacy avatar", async () => {
  for (const response of [
    { id: "av_live2d_123", renderer: "live2d" }, { ...avatar, id: 123 },
    { ...avatar, renderer: "unexpected" }, { ...avatar, renderer: undefined },
    { ...avatar, tenantId: 123 }, { ...avatar, llm: { provider: "unknown" } },
    { ...avatar, createdAt: 123 }, { ...avatar, status: "invented" }, null,
  ]) {
    const { client } = mock(response);
    await assert.rejects(client.createLive2dAvatar({ displayName: "Rin", voice }), server.RealtimeAvatarError);
  }
});

test("legacy avatar reads preserve renderer and default old responses to video", async () => {
  for (const renderer of ["live2d", "video", undefined] as const) {
    const fetchImpl: typeof fetch = async () => Response.json({ ...avatar, renderer });
    const client = new server.RealtimeAvatar({ apiKey: "test", fetch: fetchImpl });
    assert.equal((await client.getAvatar(avatar.id)).renderer, renderer ?? "video");
  }
});

test("server schemas are existing canonical instances and reject unsafe persistence/proxy fixtures", () => {
  assert.equal(server.liveKitSessionGrantSchema, liveKitSessionGrantSchema);
  assert.equal(server.capacityBusyResponseSchema, capacityBusyResponseSchema);
  assert.equal(server.proxyConnectRequestSchema, proxyConnectRequestSchema);
  assert.equal(server.proxyEndRequestSchema, proxyEndRequestSchema);
  const grant = { session_id: "session_123", room_name: "room_123", livekit_url: "wss://livekit.example.com",
    participant_token: "token", participant_identity: "user_123", reservation_expires_at: "2026-11-09T00:10:00Z" };
  assert.equal(server.liveKitSessionGrantSchema.safeParse(grant).success, true);
  assert.equal(server.liveKitSessionGrantSchema.safeParse({ ...grant, participant_token: 123 }).success, false);
  assert.equal(server.liveKitSessionGrantSchema.safeParse({ ...grant, session_id: "" }).success, false);
  assert.equal(server.proxyConnectRequestSchema.safeParse({ avatarId: "av_123", mode: "voice" }).success, true);
  assert.equal(server.proxyConnectRequestSchema.safeParse({ avatarId: 123 }).success, false);
  assert.equal(server.proxyConnectRequestSchema.safeParse({ avatarId: "av_123", mode: "unsafe" }).success, false);
  assert.deepEqual(server.proxyConnectRequestSchema.parse({ avatarId: "av_123", instructions: "untrusted" }), { avatarId: "av_123" });
  assert.equal(server.proxyEndRequestSchema.safeParse({ session_id: "session_123" }).success, true);
  assert.equal(server.proxyEndRequestSchema.safeParse({}).success, false);
  assert.equal(server.proxyEndRequestSchema.safeParse({ session_id: 123 }).success, false);
  const busy = { message: "Busy", queue_size: 1, recommended_retry_ms: 1000,
    capacity: { max_sessions: 2, worker_count: 1, active_sessions: 2, reserved_sessions: 0,
      observed_worker_active_sessions: 2, available_sessions: 0, queue_size: 1, admission_open: false,
      recommended_retry_ms: 1000, load: 1 } };
  assert.equal(server.capacityBusyResponseSchema.safeParse(busy).success, true);
  assert.equal(server.capacityBusyResponseSchema.safeParse({ ...busy, queue_size: -1 }).success, false);
  assert.equal(server.capacityBusyResponseSchema.safeParse({ ...busy, capacity: {} }).success, false);
});
