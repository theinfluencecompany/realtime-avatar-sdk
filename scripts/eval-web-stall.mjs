// Browser reproduction for live/idle switching under interrupted frame delivery.
// Runs the actual AvatarVideoSurface with a local media source; no API key or GPU.
//
// Three delivery patterns, all replayed through the REAL component in Chromium:
//   harness  — the #62 pattern: 5 × (1250ms off, 180ms on). A hold ≥ 2s must never leave live.
//   prod     — the presented-frame gap train recorded on a prod rtx6000 call through a
//              900 kbit / 150 ms / 10 % loss link (2026-09-09, self-created character): a rough
//              opening (3.0 s and 6.0 s outages around simulcast layer switches) and then gaps of
//              650–1150 ms every couple of seconds. The shipped 800 ms watchdog swapped bodies on
//              every one of them; the 2 s hold (escalating to 4 s) keeps the two opening outages
//              and holds through the rest.
//   flap     — three 2.6 s outages inside 12 s: the third lands after the link has proven
//              unstable and must be HELD by the escalated 4 s threshold.
// Every pattern also asserts no idle seek, immediate hiding on disconnect, and the
// replacement-track / same-track mute hysteresis from #62.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv.includes("--baseline");
// 0.10.0 + the governor fix (#63) — everything on main before this change, so the comparison
// isolates the stall policy. Override with STALL_BASELINE_REF.
const baselineRef = process.env.STALL_BASELINE_REF || "9815239";
const reportDir = process.env.STALL_REPORT_DIR || await mkdtemp(join(tmpdir(), "rta-web-stall-"));
await mkdir(reportDir, { recursive: true });
const playwrightPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const chromiumPath = process.env.STALL_CHROMIUM_PATH || undefined;
// Optional real clip for BOTH layers (an avatar whose idle clip is also its source clip): the
// live canvas then paints frames of the same clip from an unrelated cursor, so a swap is the
// same motion jumping phase — the "it keeps replaying" reading. Default: synthetic test pattern.
const idleClipPath = process.env.STALL_IDLE_CLIP || null;
const { chromium } = await import(playwrightPath.startsWith("/") ? pathToFileURL(playwrightPath).href : playwrightPath);
const surfacePath = join(root, "libs/client/src/react/avatar-video-surface.ts");
const recoveryPath = join(root, "libs/client/src/react/frame-recovery.ts");

const framework = `
import React, {createContext, useContext, useEffect, useRef} from 'react';
export const MediaContext = createContext({});
export function useVoiceAssistant() { return useContext(MediaContext); }
export function useConnectionState() { return useContext(MediaContext).connection; }
export function VideoTrack({trackRef, ...props}) {
  const ref = useRef(null);
  useEffect(() => {ref.current.srcObject = trackRef.stream; void ref.current.play();}, [trackRef]);
  return React.createElement('video', {...props, ref});
}`;

const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AvatarVideoSurface} from ${JSON.stringify(surfacePath)};
import {MediaContext} from '@livekit/components-react';

