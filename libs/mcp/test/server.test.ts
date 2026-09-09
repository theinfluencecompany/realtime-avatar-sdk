import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { CLIP_DECLARATION, CLIP_LIBRARY, CLIP_UPDATE, INVALID_CLIP_DECLARATIONS } from "../../http-client/test/clip-library.fixture.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, MCP_VERSION, type CreateServerOptions } from "../src/server.ts";

const AVATARS = {
  data: [
    // Callable: ready WITH a loop attached. The second one is the shape that used to be
    // read as "image source, therefore broken" and is now simply an avatar whose loop is
    // still rendering — ready, but not yet callable.
    { id: "ava_video", displayName: "Rin", status: "ready", sourceKind: "video", idleVideoStatus: "ready", createdAt: "x" },
    { id: "ava_image", displayName: "Still", status: "ready", sourceKind: "image", idleVideoStatus: "generating", createdAt: "x" },
  ],
};

/** Drive the server the way a real host does: over a transport, not by calling functions. */
async function connect(overrides: Partial<CreateServerOptions>, body: unknown = AVATARS) {
  const seen: { urls: string[]; methods: string[]; bodies: unknown[] } = {
    urls: [], methods: [], bodies: [],
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.urls.push(String(url));
    seen.methods.push(init?.method ?? "GET");
    if (typeof init?.body === "string") seen.bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  const server = createServer({ apiKey: "tic_test_k", fetch: fetchImpl, ...overrides });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, seen };
}

const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();

const say = (result: unknown): string => {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
};

test("the default surface is read-only — an agent cannot spend credits", async () => {
  const { client } = await connect({});
  const tools = await names(client);
  assert.deepEqual(tools, ["credit_balance", "get_avatar", "list_avatars", "list_clips", "list_sessions"]);
  // Every one of them says so, so a host can gate on the annotation rather than the name.
  for (const tool of (await client.listTools()).tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
  }
});

test("allowWrites is what exposes the tools that cost money", async () => {
  const { client } = await connect({ allowWrites: true });
  const tools = await names(client);
  assert.ok(tools.includes("start_call"));
  assert.ok(tools.includes("create_avatar_from_video"));
  // The no-footage path. An agent that cannot reach it will invent a video URL instead.
  assert.ok(tools.includes("create_avatar_from_image"));
});

