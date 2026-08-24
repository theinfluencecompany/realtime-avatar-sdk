import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, MCP_VERSION, type CreateServerOptions } from "../src/server.ts";

const AVATARS = {
  data: [
    { id: "ava_video", displayName: "Rin", status: "ready", sourceKind: "video", createdAt: "x" },
    { id: "ava_image", displayName: "Still", status: "ready", sourceKind: "image", createdAt: "x" },
  ],
};

/** Drive the server the way a real host does: over a transport, not by calling functions. */
async function connect(overrides: Partial<CreateServerOptions>, body: unknown = AVATARS) {
  const seen: { urls: string[] } = { urls: [] };
  const fetchImpl = (async (url: string) => {
    seen.urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

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
  assert.deepEqual(tools, ["credit_balance", "get_avatar", "list_avatars", "list_sessions"]);
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

test("list_avatars flags image-sourced avatars, which render black", async () => {
  const { client } = await connect({});
  const out = say(await client.callTool({ name: "list_avatars", arguments: {} }));
  assert.match(out, /ava_video/);
  assert.match(out, /1 ready \+ video-sourced/);   // the image one is excluded from the count
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
    "create_avatar_from_video", "create_remote_asset", "credit_balance", "get_avatar",
    "list_avatars", "list_sessions", "start_call", "sync_clips", "upload_asset",
  ]);
});

test("sync_clips says what it retired, not just what it queued", async () => {
  // Passing a partial set silently retires the rest, so the result has to show all three
  // buckets — "queued: 1" alone reads like nothing else changed.
  const { client } = await connect({ allowWrites: true }, {
    queued: ["https://x/new.mp4"], ready: ["https://x/kept.mp4"], retired: ["https://x/gone.mp4"],
  });
  const out = say(await client.callTool({
    name: "sync_clips",
    arguments: { avatarId: "ava_1", clipUrls: ["https://x/new.mp4", "https://x/kept.mp4"] },
  }));
  assert.match(out, /queued.*\(1\)/s);
  assert.match(out, /retired.*\(1\)/s);
  assert.match(out, /gone\.mp4/);
  assert.match(out, /not usable until they finish preparing/);
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