const canvas = document.createElement('canvas');
canvas.width = 240; canvas.height = 320;
const ctx = canvas.getContext('2d');
// Optional: the live layer paints the SAME clip as the idle layer, from its own cursor.
const liveSource = ${JSON.stringify(Boolean(idleClipPath))} ? Object.assign(document.createElement('video'), {src:'/idle.mp4', muted:true, loop:true, playsInline:true}) : null;
if (liveSource) { liveSource.currentTime = 2.3; void liveSource.play(); }
let mediaTrack;
function makeTrack() {
const stream = canvas.captureStream(0);
mediaTrack = stream.getVideoTracks()[0];
const handlers = new Map();
const remote = {
  mediaStreamTrack: mediaTrack,
  on(name, fn) {if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn);},
  off(name, fn) {handlers.get(name)?.delete(fn);},
};
return {stream, publication:{track:remote, dimensions:{width:240,height:320},
  on:remote.on,off:remote.off}};
}
const initialTrack = makeTrack();
let setConnection, setTrack;
function App() {
  const [connection, update] = useState('connected'); setConnection = update;
  const [videoTrack, updateTrack] = useState(initialTrack); setTrack = updateTrack;
  return <MediaContext.Provider value={{connection, videoTrack}}>
    <AvatarVideoSurface idleVideoUrl='/idle.mp4' fit='cover' adaptiveQuality={false} showLiveBadge={false}/>
  </MediaContext.Provider>;
}
createRoot(document.getElementById('app')).render(<App/>);
const started = performance.now();
let frame = 0, flowing = true;
window.flow = (value) => {flowing = value;};
window.disconnect = () => setConnection('disconnected');
window.connect = () => setConnection('connected');
window.replaceTrack = () => {mediaTrack.stop();setTrack(makeTrack());};
window.mute = (muted) => {
  mediaTrack.enabled = !muted;
  mediaTrack.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
};
window.samples = [];
window.events = [];
window.endedIdle = false;
setInterval(() => {
  if (!flowing) return;
  frame++;
  if (liveSource && liveSource.readyState >= 2) {
    ctx.drawImage(liveSource, 0, 0, 240, 320);
  } else {
    ctx.fillStyle = '#162339';ctx.fillRect(0,0,240,320);
    ctx.fillStyle = '#72e3be';ctx.beginPath();ctx.arc(120 + Math.sin(frame/30)*30,110,55,0,Math.PI*2);ctx.fill();
    ctx.fillRect(75,170,90,105);
  }
  ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(0,288,240,32);
  ctx.fillStyle='white';ctx.font='18px monospace';
  ctx.fillText('LIVE '+frame,12,310);mediaTrack.requestFrame();
},40);
let observedIdle, observedLive, presented = 0;
setInterval(() => {
  const idle = document.querySelector('[data-testid="avatar-idle-video"]');
  const layer = document.querySelector('[data-testid="avatar-live-layer"]');
  const live = layer?.querySelector('video');
  if (idle && idle !== observedIdle) {
    observedIdle = idle;
    // A native loop wrap also fires seeking (from ~duration back to 0). Record where the
    // playhead WAS so the report can tell a wrap from a reset to the opening.
    let lastIdleTime = 0;
    idle.addEventListener('timeupdate', () => {lastIdleTime = idle.currentTime;});
    idle.addEventListener('seeking', () => window.events.push({at:performance.now()-started,type:'idle-seek',time:idle.currentTime,from:lastIdleTime,duration:idle.duration,
      wrap: Number.isFinite(idle.duration) && lastIdleTime >= idle.duration - 0.4}));
    idle.addEventListener('ended', () => {window.endedIdle=true;});
  }
  if (live && live !== observedLive) {
    observedLive = live;
    const tick = () => {presented++;live.requestVideoFrameCallback(tick);};
    live.requestVideoFrameCallback(tick);
  }
  window.samples.push({at:performance.now()-started,live:layer?.style.opacity==='1',
    idleTime:idle?.currentTime ?? null,liveTime:live?.currentTime ?? null,
    presented,decoded:live?.getVideoPlaybackQuality().totalVideoFrames ?? 0,sent:frame});
},50);
`;

const gitShow = (path) => execFileSync("git", ["show", `${baselineRef}:${path}`], { cwd: root, encoding: "utf8" });
const bundled = await build({
  stdin: {contents:entry, resolveDir:root, loader:"tsx"}, bundle:true, write:false,
  format:"iife", platform:"browser", define:{"process.env.NODE_ENV":'"production"'},
  plugins:[{name:"media-fixture",setup(b) {
    b.onResolve({filter:/^@livekit\/components-react$/}, () => ({path:"framework",namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"}, () => ({contents:framework,loader:"jsx",resolveDir:root}));
    b.onResolve({filter:/^\.\/(livekit|use-adaptive-playout|use-quality-governor)$/}, args =>
      args.importer===surfacePath ? {path:"transport-hooks",namespace:"hooks"} : null);
    b.onLoad({filter:/.*/,namespace:"hooks"}, () => ({contents:
      "export function useAvatarPlayoutDelay(){};export function useAvatarAdaptivePlayoutDelay(){return .5};export function useAvatarQualityGovernor(){}"}));
    if (baseline) {
      b.onLoad({filter:/avatar-video-surface\.ts$/}, args => ({
        contents:gitShow("libs/client/src/react/avatar-video-surface.ts"), loader:"ts", resolveDir:dirname(args.path),
      }));
      b.onLoad({filter:/frame-recovery\.ts$/}, args => ({
        contents:gitShow("libs/client/src/react/frame-recovery.ts"), loader:"ts", resolveDir:dirname(args.path),
      }));
    }
  }}],
});
const idlePath = join(reportDir,"idle.mp4");
if (idleClipPath) {
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-i",idleClipPath,"-an","-vf","scale=240:320:force_original_aspect_ratio=increase,crop=240:320",
    "-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-movflags","+faststart",idlePath]);
} else {
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",
    "testsrc2=size=240x320:rate=25:duration=20","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",idlePath]);
}
const idle = await readFile(idlePath);
const server=createServer((req,res) => {
  if (req.url==="/app.js") {res.setHeader("content-type","text/javascript");res.end(bundled.outputFiles[0].contents);return;}
  if (req.url==="/idle.mp4") {res.setHeader("content-type","video/mp4");res.end(idle);return;}
  res.setHeader("content-type","text/html");res.end('<style>body{margin:0;background:#111}#app{width:240px;height:320px}#app>div{position:relative;width:100%;height:100%}video,[data-testid="avatar-live-layer"]{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}[data-testid="avatar-live-layer"]{z-index:2}</style><div id="app"></div><script src="/app.js"></script>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));

// Delivery patterns as [offMs, onMs] pairs after an initial run of live frames.
const PATTERNS = {
  harness: { lead: 700, pairs: Array.from({length:5}, () => [1250, 180]), tail: 1200 },
  // Presented-frame gaps measured on prod (see header); the "on" runs are the measured spans between them.
  prod: { lead: 1000, pairs: [[2986, 600], [5992, 5000], [1150, 450], [800, 900], [935, 1050], [1150, 1900], [650, 1550], [900, 2900], [656, 400], [900, 350], [800, 250], [850, 900]], tail: 1500 },
  flap: { lead: 1000, pairs: [[2600, 3000], [2600, 3000], [2600, 3000]], tail: 1500 },
};
const arm = baseline ? "baseline" : "working-tree";
const results = {};
let browser;
try {
  browser=await chromium.launch({headless:true,args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"], ...(chromiumPath ? {executablePath: chromiumPath} : {})});
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    const page=await browser.newPage({viewport:{width:360,height:400},recordVideo:{dir:join(reportDir, name),size:{width:360,height:400}}});
    const pageErrors = [];
    page.on("pageerror",e=>{pageErrors.push(e.message);console.error(e.message);});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>document.querySelector('[data-testid="avatar-live-layer"]')?.style.opacity==='1');
    await page.waitForTimeout(pattern.lead);
    for (const [off, on] of pattern.pairs) {
      await page.evaluate(()=>window.flow(false));await page.waitForTimeout(off);
      await page.evaluate(()=>window.flow(true));await page.waitForTimeout(on);
    }
    await page.waitForTimeout(pattern.tail);
    const beforeDisconnect=await page.evaluate(()=>({samples:window.samples,events:window.events}));
    await page.evaluate(()=>window.disconnect());await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden'),'true',`${name}: disconnect must hide live`);
    await page.screenshot({path:join(reportDir,`${name}-final.png`)});
    // On a fast runner the first live frame can precede the first 50ms sample.
    // Count that initial promotion from the surface's initial hidden state too.
    const transitions=beforeDisconnect.samples.filter((v,i,a)=>v.live!==(i ? a[i-1].live : false));
    const summary={arm,pattern:name,liveToIdle:transitions.filter(v=>!v.live).length,
      idleToLive:transitions.filter(v=>v.live).length,
      // Resets to the opening only — a native loop wrap is the clip's own business.
      idleSeeks:beforeDisconnect.events.filter(e=>!e.wrap).length,idleWraps:beforeDisconnect.events.filter(e=>e.wrap).length,
      firstLiveAtMs:beforeDisconnect.samples.find(v=>v.live)?.at,
      idleVisibleMs: beforeDisconnect.samples.filter(v=>!v.live).length*50,
      presented:beforeDisconnect.samples.at(-1)?.presented,endsLive:beforeDisconnect.samples.at(-1)?.live};
    await writeFile(join(reportDir,`${name}-report.json`),JSON.stringify({summary,...beforeDisconnect},null,2));
    console.log(JSON.stringify(summary));
    results[name] = summary;
    assert.deepEqual(pageErrors,[],'the actual component must run without browser errors');
    if (!baseline) {
      assert.equal(summary.idleSeeks,0,`${name}: temporary stalls must not replay the idle opening`);
      assert.equal(summary.endsLive,true,`${name}: sustained flow must recover`);
    }
    if (!baseline && name === "harness") {
      // Every interruption is shorter than the 2 s hold: the live frame is held, nothing swaps.
      assert.equal(summary.liveToIdle,0,'sub-threshold interruptions must hold the live frame');
      assert.equal(summary.idleToLive,1,'only the initial promotion');
      // A replacement track starts its own presentation clock. Its first frame
      // must not be held by the retired track's stall or larger media timestamp.
      await page.evaluate(()=>{window.replaceTrack();window.connect();});
      await page.waitForFunction(()=>document.querySelector('[data-testid="avatar-live-layer"]')?.style.opacity==='1');
      await page.waitForTimeout(250);
      // The same track can mute/unmute during a network gap. Rebinding its frame
      // observer must not grant each brief burst the new-track fast path. The gap
      // exceeds the 2 s hold, so the layer must be down when the burst starts.
      for (let i=0;i<2;i++) {
        const mark = await page.evaluate(()=>window.samples.length);
        await page.evaluate(()=>{window.flow(false);window.mute(true);});
        await page.waitForTimeout(2600);
        await page.evaluate(()=>{window.mute(false);window.flow(true);});
        await page.waitForTimeout(180);
        const hidden = await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden');
        if (hidden !== 'true') {
          const debug = await page.evaluate((m)=>window.samples.slice(m), mark);
          await writeFile(join(reportDir,`${name}-mute-cycle-${i}-debug.json`),JSON.stringify(debug,null,1));
        }
        assert.equal(hidden,'true','same-track mute/unmute must preserve recovery hysteresis');
      }
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden'),'false',
        'sustained frames after unmute must recover');
    }
    if (!baseline && name === "prod") {
      // The two multi-second opening outages are genuine; everything after them is held.
      assert.equal(summary.liveToIdle,2,'prod gap train: only the two multi-second outages swap');
    }
    if (!baseline && name === "flap") {
      // Two outages past the 2 s hold prove the link unstable; the third is held by the 4 s threshold.
      assert.equal(summary.liveToIdle,2,'the escalated hold must absorb the third outage');
    }
    await page.close();
  }
  await writeFile(join(reportDir,'report.json'),JSON.stringify({arm, baselineRef: baseline ? baselineRef : null, idleClip: idleClipPath, results},null,2));
  console.log(`report: ${reportDir}`);
} finally {
  await browser?.close();server.close();
}