test("start_call REFUSES a live key even when writes are allowed", async () => {
  // Two independent gates. An operator who turns on writes for a test key and later swaps in
  // a production one must not silently start billing a real customer account.
  const { client, seen } = await connect({ apiKey: "tic_live_real", allowWrites: true });
  const result = await client.callTool({
    name: "start_call", arguments: { avatarId: "ava_video", maxSeconds: 60 },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(say(result), /tic_live_/);
  assert.equal(seen.urls.length, 0, "it must not have called the API at all");
});

test("list_avatars counts the ones that can actually take a call", async () => {
  // The count still excludes an avatar with no loop attached, but the REASON changed: an
  // image source used to render a black track, and now it is simply one whose loop has not
  // finished rendering. Same arithmetic, opposite story — so the wording had to move too.
  const { client } = await connect({});
  const out = say(await client.callTool({ name: "list_avatars", arguments: {} }));
  assert.match(out, /ava_video/);
  assert.match(out, /1 ready with a loop attached/);
  assert.match(out, /generating/); // the un-callable one says WHY, not just that it is missing
});

test("list_sessions reports seconds and never rounds up to a minute", async () => {
  const { client } = await connect({}, {
    data: [{
      sessionId: "s1", avatarId: "ava_video", status: "released",
      startedAt: "2026-08-10T05:00:00Z", endedAt: "2026-08-10T05:01:02Z",
      activeSeconds: 61.5, billedCreditMicros: 61_500_000,
      metadata: { user_id: "u_42" }, createdAt: "2026-08-10T05:00:00Z",
    }],
    nextCursor: null, from: "2026-07-11T00:00:00Z", to: "2026-08-10T00:00:00Z",
  });
  const out = say(await client.callTool({ name: "list_sessions", arguments: {} }));
  assert.match(out, /61\.5s/);          // seconds, not "2 minutes"
  assert.match(out, /61\.50 credits/);
  assert.match(out, /u_42/);            // whose session it was
});

test("an empty account explains itself instead of printing an empty table", async () => {
  const { client } = await connect({}, { data: [] });
  assert.match(say(await client.callTool({ name: "list_avatars", arguments: {} })), /No avatars yet/);
});

test("the server tells the agent the rules it cannot infer from a schema", async () => {
  const { client } = await connect({});
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /never invent one/);   // avatar ids are unguessable
  assert.match(instructions, /untouched/);          // the relay rule
  assert.match(instructions, /per second/);         // billing granularity
});

test("the write surface is exactly the tools that mutate", async () => {
  const { client } = await connect({ allowWrites: true });
  assert.deepEqual(await names(client), [
    "create_avatar_from_image", "create_avatar_from_video", "create_remote_asset",
    "credit_balance", "get_avatar", "list_avatars", "list_clips", "list_sessions",
    "set_clip_library", "set_loop", "start_call", "upload_asset",
  ]);
});

const canonicalSchemas = JSON.parse(readFileSync(
  new URL("../../../spec/realtime-avatar.openapi.json", import.meta.url), "utf8",
)).components.schemas;
const canonicalClipSchema = canonicalSchemas.PutAvatarClipsRequest;

test("shared clip fixtures validate against the vendored canonical contract", () => {
  for (const [name, fixture] of [
    ["PutAvatarClipsRequest", CLIP_DECLARATION],
    ["ListAvatarClipsResponse", CLIP_LIBRARY],
    ["PutAvatarClipsResponse", CLIP_UPDATE],
  ] as const) {
    assert.deepEqual(z.fromJSONSchema(canonicalSchemas[name]).parse(fixture), fixture);
  }
});

test("set_clip_library advertises the canonical declaration instead of a second schema", async () => {
  const { client } = await connect({ allowWrites: true });
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "set_clip_library");
  assert.ok(tool);
  const { avatarId, ...properties } = tool.inputSchema.properties ?? {};
  assert.deepEqual(avatarId, { type: "string" });
  assert.deepEqual(properties, canonicalClipSchema.properties);
  assert.deepEqual(new Set(tool.inputSchema.required), new Set([
    "avatarId", ...canonicalClipSchema.required,
  ]));
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.doesNotMatch(tool.description ?? "", /whenHint|reroll|pool\b|excludePrevious|responseStarted|≤20|≤8|≤2|unconditionally|Does not spend credits/);
  assert.match(tool.description ?? "", /generation or pose-validation charges/);
  assert.match(tool.description ?? "", /'primary' is reserved/);
  const loop = (await client.listTools()).tools.find((entry) => entry.name === "set_loop");
  assert.match(loop?.description ?? "", /implicit rest state/);
  assert.doesNotMatch(loop?.description ?? "", /idle pool|role 'idle'|variant spliced over/);
  const schema = z.fromJSONSchema(canonicalClipSchema);
  assert.deepEqual(schema.parse(CLIP_DECLARATION), CLIP_DECLARATION);
});

test("set_clip_library forwards sources and behavior without reshaping", async () => {
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const result = await client.callTool({
    name: "set_clip_library", arguments: { avatarId: "ava_1", ...CLIP_DECLARATION },
  });
  assert.notEqual(result.isError, true, say(result));
  assert.deepEqual(seen.bodies, [CLIP_DECLARATION]);
  assert.deepEqual(seen.methods, ["PUT"]);
  assert.match(seen.urls[0] ?? "", /\/avatars\/ava_1\/clips$/);
  assert.match(say(result), /revision 1/);
  assert.match(say(result), /kept.*\(2\).*rest, nod/);
  assert.match(say(result), /queued.*\(1\).*wave/);
  assert.match(say(result), /retired.*\(1\).*old_idle/);
  assert.match(say(result), /poll list_clips/);
});

test("set_clip_library preserves a disabled idle weight and multi-variant lists through HTTP", async () => {
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const declaration = {
    ...CLIP_DECLARATION,
    idle: { clips: ["nod"], weight: 0 },
    on: { userSpeechStarted: { clips: ["nod", "wave"] } },
    actions: { greet: { description: "When greeting", clips: ["wave", "nod", "rest"] } },
  };
  const result = await client.callTool({ name: "set_clip_library", arguments: { avatarId: "ava_1", ...declaration } });
  assert.notEqual(result.isError, true, say(result));
  assert.deepEqual(seen.bodies, [declaration]);
});

