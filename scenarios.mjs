// Four scenarios, run against PRODUCTION through the built `realtime-avatar` entry point —
// the same file a consumer gets from npm, not the internal workspace source.
//
//   1. create with a custom LOOPING-VIDEO description
//   2. create, then declare a custom MULTI-CLIP library (a description per clip)
//   3. EDIT (1): re-direct that avatar's loop with a new description
//   4. EDIT (2): re-declare the library — revise one, add one, retire one
//
// Every number printed here is measured, not modelled.

import { RealtimeAvatar } from "./libs/sdk-server/dist/index.js";
import { writeFileSync } from "node:fs";

const apiKey = process.env.RTA_KEY;
if (!apiKey) throw new Error("set RTA_KEY");
const PORTRAIT = "https://assets.fried.gg/rta-creation-lifecycle/pr-106/portrait.jpg";

const rta = new RealtimeAvatar({ apiKey });
const t0 = Date.now();
const report = { startedAt: new Date().toISOString(), scenarios: {} };
const since = () => Math.round((Date.now() - t0) / 1000);
const log = (...a) => console.log(`[${String(since()).padStart(4)}s]`, ...a);

function record(key, data) {
  report.scenarios[key] = data;
  writeFileSync("/tmp/scenarios-report.json", JSON.stringify(report, null, 2));
  log(key, JSON.stringify(data));
}

// ── 1 · create with a custom looping-video description ────────────────────────────
const LOOP_1 = "settles into frame, breathes slowly, one unhurried blink, returns to stillness";
const s1Start = Date.now();
const a1 = await rta.createAvatarFromImage({
  displayName: `S1 custom loop ${new Date().toISOString().slice(11, 19)}`,
  imageUrl: PORTRAIT,
  motionPrompt: LOOP_1,
});
log("1. created", a1.id, a1.status, a1.idleVideoStatus);

// ── 2 · create, then declare a custom multi-clip library ──────────────────────────
const a2 = await rta.createAvatarFromImage({
  displayName: `S2 custom clips ${new Date().toISOString().slice(11, 19)}`,
  imageUrl: PORTRAIT,
});
log("2. created", a2.id, a2.status);

// Both loops render in parallel; wait for each to settle.
const a1Ready = await rta.waitForLoop(a1.id, { pollMs: 15_000, timeoutMs: 20 * 60_000 });
record("1_create_custom_loop", {
  avatarId: a1.id,
  motionPrompt: LOOP_1,
  elapsedS: Math.round((Date.now() - s1Start) / 1000),
  status: a1Ready.status,
  idleVideoStatus: a1Ready.idleVideoStatus,
  loopAssetId: a1Ready.sourceAssetId,
});

const a2Ready = await rta.waitForLoop(a2.id, { pollMs: 15_000, timeoutMs: 20 * 60_000 });
// The starter library the platform designs on its own — the baseline scenario 2 replaces.
const a2Starter = await rta.waitForClips(a2.id, { pollMs: 15_000, timeoutMs: 20 * 60_000 });

const CLIPS_V1 = [
  { clipId: "idle_soft", role: "idle", source: { motionPrompt: "breathing gently, a slow blink, eyes stay warm" } },
  { clipId: "listen_lean", role: "listen", source: { motionPrompt: "leans in a little, attentive, small nod" } },
  { clipId: "gesture_wave", role: "gesture", whenHint: "when greeting someone", source: { motionPrompt: "raises a hand and waves warmly, then lowers it" } },
];
const s2Start = Date.now();
const declared = await rta.setClipLibrary(a2.id, {
  expectedRevision: a2Starter.revision,
  clips: CLIPS_V1,
});
const a2Settled = await rta.waitForClips(a2.id, { pollMs: 15_000, timeoutMs: 20 * 60_000 });
record("2_create_custom_clips", {
  avatarId: a2.id,
  starterLibrary: a2Starter.data.map((c) => `${c.clipId}:${c.status}`),
  declaredPerClipPrompts: CLIPS_V1.map((c) => ({ clipId: c.clipId, role: c.role, motionPrompt: c.source.motionPrompt, whenHint: c.whenHint ?? null })),
  plan: declared.plan,
  revision: a2Settled.revision,
  elapsedS: Math.round((Date.now() - s2Start) / 1000),
  settled: a2Settled.data.map((c) => `${c.clipId}:${c.status}`),
  anchorSource: a2Settled.anchor?.source ?? null,
});

// ── 3 · EDIT (1): re-direct the loop of the image-created avatar ──────────────────
const LOOP_2 = "tilts her head, a small amused smile, settles back to centre";
const s3Start = Date.now();
const redirect = await rta.setLoop(a1.id, { motionPrompt: LOOP_2 });
log("3. accepted", JSON.stringify(redirect));
const a1After = await rta.waitForLoop(a1.id, { pollMs: 15_000, timeoutMs: 25 * 60_000 });
const a1Clips = await rta.listClips(a1.id);
record("3_edit_loop", {
  avatarId: a1.id,
  from: LOOP_1,
  to: LOOP_2,
  accepted: { loopStatus: redirect.loopStatus, servingUrlWasPreviousLoop: redirect.servingUrl !== null },
  elapsedS: Math.round((Date.now() - s3Start) / 1000),
  loopAssetBefore: a1Ready.sourceAssetId,
  loopAssetAfter: a1After.sourceAssetId,
  swapped: a1Ready.sourceAssetId !== a1After.sourceAssetId,
  stayedReadyThroughout: a1After.status === "ready",
  clipLibraryUntouched: a1Clips.data.every((c) => c.status !== "queued" && c.status !== "generating"),
});

// ── 4 · EDIT (2): re-declare the library — revise one, add one, retire one ────────
const CLIPS_V2 = [
  // kept verbatim → should land in `kept`, no re-render
  CLIPS_V1[0],
  // REVISED description → should re-render
  { clipId: "listen_lean", role: "listen", source: { motionPrompt: "listens quietly, head tilted, a patient half-smile" } },
  // NEW
  { clipId: "gesture_think", role: "gesture", whenHint: "when considering something", source: { motionPrompt: "glances up thinking, then back, a small nod" } },
  // gesture_wave omitted → should be retired
];
const s4Start = Date.now();
const redeclared = await rta.setClipLibrary(a2.id, {
  expectedRevision: a2Settled.revision,
  clips: CLIPS_V2,
});
const a2Final = await rta.waitForClips(a2.id, { pollMs: 15_000, timeoutMs: 25 * 60_000 });
record("4_edit_clips", {
  avatarId: a2.id,
  plan: redeclared.plan,
  revisionBefore: a2Settled.revision,
  revisionAfter: a2Final.revision,
  elapsedS: Math.round((Date.now() - s4Start) / 1000),
  final: a2Final.data.map((c) => `${c.clipId}:${c.status}`),
  revisedPrompt: CLIPS_V2[1].source.motionPrompt,
});

report.finishedAt = new Date().toISOString();
report.totalS = since();
writeFileSync("/tmp/scenarios-report.json", JSON.stringify(report, null, 2));
log("DONE in", since(), "s");
