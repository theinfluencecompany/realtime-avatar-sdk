#!/usr/bin/env node
/**
 * Scan COMMIT MESSAGES for internal references — the half of the boundary that
 * `check-boundary.mjs` cannot reach.
 *
 * WHY THIS EXISTS, SPECIFICALLY. The file scan asks whether anything *shipped* names an
 * internal concept. A commit message ships nothing, so it has always passed. That is the
 * hole: a message is written once, reviewed by nobody after the fact, and then made
 * PERMANENT by GitHub the moment the PR opens — `refs/pull/<n>/head` is created before any
 * check runs, is not removed by a force-push, and cannot be deleted by a push at all.
 * Squash-merging cleans what lands on main and leaves the original branch head pinned
 * behind that ref forever.
 *
 * Measured on this repo before this check existed: 22 orphaned PR-ref heads, six of them
 * naming a customer, a capacity constant, an internal service or an inference design doc in
 * their commit messages. None of it is reachable from `main`; all of it is fetchable by
 * anyone who can read the repo, and would be public if the repo ever were.
 *
 * So the only moment this is fixable is BEFORE the merge — which is when this runs.
 * Rewriting afterwards does not help: `filter-repo` writes new commits and the originals
 * stay pinned by the ref that made them permanent.
 *
 *   node scripts/check-commit-messages.mjs [<base-ref>]     # default: origin/main
 *
 * Needs full history — `actions/checkout` must run with `fetch-depth: 0`, or the range
 * resolves to nothing and this passes vacuously.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const DEFAULT_TERMS = "scripts/boundary-terms.private.txt";
const termsFile = process.env.BOUNDARY_TERMS_FILE ?? DEFAULT_TERMS;
const base = process.argv[2] ?? "origin/main";

const raw = await readFile(termsFile, "utf8").catch(() => null);
if (raw === null) {
  // Same posture as check-boundary.mjs: no list configured is a soft pass, because the
  // list is private and a fork legitimately does not have it.
  console.log(`✓ commit messages — no term list at ${termsFile} (set BOUNDARY_TERMS_FILE)`);
  process.exit(0);
}

const FORBIDDEN = [
  ...new Set(
    raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  ),
];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// `--not <base>` rather than `base..HEAD`: on a merge commit the two-dot form silently
// resolves to nothing, which would pass a PR that merged main back into itself.
let log;
try {
  log = git("log", "--format=%H%x00%s%x00%b%x1e", "HEAD", "--not", base);
} catch {
  console.error(`✗ cannot resolve ${base} — checkout needs fetch-depth: 0`);
  process.exit(1);
}

const commits = log
  .split("\x1e")
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => {
    const [sha, subject, body = ""] = c.split("\x00");
    return { sha, subject, text: `${subject}\n${body}` };
  });

const hits = [];
for (const commit of commits) {
  const lower = commit.text.toLowerCase();
  for (const term of FORBIDDEN) {
    if (lower.includes(term.toLowerCase())) hits.push({ commit, term });
  }
}

if (hits.length > 0) {
  console.error(`\n✗ boundary violated — internal reference(s) in ${hits.length} commit message(s):\n`);
  for (const { commit, term } of hits) {
    console.error(`  ${commit.sha.slice(0, 9)}  ${term}`);
    console.error(`             ${commit.subject}`);
  }
  console.error(`
Fix it NOW, before this merges — after that it is permanent. GitHub pins your branch head
at refs/pull/<n>/head, that ref survives force-pushes, and no push can delete it.

  git rebase -i ${base}      # reword the offending commits, then force-push the BRANCH

Say what changed in this repo's own words. Do not add the term to the list to pass.
`);
  process.exit(1);
}

console.log(
  `✓ commit messages clean — ${commits.length} commit(s) vs ${base}, ${FORBIDDEN.length} terms checked`,
);
