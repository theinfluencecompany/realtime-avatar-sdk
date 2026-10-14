// Compare actual offline LiveKit Egress outputs through the shipped React player.
// Input: probe JSON plus its adjacent media/ directory and .analysis.json from the capture probe.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

if (!process.argv[2]) throw new Error("Usage: node scripts/eval-provider-recording-playback.mjs /absolute/path/to/probe.json");
const probePath = resolve(process.argv[2]);
const sourceDir = dirname(probePath);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probe = JSON.parse(await readFile(probePath, "utf8"));
const analysis = JSON.parse(await readFile(probePath.replace(/\.json$/, ".analysis.json"), "utf8"));
const reportDir = join(sourceDir, `${probe.room}-browser`);
await mkdir(reportDir, { recursive: true });
const groups = { raw: [], current: [] };
const mediaFiles = new Map();
for (const egress of probe.egress) {
  const file = egress.file_results?.[0] ?? egress.file;
  if (!file) continue;
  const name = basename(file.filename);
  // Delayed explicit passthrough jobs are a separate experiment, not a second
  // participant recording to play on top of this same voice.
  const raw = Boolean(egress.track) || egress.egress?.preset === "PASSTHROUGH";
  if (!raw && !name.endsWith("-current.mp4")) continue;
  if (name.includes("-delayed-")) continue;
  const evidence = analysis.items.find(item => item.file === name);
  const start = Number(file.started_at) / 1e6;
  const localPath = join(sourceDir, "media", probe.room, name);
  // The owned recorder finalizes from native packet bounds. Provider duration and
  // WebM's initial format.duration can both truncate media that is actually present.
  const packets = raw ? JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "packet=pts_time,duration_time", "-of", "json", localPath], { maxBuffer: 16 * 1024 * 1024 })).packets : [];
  const nativeEnd = packets.length ? Math.max(...packets.map(packet => Number(packet.pts_time) + Number(packet.duration_time || 0))) : evidence.container_duration_s;
  const duration = Math.round(nativeEnd * 1000);
  const role = name.startsWith("synthetic-user-") ? "user" : "avatar";
  const audio = name.endsWith(".ogg");
  const mediaType = audio ? "audio/ogg" : name.endsWith(".webm") ? "video/webm" : "video/mp4";
  const sidecarPath = join(sourceDir, "media", probe.room, `${egress.egress_id}.json`);
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8").catch(() => "{}"));
  const mutedIntervals = [];
  let mutedAt = null;
  if (raw && !audio) for (const event of sidecar.raw_timeline?.events ?? []) {
    const at = Math.min(duration, Math.max(0, Number(event.observed_at_ns) / 1e6 - start));
    if (event.muted && mutedAt === null) mutedAt = at;
    if (!event.muted && mutedAt !== null) {
      if (at > mutedAt) mutedIntervals.push({ startMs: Math.round(mutedAt), endMs: Math.round(at) });
      mutedAt = null;
    }
  }
  if (mutedAt !== null && duration > mutedAt) mutedIntervals.push({ startMs: Math.round(mutedAt), endMs: Math.round(duration) });
  const asset = { recording: {
    sessionId: probe.room, recordingId: egress.egress_id, mode: raw ? audio ? "audio" : "video" : "audio_video",
    status: "ready", createdAt: new Date(start).toISOString(), retainedUntil: new Date(start + 86400000).toISOString(),
    mediaStartedAt: new Date(start).toISOString(), mediaEndedAt: new Date(start + duration).toISOString(),
    mediaStartOffsetMs: Math.round(Math.min(...evidence.streams.map(stream => Number(stream.start) || 0)) * 1000),
    ...(mutedIntervals.length ? { mediaMutedIntervalsMs: mutedIntervals } : {}),
    durationMs: Math.round(duration), sizeBytes: Number(file.size || 1), mediaType, participant: { role, participantIdentity: `synthetic-${role}` },
  }, url: `../media/${probe.room}/${name}` };
  groups[raw ? "raw" : "current"].push(asset);
  mediaFiles.set(`/media/${probe.room}/${name}`, { bytes: await readFile(localPath), type: mediaType });
}
const offsets = Object.fromEntries(Object.entries(groups).map(([key, assets]) => [key,
  Math.min(...assets.map(asset => Date.parse(asset.recording.mediaStartedAt))) - probe.media_started_at * 1000,
]));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {RecordingPlayer} from './libs/client/src/react/recording-player.tsx';
const groups = ${JSON.stringify(groups)};
window.captureGroups = groups;
window.captureOffsets = ${JSON.stringify(offsets)};
createRoot(document.getElementById('app')).render(<>
  <h1>Offline LiveKit recording comparison</h1>
  <p>Synthetic media only. Both panels use the candidate admin RecordingPlayer and the provider's file timestamps.</p>
  <p id="sample-time"/>
  {Object.entries(groups).map(([name, assets]) => <section id={name} key={name}>
    <h2>{name === 'raw' ? 'Raw track capture' : 'Current participant capture'}</h2>
    <p data-evidence/>
    <RecordingPlayer assets={assets}/>
  </section>)}
</>);
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
const javascript = bundle.outputFiles[0].contents;
const html = '<!doctype html><meta charset="utf-8"><title>Offline recording comparison</title><style>body{font:16px system-ui;max-width:1100px;margin:24px auto}section{border:1px solid #999;padding:12px;margin:16px 0}h2{margin:4px 0 12px}video{max-height:220px!important}</style><div id="app"></div><script src="app.js"></script>';
await writeFile(join(reportDir, "index.html"), html);
await writeFile(join(reportDir, "app.js"), javascript);
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path.endsWith("/index.html")) { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  if (path.endsWith("/app.js")) { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(javascript); return; }
  const file = mediaFiles.get(path);
  if (!file) { response.writeHead(404); response.end(); return; }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = Math.min(range?.[2] ? Number(range[2]) : file.bytes.length - 1, file.bytes.length - 1);
  response.writeHead(range ? 206 : 200, { "Content-Type": file.type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.bytes.length}` } : {}),
  });
  response.end(file.bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(String(error)));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/${basename(reportDir)}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll("audio,video").length === 7 && [...document.querySelectorAll("audio,video")].every(element => element.readyState >= 2));
  const nativeLead = groups.raw.find(asset => asset.recording.mode === "video" && asset.recording.mediaStartOffsetMs > 100);
  if (nativeLead) {
    const sourcePosition = Date.parse(nativeLead.recording.mediaStartedAt) - probe.media_started_at * 1000 + nativeLead.recording.mediaStartOffsetMs / 2;
    await page.locator('#raw input[type="range"]').evaluate((slider, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(value));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }, sourcePosition - offsets.raw);
    const nativeFile = basename(nativeLead.url);
    await page.waitForFunction(name => {
      const video = [...document.querySelectorAll("#raw video")].find(element => new URL(element.src).pathname.endsWith(name));
      return video?.hidden && video?.closest("figure")?.hidden;
    }, nativeFile);
  }
  const samples = [];
  for (const seconds of [5, 9, 12, 16, 18, 19.9, 21.5, 26, 33.8]) {
    await page.evaluate(seconds => {
      for (const [group, offset] of Object.entries(window.captureOffsets)) {
        const slider = document.querySelector(`#${group} input[type="range"]`);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(seconds * 1000 - offset));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, seconds);
    await page.waitForFunction(() => [...document.querySelectorAll("audio,video")].every(element => !element.seeking && element.readyState >= 2));
    const panels = await page.evaluate(() => Object.fromEntries(["raw", "current"].map(group => [group,
      [...document.querySelectorAll(`#${group} video`)].map(video => {
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext("2d"); context.drawImage(video, 0, 0, 320, 180);
        let tick = 0;
        for (let bit = 0; bit < 10; bit++) if (context.getImageData(16 + bit * 32, 30, 1, 1).data[0] > 128) tick += 2 ** bit;
        return { file: new URL(video.src).pathname.split("/").at(-1), mediaTime: video.currentTime, visible: !video.hidden && !video.closest("figure").hidden, decodedSourceTime: tick / 10 };
      }),
    ])));
    samples.push({ sourceTime: seconds, panels });
    await page.evaluate(({ seconds, panels }) => {
      document.querySelector("#sample-time").textContent = `Requested source time: ${seconds.toFixed(1)} seconds`;
      for (const [group, videos] of Object.entries(panels)) {
        document.querySelector(`#${group} [data-evidence]`).textContent = videos.filter(video => video.visible).map(video =>
          `${video.file.startsWith("synthetic-user") ? "User" : "Character"} displayed frame: ${video.decodedSourceTime.toFixed(1)}s`,
        ).join(" · ");
      }
    }, { seconds, panels });
    if (seconds === 12 || seconds === 21.5) await page.screenshot({ path: join(reportDir, `comparison-${seconds}s.png`), fullPage: true });
  }
  const nativeTail = samples.at(-1).panels.raw.filter(video => video.visible);
  assert.ok(nativeTail.every(video => video.decodedSourceTime >= 33.5), "a seek into the native WebM tail must reach the actual recorded final frames");
  if (groups.raw.some(asset => asset.recording.mediaMutedIntervalsMs?.length)) {
    assert.equal(samples.find(sample => sample.sourceTime === 9).panels.raw.filter(video => video.visible && video.file.startsWith("synthetic-user-")).length, 0);
    const recovered = samples.find(sample => sample.sourceTime === 12).panels.raw.find(video => video.visible && video.file.startsWith("synthetic-user-"));
    assert.ok(Math.abs(recovered.decodedSourceTime - 12) <= 0.2, "the camera resumes on its native clock after unmute");
    assert.ok(samples.find(sample => sample.sourceTime === 19.9).panels.raw.some(video => video.visible && video.file.startsWith("synthetic-user-")), "provider metadata must retain the camera tail until actual unpublication");
  }
  assert.equal(samples.find(sample => sample.sourceTime === 21.5).panels.raw.filter(video => video.visible && video.file.startsWith("synthetic-user-")).length, 0);
  const voices = [];
  for (const group of ["raw", "current"]) {
    await page.locator(`#${group} input[type="range"]`).evaluate((slider, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(value));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }, 5000 - offsets[group]);
    await page.waitForFunction(group => [...document.querySelectorAll(`#${group} audio,#${group} video`)].every(element => !element.seeking), group);
    await page.evaluate(async group => {
      const context = new AudioContext();
      window.activeAnalyzers = [...document.querySelectorAll(`#${group} audio,#${group} video`)].filter(element => !element.muted).map(element => {
        const analyser = context.createAnalyser();
        context.createMediaElementSource(element).connect(analyser).connect(context.destination);
        return { analyser, file: new URL(element.src).pathname.split("/").at(-1) };
      });
      window.voiceAnalyzersByGroup ??= {};
      window.voiceAnalyzersByGroup[group] = window.activeAnalyzers;
      await context.resume();
    }, group);
    await page.locator(`#${group}`).getByRole("button", { name: "Play", exact: true }).click();
    const audible = await page.evaluate(async () => {
      const maxima = window.activeAnalyzers.map(({ file }) => ({ file, maxRms: 0 }));
      const until = performance.now() + 1500;
      while (performance.now() < until) {
        window.activeAnalyzers.forEach(({ analyser }, index) => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          maxima[index].maxRms = Math.max(maxima[index].maxRms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
        });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return maxima;
    });
    assert.equal(audible.length, 2, `${group} must play exactly one voice for each participant`);
    assert.ok(audible.every(voice => voice.maxRms > 0.01), `${group} must decode both voices audibly`);
    voices.push({ group, audible });
    await page.locator(`#${group}`).getByRole("button", { name: "Pause", exact: true }).click();
  }
  await page.locator('#raw input[type="range"]').evaluate((slider, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(value));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }, 14400 - offsets.raw);
  await page.waitForFunction(() => [...document.querySelectorAll("#raw audio,#raw video")].every(element => !element.seeking));
  await page.locator("#raw").getByRole("button", { name: "Play", exact: true }).click();
  const microphoneMute = await page.evaluate(async () => {
    const sources = window.voiceAnalyzersByGroup.raw;
    const maxima = sources.map(({ file }) => ({ file, maxRms: 0 }));
    const until = performance.now() + 1000;
    while (performance.now() < until) {
      sources.forEach(({ analyser }, index) => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        maxima[index].maxRms = Math.max(maxima[index].maxRms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
      });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return maxima;
  });
  assert.ok(microphoneMute.find(voice => voice.file.startsWith("synthetic-user-")).maxRms < 0.01, "the user's recorded microphone mute stays silent");
  assert.ok(microphoneMute.find(voice => voice.file.startsWith("synthetic-avatar-")).maxRms > 0.01, "the avatar voice continues during the user's microphone mute");
  await page.locator("#raw").getByRole("button", { name: "Pause", exact: true }).click();
  // Seeking repeatedly through an MP4 camera gap skips its recorded blank frames.
  // Exercise ordinary playback of the legacy files as a regression guard.
  await page.locator('#current input[type="range"]').evaluate((slider, offset) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, String(7500 - offset));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  }, offsets.current);
  await page.waitForFunction(() => [...document.querySelectorAll("#current video")].every(element => !element.seeking));
  await page.locator("#current").getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.runningSeeks = 0;
    for (const element of document.querySelectorAll("#current video")) element.addEventListener("seeking", () => window.runningSeeks++);
  });
  await page.waitForTimeout(2600);
  const runningSeeks = await page.evaluate(() => window.runningSeeks);
  assert.equal(runningSeeks, 0, "native playback must cross MP4 camera gaps without correction seeks");
  await page.locator("#current").getByRole("button", { name: "Pause", exact: true }).click();
  assert.deepEqual(pageErrors, []);
  await writeFile(join(reportDir, "report.json"), JSON.stringify({ probePath, pageErrors, nativeTail, runningSeeks, voices, microphoneMute, samples }, null, 2));
  console.log(JSON.stringify({ reportDir, pageErrors, nativeTail, runningSeeks, voices, microphoneMute, samples }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
