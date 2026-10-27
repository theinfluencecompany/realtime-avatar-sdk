import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RealtimeAvatar } from "../../http-client/src/client.ts";
import { RealtimeAvatar as PublicRealtimeAvatar, RealtimeAvatarError as PublicRealtimeAvatarError } from "realtime-avatar";

test("malformed session pages use the public server error hierarchy without response contents", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ sessionId: "private-session", activeSeconds: "secret-response-value" }],
    nextCursor: null,
    from: "2026-10-20T00:00:00Z",
    to: "2026-10-20T06:00:00Z",
  }), { headers: { "content-type": "application/json" } });
  const client = new PublicRealtimeAvatar({ apiKey: "secret-api-token", fetch: fetchImpl });
  for (const read of [() => client.listSessions(), () => client.iterateSessions().next()]) {
    await assert.rejects(read(), (error: unknown) => {
      assert.ok(error instanceof PublicRealtimeAvatarError);
      assert.equal(error.name, "RealtimeAvatarError");
      assert.match(error.message, /usage sessions.*contract/i);
      assert.doesNotMatch(`${error}\n${error.stack}\n${JSON.stringify(error)}`,
        /private-session|secret-response-value|secret-api-token/);
      assert.equal(error.cause, undefined);
      assert.equal(Object.hasOwn(error, "value"), false);
      assert.equal(Object.hasOwn(error, "issues"), false);
      return true;
    });
  }
});

/**
 * Two READMEs carry an `## API` block — the repo root's, and this package's, which is the one
 * npm renders on the package page. They must teach the same surface, and twice in one day they
 * did not: #38 (setLoop) and #40 (waitForLoop/waitForClips) each added a client method and
 * updated only the root block, so the package page went stale the moment the feature merged.
 *
 * This replays the check mechanically, against the class itself rather than either README:
 * every public prototype method must appear as `rta.<name>(` in BOTH blocks, and every
 * `rta.<name>(` in a block must exist on the class — so a stale entry fails the same way a
 * missing one does.
 */

// The one deliberate omission: createAvatar is the low-level lane that createAvatarFromImage /
// createAvatarFromVideo call; the blocks document those two instead.
const UNDOCUMENTED = new Set(["createAvatar"]);

const READMES = [
  ["README.md (repo root)", new URL("../../../README.md", import.meta.url)],
  ["libs/sdk-server/README.md", new URL("../README.md", import.meta.url)],
] as const;

const classMethods = Object.getOwnPropertyNames(RealtimeAvatar.prototype).filter(
  (n) => n !== "constructor",
);

function apiBlockMethods(label: string, path: URL): Set<string> {
  const md = readFileSync(path, "utf8");
  const api = md.split(/^## API$/m)[1]?.split(/^## /m)[0];
  assert.ok(api, `${label}: no "## API" section found`);
  const names = new Set<string>();
  for (const m of api.matchAll(/^rta\.(\w+)\(/gm)) names.add(m[1]!);
  assert.ok(names.size > 0, `${label}: the API section lists no rta.* methods`);
  return names;
}

for (const [label, path] of READMES) {
  test(`${label} API block matches the RealtimeAvatar surface`, () => {
    const documented = apiBlockMethods(label, path);
    const missing = classMethods.filter((n) => !UNDOCUMENTED.has(n) && !documented.has(n));
    assert.deepEqual(
      missing,
      [],
      `${label}: class methods absent from the API block (add them, or add to UNDOCUMENTED with a reason): ${missing.join(", ")}`,
    );
    const stale = [...documented].filter((n) => !classMethods.includes(n));
    assert.deepEqual(
      stale,
      [],
      `${label}: API block names methods the class does not have: ${stale.join(", ")}`,
    );
  });
}

/**
 * The voice webhook's reply contract is the worker's, and every page that teaches it must say the
 * same thing. The first draft told receivers a failure "skips that one sentence" and that only a
 * 401/403 is fatal; the worker drops the rest of the reply and ends the call after repeated
 * failures of any kind, and a receiver built on the draft would budget for neither.
 */
const VOICE_WEBHOOK_PAGES = [
  ["README.md (repo root)", new URL("../../../README.md", import.meta.url)],
  ["libs/sdk-server/README.md", new URL("../README.md", import.meta.url)],
  ["AGENTS.md", new URL("../../../AGENTS.md", import.meta.url)],
  ["CHANGELOG.md", new URL("../../../CHANGELOG.md", import.meta.url)],
] as const;

function voiceWebhookText(label: string, path: URL): string {
  const md = readFileSync(path, "utf8");
  const start = md.search(/^#{2,3} .*(Custom voice \(webhook\)|0\.28\.0)/m);
  assert.ok(start >= 0, `${label}: no voice webhook section found`);
  const rest = md.slice(start);
  const body = rest.indexOf("\n");
  const end = rest.slice(body).search(/^#{2,3} (?!Added|Changed)/m);
  return (end < 0 ? rest : rest.slice(0, body + end)).replace(/\s+/g, " ");
}

for (const [label, path] of VOICE_WEBHOOK_PAGES) {
  test(`${label} states the worker's voice webhook reply contract`, () => {
    const text = voiceWebhookText(label, path);
    assert.match(text, /rest of that reply/, `${label}: a failure drops the rest of that reply`);
    assert.match(text, /next reply tries again/, `${label}: the next reply tries again`);
    assert.match(text, /408`?, `?429`? or 5xx is retried once, only before any audio has arrived, as a new POST with a new `?request_id/,
      `${label}: the retry set and what a retry is`);
    assert.match(text, /every later gap between chunks/, `${label}: timeoutMs bounds every gap, not only the first byte`);
    assert.match(text, /`?204`?/, `${label}: an empty 2xx, a 204 included, is voice_webhook_empty_audio`);
    assert.match(text, /last failure's code/, `${label}: repeated failures end the call with the last failure's code`);
    assert.doesNotMatch(text, /skips (that|this) (one )?sentence|l16/i, `${label}: still teaches the draft contract`);
  });
}

test("the quickstarts never promise a skipped sentence or a big-endian PCM type", () => {
  for (const rel of [
    "../../../apps/quickstart/nextjs-app-router/README.md",
    "../../../apps/quickstart/nextjs-app-router/app/api/voice/route.ts",
    "../../../apps/quickstart/python-fastapi/README.md",
    "../../../apps/quickstart/python-fastapi/main.py",
  ]) {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.doesNotMatch(text, /skips (that|this) (one )?sentence|l16/i, rel);
    assert.match(text, /rest of (that|this) reply/, `${rel}: a failed 502 drops the rest of the reply`);
  }
});

test("the VoiceError and onVoiceError docs say what fatal and a failure really mean", () => {
  for (const [rel, anchor] of [
    ["../../client/src/react/use-realtime-session.ts", "export type VoiceError = {"],
    ["../../client/src/react/avatar-call.ts", "onVoiceError?: (error: VoiceError) => void;"],
  ] as const) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    const at = source.indexOf(anchor);
    assert.ok(at > 0, `${rel}: ${anchor} not found`);
    const doc = source.slice(source.lastIndexOf("/**", at), at).replace(/\s*\*\s*/g, " ");
    assert.match(doc, /rest of that reply/, `${rel}: a failure drops the rest of that reply`);
    assert.match(doc, /repeated failures/, `${rel}: fatal is not only a 401/403 or a refused URL`);
    assert.match(doc, /last failure's code/, `${rel}: a fatal close carries the last failure's code`);
  }
});
