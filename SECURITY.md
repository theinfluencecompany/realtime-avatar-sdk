# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/theinfluencecompany/realtime-avatar-sdk/security/advisories/new),
or email **hi@realtimeavatar.ai**.

Include what you need to make the case reproducible: affected package and version, what an
attacker gets, and the steps. A proof of concept helps but isn't required to report.

**What to expect**

| | |
| --- | --- |
| Acknowledgement | within 3 business days |
| Initial assessment | within 7 business days |
| Fix or mitigation plan | communicated before public disclosure |

We'll credit you in the advisory unless you'd rather stay anonymous. We won't pursue legal
action against good-faith research that follows this policy.

## Supported versions

The SDK is pre-1.0 and moves quickly. Security fixes land on the latest published version of
each package; there are no backports to earlier `0.x` releases. Pin exact versions in
production and update deliberately.

## What's in scope

- The packages published from this repository.
- The example apps under `apps/`, insofar as they demonstrate an unsafe pattern that a reader
  would reasonably copy into production.

## What's out of scope

- The hosted API at `realtimeavatar.ai` — report those to the same address, but they're
  handled outside this repo's advisory process.
- Denial of service through legitimate API usage. Spend and duration limits are the control
  there: see `maxSeconds` and per-key spend limits.

## Two things worth saying plainly

These are the mistakes we see most, and neither is a vulnerability in the SDK:

1. **The API key is server-only.** A browser holding it can start unlimited calls on your
   account. `new RealtimeAvatar()` throws in a browser runtime so this fails loudly — do not
   work around that. Never prefix the key with `NEXT_PUBLIC_` or any other bundler-inlined
   variable.
2. **Never accept call policy from the client.** `instructions`, `context`, `maxSeconds`,
   `voice` and `video` are your server's decisions. A route that spreads a request body into
   `startCall` lets any visitor write your system prompt and set their own spend limit.

Likewise, an endpoint that ends a call by relaying an arbitrary `session_id` from the request
body lets any visitor hang up any call on your account. Track the ids you minted and only end
those.
