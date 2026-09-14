// Actual React hook, controlled LiveKit events/stats, and a virtual browser clock.
// No network calls or production credentials. Run after installing Playwright Chromium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const baseline = process.argv.includes("--baseline");
const packagePath = process.env.QUALITY_PACKAGE;
const reportDir = process.env.QUALITY_REPORT_DIR;
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ConnectionQuality, RoomEvent, Track} from 'livekit-client';
import {useAvatarQualityGovernor} from './libs/client/src/react/use-quality-governor';
import {DEFAULT_GOVERNOR_CONFIG} from './libs/client/src/react/quality-governor';
const listeners = new Map();
const room = {
  on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
  off(event, fn) { listeners.get(event)?.delete(fn); },
  emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args); },
};
let history = [], notices = [], frozen = 0, pending = null, release = null, statsReads = 0;
const participant = {sid:'avatar', connectionQuality:ConnectionQuality.Excellent};
function publication(id) {let frames=0, received=0, lost=0; return {
  id, trackInfo:{layers:[{quality:0},{quality:2}]},
  setVideoQuality(quality) {
    if (options.qualityThrows) throw new Error('detached publication');
    history.push({at:Date.now(),id,quality});
  },
  track:{streamState:Track.StreamState.Active, async getRTCStatsReport() {
    statsReads++;
    if (pending) {const p=pending;pending=null;await p;}
    if (options.statsThrows) throw new Error('stats unavailable');
    if (options.enabled === 'network-only') {
      frames+=options.weak ? 0 : 25; received+=options.weak ? 92 : 100; lost+=options.weak ? 8 : 0;
      return new Map([['video',{id,ssrc:1,type:'inbound-rtp',kind:'video',timestamp:performance.now(),
        framesDecoded:frames,packetsReceived:received,packetsLost:lost,jitter:0.01}]]);
    }
    return new Map([['video',{type:'inbound-rtp',totalFreezesDuration:frozen/1000}]]);
  }},
};}
let pub = publication('first'), options = {}, freeze = 0, inhibited = false;
window.binding = {room, videoTrack:{publication:pub,participant}};
let root = createRoot(document.getElementById('app'));
function App() {
  useAvatarQualityGovernor({enabled:options.enabled ?? true,
    onNetworkStatusChange:status=>notices.push({at:Date.now(),status}),
    config:{...DEFAULT_GOVERNOR_CONFIG,...options.config},
    freezeReading:() => ({freezeMsInWindow:freeze,inhibited})});
  return null;
}
window.render = (next={}) => {
  options = {...options,...next};
  if ('freeze' in next) freeze=next.freeze;
  if ('inhibited' in next) inhibited=next.inhibited;
  if ('frozen' in next) frozen=next.frozen;
  if (next.replace) pub=publication(next.replace);
  if (next.layers) pub.trackInfo={layers:next.layers.map(quality=>({quality}))};
  if (next.replaceTrack) pub.track=publication('replacement-track').track;
  // Recreate the wrapper and callbacks, as ordinary context/transcript renders do.
  window.binding.videoTrack=next.noTrack ? undefined : {publication:pub,participant};
  window.binding.room=next.noRoom ? undefined : room;
  flushSync(()=>root.render(<App/>));
};
window.pause = (other=false) => room.emit(RoomEvent.TrackStreamStateChanged,other ? publication('other') : pub,Track.StreamState.Paused);
window.holdStats = () => {pending=new Promise(r=>{release=r;});};
window.releaseStats = () => release?.();
window.result = () => ({history,notices,listeners:[...listeners.values()].reduce((n,s)=>n+s.size,0)});
window.statsReads = () => statsReads;
window.stop = () => flushSync(()=>root.unmount());
`;
const bundled = await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,
  alias:Object.fromEntries(["react","react-dom","livekit-client"].map(name=>[name,resolve(root,"node_modules",name)])),
  platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"development"'},plugins:[{
    name:"controlled-room",setup(b){
      b.onResolve({filter:/^@livekit\/components-react$/},()=>({path:"room",namespace:"controlled"}));
      b.onLoad({filter:/.*/,namespace:"controlled"},()=>({contents:
        "export const useMaybeRoomContext=()=>window.binding.room; export const useVoiceAssistant=()=>({videoTrack:window.binding.videoTrack}); export const useTranscriptions=()=>[],useLocalParticipant=()=>({}),RoomAudioRenderer=()=>null,LiveKitRoom=()=>null,useConnectionState=()=> 'connected',VideoTrack=()=>null,useRoomContext=useMaybeRoomContext,useChat=()=>({});"}));
      if (packagePath) {
        b.onResolve({filter:/^\.\/libs\/client\/src\/react\/use-quality-governor$/},()=>({path:"installed",namespace:"installed"}));
        b.onLoad({filter:/.*/,namespace:"installed"},()=>({contents:"export {useAvatarQualityGovernor} from "+JSON.stringify(resolve(packagePath,"dist/react.js"))+";",resolveDir:root}));
      }
      if (baseline) b.onLoad({filter:/use-quality-governor\.ts$/},args=>({
        contents:execFileSync("git",["show","40b0b02850ff2a12ca349d40d11b34986aa51b6e:libs/client/src/react/use-quality-governor.ts"],{cwd:root,encoding:"utf8"}),
        loader:"ts",resolveDir:resolve(args.path,".."),
      }));
    },
  }]});
const server=createServer((req,res)=>{
  res.setHeader("content-type",req.url==="/app.js" ? "text/javascript" : "text/html");
  res.end(req.url==="/app.js" ? bundled.outputFiles[0].contents : '<div id="app"></div><script src="/app.js"></script>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
let browser;
const results=[];
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,args:["--no-sandbox"]});
  const page=await browser.newPage();
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.clock.install({time:new Date(0)});
  const start=async(options={})=>{
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(o=>window.render(o),options);
  };
  const read=()=>page.evaluate(()=>window.result());
  const advance=ms=>page.clock.runFor(ms);
  const render=options=>page.evaluate(o=>window.render(o),options);
  const record=async name=>{const result={name,...await read()};results.push(result);return result;};

  await start({config:{openingCap:"high"}});
  const high=await record("configured high opening");
  if (!baseline) assert.equal(high.history[0].quality,2);

  await start();
  for(let i=0;i<24;i++){await advance(250);await render({});}
  const lowRamp=await record("low opening survives 24 equivalent renders");
  if (!baseline) assert.deepEqual(lowRamp.history.map(v=>v.quality),[0,2]);

  await start({config:{openingCap:"high"}});
  await page.evaluate(()=>window.pause());await advance(1000);
  for(let i=0;i<24;i++){await render({});await advance(250);}
  const congestion=await record("paused downgrade survives subsequent renders");
  if (!baseline) assert.deepEqual(congestion.history.map(v=>v.quality),[2,0]);
  assert.equal(congestion.listeners,2,"one listener pair per mounted governor");

  await start({config:{openingCap:"high"}});
  await render({freeze:120});await advance(1000);
  const getter=await record("latest freeze getter drives probation");
  if (!baseline) assert.deepEqual(getter.history.map(v=>v.quality),[2,0]);

  await start({config:{openingCap:"high"}});
  await page.evaluate(()=>window.pause(true));await advance(1000);
  const unrelated=await record("unrelated track pause is ignored");
  if (!baseline) assert.deepEqual(unrelated.history.map(v=>v.quality),[2]);

  await start({config:{openingCap:"high"}});
  await render({freeze:500,inhibited:true});await advance(1000);
  const hidden=await record("inhibited freeze cannot downgrade");
  if (!baseline) assert.deepEqual(hidden.history.map(v=>v.quality),[2]);

  await start({config:{openingCap:"high"}});
  await page.evaluate(()=>window.holdStats());await render({freeze:200});await advance(1000);
  await render({replace:"second",freeze:0});await page.evaluate(()=>window.releaseStats());await advance(1000);
  const rebound=await record("replacement fences in-flight old stats");
  if (!baseline) assert.deepEqual(rebound.history.map(({id,quality})=>({id,quality})),[{id:"first",quality:2},{id:"second",quality:2}]);
  assert.equal(rebound.listeners,2);

  await start({config:{openingCap:"high"}});
  await render({config:{openingCap:"low"}});
  const policy=await record("changed policy rebinds deliberately");
  if (!baseline) assert.deepEqual(policy.history.map(v=>v.quality),[2,0]);
  await page.evaluate(()=>window.stop());
  assert.equal((await read()).listeners,0,"unmount removes listeners");

  await start({enabled:false});await advance(6000);
  const disabled=await record("disabled requests HIGH once without listeners or stats");
  assert.deepEqual(disabled.history.map(v=>v.quality),baseline?[]:[2]);
  assert.equal(disabled.listeners,0);
  assert.equal(await page.evaluate(()=>window.statsReads()),0);
  await start({noTrack:true});await advance(6000);
  const missing=await record("missing track does not actuate");
  if (!baseline) assert.deepEqual(missing.history,[]);

  if (!baseline) {
    await start({enabled:false,freeze:500});
    for(let i=0;i<24;i++){await advance(250);await render({});}
    await page.evaluate(()=>window.pause());await advance(1000);
    const steady=await record("disabled ignores freezes and pause without reasserting on renders");
    assert.deepEqual(steady.history.map(v=>v.quality),[2]);
    assert.equal(steady.listeners,0);
    assert.equal(await page.evaluate(()=>window.statsReads()),0);

    await start({config:{openingCap:"high"}});
    await page.evaluate(()=>window.pause());await advance(1000);
    await render({enabled:false});
    const released=await record("disabling releases an already applied LOW cap");
    assert.deepEqual(released.history.map(v=>v.quality),[2,0,2]);
    assert.equal(released.listeners,0);
    const reads=await page.evaluate(()=>window.statsReads());
    await advance(5000);
    assert.equal(await page.evaluate(()=>window.statsReads()),reads);

    await start({config:{openingCap:"high"}});
    await page.evaluate(()=>window.holdStats());await render({freeze:200});await advance(1000);
    await render({enabled:false});await page.evaluate(()=>window.releaseStats());await advance(2000);
    const stale=await record("disabling fences an in-flight downgrade");
    assert.deepEqual(stale.history.map(v=>v.quality),[2,2]);
    assert.equal(stale.listeners,0);

    await start({enabled:false});
    await render({replace:"second"});
    await render({replaceTrack:true});
    const replaced=await record("disabled reasserts HIGH on publication and track replacement");
    assert.deepEqual(replaced.history.map(({id,quality})=>({id,quality})),
      [{id:"first",quality:2},{id:"second",quality:2},{id:"second",quality:2}]);
    assert.equal(replaced.listeners,0);

    await start({enabled:false,noTrack:true});await advance(1000);
    assert.deepEqual((await read()).history,[]);
    await render({noTrack:false});
    assert.deepEqual((await record("disabled waits for a subscription")).history.map(v=>v.quality),[2]);

    await start({enabled:false,noRoom:true});await advance(1000);
    assert.deepEqual((await read()).history,[]);
    await render({noRoom:false});
    assert.deepEqual((await record("disabled waits for the room")).history.map(v=>v.quality),[2]);

    await start({enabled:false});
    await render({enabled:true,config:{openingCap:"low"}});
    const resumed=await record("re-enabling restores the configured governor");
    assert.deepEqual(resumed.history.map(v=>v.quality),[2,0]);
    assert.equal(resumed.listeners,2);
    await advance(5000);
    assert.deepEqual((await read()).history.map(v=>v.quality),[2,0,2]);
    await page.evaluate(()=>window.stop());
    assert.equal((await read()).listeners,0);

    await start({enabled:false,qualityThrows:true});await advance(1000);
    const detached=await record("detached publication cannot throw into the call");
    assert.deepEqual(detached.history,[]);
    assert.equal(detached.listeners,0);
  }

  if (!baseline) {
    await start({enabled:"network-only",freeze:700,layers:[0,1,2]});
    for(let i=0;i<24;i++){await advance(250);await render({});}
    const healthyNetwork=await record("network-only ignores rendering jitter on healthy RTP");
    assert.deepEqual(healthyNetwork.history.map(v=>v.quality),[2]);
    assert.equal(healthyNetwork.listeners,0);
    await render({weak:true});await advance(7000);
    const reducedNetwork=await record("network-only gives reduced quality five seconds before notifying");
    assert.deepEqual(reducedNetwork.history.map(v=>v.quality),[2,1,0]);
    assert.notEqual(reducedNetwork.notices.at(-1).status,"poor");
    await advance(2000);
    const weakNetwork=await record("network-only notifies after continued impairment on reduced quality");
    assert.deepEqual(weakNetwork.history.map(v=>v.quality),[2,1,0]);
    assert.equal(weakNetwork.notices.at(-1).status,"poor");
    await render({weak:false,freeze:4});await advance(7000);
    const recoveredNetwork=await record("network-only recovers despite 4ms estimate residue");
    assert.equal(recoveredNetwork.history.at(-1).quality,2);
    await advance(5000);
    assert.equal((await read()).notices.at(-1).status,"healthy");

    await start({enabled:"network-only",weak:true});
    await advance(4000); await page.evaluate(()=>window.holdStats());await advance(1000);
    await render({replace:"second",weak:false});
    await page.evaluate(()=>window.releaseStats());await advance(1000);
    const networkRebind=await record("network-only fences replacement and clears old notice");
    assert.equal(networkRebind.history.at(-1).id,"second");
    assert.equal(networkRebind.history.at(-1).quality,2);

    await start({enabled:"network-only",weak:true,inhibited:true});
    await advance(10000);
    const inhibitedNetwork=await record("network-only cannot downgrade or notify while inhibited");
    assert.deepEqual(inhibitedNetwork.history.map(v=>v.quality),[2]);
    assert.equal(inhibitedNetwork.notices.at(-1).status,"unknown");

    await start({enabled:"network-only",weak:true,statsThrows:true});
    await advance(10000);
    const unsupportedNetwork=await record("network-only fails open on missing stats");
    assert.deepEqual(unsupportedNetwork.history.map(v=>v.quality),[2]);

    await start({enabled:"network-only",weak:true});
    await advance(10000);
    await render({enabled:false});
    const networkOff=await record("network-only disable releases cap and clears notice");
    assert.equal(networkOff.history.at(-1).quality,2);
    assert.equal(networkOff.notices.at(-1).status,"unknown");
    const readCount=await page.evaluate(()=>window.statsReads());
    await advance(10000);
    assert.equal(await page.evaluate(()=>window.statsReads()),readCount);
    await page.evaluate(()=>window.stop());
  }
  assert.deepEqual(errors,[],"the hook must not throw into the call");
  const report={arm:baseline?"baseline":"candidate",checks:results.length,results};
  if(reportDir){await mkdir(reportDir,{recursive:true});await writeFile(resolve(reportDir,`hook-${report.arm}.json`),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
