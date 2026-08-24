## What changed

<!-- Describe the behaviour, not the diff: what was broken, and what is true now. -->

## Why

<!-- If it fixes an issue, link it: Fixes #123 -->

## How it was verified

<!-- Tests added? Run against a live call? Which example did you try it in? -->

---

- [ ] `npm run check` passes (typecheck + build + tests + boundary)
- [ ] One logical change — a refactor bundled with a fix is two PRs
- [ ] No API key, token or credential in the diff, the tests or the screenshots
- [ ] If this changes the public surface, an issue was opened first and agreed

<!--
Heads up on libs/: those packages are generated from an upstream source of truth. We're glad
to take the PR — we land the change upstream and it arrives here on the next sync, so your
patch ships even though the commit may not appear verbatim. You'll be credited in the
release notes. See CONTRIBUTING.md.
-->
