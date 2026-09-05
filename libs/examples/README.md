# realtime-avatar-examples

The **contracts** of the example demos, published so that every host of a demo imports the
same words instead of carrying a copy.

A demo is three things: a page that renders the avatar, a brief that tells her who she is
and which tools she may call, and the tools' descriptors — name, description, argument
schema. The page is a host's own business (a vanilla server in this repo, a React route on
realtimeavatar.ai). The brief and the descriptors are not: they are the demo. When each host
kept its own copy, the copies drifted — the hosted coding companion lost its publish lines,
other demos' briefs ended up 40–60% similar to the originals — and nobody noticed, because a
copy that drifted still runs.

This package is the one place those words live.

## What is in it

| Module | Exports |
| --- | --- |
| `realtime-avatar-examples/tools` | `ToolDescriptor`, `ToolWithHandler`, `toolSet(descriptors, handlers)` — marries descriptors to a host's handlers and throws on a descriptor without a handler or a handler without a descriptor |
| `realtime-avatar-examples/coding-companion` | `companionBrief({ canPublish })`, `BUILD_ENGINE_SYSTEM_PROMPT`, `CODING_COMPANION_TOOLS`, `PUBLISH_TOOL`, `CODING_COMPANION_MAX_SECONDS` — the coding companion and the pair programmer, which are one program in two rooms |

Everything is pure data: no DOM, no Node, no React, no platform, zero dependencies. That is
what lets the same module be imported by a Node server, served raw to a browser page, and
bundled into a Worker.

## How a host uses it

Server side — the brief goes into `instructions`, rendered with what THIS host can do:

```js
import { companionBrief, BUILD_ENGINE_SYSTEM_PROMPT } from "realtime-avatar-examples/coding-companion";

const session = await avatar.startCall({
  avatarId,
  instructions: companionBrief({ canPublish: Boolean(process.env.CLOUDFLARE_API_TOKEN) }),
  clientTools: true,
});
```

Page side — the descriptors come from the package, the handlers stay in the page because they
touch its state:

```js
import { CODING_COMPANION_TOOLS } from "realtime-avatar-examples/coding-companion";
import { toolSet } from "realtime-avatar-examples/tools";

const TOOLS = toolSet(CODING_COMPANION_TOOLS, {
  build_app: async ({ request }) => startBuild(request),
  check_app: () => studioState(),
  restore_version: ({ version }) => restore(version),
});
```

`canPublish` matters. A host that cannot publish must not brief her on a verb she cannot
call — she will try it, apologise, and try it again. The hosted ports never can; the vanilla
demos can when the Cloudflare variables are set.

## Rules

- **A demo's contract lives here or nowhere.** Do not paste a brief or a descriptor into a
  host. `libs/examples/test` fails if the demos in this repo carry an inline copy; the hosted
  ports carry the same guard.
- **Handlers stay with the host.** A handler closes over a page's DOM or a server's state.
  Sharing it would mean sharing the host, and then there is no second host.
- **Descriptors use `parameters`** (the SDK tool plane's word). A host whose tool type says
  `inputSchema` maps the field at the import site; the schema itself is identical.
- **Pure data only.** No imports beyond this package's own modules. If a contract needs a
  runtime, it is not a contract.

## Adding a demo's contract

One module per demo, named after the demo folder in `apps/demo`. Export the brief as a
function of what the host can do (never as a string with switches a host cannot flip), the
descriptors as a `readonly ToolDescriptor[]`, and any constant the hosts must agree on. Then
delete the inline copies from every host and let the drift test prove they are gone.
