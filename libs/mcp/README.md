# realtime-avatar-mcp

**Not published yet** — the package is marked `private: true`, so `npm publish` skips it rather than relying on nobody running the command. Build it and point your agent at the local path.

An MCP server for Realtime Avatar. [`AGENTS.md`](../../AGENTS.md) tells a coding agent what
the API is; this lets it *look* — at your avatars, your balance, your bill — instead of
guessing ids and inventing shapes.

```bash
npm run build
```

```jsonc
{
  "mcpServers": {
    "realtime-avatar": {
      "command": "node",
      "args": ["/abs/path/to/realtime-avatar-sdk/libs/mcp/dist/bin.js"],
      "env": { "REALTIME_AVATAR_API_KEY": "tic_test_…" }
    }
  }
}
```

## Tools

| Tool | |
| --- | --- |
| `list_avatars` | Every avatar with the id you pass to `startCall`, and which are usable live |
| `get_avatar` | Full detail for one |
| `credit_balance` | Balance, and what in-flight calls have reserved |
| `list_sessions` | The itemised bill — when each session ran, how long, what it cost |

With `REALTIME_AVATAR_ALLOW_WRITES=1`:

| Tool | | Bills? |
| --- | --- | --- |
| `sync_clips` | Prepare an avatar's clip set. Idempotent | no |
| `upload_asset` | Upload a file **from this machine's disk**, get a public URL | no |
| `create_remote_asset` | Register a file already on the internet — no local copy | no |
| `create_avatar_from_video` | Build an avatar from a looping video URL | no |
| `start_call` | Mint a live session to verify an integration | **yes, per second** |

## Spending money is opt-in, and twice gated

The four tools above are **read-only**, and each carries `readOnlyHint` so a host can gate on
the annotation rather than on a name it has to recognise. Pointed at a production key, this
server is no more dangerous than a dashboard you left open.

`REALTIME_AVATAR_ALLOW_WRITES=1` adds the five write tools. Only `start_call` costs credits,
and it **refuses a `tic_live_` key outright** — an operator who armed writes against a test
key and later swapped in a production one should not discover it by being billed. Two
independent gates, because one is a single mistake away from being none.

Two things to understand before arming writes:

- **`upload_asset` reads local disk.** It opens whatever absolute path the agent names, on the
  machine running the server. Relative paths are refused rather than resolved against
  whatever directory the host spawned it in.
- **`sync_clips` retires by omission.** Pass the complete set you want live; anything missing
  from the list stops being served. The tool reports all three buckets — queued, ready,
  retired — because "queued: 1" alone reads like nothing else changed.

## Why an MCP server at all

An agent that reads docs still guesses. `ava_…` ids cannot be inferred, and the failures that
cost the most time here are invisible in a type signature: an image-sourced avatar reports
`ready` and publishes a black video track; a reshaped connection payload is rejected by the
browser client; a 429 on a call is the queue, not an error.

`list_avatars` marks which avatars are actually usable. The server's `instructions` carry the
relay rule and the per-second billing model. That is context an agent cannot derive, delivered
where it is about to act.
