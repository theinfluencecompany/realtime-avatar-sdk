import { chromium } from "playwright";
import { build, transform } from "esbuild";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// This opt-in runs metered calls through the real production UI. Never run in CI.
assert.equal(process.env.RTA_PROD_EVAL, "1", "Set RTA_PROD_EVAL=1 only for an authorized production evaluation");
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.PROD_REPORT_DIR ?? resolve(tmpdir(), "rta-prod-video-recovery"));
const arm = process.env.PROD_ARM ?? "before";
assert(["before", "after"].includes(arm));
const name = process.env.PROD_RUN ?? `${arm}-${Date.now()}`;
assert(/^[a-zA-Z0-9_-]+$/.test(name));
const out = resolve(root, name);
await mkdir(out, { recursive: true });
await mkdir(resolve(root, "private"), { recursive: true, mode: 0o700 });
const durationMs = Number(process.env.PROD_DURATION_MS ?? 65000);
const slowMs = Number(process.env.PROD_SLOW_MS ?? 6000);
const slowBps = Number(process.env.PROD_SLOW_BPS ?? 450000);
const packetLoss = Number(process.env.PROD_PACKET_LOSS ?? 0);
const startAfterFrameMs = Number(process.env.PROD_START_AFTER_FRAME_MS ?? 2500);
const screenRecording = process.env.PROD_SCREEN_RECORD === "1";
const captureScreenshots = process.env.PROD_SCREENSHOTS !== "0";
const progressFix = process.env.PROD_PROGRESS_FIX !== "0";
const mediaRecording = process.env.PROD_MEDIA_RECORD === "1";
// Capture the deployed asset once and pin all arms to it. These audited symbol
// adapters intentionally fail closed when the site deploys a different bundle.
const expectedBundleHash = "98962b34ddeb8928552f051e9fe59a577319f0c8966fff26b52550a7bfbb698e";
let assets;
try {
  assets = JSON.parse(await readFile(resolve(root, "assets.json"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch("https://prelulu.ai/character/remy");
  assert(response.ok, `character page returned ${response.status}`);
  const html = await response.text();
  const paths = [...new Set([...html.matchAll(/(?:src|href)="([^"\s]+vendor-livekit-[^"\s]+\.js)"/g)].map(match => match[1]))];
  assert.equal(paths.length, 1, "expected one deployed SDK bundle");
  const assetResponse = await fetch(new URL(paths[0], "https://prelulu.ai"));
  assert(assetResponse.ok);
  const body = await assetResponse.text();
  const sha256 = createHash("sha256").update(body).digest("hex");
  assert.equal(sha256, expectedBundleHash, "production changed: audit the browser-only adapters before rerunning");
  await writeFile(resolve(root, "private", paths[0].split("/").at(-1)), body);
  assets = [{ path: paths[0], sha256 }];
  await writeFile(resolve(root, "assets.json"), JSON.stringify(assets, null, 2));
}
const asset = assets.find(a => a.path.includes("vendor-livekit-"));
assert.equal(asset.sha256, expectedBundleHash);
const pristine = await readFile(resolve(root, "private", asset.path.split("/").at(-1)), "utf8");
assert.equal(createHash("sha256").update(pristine).digest("hex"), asset.sha256);
const compiled = await build({
  stdin: {
    contents: `
      export { step } from ${JSON.stringify(resolve(sdk, "libs/client/src/react/quality-governor.ts"))};
      export * from ${JSON.stringify(resolve(sdk, "libs/client/src/react/frame-progress.ts"))};
    `,
    resolveDir: sdk,
  },
  bundle: true, write: false, format: "iife", globalName: "__draftQuality", minify: true,
});
const surfaceSource = await readFile(resolve(sdk, "libs/client/src/react/avatar-video-surface.ts"), "utf8");
const flowStart = surfaceSource.indexOf("function useLiveFrameFlow(");
const flowEnd = surfaceSource.indexOf("\n/**", flowStart);
assert(flowStart > 0 && flowEnd > flowStart);
const frameFlow = await transform(surfaceSource.slice(flowStart, flowEnd), { loader: "ts" });
const frameFlowPatch = `
if(globalThis.__qualityProgressFix) {
  QT = (() => {
    const {useMemo,useRef,useState,useEffect,useCallback} = n;
    const FrameRecovery=FT,StallEscalation=VT,firstFrameWaitFreezeMs=LT;
    const normalizeFrameStallMs=JT,isFrameFlowingAt=YT,isFrameFreezeInhibited=ZT;
    const freezeMsFromFrameGap=__draftQuality.scoreFrameGap,observeVideoElement=nE;
    const {completedFrameGapMs,ongoingFrameGapMs,presentedVideoFrames}=__draftQuality;
    ${frameFlow.code}
    return useLiveFrameFlow;
  })();
}
`;
const stepAnchor = "let{governor:a,action:o}=jT(l,r,Date.now(),_);l=a,o&&d(o.setCap)";
assert.equal(pristine.split(stepAnchor).length, 2, "live reducer call must match exactly once");
const bindAnchor = "let l=TT(Date.now(),_.openingCap),u=async()=>";
assert.equal(pristine.split(bindAnchor).length, 2, "live publication binding must match exactly once");
const observeAnchor = "y?.setVideoQuality?.(e===`low`?t:No.HIGH)";
assert.equal(pristine.split(observeAnchor).length, 2);
const patched = compiled.outputFiles[0].text + "\n" + pristine
  .replace(stepAnchor, "let{governor:a,action:o}=globalThis.__qualityStep(jT,__draftQuality.step,l,r,Date.now(),_);l=a,o&&d(o.setCap)")
  .replace(bindAnchor, "globalThis.__qualityPublication=y;globalThis.__qualityRoom=o;let l=TT(Date.now(),_.openingCap),u=async()=>")
  .replace(observeAnchor, "(globalThis.__qualityCaps.push({t:performance.now(),cap:e,quality:e===`low`?t:No.HIGH,layers:(y?.trackInfo?.layers??[]).map(l=>({quality:l.quality,width:l.width,height:l.height,bitrate:l.bitrate}))}),y?.setVideoQuality?.(e===`low`?t:No.HIGH))")
  + "\n" + frameFlowPatch;
await writeFile(resolve(root, "private", `${name}-vendor.js`), patched);
const result = {
  name, arm, startedAt: new Date().toISOString(), productionOrigin: "https://prelulu.ai",
  draftBrowserOnly: true, candidateApplied: arm === "after", deployedBundleSha256: asset.sha256,
  candidateCoreSha256: createHash("sha256").update(await readFile(resolve(sdk, "libs/client/src/react/quality-governor.ts"))).digest("hex"),
  browserPatchedBundleSha256: createHash("sha256").update(patched).digest("hex"),
  surfaceSourceSha256: createHash("sha256").update(surfaceSource).digest("hex"),
  conditions: { durationMs, slowMs, slowBps, packetLoss, startAfterFrameMs, screenRecording, captureScreenshots, progressFix, mediaRecording },
  patchesServed: 0, errors: [], apiErrors: [], events: [],
};

const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  ],
});
result.browserVersion = browser.version();
const context = await browser.newContext({
  viewport: { width: 430, height: 900 },
  permissions: ["microphone"],
  ...(screenRecording ? { recordVideo: { dir: resolve(out, "recording"), size: { width: 430, height: 900 } } } : {}),
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
const unlimited = { urlPattern: "", latency: 0, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 0, packetQueueLength: 0 };
const network = async conditions => cdp.send("Network.emulateNetworkConditionsByRule", { offline: false, matchedNetworkConditions: [conditions] });
await network(unlimited);
await context.addCookies([{ name: "prelulu_age_ok", value: "1", url: "https://prelulu.ai" }]);
await page.addInitScript(({ arm, progressFix }) => {
  localStorage.setItem("prelulu:onboarding-seen:v1", "1");
  localStorage.setItem("prelulu:first-ring:v1", "shown");
  window.__qualityCaps = [];
  window.__qualityTicks = [];
  window.__qualityFrames = [];
  window.__qualityStats = [];
  window.__qualityLongTasks = [];
  window.__qualityPeers = [];
  window.__qualityProgressFix = arm === "after" && progressFix;
  window.__qualityStep = (original, draft, state, signal, now, config) => {
    const next = (arm === "after" ? draft : original)(state, signal, now, config);
    window.__qualityTicks.push({
      t: performance.now(), now, state, signal, config, next,
    });
    return next;
  };
  const Original = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Original, {
    construct(Target, args) {
      const pc = new Target(...args);
      window.__qualityPeers.push(pc);
      return pc;
    },
  });
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__qualityLongTasks.push({ t: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const watched = new WeakSet();
  function watchVideos() {
    for (const v of document.querySelectorAll('[data-testid="avatar-live-layer"] video')) {
      if (watched.has(v)) continue;
      watched.add(v);
      const frame = (now, m) => {
        const layer = v.closest('[data-testid="avatar-live-layer"]');
        window.__qualityFrames.push({
          t: now, width: m.width, height: m.height, presentedFrames: m.presentedFrames,
          mediaTime: m.mediaTime, expectedDisplayTime: m.expectedDisplayTime,
          presentationTime: m.presentationTime, processingDuration: m.processingDuration,
          captureTime: m.captureTime, receiveTime: m.receiveTime,
          visible: layer?.getAttribute("aria-hidden") !== "true",
          videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        });
        if (!window.__qualityFirstFrame && m.width > 16) window.__qualityFirstFrame = now;
        if (!window.__qualityStopped) v.requestVideoFrameCallback(frame);
      };
      v.requestVideoFrameCallback(frame);
    }
  }
  new MutationObserver(watchVideos).observe(document, { childList: true, subtree: true });
  const keys = [
    "type", "kind", "mimeType", "frameWidth", "frameHeight", "framesPerSecond",
    "framesDecoded", "framesReceived", "framesDropped", "bytesReceived", "headerBytesReceived",
    "packetsReceived", "packetsLost", "jitter", "jitterBufferDelay",
    "jitterBufferEmittedCount", "jitterBufferTargetDelay", "totalDecodeTime",
    "totalProcessingDelay", "freezeCount", "totalFreezesDuration", "pauseCount",
    "totalPausesDuration", "nackCount", "pliCount", "firCount", "decoderImplementation",
    "powerEfficientDecoder", "availableIncomingBitrate", "currentRoundTripTime",
    "totalRoundTripTime", "state", "nominated", "candidateType", "protocol", "relayProtocol",
  ];
  let busy = false;
  setInterval(async () => {
    if (busy || window.__qualityStopped) return;
    busy = true;
    try {
      const reports = await Promise.all(window.__qualityPeers.map(pc => pc.getStats().catch(() => null)));
      const rows = [];
      for (const report of reports) {
        if (!report) continue;
        const transport = [...report.values()].find(s => s.type === "transport" && s.selectedCandidatePairId);
        const pair = transport && report.get(transport.selectedCandidatePairId);
        for (const s of report.values()) {
          if (!(
            (s.type === "inbound-rtp" && s.kind === "video") ||
            (s.type === "codec" && s.mimeType?.startsWith("video/")) ||
            s === pair || (pair && [pair.localCandidateId, pair.remoteCandidateId].includes(s.id))
          )) continue;
          const row = { peer: window.__qualityPeers.indexOf(window.__qualityPeers[reports.indexOf(report)]) };
          for (const k of keys) if (s[k] !== undefined) row[k] = s[k];
          rows.push(row);
        }
      }
      if (rows.length) window.__qualityStats.push({ t: performance.now(), rows });
    } finally { busy = false; }
  }, 500);
}, { arm, progressFix });
await page.route("**/assets/vendor-livekit-*.js", async route => {
  assert.equal(new URL(route.request().url()).pathname, asset.path, "production changed; recapture assets before comparison");
  result.patchesServed++;
  await route.fulfill({ status: 200, contentType: "application/javascript", body: patched });
});
page.on("pageerror", error => result.errors.push(error.message));
page.on("response", async response => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/")) return;
  if (response.status() >= 400) result.apiErrors.push({ path: url.pathname, status: response.status() });
  if (url.pathname.includes("realtime-avatar") && response.request().method() === "POST") {
    try {
      const body = await response.json();
      if (body.participant_token) {
        result.grant = {
          capacityPool: body.capacity_pool, agentName: body.agent_name,
          sessionId: body.session_id, roomName: body.room_name,
        };
        result.events.push({ label: "grant-received", t: await page.evaluate(() => performance.now()), at: new Date().toISOString() });
        await writeFile(resolve(root, "private", `${name}-grant.json`), JSON.stringify({ path: url.pathname, body }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ event: "grant", arm, pool: body.capacity_pool }));
      }
    } catch {}
  }
});
const mark = async label => {
  const t = await page.evaluate(() => performance.now());
  result.events.push({ label, t, at: new Date().toISOString() });
  console.log(JSON.stringify({ event: label, arm, t: Math.round(t) }));
  return t;
};
const screenshot = async label => {
  if (!captureScreenshots) return;
  await page.screenshot({ path: resolve(out, `${label}.png`) });
};
let callStarted = false;
try {
  await page.goto("https://prelulu.ai/signup", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("html[data-hydrated='true']", { state: "attached", timeout: 25000 });
  const email = `e2e-video-quality-${Date.now()}@prelulu.test`;
  const password = randomBytes(24).toString("base64url") + "Aa1!";
  await page.getByLabel("Name", { exact: true }).fill("Video Quality Probe");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL("https://prelulu.ai/", { timeout: 60000 });
  await writeFile(resolve(root, "private", `${name}-account.json`), JSON.stringify({ email, password }), { mode: 0o600 });
  await context.storageState({ path: resolve(root, "private", `${name}-storage.json`) });
  await chmod(resolve(root, "private", `${name}-storage.json`), 0o600);
  await page.goto("https://prelulu.ai/character/remy", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("html[data-hydrated='true']", { state: "attached", timeout: 25000 });
  await page.getByTestId("call-button").waitFor({ timeout: 30000 });
  await mark("call-click");
  callStarted = true;
  await page.getByTestId("call-button").click();
  await page.getByTestId("call-mode-video").click({ timeout: 15000 });
  await page.getByTestId("character-call").waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.__qualityFirstFrame > 0, null, { timeout: 90000 });
  await mark("first-live-frame-observed");
  if (mediaRecording) {
    result.recordingStartT = await page.evaluate(() => {
      const v = document.querySelector('[data-testid="avatar-live-layer"] video');
      const stream = new MediaStream(v.srcObject.getVideoTracks());
      const recorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 6_000_000,
      });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      window.__qualityRecording = {
        recorder,
        stopped: new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType })); }),
      };
      recorder.start(1000);
      return performance.now();
    });
  }
  await page.waitForTimeout(startAfterFrameMs);
  await network({
    ...unlimited, downloadThroughput: slowBps / 8, packetLoss,
    packetQueueLength: 32,
  });
  await mark("slow-start");
  await page.waitForTimeout(slowMs);
  await network(unlimited);
  const restore = await mark("network-restored");
  for (const sec of [5, 10, 20, 35]) {
    const remaining = restore + sec * 1000 - await page.evaluate(() => performance.now());
    if (remaining > 0) await page.waitForTimeout(remaining);
    if (sec === 10 || sec === 35) await screenshot(`restored-plus-${sec}s`);
    const state = await page.evaluate(() => ({
      frame: window.__qualityFrames.at(-1),
      cap: window.__qualityCaps.at(-1),
      governor: window.__qualityTicks.at(-1)?.next.governor,
    }));
    console.log(JSON.stringify({ event: `restored-plus-${sec}s`, arm, ...state }));
  }
  const first = await page.evaluate(() => window.__qualityFirstFrame);
  const remaining = first + durationMs - await page.evaluate(() => performance.now());
  if (remaining > 0) await page.waitForTimeout(remaining);
  result.verdict = "captured";
} catch (error) {
  result.failure = error.stack;
  result.verdict = "setup-or-capture-failed";
  console.log(JSON.stringify({ event: "capture-failed", arm, message: error.message }));
  await screenshot("failure").catch(() => {});
  await writeFile(resolve(root, "private", `${name}-failure-ui.txt`), await page.locator("body").innerText().catch(() => ""), { mode: 0o600 });
} finally {
  await network(unlimited).catch(() => {});
  result.endedAt = new Date().toISOString();
  Object.assign(result, await page.evaluate(() => {
    window.__qualityStopped = true;
    return {
      firstFrame: window.__qualityFirstFrame,
      caps: window.__qualityCaps,
      ticks: window.__qualityTicks,
      frames: window.__qualityFrames,
      stats: window.__qualityStats,
      longTasks: window.__qualityLongTasks,
      measurementEnd: performance.now(),
    };
  }).catch(() => ({})));
  if (mediaRecording) {
    const encoded = await page.evaluate(async () => {
      const recording = window.__qualityRecording;
      if (!recording) return null;
      recording.recorder.stop();
      const blob = await recording.stopped;
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }).catch(() => null);
    if (encoded) {
      result.mediaVideo = resolve(out, "received-video.webm");
      await writeFile(result.mediaVideo, Buffer.from(encoded.split(",")[1], "base64"));
    }
  }
  if (callStarted) {
    try {
      const end = page.getByRole("button", { name: /^End$/ });
      if (await end.isVisible()) await end.click({ timeout: 5000 });
      const confirm = page.getByTestId("call-confirm-end");
      if (await confirm.isVisible()) await confirm.click({ timeout: 5000 });
      await page.getByTestId("character-call").waitFor({ state: "detached", timeout: 10000 });
      result.cleanup = "call-surface-closed";
    } catch {
      await page.evaluate(() => window.__qualityRoom?.disconnect()).catch(() => {});
      result.cleanup = "room-disconnected";
    }
  }
  await page.goto("https://prelulu.ai/", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  result.finishedAt = new Date().toISOString();
  await context.close();
  result.video = await page.video()?.path();
  await browser.close();
  await writeFile(resolve(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    name, arm, verdict: result.verdict, firstFrame: result.firstFrame,
    frameCount: result.frames?.length, caps: result.caps, cleanup: result.cleanup,
    errors: result.errors, apiErrors: result.apiErrors,
  }));
}
