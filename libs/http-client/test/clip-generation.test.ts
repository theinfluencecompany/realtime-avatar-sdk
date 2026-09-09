import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../../../", import.meta.url);
const files = [
  "spec/realtime-avatar.openapi.json",
  "libs/http-client/src/generated/character-motion.ts",
  "libs/http-client/src/generated/clip-library-schema.ts",
] as const;
const specBytes = await readFile(new URL(files[0], root));
const vendorBytes = await readFile(new URL(files[1], root));
const script = "scripts/generate-clip-schema.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "rta-clip-generation-"));
  for (const file of [script, ...files]) {
    const target = join(dir, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, await readFile(new URL(file, root)));
  }
  const snapshot = () => Promise.all(files.map(file => readFile(join(dir, file))));
  const run = async (args: string[], setup = "globalThis.fetch = () => { throw new Error('network forbidden'); };") => {
    const runner = join(dir, "runner.mjs");
    await writeFile(runner, `
      process.argv = [process.execPath, ${JSON.stringify(join(dir, script))}, ...${JSON.stringify(args)}];
      ${setup}
      await import(${JSON.stringify(join(dir, script))});
    `);
    return exec(process.execPath, [runner]);
  };
  return { dir, snapshot, run };
}

function mockPull(spec: Buffer = specBytes, artifact: Buffer = vendorBytes) {
  const source = JSON.parse(spec.toString("utf8"))["x-clip-contract"].source;
  return `
    const assert = (await import('node:assert/strict')).default;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      calls.push(String(url));
      assert.deepEqual(calls, ['https://realtimeavatar.ai/openapi.json',
        ${JSON.stringify(`https://realtimeavatar.ai${source}`)}].slice(0, calls.length));
      assert.ok(calls.length <= 2);
      return new Response(Buffer.from(calls.length === 1
        ? ${JSON.stringify(spec.toString("base64"))}
        : ${JSON.stringify(artifact.toString("base64"))}, 'base64'));
    };
    process.on('exit', code => { if (code === 0) assert.equal(calls.length, 2); });
  `;
}

test("generation and --check verify the committed executable offline and reject stale output", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    await f.run([]);
    await f.run(["--check"]);
    assert.deepEqual(await f.snapshot(), before);
    await writeFile(join(f.dir, files[2]), "stale response schema");
    await assert.rejects(f.run(["--check"]), /Clip schemas are stale/);
    await f.run([]);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("offline generation and --check fail on executable tampering before any writes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, files[1]), Buffer.concat([vendorBytes, Buffer.from("\n")]));
    const before = await f.snapshot();
    for (const args of [[], ["--check"]]) {
      await assert.rejects(f.run(args), /SHA-256 mismatch/);
      assert.deepEqual(await f.snapshot(), before);
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("--pull fetches the spec before its executable from the same trusted origin", async () => {
  const f = await fixture();
  try {
    const expected = await f.snapshot();
    await writeFile(join(f.dir, files[1]), "old executable");
    await f.run(["--pull"], mockPull());
    assert.deepEqual(await f.snapshot(), expected);
    await f.run(["--check"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("--pull refuses a digest mismatch without replacing the spec, vendor or response schemas", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    await assert.rejects(f.run(["--pull"], mockPull(specBytes, Buffer.from("tampered executable"))), /SHA-256 mismatch/);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("--pull rejects untrusted sources and redirects instead of fetching executable code", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    for (const source of ["https://evil.example/character-motion.ts", "//evil.example/character-motion.ts", "/../character-motion.ts"]) {
      const spec = JSON.parse(specBytes.toString("utf8"));
      spec["x-clip-contract"].source = source;
      await assert.rejects(f.run(["--pull"], `
        let calls = 0;
        globalThis.fetch = async () => {
          if (++calls > 1) throw new Error('must not fetch executable');
          return new Response(${JSON.stringify(JSON.stringify(spec))});
        };
      `), /invalid x-clip-contract/);
      assert.deepEqual(await f.snapshot(), before);
    }
    await assert.rejects(f.run(["--pull"], "globalThis.fetch = async () => new Response(null, {status: 302});"), /HTTP 302/);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("--sync requires an absolute platform root and verifies published bytes against their owner", async () => {
  const f = await fixture();
  try {
    const platform = join(f.dir, "platform");
    const artifact = "apps/web/public/character-motion.ts";
    const owner = "packages/realtime-avatar-contracts/src/character-motion.ts";
    for (const [file, bytes] of [
      [artifact, vendorBytes], [owner, vendorBytes],
      ["packages/realtime-avatar-contracts/openapi/realtime-avatar.openapi.json", specBytes],
    ] as const) {
      const target = join(platform, file);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    await assert.rejects(f.run(["--sync", "relative/root"]), /Usage:/);
    await f.run(["--sync", platform]);
    await f.run(["--check"]);
    const before = await f.snapshot();
    await writeFile(join(platform, owner), "different owner");
    await assert.rejects(f.run(["--sync", platform]), /differs from its canonical owner/);
    assert.deepEqual(await f.snapshot(), before);
    await writeFile(join(platform, artifact), "different owner");
    await assert.rejects(f.run(["--sync", platform]), /SHA-256 mismatch/);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(createHash("sha256").update(vendorBytes).digest("hex"),
      JSON.parse(specBytes.toString("utf8"))["x-clip-contract"].sha256);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
