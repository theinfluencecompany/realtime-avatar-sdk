#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const config = JSON.parse(readFileSync(new URL("./integration.json", import.meta.url), "utf8"));
const configuredKey = process.env.RTA_PLUGIN_API_KEY?.trim();
const apiKey = configuredKey && !configuredKey.includes("${")
  ? configuredKey : process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey || apiKey.includes("${")) {
  console.error("Configure your RTA API key in the plugin settings, or forward REALTIME_AVATAR_API_KEY in the host's MCP environment. Account tools are unavailable until configured; never paste the key into chat.");
  process.exit(1);
}
if (!/^realtime-avatar-mcp@\d+\.\d+\.\d+$/.test(config.mcpPackage)) {
  console.error("Invalid pinned MCP package.");
  process.exit(1);
}
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", config.mcpPackage], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    REALTIME_AVATAR_API_KEY: apiKey,
    REALTIME_AVATAR_ALLOW_WRITES: process.env.RTA_PLUGIN_ALLOW_WRITES === "1" ? "1" : "0",
    // A configured editor cannot redirect account credentials to an arbitrary endpoint.
    REALTIME_AVATAR_BASE_URL: "https://realtimeavatar.ai/api/v1",
    npm_config_ignore_scripts: "true"
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Could not launch the pinned RTA MCP package. Check Node.js, npm and network access."); process.exit(1); });
child.on("exit", (code) => process.exit(code ?? 1));
