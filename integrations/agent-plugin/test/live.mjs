import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { root, config } from "../build.mjs";

if (!process.env.REALTIME_AVATAR_API_KEY) throw Error("Supply REALTIME_AVATAR_API_KEY through the environment");
const report = { at: new Date().toISOString(), accountReads: [], paidCallsStarted: 0, preview: {}, actualClaudeWebMedia: false, actualCursorMedia: false };
const client = new Client({ name: "rta-shared-account-live-check", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: [resolve(root, "../../plugins/realtime-avatar/account.mjs")],
  env: { PATH: process.env.PATH, REALTIME_AVATAR_API_KEY: process.env.REALTIME_AVATAR_API_KEY, RTA_PLUGIN_ALLOW_WRITES: "0" }, stderr: "pipe" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 5);
  assert(tools.every(tool => tool.annotations.readOnlyHint));
  for (const name of ["list_avatars", "credit_balance"]) {
    const result = await client.callTool({ name, arguments: {} });
    assert(!result.isError, `${name} failed`);
    report.accountReads.push({ tool: name, passed: true });
  }
} finally { await client.close(); }
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
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
