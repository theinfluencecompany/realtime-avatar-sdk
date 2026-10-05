import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "realtime-avatar-mcp";
import { build, root, config } from "../build.mjs";

const release = build();
const plugin = resolve(root, "../../plugins/realtime-avatar");
const read = file => JSON.parse(readFileSync(join(plugin, file), "utf8"));

test("both host manifests load only the same account runtime and leave preview opt-in", () => {
  const claude = read(".claude-plugin/plugin.json"), cursor = read(".cursor-plugin/plugin.json");
  assert.equal(claude.name, cursor.name);
  assert.equal(claude.version, cursor.version);
  assert.equal(claude.userConfig.api_key.sensitive, true);
  for (const [manifest, variable] of [[claude, "${CLAUDE_PLUGIN_ROOT}"], [cursor, "${CURSOR_PLUGIN_ROOT}"]]) {
    const servers = read(manifest.mcpServers).mcpServers;
    assert.deepEqual(Object.keys(servers), ["realtime-avatar"]);
    const account = servers["realtime-avatar"];
    assert.equal(account.type, "stdio");
    assert.equal(account.command, "node");
    assert.equal(account.args[0].replace(variable, plugin), join(plugin, "account.mjs"));
  }
  assert.equal(read("optional/preview.mcp.json").mcpServers["realtime-avatar-preview"].url, config.previewUrl);
  assert.equal(read("optional/preview.mcp.json").mcpServers["realtime-avatar-preview"].type, "http");
  assert.equal(config.mcpPackage, `realtime-avatar-mcp@${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["realtime-avatar-mcp"]}`);
  assert(readFileSync(join(plugin, "skills/build-avatar-app/SKILL.md"), "utf8").startsWith("---\nname: build-avatar-app\n"));
  const decoded = JSON.parse(Buffer.from(new URL(release.cursorPreviewInstall).searchParams.get("config"), "base64").toString());
  assert.deepEqual(decoded, { url: config.previewUrl });
  const entries = execFileSync("unzip", ["-Z1", join(root, "dist", release.file)], { encoding: "utf8" });
  for (const needed of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "mcp.claude.json", "mcp.cursor.json", "skills/build-avatar-app/SKILL.md"]) assert(entries.includes("realtime-avatar/" + needed));
  assert(!/node_modules|\.env(?:\n|\.)|evidence\//.test(entries));
});

test("rebuilding identical plugin contents reproduces the release checksum", () => {
  assert.equal(build().sha256, release.sha256);
});

test("an extracted release has complete native manifests and no automatically installed preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "rta fresh install "));
  try {
    execFileSync("unzip", ["-q", join(root, "dist", release.file), "-d", dir]);
    const unpacked = join(dir, "realtime-avatar");
    for (const [manifestPath, variable] of [[".claude-plugin/plugin.json", "${CLAUDE_PLUGIN_ROOT}"], [".cursor-plugin/plugin.json", "${CURSOR_PLUGIN_ROOT}"]]) {
      const manifest = JSON.parse(readFileSync(join(unpacked, manifestPath), "utf8"));
      assert.equal(manifest.version, config.version);
      const servers = JSON.parse(readFileSync(join(unpacked, manifest.mcpServers), "utf8")).mcpServers;
      assert.deepEqual(Object.keys(servers), ["realtime-avatar"]);
      const script = servers["realtime-avatar"].args[0].replace(variable, unpacked);
      const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH, RTA_PLUGIN_API_KEY: "" } });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /Configure your RTA API key/);
      assert.equal(run.stdout, "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launcher keeps keys off argv, ignores inherited write access and fixes the API destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "rta-launcher-"));
  const capture = join(dir, "capture.json");
  try {
    const fake = join(dir, "npx");
    writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.RTA_CAPTURE,JSON.stringify({args:process.argv.slice(2),key:process.env.REALTIME_AVATAR_API_KEY,writes:process.env.REALTIME_AVATAR_ALLOW_WRITES,base:process.env.REALTIME_AVATAR_BASE_URL}));\n`);
    chmodSync(fake, 0o700);
    const run = env => spawnSync(process.execPath, [join(plugin, "account.mjs")], { encoding: "utf8", env: { ...process.env, PATH: dir, RTA_CAPTURE: capture, RTA_PLUGIN_API_KEY: "", RTA_PLUGIN_ALLOW_WRITES: "", REALTIME_AVATAR_API_KEY: "fixture-private-key", REALTIME_AVATAR_ALLOW_WRITES: "1", REALTIME_AVATAR_BASE_URL: "https://untrusted.invalid", ...env } });
    for (const writes of ["", "0", "true", "1"]) {
      const result = run({ RTA_PLUGIN_ALLOW_WRITES: writes });
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(readFileSync(capture, "utf8"));
      assert.deepEqual(seen.args, ["--yes", config.mcpPackage]);
      assert.equal(seen.key, "fixture-private-key");
      assert.equal(seen.base, "https://realtimeavatar.ai/api/v1");
      assert.equal(seen.writes, writes === "1" ? "1" : "0");
      assert(!result.stdout.includes(seen.key));
      assert(!result.stderr.includes(seen.key));
    }
    assert.equal(run({ REALTIME_AVATAR_API_KEY: "", RTA_PLUGIN_API_KEY: "${user_config.api_key}" }).status, 1);
    assert.equal(run({ RTA_PLUGIN_API_KEY: "configured-key" }).status, 0);
    assert.equal(JSON.parse(readFileSync(capture, "utf8")).key, "configured-key");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("published account MCP reads account data and denies paid operations by default", async () => {
  const methods = [];
  const server = createServer({ apiKey: "fixture-key", fetch: async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json({ data: [{ id: "ava_fixture", displayName: "Example", status: "ready", sourceKind: "image", idleVideoStatus: "ready", createdAt: "2026-10-04" }] });
  } });
  const client = new Client({ name: "host-compatibility-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 5);
    assert(tools.every(tool => tool.annotations.readOnlyHint));
    const response = await client.callTool({ name: "list_avatars", arguments: {} });
    assert.match(response.content[0].text, /ava_fixture/);
    assert.deepEqual(methods, ["GET"]);
    assert.equal((await client.callTool({ name: "create_avatar_from_image", arguments: {} })).isError, true);
    assert.deepEqual(methods, ["GET"]);
  } finally { await client.close(); await server.close(); }
});
