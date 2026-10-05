# Realtime Avatar for Claude and Cursor

One plugin contains shared RTA guidance and the same published account MCP server.
Native manifests adapt credential configuration to Claude Code and Cursor.
The default install includes only your account connection. The bounded hosted
preview is an optional, separately installed connection.

## Install in Claude Code

Add this repository as a plugin marketplace and install `realtime-avatar` from
`realtime-avatar-tools` from `main`:

```text
/plugin marketplace add theinfluencecompany/realtime-avatar-sdk
/plugin install realtime-avatar@realtime-avatar-tools
```

For a downloaded directory, run `claude --plugin-dir ./realtime-avatar`.
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

Account tools require Node.js 20+ and npm and use `realtime-avatar-mcp@0.27.0`.
Writes default to `0`. Set the plugin's write setting to `1` only when you want
tools that create/configure avatars or spend credits. The underlying API key's
scopes and the published MCP package's restrictions still apply.

## Optional hosted preview

The plugin does not contact the preview automatically. Its configuration is in
`optional/preview.mcp.json`, outside both hosts' auto-loaded MCP manifests. Enable
it separately in Claude Code with:

```sh
claude mcp add --transport http realtime-avatar-preview https://rta-chatgpt-practice-review.zjudn2013.workers.dev/mcp
```

Use the separate preview install link on the download page for Cursor. The preview
shares three call attempts across all visitors, each capped at 45 seconds, and
ends February 1, 2027. It does not provide ongoing customer capacity.

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
it never creates avatars or starts a call. Add `-- --preview` to also probe the
optional preview. No live test runs in CI. ZIP builds use stable file order and
timestamps, so the same plugin contents have the same SHA-256 checksum.

Plugin releases use `agent-plugin-v*` tags and GitHub ZIP assets. They do not bump
or republish the SDK's npm packages. The release page contains `SHA256SUMS` and a
verification report. Marketplace submissions are separate from these releases.
