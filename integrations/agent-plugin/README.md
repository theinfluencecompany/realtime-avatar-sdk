# Realtime Avatar for Claude and Cursor

One plugin contains shared RTA guidance and the same published account MCP server.
Native manifests adapt credential configuration to Claude Code and Cursor. A
separate hosted preview connection offers the bounded live-avatar review.

## Install in Claude Code

Add this repository as a plugin marketplace and install `realtime-avatar` from
`realtime-avatar-tools`. Before merge, use the feature branch URL shown on the
download page. For a downloaded directory, run `claude --plugin-dir ./realtime-avatar`.
The manifest can prompt for the API key in a sensitive configuration field. You
can also set `REALTIME_AVATAR_API_KEY` in the process environment before launching
Claude. Do not put the value in a prompt or command-line argument.

## Install in Cursor

Import this repository into your team's marketplace, or place the downloaded
`realtime-avatar` directory inside `~/.cursor/plugins/local` and reload Cursor.
Configure `RTA_API_KEY` in the plugin settings. For direct Cursor CLI MCP config,
map `RTA_PLUGIN_API_KEY` to `${env:REALTIME_AVATAR_API_KEY}`: the CLI filters
inherited environment variables, so the explicit mapping is needed.
Enterprise policy may disable local imports.
The download page includes a separate one-click link for the hosted preview only;
it does not configure your account or install the skill.

## Account and preview are distinct

| Connection | Authentication | Capability |
| --- | --- | --- |
| realtime-avatar | Your API key, handled by the local MCP process | Your avatars, credits, usage and clips; opt-in writes |
| realtime-avatar-preview | None | Operator-funded avatar review; shared capacity |

Account tools require Node.js 20+ and npm and use `realtime-avatar-mcp@0.25.0`.
Writes default to `0`. Set the plugin's write setting to `1` only when you want
tools that create/configure avatars or spend credits. The underlying API key's
scopes and the published MCP package's restrictions still apply.

Claude web/mobile custom connectors can connect to the remote preview URL. They
cannot run the local account MCP process: production account access there requires
remote OAuth, which this package does not implement. Actual host media permissions
must be tested separately. Installing this package does not publish a marketplace
listing or imply approval by Anthropic or Cursor.

## Try it

“Use Realtime Avatar to inspect my ready avatars and credits, then add a voice and
video call page to this app. Keep the key on the server and do not start a paid call.”

“Inspect this avatar's clips and tell me why it is not ready.”

“Open the hosted Realtime Avatar preview.”

Website: https://realtimeavatar.ai
Documentation: https://realtimeavatar.ai/docs/mcp
Support: https://realtimeavatar.ai/contact

## Develop

Run `npm ci`, `npm run build`, and `npm test` in `integrations/agent-plugin`.
The builder generates `plugins/realtime-avatar` and both root marketplace manifests
from the shared configuration. Its `dist` directory contains the install page and
ZIP. `npm run test:live` uses an explicitly supplied API key for read-only checks;
it never creates avatars or starts a call. No live test runs in CI.
