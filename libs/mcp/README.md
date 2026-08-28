# realtime-avatar-mcp

Published on npm as [`realtime-avatar-mcp`](https://www.npmjs.com/package/realtime-avatar-mcp) — run it with `npx`, never installed into an app.

An MCP server for Realtime Avatar. [`AGENTS.md`](../../AGENTS.md) tells a coding agent what
the API is; this lets it *look* — at your avatars, your balance, your bill — instead of
guessing ids and inventing shapes.

```jsonc
{
  "mcpServers": {
    "realtime-avatar": {
      "command": "npx",
      "args": ["-y", "realtime-avatar-mcp"],
      "env": { "REALTIME_AVATAR_API_KEY": "tic_test_…" }
    }
  }
}
```

Working on it in this repo? `npm run build`, then point `command` at `node` with
`args: ["/abs/path/to/realtime-avatar-sdk/libs/mcp/dist/bin.js"]`.

## Tools

| Tool | |
| --- | --- |
| `list_avatars` | Every avatar with the id you pass to `startCall`, and which are usable live |
| `get_avatar` | Full detail for one |
| `credit_balance` | Balance, and what in-flight calls have reserved |
| `list_sessions` | The itemised bill — when each session ran, how long, what it cost |
| `list_clips` | An avatar's clip library: every clip, its status, the revision and rest pose |

With `REALTIME_AVATAR_ALLOW_WRITES=1`:

| Tool | | Bills? |
| --- | --- | --- |
| `set_clip_library` | Declare an avatar's full clip set as JSON — the platform renders it | no |
| `sync_clips` | **Deprecated.** The external-URL tier. Use `set_clip_library` | no |
| `upload_asset` | Upload a file **from this machine's disk**, get a public URL | no |
| `create_remote_asset` | Register a file already on the internet — no local copy | no |
| `create_avatar_from_image` | Build an avatar from ONE still — the loop is generated | no |
| `create_avatar_from_video` | **Deprecated.** Closed to new callers (422). Use the image tool | no |
| `start_call` | Mint a live session to verify an integration | **yes, per second** |

## Spending money is opt-in, and twice gated

The five tools above are **read-only**, and each carries `readOnlyHint` so a host can gate on
the annotation rather than on a name it has to recognise. Pointed at a production key, this
server is no more dangerous than a dashboard you left open.

`REALTIME_AVATAR_ALLOW_WRITES=1` adds the seven write tools. Only `start_call` costs credits,
and it **refuses a `tic_live_` key outright** — an operator who armed writes against a test
key and later swapped in a production one should not discover it by being billed. Two
independent gates, because one is a single mistake away from being none.

Two things to understand before arming writes:

- **`upload_asset` reads local disk.** It opens whatever absolute path the agent names, on the
  machine running the server. Relative paths are refused rather than resolved against
  whatever directory the host spawned it in.
- **The clip tools retire by omission.** Both `set_clip_library` and `sync_clips` take the
  COMPLETE set you want live; anything missing from it stops being served. Each reports all
  three buckets — kept/queued/retired — because "queued: 1" alone reads like nothing else
  changed. Declare with `set_clip_library`: clips are JSON (`motionPrompt` or an uploaded
  `assetId`) and the platform renders and hosts them. `sync_clips` is the deprecated tier
  that takes URLs on your own storage.

## Why an MCP server at all

An agent that reads docs still guesses. `ava_…` ids cannot be inferred, and the failures that
cost the most time here are invisible in a type signature: a reshaped connection payload is
rejected by the browser client; a 429 on a call is the queue, not an error; the resting loop
is the avatar's source rather than a library clip, so no declaration changes it.

`list_avatars` marks which avatars are actually usable. The server's `instructions` carry the
relay rule and the per-second billing model. That is context an agent cannot derive, delivered
where it is about to act.
