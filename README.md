<div align="center">

# Realtime Avatar

**Live voice and video characters you can interrupt.**

Your footage. Your voice. Your persona. Talking back in real time — and stopping
mid-sentence the moment someone cuts in, the way a person stops.

[![npm](https://img.shields.io/npm/v/realtime-avatar?color=1a7f37&label=npm)](https://www.npmjs.com/package/realtime-avatar)
[![CI](https://github.com/theinfluencecompany/realtime-avatar-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/theinfluencecompany/realtime-avatar-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-realtimeavatar.ai-6f42c1)](https://realtimeavatar.ai/docs)
[![Agent-ready](https://img.shields.io/badge/agent--ready-AGENTS.md-ff6b35)](./AGENTS.md)

[Quickstart](#quickstart) · [Examples](#examples) · [Packages](#packages) · [API](#api) · [Docs](https://realtimeavatar.ai/docs)

</div>

---

## Quickstart

```bash
npm install realtime-avatar realtime-avatar-proxy
```

Start the call on your **server**. Your key never touches a browser.

```ts
import { RealtimeAvatar, isQueued } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

const call = await rta.startCall({
  avatarId: "ava_…",
  instructions: "You are Rin. Short, warm, specific sentences.",
  maxSeconds: 600,
});

if (isQueued(call)) return { queued: true, position: call.position };
return call.raw;            // relay to the browser, byte-for-byte
```

Join it from your **client**.

```tsx
import { AvatarCall } from "realtime-avatar-react";

<AvatarCall grant={grant} onEnd={() => router.push("/")} />;
```

That's the whole integration. Two halves, one payload between them.

> [!TIP]
> Not on Node? The server half is plain HTTP — see
> [`apps/quickstart/python-fastapi`](./apps/quickstart/python-fastapi) for the same split
> from a Python backend.

---

## Why this one

|  |  |
| --- | --- |
| 🎙️ **Full duplex, always** | They listen the entire time they speak. Interrupt and they stop. A cough doesn't derail them; a pause isn't the end of your turn. Video doesn't cost you this. |
| 🎭 **Your character, not a stock presenter** | Built from your own footage and voice. Start from a single image or one looping video and the resting loop is generated for you; author a multi-clip state map when you want to direct it. ([the one rule](./AGENTS.md#the-one-rule-that-decides-whether-multi-clip-looks-good): every clip starts and ends on the same frame.) |
| 🛠️ **Tools run on your machine** | Your functions, your data, your secrets — never uploaded. They're called mid-conversation and have 2.5s to answer. |
| 💸 **Priced to leave running** | Under $5 per hour of live conversation, billed by the second — not rounded up to the minute. |
| 🧾 **An itemised bill** | `listSessions` returns every session: when it ran, how long, what it cost. Tag calls with your own user id to attribute them. |
| 🤖 **Written for coding agents** | [`AGENTS.md`](./AGENTS.md) ships in the package. Point your agent at it and it writes the integration correctly the first time. |

---

## How it fits together

```
your client  ──▶  your backend  ──▶  Realtime Avatar
                  (holds the key,      (capacity, listening,
                   decides the call)    thinking, speaking, rendering)
     ◀────────── live audio + video, and they're still listening ──────────
```

Two rules fall out of that picture, and they drive everything else:

1. **The key is server-only.** A browser holding it can start unlimited calls on your
   account. The constructor throws in a browser runtime, so that fails loudly instead of
   quietly costing you money.
2. **The connection payload is opaque.** Relay `call.raw` untouched — the client validates
   it strictly and will reject a reshaped object.

---

## Built with an AI agent?

Most people integrating this in 2026 aren't typing it by hand. So the reference is written
for the reader that shows up: **[`AGENTS.md`](./AGENTS.md)** is the entire surface in one
file, plus the twelve rules that are expensive to learn the hard way.

```
"Add a voice call to my Next.js app using the Realtime Avatar SDK.
 Read AGENTS.md in node_modules/realtime-avatar first."
```

`CLAUDE.md` symlinks to it, so Claude Code picks it up with no prompting. Codex, Cursor and
Copilot read `AGENTS.md` directly. There's also an
**[MCP server](./libs/mcp)** if you'd rather your agent query your avatars, balance and bill
live instead of reading about them.

---

## Packages

| Package | Install | What it does |
| --- | --- | --- |
| [`libs/http-client`](./libs/http-client) | `realtime-avatar` | The server client. **Zero dependencies.** |
| [`libs/react`](./libs/client) | `realtime-avatar-react` | React + React Native. `<AvatarCall>` and `useAvatarCall`. |
| [`libs/proxy`](./libs/proxy) | `realtime-avatar-proxy` | Next.js / Hono / Express adapters that keep your key server-side |
| [`libs/browser`](./libs/browser) | `realtime-avatar-browser` | Mic and playback, with the six failure modes turned into values |
| [`libs/tools`](./libs/tools) | `realtime-avatar-tools` | The browser tool plane — your functions, called mid-conversation |
| [`libs/contracts`](./libs/contracts) | `realtime-avatar-contracts` | Runtime schemas for the wire, if you're building your own proxy |
| [`libs/mcp`](./libs/mcp) | `realtime-avatar-mcp` | MCP server for coding agents |

---

## Examples

Every example runs standalone — copy one out of the repo and it still works.

### `apps/quickstart/` — the smallest correct integration

| | |
| --- | --- |
| [**nextjs-app-router**](./apps/quickstart/nextjs-app-router) | A route handler and a call button. Start here. |
| [**python-fastapi**](./apps/quickstart/python-fastapi) | The same split from Python, plus verifying the signed session history |
| [**canvas-tools**](./apps/quickstart/canvas-tools) | The tool plane end to end — four tools drawing on a live canvas, including one that deliberately blows the deadline |

### `apps/demo/` — the showcases

| | |
| --- | --- |
| [**coding-companion**](./apps/demo/coding-companion) | A builder you talk to: the character is the conversation, a cheaper model writes the page, and they ship it to a public URL through the tool plane |
| [**pair-programmer**](./apps/demo/pair-programmer) | The same builder, composited into the room instead of sat beside it — same brief, same tools, same build engine, so the pair shows what a layout changes and what it does not |
| [**livestream**](./apps/demo/livestream) | An audience is not a new primitive — comments, gifts and hearts all ride one chat topic |
| [**live-shopping**](./apps/demo/live-shopping) | The character is not allowed to know the price — every commercial figure comes back from a tool and expires when the fact behind it does |
| [**math-studio**](./apps/demo/math-studio) | A tool plane that stays six tools wide however far the app grows — the things on screen register with the page, not with the character |
| [**terminal-tutor**](./apps/demo/terminal-tutor) | The character draws on the screen to teach vim and tmux, and never sends a coordinate — they name the thing, the page resolves where it is |
| [**dating-rehearsal**](./apps/demo/dating-rehearsal) | A first date you practice on, and four tools that are all the character's own call — he rates his interest into a live meter, pins the beats that turned it, walks out if it dies, and writes the debrief |
| [**persuasion**](./apps/demo/persuasion) | A win condition that is the character's own judgement — she concedes only by calling a `concede` tool when a genuinely new argument defeats her, and nothing else decides it |

See [`apps/README.md`](./apps/README.md) for what a new example has to contain and which tier
it belongs in.

---

## API

One class, one types file. The full surface is
[`libs/http-client/src/types.ts`](./libs/http-client/src/types.ts) — no import chasing.

```ts
// calls
rta.startCall({ avatarId, mode?, instructions?, context?, maxSeconds?, video?, transcript?, metadata? })
rta.endCall(sessionId, { reason? })     // free an abandoned call's slot; idempotent, never throws

// avatars
rta.createAvatarFromVideo({ displayName, videoUrl, voice? })
rta.listAvatars()
rta.getAvatar(avatarId)
rta.syncClips(avatarId, clipUrls)       // after ANY clip change

// assets
rta.createRemoteAsset({ kind, remoteUrl })
rta.uploadAsset(file, { kind })

// billing
rta.creditBalance()                                 // balance + reserved
rta.listSessions({ from, to, endUserId })           // per-session: when, how long, what it cost
rta.iterateSessions({ from, to })                   // the same, paging handled

// webhooks
verifyTranscript(rawBytes, headers, secret)
```

### Errors worth branching on

| Status | Means | Do |
| --- | --- | --- |
| `401` | Bad, missing or revoked key | Check the bearer and the environment tag |
| `402` | Out of credits, or over the key's spend limit | Show a paywall, not an error screen |
| `403` | Key lacks the scope | Mint one with it. Don't widen to `*`. |
| `422` | Schema rejection | Unknown or mis-cased field — the wire is strict |
| `429` | Capacity full **or** rate limited | On a call this is the queue. Retry; not auto-retried. |
| `503` | Transient upstream | Retried for you, up to `maxRetries` |

`429` is not a failure — it's `{ queued: true, position, retryAfterMs }`. Render the position.
Showing an error there is the most common bad first impression.

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm install
npm run check     # typecheck + build + tests, all of it
```

Found a security issue? Please don't open a public issue —
[SECURITY.md](./SECURITY.md) has the disclosure path.

---

## Support

- 📖 **Docs** — <https://realtimeavatar.ai/docs>
- 🐛 **Bugs and feature requests** — [open an issue](https://github.com/theinfluencecompany/realtime-avatar-sdk/issues)
- 🔀 **Versioning** — the API is pinned at `/api/v1`. Breaking changes get a new version, never a silent edit.

---

<div align="center">

**[MIT](./LICENSE)** © The Influence Company

</div>
