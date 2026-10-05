import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { root, config, build } from "../build.mjs";

if (!process.env.REALTIME_AVATAR_API_KEY) throw Error("Supply REALTIME_AVATAR_API_KEY through the environment");
const release = build();
const install = mkdtempSync(join(tmpdir(), "rta-clean-install-"));
execFileSync("unzip", ["-q", join(root, "dist", release.file), "-d", install]);
const report = { at: new Date().toISOString(), version: config.version, sha256: release.sha256, accountReads: [], paidCallsStarted: 0, preview: { tested: false }, actualClaudeWebMedia: false, actualCursorMedia: false };
try {
  for (const host of ["claude", "cursor"]) {
    const entry = JSON.parse(readFileSync(join(install, "realtime-avatar", `mcp.${host}.json`), "utf8")).mcpServers["realtime-avatar"];
    const client = new Client({ name: `rta-${host}-package-check`, version: config.version });
    const script = entry.args[0].replace(host === "claude" ? "${CLAUDE_PLUGIN_ROOT}" : "${CURSOR_PLUGIN_ROOT}", join(install, "realtime-avatar"));
    const transport = new StdioClientTransport({ command: entry.command, args: [script],
      env: { PATH: process.env.PATH, RTA_PLUGIN_API_KEY: process.env.REALTIME_AVATAR_API_KEY, RTA_PLUGIN_ALLOW_WRITES: "0" }, stderr: "pipe" });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().version, config.mcpPackage.split("@")[1]);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 5);
      assert(tools.every(tool => tool.annotations.readOnlyHint));
      for (const name of ["list_avatars", "credit_balance"]) {
        const result = await client.callTool({ name, arguments: {} });
        assert(!result.isError, `${host}: ${name} failed`);
        report.accountReads.push({ hostConfig: host, tool: name, passed: true });
      }
    } finally { await client.close(); }
  }
} finally { rmSync(install, { recursive: true, force: true }); }
if (process.argv.includes("--preview")) {
const before = await (await fetch(config.previewUrl.replace(/\/mcp$/, "/health"))).json();
const previewClient = new Client({ name: "rta-shared-preview-check", version: "0.1.0" });
const remote = new StreamableHTTPClientTransport(new URL(config.previewUrl));
try {
  await previewClient.connect(remote);
  const tools = (await previewClient.listTools()).tools;
  assert.equal(tools.length, 5);
  const prepared = await previewClient.callTool({ name: "prepare_session", arguments: { topic: "Building an avatar app" } });
  assert(!prepared.isError);
  assert.equal(prepared.structuredContent.scenario, "conversation");
  const resource = await previewClient.readResource({ uri: "ui://rta/practice-v1.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  report.preview = { discovery: true, preparation: true, resource: true };
} finally { await remote.terminateSession(); await previewClient.close(); }
const after = await (await fetch(config.previewUrl.replace(/\/mcp$/, "/health"))).json();
assert.equal(before.remainingCalls, after.remainingCalls);
report.preview.remainingCalls = after.remainingCalls;
}
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
