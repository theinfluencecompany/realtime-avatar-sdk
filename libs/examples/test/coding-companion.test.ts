import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  BUILD_ENGINE_SYSTEM_PROMPT,
  CODING_COMPANION_MAX_SECONDS,
  CODING_COMPANION_TOOLS,
  PUBLISH_TOOL,
  companionBrief,
} from "../src/coding-companion.ts";
import { toolSet } from "../src/tools.ts";

/** The platform caps `instructions` at this many characters; the brief must leave a host room to add to it. */
const INSTRUCTIONS_LIMIT = 8000;
/** What the platform accepts as a tool name — the same rule the tool plane enforces at registration. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ALL_TOOLS = [...CODING_COMPANION_TOOLS, PUBLISH_TOOL];

test("the brief is pure, bounded and fits the instructions cap with room to spare", () => {
  const brief = companionBrief();
  assert.equal(brief, companionBrief(), "the same input must yield the same brief");
  assert.equal(brief, companionBrief({ canPublish: false }));
  assert.ok(brief.length > 500, "a brief this short is not the brief");
  assert.ok(companionBrief({ canPublish: true }).length <= INSTRUCTIONS_LIMIT / 2, "leave the host half the cap");
  assert.ok(!brief.includes("${"), "an unrendered template placeholder leaked into the brief");
  assert.equal(brief, brief.trim());
});

test("canPublish is the only difference, and it adds exactly the publish verb", () => {
  const without = companionBrief({ canPublish: false });
  const withIt = companionBrief({ canPublish: true });
  assert.notEqual(without, withIt);
  assert.ok(withIt.includes(PUBLISH_TOOL.name), "a host that can publish must brief her on the verb");
  assert.ok(!without.includes(PUBLISH_TOOL.name), "a host that cannot publish must not brief her on a verb she cannot call");
  assert.ok(!/publish/i.test(without), "publishing must not be mentioned at all when the host cannot do it");
  // Every line of the no-publish brief survives in the publish brief: the switch only ADDS.
  for (const line of without.split("\n")) {
    if (line.trim()) assert.ok(withIt.includes(line.slice(0, 40)), `line dropped by canPublish: ${line.slice(0, 60)}`);
  }
});

test("the brief names exactly the tools the descriptors declare", () => {
  const declared = new Set(ALL_TOOLS.map((t) => t.name));
  for (const canPublish of [false, true]) {
    const brief = companionBrief({ canPublish });
    const mentioned = new Set(brief.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
    for (const name of mentioned) assert.ok(declared.has(name), `brief names an undeclared tool: ${name}`);
    for (const tool of CODING_COMPANION_TOOLS) assert.ok(mentioned.has(tool.name), `brief never names ${tool.name}`);
    assert.equal(mentioned.has(PUBLISH_TOOL.name), canPublish);
  }
});

test("every descriptor is a valid tool: platform-legal name, a description, an object schema", () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
  for (const tool of ALL_TOOLS) {
    assert.match(tool.name, TOOL_NAME);
    assert.ok(tool.description.trim().length >= 40, `${tool.name}: a description a model can act on is longer than this`);
    assert.equal(tool.parameters.type, "object", `${tool.name}: parameters must be a JSON-schema object`);
    const props = tool.parameters.properties;
    assert.ok(props && typeof props === "object", `${tool.name}: properties missing`);
    const required = tool.parameters.required;
    if (required !== undefined) {
      assert.ok(Array.isArray(required));
      for (const key of required) assert.ok(key in (props as object), `${tool.name}: required ${String(key)} is not a property`);
    }
  }
  assert.deepEqual(names, ["build_app", "check_app", "restore_version", "publish_app"]);
});

test("the builder's system prompt is a rendered constant, not a template", () => {
  assert.ok(BUILD_ENGINE_SYSTEM_PROMPT.startsWith("You are the build engine"));
  assert.ok(!BUILD_ENGINE_SYSTEM_PROMPT.includes("${"));
  assert.equal(BUILD_ENGINE_SYSTEM_PROMPT, BUILD_ENGINE_SYSTEM_PROMPT.trim());
  assert.ok(Number.isInteger(CODING_COMPANION_MAX_SECONDS) && CODING_COMPANION_MAX_SECONDS > 0 && CODING_COMPANION_MAX_SECONDS <= 1800);
});

test("toolSet marries descriptors to handlers and refuses a partial or a stray handler", () => {
  const execute = () => "ok";
  const set = toolSet(CODING_COMPANION_TOOLS, { build_app: execute, check_app: execute, restore_version: execute });
  assert.deepEqual(Object.keys(set), ["build_app", "check_app", "restore_version"]);
  for (const tool of CODING_COMPANION_TOOLS) {
    const entry = set[tool.name];
    assert.ok(entry, `${tool.name} missing from the set`);
    assert.equal(entry.description, tool.description);
    assert.equal(entry.parameters, tool.parameters);
    assert.equal(entry.execute, execute);
  }
  assert.throws(() => toolSet(CODING_COMPANION_TOOLS, { build_app: execute }), /check_app/);
  assert.throws(() => toolSet([PUBLISH_TOOL], { publish_app: execute, stray_tool: execute }), /stray_tool/);
});

/**
 * Drift guard. The whole point of this package is that the two demo hosts in this repo carry
 * NO copy of the brief, the builder prompt or the descriptors. A copy pasted back in would pass
 * every other test and silently fork the contract again — this is the test that fails instead.
 */
test("the demo hosts import the contract and carry no inline copy of it", async () => {
  const root = new URL("../../../", import.meta.url);
  const fingerprints = [
    companionBrief().slice(0, 60),
    BUILD_ENGINE_SYSTEM_PROMPT.slice(0, 60),
    ...ALL_TOOLS.map((t) => t.description.slice(0, 50)),
  ];
  for (const demo of ["coding-companion", "pair-programmer"]) {
    const server = await readFile(new URL(`apps/demo/${demo}/server.mjs`, root), "utf8");
    const page = await readFile(new URL(`apps/demo/${demo}/index.html`, root), "utf8");
    for (const text of fingerprints) {
      assert.ok(!server.includes(text), `${demo}/server.mjs carries an inline copy: "${text.slice(0, 40)}…"`);
      assert.ok(!page.includes(text), `${demo}/index.html carries an inline copy: "${text.slice(0, 40)}…"`);
    }
    assert.ok(server.includes('from "realtime-avatar-examples/coding-companion"'), `${demo}: server must import the contract`);
    assert.ok(server.includes("companionBrief({ canPublish })"), `${demo}: the brief must be rendered with the host's publish capability`);
    assert.ok(server.includes("BUILD_ENGINE_SYSTEM_PROMPT"), `${demo}: the builder prompt must come from the package`);
    assert.ok(server.includes("sdk\\/examples\\/") && server.includes("EXAMPLES_DIR"), `${demo}: server must serve the package to the page`);
    assert.ok(page.includes('from "/sdk/examples/coding-companion.js"'), `${demo}: page must import the descriptors`);
    assert.ok(page.includes('from "/sdk/examples/tools.js"'), `${demo}: page must import toolSet`);
    assert.ok(page.includes("toolSet(CODING_COMPANION_TOOLS,"), `${demo}: page must build TOOLS from the descriptors`);
    assert.ok(page.includes("toolSet([PUBLISH_TOOL_DESCRIPTOR],"), `${demo}: page must build PUBLISH_TOOL from the descriptor`);
  }
});
