// Offline media compatibility gate for the RecordingPlayer used by admin consoles.
// Requires ffmpeg and Playwright Chromium. Captures synthetic audio/video only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = await mkdtemp(join(tmpdir(), "recording-playback-"));
const ffmpeg = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
for (const [name, frequency, duration] of [["user", 440, 12], ["avatar", 660, 11.75]]) {
  ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`, "-c:a", "libopus", join(reportDir, `${name}.ogg`)]);
}
for (const [name, duration, codec, extension] of [
  ["user-before", 3, "libx264", "mp4"],
  ["user-after", 6, "libvpx", "webm"],
  ["avatar", 11.5, "libvpx", "webm"],
]) {
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=160x120:rate=10:duration=${duration}`, "-an", "-c:v", codec, "-g", "10", join(reportDir, `${name}.${extension}`)]);
}
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
  "-c:v", "libx264", "-g", "10", "-c:a", "aac", "-shortest", join(reportDir, "user-legacy.mp4")]);
// The production avatar track pair: a separate AAC voice and a 1 Mbps H.264 face with sparse keyframes.
ffmpeg(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=20", "-c:a", "aac", "-b:a", "64k", join(reportDir, "stall-voice.m4a")]);
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-b:v", "1M", "-maxrate", "1M", "-bufsize", "1M", "-g", "250", join(reportDir, "stall-face.mp4")]);
// Bytes per second for /slow/ files: a little above the face's bitrate, so a stall starves it within seconds.
const SLOW_BYTES_PER_SECOND = 160_000;
let blackoutUntil = 0;
const entries = [
  ["user-audio", "user", "audio", 0, 12000, "user.ogg", "audio/ogg"],
  ["avatar-audio", "avatar", "audio", 250, 11750, "avatar.ogg", "audio/ogg"],
  ["user-before", "user", "video", 0, 3000, "user-before.mp4", "video/mp4"],
  ["user-after", "user", "video", 6000, 6000, "user-after.webm", "video/webm"],
  ["avatar-video", "avatar", "video", 500, 11500, "avatar.webm", "video/webm"],
];
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RecordingPlayer} from './libs/client/src/react/recording-player.tsx';
import {recordingArtifactSchema} from './libs/http-client/src/generated/recording.ts';
const origin = Date.parse('2026-10-13T00:00:00.000Z');
const entries = ${JSON.stringify(entries)};
const stallEntries = [
  ['stall-voice', 'avatar', 'audio', 0, 20000, 'stall-voice.m4a', 'audio/mp4'],
  ['stall-face', 'avatar', 'video', 0, 20000, 'slow/stall-face.mp4', 'video/mp4'],
];
function App() {
  const [revision, setRevision] = useState(0);
  const [, setMetadataRevision] = useState(0);
  const [legacy, setLegacy] = useState(false);
  const [stall, setStall] = useState(false);
  window.refreshAccess = () => setRevision(value => value + 1);
  window.refreshMetadata = () => setMetadataRevision(value => value + 1);
  window.showLegacy = () => setLegacy(true);
  window.showStall = () => setStall(true);
  const selected = stall ? stallEntries : legacy ? [...entries.filter(entry => entry[1] === 'avatar'), ['user-legacy', 'user', 'audio_video', 0, 12000, 'user-legacy.mp4', 'video/mp4']] : entries;
  const assets = selected.map(([id, role, mode, start, duration, filename, mediaType]) => ({
    recording: recordingArtifactSchema.parse({
      sessionId:stall ? 'stall-call' : legacy ? 'legacy-call' : 'offline-call', recordingId:id, mode, status:'ready',
      createdAt:new Date(origin).toISOString(), retainedUntil:new Date(origin + 86400000).toISOString(),
      mediaStartedAt:new Date(origin + start).toISOString(), mediaEndedAt:new Date(origin + start + duration).toISOString(),
      ...(id === 'user-before' ? {mediaMutedIntervalsMs:[{startMs:2200,endMs:2700}]} : {}),
      ...(id === 'user-legacy' ? {mediaMutedIntervalsMs:[{startMs:2000,endMs:5000}]} : {}),
      durationMs:duration, mediaType, sizeBytes:1000, participant:{role,participantIdentity:role},
    }), url: '/' + filename + '?access=' + revision,
  }));
  return <RecordingPlayer assets={assets}/>;
}
createRoot(document.getElementById('app')).render(<App/>);
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic" });
const javascript = bundle.outputFiles[0].contents;
const media = new Map(await Promise.all(entries.map(async ([, , , , , filename, type]) => [filename, { bytes: await readFile(join(reportDir, filename)), type }])));
media.set("user-legacy.mp4", { bytes: await readFile(join(reportDir, "user-legacy.mp4")), type: "video/mp4" });
media.set("stall-voice.m4a", { bytes: await readFile(join(reportDir, "stall-voice.m4a")), type: "audio/mp4" });
media.set("stall-face.mp4", { bytes: await readFile(join(reportDir, "stall-face.mp4")), type: "video/mp4" });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname.slice(1);
  if (!path) { response.writeHead(200, { "Content-Type": "text/html" }); response.end('<div id="app"></div><script src="/app.js"></script>'); return; }
  if (path === "app.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(javascript); return; }
  const slow = path.startsWith("slow/");
  const file = media.get(slow ? path.slice("slow/".length) : path);
  if (!file) { response.writeHead(404); response.end(); return; }
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = Math.min(range?.[2] ? Number(range[2]) : file.bytes.length - 1, file.bytes.length - 1);
  response.writeHead(range ? 206 : 200, { "Content-Type": file.type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${file.bytes.length}` } : {}),
  });
  if (!slow) { response.end(file.bytes.subarray(start, end + 1)); return; }
  // A throttled network that can black out: delivery stops entirely while blackoutUntil is ahead.
  let closed = false;
  response.on("close", () => { closed = true; });
  for (let offset = start; offset <= end && !closed;) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (Date.now() < blackoutUntil) continue;
    const next = Math.min(offset + SLOW_BYTES_PER_SECOND / 20, end + 1);
    if (!response.write(file.bytes.subarray(offset, next))) await new Promise(resolve => response.once("drain", resolve));
    offset = next;
  }
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.RECORDING_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
const reports = [];
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelectorAll("audio,video").length === 5 && [...document.querySelectorAll("audio,video")].every(element => element.readyState >= 2));
  // Decode each separate voice through Web Audio so readiness alone cannot hide silence.
  await page.evaluate(async () => {
    const context = new AudioContext();
    window.voiceAnalyzers = [...document.querySelectorAll("audio")].map(element => {
      const analyser = context.createAnalyser();
      context.createMediaElementSource(element).connect(analyser).connect(context.destination);
      return analyser;
    });
    await context.resume();
  });
  const snapshot = () => page.evaluate(() => ({
    position: Number(document.querySelector('input[type="range"]').value),
    status: document.querySelector('[role="status"]').textContent,
    media: [...document.querySelectorAll("audio,video")].map(element => ({
      file: new URL(element.src).pathname, time: element.currentTime, paused: element.paused, muted: element.muted,
      visible: element.tagName === "VIDEO" && !element.hidden && !element.closest("figure").hidden,
    })),
    voices: window.voiceAnalyzers.map(analyser => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length);
    }),
  }));
  const seek = async (milliseconds) => {
    await page.locator('input[type="range"]').evaluate((element, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, milliseconds);
    await page.waitForFunction(value => Number(document.querySelector('input[type="range"]').value) === value, milliseconds);
  };
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 1500);
  const opening = await snapshot();
  assert.equal(opening.media.filter(item => !item.paused).length, 4);
  assert.equal(opening.media.filter(item => item.visible).length, 2);
  assert.ok(opening.voices.every(rms => rms > 0.01), "both voices decode audibly");
  assert.ok(opening.media.filter(item => item.file.endsWith(".mp4") || item.file.endsWith(".webm")).every(item => item.muted));
  reports.push({ scenario: "opening: both voices, offset videos, native codecs", ...opening });
  await page.evaluate(() => {
    window.metadataSeekEvents = 0;
    for (const element of document.querySelectorAll("audio,video")) element.addEventListener("seeking", () => window.metadataSeekEvents++);
    window.refreshMetadata();
  });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.metadataSeekEvents), 0, "metadata polling must not restart native playback with seek corrections");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await seek(2300);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 2400);
  const masked = await snapshot();
  assert.equal(masked.media.filter(item => item.visible).length, 1, "the raw camera is hidden for its native mute interval");
  assert.equal(masked.media.find(item => item.file === "/user-before.mp4").paused, false, "masking must not stop the native video clock");
  assert.ok(masked.voices.every(rms => rms > 0.01));
  reports.push({ scenario: "raw camera mute masks video while both voices and media clocks continue", ...masked });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await seek(4500);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 4800);
  const gap = await snapshot();
  assert.equal(gap.media.filter(item => item.visible).length, 1, "camera gap never freezes the previous user picture");
  assert.equal(gap.media.filter(item => !item.paused && item.file.endsWith(".ogg")).length, 2);
  assert.ok(gap.voices.every(rms => rms > 0.01));
  reports.push({ scenario: "camera gap: both voices continue", ...gap });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await seek(7500);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 7800);
  const resumed = await snapshot();
  assert.equal(resumed.media.filter(item => item.visible).length, 2);
  assert.equal(resumed.media.filter(item => !item.paused && item.file.endsWith(".ogg")).length, 2);
  const userTime = resumed.media.find(item => item.file === "/user.ogg").time;
  for (const [file, offset] of [["/avatar.ogg", 0.25], ["/avatar.webm", 0.5], ["/user-after.webm", 6]]) {
    assert.ok(Math.abs(userTime - resumed.media.find(item => item.file === file).time - offset) < 0.15, `seek alignment: ${file}`);
  }
  reports.push({ scenario: "seek after republish: preserved offsets", ...resumed });
  await page.evaluate(() => window.refreshAccess());
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 8500 && document.querySelector('[role="status"]').textContent === "");
  const refreshed = await snapshot();
  assert.ok(refreshed.voices.every(rms => rms > 0.01));
  reports.push({ scenario: "renewed signed URLs preserve playback", ...refreshed });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await seek(1000);
  const backwards = await snapshot();
  assert.equal(backwards.media.filter(item => item.visible).length, 2);
  assert.ok(backwards.media.every(item => item.paused));
  reports.push({ scenario: "backward seek returns to first camera segment", ...backwards });
  await page.evaluate(() => window.showLegacy());
  await page.waitForFunction(() => document.querySelectorAll("audio,video").length === 3 && [...document.querySelectorAll("audio,video")].every(element => element.readyState >= 2));
  await page.evaluate(async () => {
    const context = new AudioContext();
    const element = document.querySelector('video[src*="user-legacy"]');
    const analyser = context.createAnalyser();
    context.createMediaElementSource(element).connect(analyser).connect(context.destination);
    window.voiceAnalyzers = [analyser];
    await context.resume();
  });
  await seek(3000);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 3400);
  const legacyMasked = await snapshot();
  const combined = legacyMasked.media.find(item => item.file === "/user-legacy.mp4");
  assert.equal(combined.visible, false);
  assert.equal(combined.paused, false);
  assert.equal(combined.muted, false);
  assert.ok(legacyMasked.voices[0] > 0.01, "hiding the legacy camera preserves the voice carried by that same video element");
  reports.push({ scenario: "legacy combined camera mute preserves its own audible voice", ...legacyMasked });
  // A separate face whose download stalls mid-play: Chromium reports it at readyState 2, not below, so
  // the player must notice the face falling behind its voice and hold both until it can play again.
  await page.evaluate(() => window.showStall());
  await page.waitForFunction(() => document.querySelectorAll("audio,video").length === 2 && [...document.querySelectorAll("audio,video")].every(element => element.readyState >= 2));
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 2000);
  blackoutUntil = Date.now() + 6000;
  await page.waitForFunction(() => Number(document.querySelector('input[type="range"]').value) > 12000, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const starved = await snapshot();
  const voiceTime = starved.media.find(item => item.file === "/stall-voice.m4a").time;
  const faceTime = starved.media.find(item => item.file === "/slow/stall-face.mp4").time;
  assert.ok(starved.media.every(item => !item.paused), "both tracks play again after the stall");
  assert.ok(Math.abs(faceTime - voiceTime) < 0.15, `a starved face rejoins its voice (face ${faceTime.toFixed(3)} s, voice ${voiceTime.toFixed(3)} s)`);
  reports.push({ scenario: "a separate face that stalls mid-play rejoins its voice", ...starved });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(reportDir, "playback.png") });
  await writeFile(join(reportDir, "report.json"), JSON.stringify({ passed: true, reports }, null, 2));
  console.log(`PASS: raw audio/video playback, camera gaps, segment republish, seeks, voice decoding, URL renewal and a stalled face. Evidence: ${reportDir}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