test("set_clip_library canonical parsing trims text and preserves the absent idle weight", async () => {
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const result = await client.callTool({
    name: "set_clip_library", arguments: {
      avatarId: "ava_1", ...CLIP_DECLARATION,
      clips: { ...CLIP_DECLARATION.clips, rest: { source: { assetId: " ast_rest " } } },
      idle: { clips: ["nod"] },
      actions: { greet: { description: " Greeting ", clips: ["wave"] } },
    },
  });
  assert.notEqual(result.isError, true, say(result));
  assert.deepEqual(seen.bodies, [{
    ...CLIP_DECLARATION,
    idle: { clips: ["nod"] },
    actions: { greet: { description: "Greeting", clips: ["wave"] } },
  }]);
});

test("set_clip_library accepts an empty record but requires the revision", async () => {
  const { client, seen } = await connect({ allowWrites: true }, {
    ...CLIP_UPDATE, data: [], behavior: {}, plan: { kept: [], queued: [], retired: ["wave"] },
  });
  const result = await client.callTool({
    name: "set_clip_library", arguments: { avatarId: "ava_1", expectedRevision: 0, clips: {} },
  });
  assert.notEqual(result.isError, true, say(result));
  assert.deepEqual(seen.bodies, [{ expectedRevision: 0, clips: {} }]);
  assert.doesNotMatch(say(result), /poll list_clips/);
});

const invalidDeclarations = [
  ...INVALID_CLIP_DECLARATIONS,
  { name: "missing revision", body: { clips: {} } },
  { name: "negative revision", body: { expectedRevision: -1, clips: {} } },
  { name: "fractional revision", body: { expectedRevision: 0.5, clips: {} } },
  { name: "legacy array", body: { expectedRevision: 0, clips: [] } },
  { name: "legacy role", body: { expectedRevision: 0, clips: { wave: { source: { assetId: "ast_1" }, role: "gesture" } } } },
  { name: "legacy whenHint", body: { expectedRevision: 0, clips: { wave: { source: { assetId: "ast_1" }, whenHint: "greet" } } } },
  { name: "legacy reroll", body: { expectedRevision: 0, clips: { wave: { source: { motionPrompt: "wave" }, reroll: true } } } },
  { name: "duration outside source", body: { expectedRevision: 0, clips: { wave: { source: { motionPrompt: "wave" }, durationSeconds: 6 } } } },
  { name: "ambiguous source", body: { expectedRevision: 0, clips: { wave: { source: { assetId: "ast_1", motionPrompt: "wave" } } } } },
  { name: "duration on upload", body: { expectedRevision: 0, clips: { wave: { source: { assetId: "ast_1", durationSeconds: 6 } } } } },
  { name: "invalid duration", body: { expectedRevision: 0, clips: { wave: { source: { motionPrompt: "wave", durationSeconds: 9 } } } } },
  { name: "empty prompt", body: { expectedRevision: 0, clips: { wave: { source: { motionPrompt: "" } } } } },
  { name: "invalid clip id", body: { expectedRevision: 0, clips: { "bad id": { source: { assetId: "ast_1" } } } } },
  { name: "empty idle list", body: { ...CLIP_DECLARATION, idle: { clips: [] } } },
  { name: "negative idle weight", body: { ...CLIP_DECLARATION, idle: { clips: ["nod"], weight: -1 } } },
  { name: "legacy candidate objects", body: { ...CLIP_DECLARATION, idle: { clips: [{ clip: "nod" }] } } },
  { name: "legacy pools", body: { ...CLIP_DECLARATION, pools: { expressive: ["nod"] } } },
  { name: "legacy responseStarted", body: { ...CLIP_DECLARATION, on: { responseStarted: { actions: {} } } } },
  { name: "unknown event", body: { ...CLIP_DECLARATION, on: { listening: { clips: ["nod"] } } } },
  { name: "missing action description", body: { ...CLIP_DECLARATION, actions: { greet: { clips: ["wave"] } } } },
  { name: "unknown root field", body: { ...CLIP_DECLARATION, role: "idle" } },
];

