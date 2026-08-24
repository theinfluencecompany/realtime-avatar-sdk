# Contributing

Thanks for being here. Issues, examples and fixes are all welcome.

## Getting set up

```bash
npm install
npm run check     # typecheck + build + tests — run this before you push
```

Node 20+. No other prerequisites; the server client has zero runtime dependencies.

## Where changes go

**`apps/` — the easiest place to contribute.** Every example is standalone: no shared local
imports, so one can be copied out of the repo and still run. If you built an integration we
don't cover, that's a great PR. `apps/README.md` says which tier it belongs in and what it
has to contain.

**`libs/` — read this first.** These packages are generated from our internal source of
truth, not hand-authored here. We're glad to take PRs against them, but we land the change
upstream and it arrives here on the next sync — so your patch ships, while your commit may
not appear verbatim. You'll be credited in the release notes. For anything non-trivial,
**open an issue before you write the code** so we can confirm the shape.

A corollary: if you edit `libs/*/src` locally and it disappears on a later update, that's
why. Nothing was rejected.

## The public surface is deliberately narrow

`libs/contracts` carries the request and response shapes a customer sends and reads — and
only those. It's smaller than what the API can technically express, on purpose: if a field
isn't there, a caller has no reason to set it.

So **adding a schema field is a product decision, not a housekeeping task.** A PR that
widens the surface is a design conversation first. Open an issue describing what you're
trying to build and we'll tell you whether the field is coming.

`npm run boundary` enforces this and runs in CI on every PR. If it fails on your branch,
don't add your term to the allowlist to make it pass — that check is load-bearing.

## Reading and validation

One rule that bites people writing their own proxy:

- **Read with `.passthrough()`, never `.strict()`.** A newer API may add a response field,
  and a client validating a connection payload must not start *rejecting* grants it could
  have relayed. Validate to read, never to filter.
- **Requests are the opposite** — those are `.strict()`, because an unknown key there is a
  caller's typo and should fail loudly.

## Style

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) —
  `feat(client): …`, `fix(proxy): …`, `docs: …`. The scope is the package directory.
- **Formatting:** Prettier, config in `.prettierrc`. No separate lint step to run.
- **Tests:** `node --test` with the native runner. Add one for any behaviour that would be
  expensive to get wrong twice.
- **Comments:** explain *why*, not *what*. The codebase's convention is that a comment earns
  its place by recording something that was learned the hard way.

## Pull requests

1. Fork, branch, and make `npm run check` pass.
2. One logical change per PR. A refactor bundled with a fix is two PRs.
3. Describe the behaviour, not the diff — what was broken, what's true now.
4. CI runs typecheck, build, tests, the boundary check and a credential scan.

## Reporting a vulnerability

Please don't open a public issue. [SECURITY.md](./SECURITY.md) has the disclosure path.

## Code of conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
