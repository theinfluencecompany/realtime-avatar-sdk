#!/usr/bin/env node
/**
 * stdio entry point. Configure it in your agent host:
 *
 *   {
 *     "mcpServers": {
 *       "realtime-avatar": {
 *         "command": "npx",
 *         "args": ["-y", "realtime-avatar-mcp"],
 *         "env": { "REALTIME_AVATAR_API_KEY": "tic_test_…" }
 *       }
 *     }
 *   }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const apiKey = process.env.REALTIME_AVATAR_API_KEY;
if (!apiKey) {
  // stderr, never stdout: stdout IS the protocol channel and a stray line corrupts it.
  console.error("REALTIME_AVATAR_API_KEY is not set. The server needs a tic_test_ or tic_live_ key.");
  process.exit(1);
}

const server = createServer({
  apiKey,
  baseUrl: process.env.REALTIME_AVATAR_BASE_URL,
  // Off unless asked for. The default surface cannot spend credits.
  allowWrites: process.env.REALTIME_AVATAR_ALLOW_WRITES === "1",
});

await server.connect(new StdioServerTransport());