for (const invalid of invalidDeclarations) {
  test(`set_clip_library rejects ${invalid.name} before HTTP`, async () => {
    const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
    const result = await client.callTool({
      name: "set_clip_library", arguments: { avatarId: "ava_1", ...invalid.body },
    });
    assert.equal(result.isError, true, say(result));
    assert.equal(seen.urls.length, 0);
    if ("path" in invalid) {
      const path = invalid.path.map((part, index) => typeof part === "number"
        ? `[${part}]` : `${index ? "." : ""}${part}`).join("");
      assert.ok(say(result).includes(` at ${path}`), say(result));
    }
  });
}

test("set_clip_library preserves root cross-reference validation before HTTP", async () => {
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const result = await client.callTool({
    name: "set_clip_library", arguments: {
      avatarId: "ava_1", expectedRevision: 0, clips: {}, idle: { clips: ["missing"] },
    },
  });
  assert.equal(result.isError, true);
  assert.match(say(result), /Unknown clip "missing"/);
  assert.match(say(result), /Unknown clip "missing" at idle\.clips\[0\]/);
  assert.deepEqual(seen.urls, []);
});

test("set_clip_library rejects declaring \"primary\" with the contract's explanation", async () => {
  // The stored source IS the rest state; a declared "primary" would be a second copy of that
  // fact, stale on the next swap. The refusal has to say so, or the fix is a guess.
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const result = await client.callTool({
    name: "set_clip_library", arguments: {
      avatarId: "ava_1", ...CLIP_DECLARATION,
      clips: { ...CLIP_DECLARATION.clips, primary: { source: { motionPrompt: "rests" } } },
    },
  });
  assert.equal(result.isError, true);
  assert.match(say(result),
    /The avatar's stored source is the rest state and is not declared — pick another id/);
  assert.match(say(result), / at clips\.primary/);
  assert.deepEqual(seen.urls, []);
});

test("reserved record keys are rejected before MCP can strip them into a retire-all", async () => {
  const { client, seen } = await connect({ allowWrites: true }, CLIP_UPDATE);
  const result = await client.callTool({ name: "set_clip_library", arguments: {
    avatarId: "ava_1", expectedRevision: 7,
    clips: Object.fromEntries([["__proto__", { source: { assetId: "ast_1" } }]]),
  } });
  assert.equal(result.isError, true);
  assert.equal(seen.urls.length, 0);
});

test("list_clips preserves behavior, default source and the data array", async () => {
  const { client } = await connect({}, CLIP_LIBRARY);
  const result = await client.callTool({ name: "list_clips", arguments: { avatarId: "ava_1" } });
  assert.deepEqual(JSON.parse(say(result)), CLIP_LIBRARY);
});

test("upload_asset refuses a relative path rather than guessing a directory", async () => {
  const { client, seen } = await connect({ allowWrites: true });
  const result = await client.callTool({
    name: "upload_asset", arguments: { path: "clip.mp4" },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(say(result), /absolute path/);
  assert.equal(seen.urls.length, 0);
});

test("upload_asset reports a missing file instead of throwing", async () => {
  const { client } = await connect({ allowWrites: true });
  const result = await client.callTool({
    name: "upload_asset", arguments: { path: "/tmp/definitely-not-here-9f3a.mp4" },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(say(result), /No file at/);
});

test("upload_asset infers kind from the extension, and asks when it cannot", async () => {
  const { writeFile, rm } = await import("node:fs/promises");
  const mp4 = "/tmp/rta-mcp-fixture.mp4";
  const odd = "/tmp/rta-mcp-fixture.bin";
  await writeFile(mp4, "not really a video");
  await writeFile(odd, "unknown");
  try {
    const { client } = await connect({ allowWrites: true }, {
      id: "ast_1", kind: "video", publicUrl: "https://cdn/ast_1.mp4", createdAt: "x",
    });
    const ok = say(await client.callTool({ name: "upload_asset", arguments: { path: mp4 } }));
    assert.match(ok, /ast_1/);
    assert.match(ok, /https:\/\/cdn\/ast_1\.mp4/);   // the URL is the point of the tool

    const bad = await client.callTool({ name: "upload_asset", arguments: { path: odd } });
    assert.equal((bad as { isError?: boolean }).isError, true);
    assert.match(say(bad), /pass kind explicitly/);
  } finally {
    await rm(mp4, { force: true });
    await rm(odd, { force: true });
  }
});

test("MCP_VERSION tracks package.json, so the server identity cannot go stale", async () => {
  const pkg = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(MCP_VERSION, pkg.version);
});
