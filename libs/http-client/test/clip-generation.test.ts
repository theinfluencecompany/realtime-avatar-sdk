import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../../../", import.meta.url);
const files = [
  "spec/realtime-avatar.openapi.json",
  "libs/http-client/src/generated/character-motion.ts",
  "libs/http-client/src/generated/clip-library-schema.ts",
  "libs/http-client/src/generated/recording.ts",
  "libs/http-client/src/generated/content-policy.ts",
  "libs/http-client/src/generated/transcription.ts",
  "libs/http-client/src/generated/usage-sessions.ts",
] as const;
const specBytes = await readFile(new URL(files[0], root));
const vendorBytes = await readFile(new URL(files[1], root));
const recordingBytes = await readFile(new URL(files[3], root));
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
        ${JSON.stringify(`https://realtimeavatar.ai${source}`)},
        'https://realtimeavatar.ai/recording.contract.ts'].slice(0, calls.length));
      assert.ok(calls.length <= 3);
      return new Response(Buffer.from(calls.length === 1
        ? ${JSON.stringify(spec.toString("base64"))}
        : calls.length === 2 ? ${JSON.stringify(artifact.toString("base64"))}
        : ${JSON.stringify(recordingBytes.toString("base64"))}, 'base64'));
    };
    process.on('exit', code => { if (code === 0) assert.equal(calls.length, 3); });
  `;
}

test("generation and --check verify the committed executable offline and reject stale output", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    await f.run([]);
    await f.run(["--check"]);
    assert.deepEqual(await f.snapshot(), before);
    await writeFile(join(f.dir, files[4]), "export const contentPolicySchema = z.any();");
    await assert.rejects(f.run(["--check"]), /Content policy schema is stale/);
    await f.run([]);
    assert.deepEqual(await f.snapshot(), before);
    await writeFile(join(f.dir, files[6]), "stale usage sessions schema");
    await assert.rejects(f.run(["--check"]), /Usage sessions schema is stale/);
    await f.run([]);
    assert.deepEqual(await f.snapshot(), before);
    await writeFile(join(f.dir, files[2]), "stale response schema");
    await assert.rejects(f.run(["--check"]), /Clip schemas are stale/);
    await f.run([]);
    assert.deepEqual(await f.snapshot(), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("canonical numeric field mutations fail generated mapping and public consumer typechecks in isolation", async () => {
  const f = await fixture();
  try {
    for (const library of ["http-client", "client"] as const) {
      await cp(new URL(`libs/${library}/src`, root), join(f.dir, `libs/${library}/src`), { recursive: true });
    }
    await symlink(fileURLToPath(new URL("node_modules", root)), join(f.dir, "node_modules"), "dir");
    await writeFile(join(f.dir, "package.json"), '{"type":"module"}');
    await writeFile(join(f.dir, "consumer.ts"), `
      import { RealtimeAvatar } from "./libs/http-client/src/index.ts";
      async function report(client: RealtimeAvatar) {
        const page = await client.listSessions();
        for (const session of page.sessions) {
          const seconds: number | null = session.activeSeconds;
          const cost: number | null = session.billedCreditMicros;
          const diagnostic = session.speechDiagnostics;
          if (diagnostic?.status === "available") {
            const p50: number | undefined = diagnostic.latency_ms.e2e?.p50;
            void p50;
          }
          void [seconds, cost];
        }
      }
      void report;
    `);
    await writeFile(join(f.dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"],
      },
      include: ["consumer.ts"],
    }));
    const compile = () => exec(process.execPath, [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
      "--project", join(f.dir, "tsconfig.json")]);
    const regenerateTypes = () => exec(process.execPath, [fileURLToPath(new URL("node_modules/openapi-typescript/bin/cli.js", root)),
      join(f.dir, files[0]), "-o", join(f.dir, "libs/http-client/src/generated/openapi.ts")]);
    await regenerateTypes();
    await f.run([]);
    await compile();
    const safeConsumer = await readFile(join(f.dir, "consumer.ts"), "utf8");
    for (const unsafe of [
      `import type { UsageSession } from "./libs/http-client/src/index.ts";
       declare const decoded: unknown;
       const row: UsageSession = decoded;`,
      `import { listUsageSessionsResponseSchema } from "./libs/http-client/src/generated/usage-sessions.ts";
       import type { z } from "zod";
       declare const decoded: unknown;
       const page: z.input<typeof listUsageSessionsResponseSchema> = decoded;`,
      `import type { UsageSession } from "./libs/http-client/src/index.ts";
       const diagnostic: UsageSession["speechDiagnostics"] = {
         status: "available", sourceRole: "dialogue", coverage: { first_at: null, last_at: null, lines: 1 },
         latency_ms: { unknown_leg: { count: 1, p50: 1, p90: 1, max: 1 } },
       };`,
    ]) {
      await writeFile(join(f.dir, "consumer.ts"), unsafe);
      await assert.rejects(compile(), (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
        assert.match(error.stdout, /consumer\.ts/);
        assert.match(error.stdout, /not assignable|unknown_leg.*does not exist/);
        assert.doesNotMatch(error.stdout, /usage-sessions\.ts/);
        return true;
      });
    }
    await writeFile(join(f.dir, "consumer.ts"), safeConsumer);
    await compile();
    for (const [field, originalType] of [["activeSeconds", "number"], ["billedCreditMicros", "integer"], ["p50", "number"]] as const) {
      const spec = JSON.parse(specBytes.toString("utf8"));
      const properties = spec.components.schemas.ListUsageSessionsResponse.properties.data.items.properties;
      const numeric = field === "p50"
        ? properties.speechDiagnostics.oneOf[0].properties.latency_ms.additionalProperties.properties.p50
        : properties[field].anyOf.find((schema: { type?: unknown }) => schema.type === originalType);
      assert.ok(numeric);
      numeric.type = "string";
      delete numeric.minimum;
      delete numeric.maximum;
      await writeFile(join(f.dir, files[0]), JSON.stringify(spec));
      await regenerateTypes();
      await assert.rejects(compile(), (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
        assert.match(error.stdout, /usage-sessions\.ts/);
        assert.match(error.stdout, /not assignable/);
        return true;
      });
      await f.run([]);
      await assert.rejects(compile(), (error: unknown) => {
        assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
        assert.match(error.stdout, /consumer\.ts/);
        assert.match(error.stdout, field === "p50" ? /string \| undefined/ : /string \| null/);
        assert.doesNotMatch(error.stdout, /usage-sessions\.ts/);
        return true;
      });
      await writeFile(join(f.dir, files[0]), specBytes);
      await regenerateTypes();
      await f.run([]);
      await compile();
    }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("generation emits the canonical diagnostics union and finite propertyNames record", async () => {
  const f = await fixture();
  try {
    await rm(join(f.dir, files[6]));
    await f.run([]);
    const output = await readFile(join(f.dir, files[6]), "utf8");
    assert.match(output, /z\.partialRecord\(/);
    assert.match(output, /z\.union\(/);
    assert.match(output, /z\.literal\("available"\)/);
    assert.match(output, /z\.literal\("unavailable"\)/);
    assert.equal(output, await readFile(new URL(files[6], root), "utf8"));
    await f.run(["--check"]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const location of ["oneOf", "propertyNames", "recordValue"] as const) {
  test(`generation rejects unsupported diagnostics keyword in ${location} before any writes`, async () => {
    const f = await fixture();
    try {
      const spec = JSON.parse(specBytes.toString("utf8"));
      const diagnostics = spec.components.schemas.ListUsageSessionsResponse.properties.data.items.properties.speechDiagnostics;
      const record = diagnostics.oneOf[0].properties.latency_ms;
      const node = location === "oneOf" ? diagnostics
        : location === "propertyNames" ? record.propertyNames.anyOf[0] : record.additionalProperties;
      node.not = { type: "null" };
      await writeFile(join(f.dir, files[0]), JSON.stringify(spec));
      const before = await f.snapshot();
      await assert.rejects(f.run([]), /Unsupported clip schema keyword: not/);
      assert.deepEqual(await f.snapshot(), before);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test("generation rejects nonfinite record keys instead of widening them to arbitrary strings", async () => {
  const f = await fixture();
  try {
    const spec = JSON.parse(specBytes.toString("utf8"));
    const record = spec.components.schemas.ListUsageSessionsResponse.properties.data.items.properties.speechDiagnostics.oneOf[0].properties.latency_ms;
    record.propertyNames = { type: "string", pattern: "^unknown_" };
    await writeFile(join(f.dir, files[0]), JSON.stringify(spec));
    const before = await f.snapshot();
    await assert.rejects(f.run([]), /Unsupported response record key schema/);
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
      ["apps/web/public/recording.contract.ts", recordingBytes],
      ["packages/realtime-avatar-contracts/src/product/recording.ts", recordingBytes],
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
