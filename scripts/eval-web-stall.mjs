// Browser reproduction for live/idle switching under interrupted frame delivery.
// Runs the actual AvatarVideoSurface with a local media source; no API key or GPU.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv.includes("--baseline");
// Published 0.9.0; a fixed revision keeps the comparison useful after this merges.
const baselineRef = process.env.STALL_BASELINE_REF || "7bd53b818e81320f875b9303b6df8152825e41e2";
const reportDir = process.env.STALL_REPORT_DIR || await mkdtemp(join(tmpdir(), "rta-web-stall-"));
const playwrightPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightPath.startsWith("/") ? pathToFileURL(playwrightPath).href : playwrightPath);
const surfacePath = join(root, "libs/client/src/react/avatar-video-surface.ts");

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
  ctx.fillStyle = '#162339';ctx.fillRect(0,0,240,320);
  ctx.fillStyle = '#72e3be';ctx.beginPath();ctx.arc(120 + Math.sin(frame/30)*30,110,55,0,Math.PI*2);ctx.fill();
  ctx.fillRect(75,170,90,105);ctx.fillStyle='white';ctx.font='18px monospace';
  ctx.fillText('LIVE '+frame,12,305);mediaTrack.requestFrame();
},40);
let observedIdle, observedLive, presented = 0;
setInterval(() => {
  const idle = document.querySelector('[data-testid="avatar-idle-video"]');
  const layer = document.querySelector('[data-testid="avatar-live-layer"]');
  const live = layer?.querySelector('video');
  if (idle && idle !== observedIdle) {
    observedIdle = idle;
    idle.addEventListener('seeking', () => window.events.push({at:performance.now()-started,type:'idle-seek',time:idle.currentTime}));
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
    if (baseline) b.onLoad({filter:/avatar-video-surface\.ts$/}, args => ({
      contents:execFileSync("git",["show",baselineRef+":libs/client/src/react/avatar-video-surface.ts"],{cwd:root,encoding:"utf8"}),
      loader:"ts",resolveDir:dirname(args.path),
    }));
  }}],
});
const idlePath = join(reportDir,"idle.mp4");
execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",
  "testsrc2=size=240x320:rate=25:duration=20","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",idlePath]);
const idle = await readFile(idlePath);
const server=createServer((req,res) => {
  if (req.url==="/app.js") {res.setHeader("content-type","text/javascript");res.end(bundled.outputFiles[0].contents);return;}
  if (req.url==="/idle.mp4") {res.setHeader("content-type","video/mp4");res.end(idle);return;}
  res.setHeader("content-type","text/html");res.end('<style>body{margin:0;background:#111}#app{width:240px;height:320px}#app>div{position:relative;width:100%;height:100%}video,[data-testid="avatar-live-layer"]{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}[data-testid="avatar-live-layer"]{z-index:2}</style><div id="app"></div><script src="/app.js"></script>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
let browser;
try {
  browser=await chromium.launch({headless:true,args:["--no-sandbox","--autoplay-policy=no-user-gesture-required"]});
  const page=await browser.newPage({viewport:{width:360,height:400},recordVideo:{dir:reportDir,size:{width:360,height:400}}});
  const pageErrors = [];
  page.on("pageerror",e=>{pageErrors.push(e.message);console.error(e.message);});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>document.querySelector('[data-testid="avatar-live-layer"]')?.style.opacity==='1');
  await page.waitForTimeout(700);
  // Sparse recovery bursts repeatedly cross the shipped 800ms watchdog.
  for (let i=0;i<5;i++) {
    await page.evaluate(()=>window.flow(false));await page.waitForTimeout(1250);
    await page.evaluate(()=>window.flow(true));await page.waitForTimeout(180);
  }
  await page.waitForTimeout(1200);
  const beforeDisconnect=await page.evaluate(()=>({samples:window.samples,events:window.events}));
  await page.evaluate(()=>window.disconnect());await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden'),'true','disconnect must hide live');
  await page.screenshot({path:join(reportDir,'final.png')});
  // On a fast runner the first live frame can precede the first 50ms sample.
  // Count that initial promotion from the surface's initial hidden state too.
  const transitions=beforeDisconnect.samples.filter((v,i,a)=>v.live!==(i ? a[i-1].live : false));
  const summary={arm:baseline?'baseline':'working-tree',liveToIdle:transitions.filter(v=>!v.live).length,
    idleToLive:transitions.filter(v=>v.live).length,idleSeeks:beforeDisconnect.events.length,
    firstLiveAtMs:beforeDisconnect.samples.find(v=>v.live)?.at,
    presented:beforeDisconnect.samples.at(-1)?.presented,reportDir};
  await writeFile(join(reportDir,'report.json'),JSON.stringify({summary,...beforeDisconnect},null,2));
  console.log(JSON.stringify(summary));
  if (!baseline) {
    assert.equal(summary.liveToIdle,1,'sparse recovery bursts must stay on idle');
    assert.equal(summary.idleToLive,2,'show the first frame, then recover only after stable flow');
    assert.equal(summary.idleSeeks,0,'temporary stalls must not replay the idle opening');
    assert.equal(beforeDisconnect.samples.at(-1).live,true,'sustained flow must recover');

    // A replacement track starts its own presentation clock. Its first frame
    // must not be held by the retired track's stall or larger media timestamp.
    await page.evaluate(()=>{window.replaceTrack();window.connect();});
    await page.waitForFunction(()=>document.querySelector('[data-testid="avatar-live-layer"]')?.style.opacity==='1');
    await page.waitForTimeout(250);
    // The same track can mute/unmute during a network gap. Rebinding its frame
    // observer must not grant each brief burst the new-track fast path.
    for (let i=0;i<2;i++) {
      await page.evaluate(()=>{window.flow(false);window.mute(true);});
      await page.waitForTimeout(1300);
      await page.evaluate(()=>{window.mute(false);window.flow(true);});
      await page.waitForTimeout(180);
      assert.equal(await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden'),'true',
        'same-track mute/unmute must preserve recovery hysteresis');
    }
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('[data-testid="avatar-live-layer"]').getAttribute('aria-hidden'),'false',
      'sustained frames after unmute must recover');
  }
  assert.deepEqual(pageErrors,[],'the actual component must run without browser errors');
  await page.close();
} finally {
  await browser?.close();server.close();
}
