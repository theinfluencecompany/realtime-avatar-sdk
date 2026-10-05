---
name: build-avatar-app
description: Build or debug live voice and video avatar applications using Realtime Avatar, inspect the connected RTA account, or create and configure its avatars when requested.
---

Use the user's framework and existing app. Realtime Avatar is the product at
https://realtimeavatar.ai; its browser SDK and server API have different jobs.

## Inspect the account

Use the `realtime-avatar` account MCP tools to list avatars and read credit balance.
Use returned IDs; do not invent an avatar ID or infer the user's credits from the
separate `realtime-avatar-preview` connection. A usable avatar has both a ready
status and a ready idle video. If none is ready, explain its actual state.

Account tools run locally through the published realtime-avatar-mcp package.
Credentials belong in plugin configuration or server environment, never in chat,
browser bundles, committed files or example output. If no account is configured,
build the integration with server-only environment placeholders and identify the
missing configuration honestly.

## Build the app

Read the relevant current guide: https://realtimeavatar.ai/docs/quickstart.md,
https://realtimeavatar.ai/docs/authentication.md, or the framework guide linked
from https://realtimeavatar.ai/llms.txt. For a new Next.js app, use the maintained
starter at https://realtimeavatar.ai/downloads/nextjs-avatar-starter.zip.

- Keep the key on the server. Authorize the application's user before minting.
- Use the published route adapter and browser/React SDK. The server chooses the
  avatar allowlist, instructions, duration and policy; do not spread browser input
  into a call request. Relay the opaque connection grant unchanged.
- Use explicit Start/End controls, optional microphone and a typed-input fallback.
  Release only owned sessions, including on cancellation or abandonment.
- Give startup, queue, permission-denied and terminal-failure states meaningful UI.
  Do not add a second browser retry loop around a timed-out mint.
- A local starter is not ready for public hosting until its real authentication,
  ownership, quotas and rate limits are implemented.

Run the app's relevant checks and inspect it in a browser. Starting a real call
consumes credits; use only the user's authorized test scope and bounded duration.
Report whether a live call actually ran, rather than treating a build as an E2E pass.

## Create or configure avatars

Write tools are disabled by default and require the user's explicit plugin setting
`allow_writes=1`. Respect authorization already given in the task; do not ask again
for actions the user has already authorized. For paid work outside that scope,
explain the concrete operation before requesting authorization. Use the published
tool schemas; a listed tool does not grant access to a restricted platform lane.
Creation is asynchronous and may consume credits. Inspect readiness before calling.
Clip-library updates declare the entire desired library and need its current
revision; preserve existing clips unless the user asked to remove them.

## Hosted preview

`realtime-avatar-preview` is optional and is not installed by this plugin. If the
user has separately connected it, it is an operator-funded review with its own shared
three-attempt budget, 45-second calls and a February 1, 2027 expiry. Preparation
does not start a call. Its account and capacity are not the user's personal RTA
account. Use it only when the user asks to try the hosted avatar.

The MCP Apps widget controls live Start and End. In a host without UI support,
offer the public review page at
https://rta-chatgpt-practice-review.zjudn2013.workers.dev/ and explain that it opens
a separate browser connection. Do not transfer a plan ID between connections or
start an orphan call with no media surface. Do not claim actual Claude/Cursor media
support from an MCP protocol or fixture test.
