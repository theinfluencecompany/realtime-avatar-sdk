// Local SFU + real LiveKit React bindings/AvatarVideoSurface. The publisher is a
// repeatable avatar clip, not an inference worker. No production keys or sessions.
// Start a loopback LiveKit server, then set RAMP_LIVEKIT_URL / RAMP_LIVEKIT_KEY /
// RAMP_LIVEKIT_SECRET. See docs/video-call-ramp.md for the measured setup.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root=resolve(import.meta.dirname,"..");
const reportDir=process.env.RAMP_REPORT_DIR;
assert.ok(reportDir,"RAMP_REPORT_DIR is required");
await mkdir(reportDir,{recursive:true});
const livekitUrl=process.env.RAMP_LIVEKIT_URL || "ws://127.0.0.1:38980";
assert.ok(["127.0.0.1","localhost","[::1]"].includes(new URL(livekitUrl).hostname),"this harness only uses loopback SFUs");
const key=process.env.RAMP_LIVEKIT_KEY || "latency-local";
const secret=process.env.RAMP_LIVEKIT_SECRET || "latency-local-test-secret-at-least-32-characters";
const trials=Number(process.env.RAMP_TRIALS || 3);
const durationMs=Number(process.env.RAMP_DURATION_MS || 14000);
const arms=(process.env.RAMP_ARMS || "before,app-only,after").split(",");
const packageBaseline=process.env.RAMP_PACKAGE_BASELINE;
const packageCandidate=process.env.RAMP_PACKAGE_CANDIDATE;
const peerRoot=process.env.RAMP_PEER_ROOT;
const publisherPeerRoot=process.env.RAMP_PUBLISHER_PEER_ROOT || peerRoot;
const lossEvery=Number(process.env.RAMP_LOSS_EVERY || 0);
const lossStart=Number(process.env.RAMP_LOSS_START_MS || 5000);
const lossEnd=Number(process.env.RAMP_LOSS_END_MS || 11000);
const recoveryMode=process.env.RAMP_RECOVERY==="1";
const baselineRef=process.env.RAMP_BASELINE_REF || "2e0b323bd3ed87cef2167b2102754ff5c599f8d5";
const bandwidthBps=Number(process.env.RAMP_BANDWIDTH_BPS || 0);
const useRelay=Boolean(lossEvery || bandwidthBps);
const proxyPort=Number(process.env.RAMP_PROXY_PORT || 39082);
const serverUdpPort=Number(process.env.RAMP_SERVER_UDP_PORT || 38982);
let activeSince=0,mediaPackets=0,droppedPackets=0,impairedMediaPackets=0;
let shapedPackets=0,shapedBytes=0,shapingDrops=0;
const wireFreeAt=new Map(),pendingSends=new Set();
const relay=createSocket("udp4"),upstreams=new Map();
const forwardDownstream=(packet,peer)=>{
  const now=Date.now(),at=now-activeSince;
  if(!bandwidthBps || at<lossStart || at>=lossEnd || packet[0]<128 || packet[0]>191){
    relay.send(packet,peer.port,peer.address);return;
  }
  const id=peer.address+":"+peer.port,free=Math.max(now,wireFreeAt.get(id) || now);
  const serializationMs=packet.length*8*1000/bandwidthBps;
  // Finite 125ms access-link queue: shape actual downstream RTP/RTCP, then drop
  // overflow. HTTP throttling never touches this UDP media path.
  if(free+serializationMs-now>125){shapingDrops++;return;}
  wireFreeAt.set(id,free+serializationMs);shapedPackets++;shapedBytes+=packet.length;
  const handle=setTimeout(()=>{
    pendingSends.delete(handle);relay.send(packet,peer.port,peer.address);
  },free+serializationMs-now);
  pendingSends.add(handle);
};
const shouldDrop=packet=>{
  if(!lossEvery || packet[0]<128 || packet[0]>191)return false;
  mediaPackets++;
  const at=Date.now()-activeSince;
  if(at>=lossStart && at<lossEnd){
    impairedMediaPackets++;
    if(mediaPackets%lossEvery===0){droppedPackets++;return true;}
  }
  return false;
};
relay.on("message",(packet,peer)=>{
  const id=peer.address+":"+peer.port;let upstream=upstreams.get(id);
  if(!upstream){
    upstream=createSocket("udp4");upstreams.set(id,upstream);
    upstream.on("message",reply=>{if(!shouldDrop(reply))forwardDownstream(reply,peer);});
    upstream.on("error",error=>console.error("local UDP relay:",error.message));
  }
  if(!shouldDrop(packet))upstream.send(packet,serverUdpPort,"127.0.0.1");
});
if(useRelay)await new Promise(r=>relay.bind(proxyPort,"127.0.0.1",r));
const modulePath=process.env.PLAYWRIGHT_MODULE || "playwright";
const {chromium}=await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const clip=await readFile(resolve(root,"apps/demo/live-shopping/characters/mira/1-SHIPPED-idle-6s-9x16.mp4"));
function token(room,role){
  const b64=x=>Buffer.from(JSON.stringify(x)).toString("base64url");
  const body=b64({alg:"HS256",typ:"JWT"})+"."+b64({iss:key,sub:role,kind:role==="publisher"?"agent":"standard",
    nbf:Math.floor(Date.now()/1000)-10,exp:Math.floor(Date.now()/1000)+120,
    video:{roomJoin:true,room,canPublish:role==="publisher",canSubscribe:true,canPublishData:true}});
  return body+"."+createHmac("sha256",secret).update(body).digest("base64url");
}
const entry=`
import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Room,RoomEvent,RemoteTrackPublication,RemoteTrack,VideoPreset,Track} from 'livekit-client';
import {RoomContext,useVoiceAssistant,RoomAudioRenderer} from '@livekit/components-react';
import {AvatarVideoSurface} from './libs/client/src/react/avatar-video-surface';
import {useAvatarQualityGovernor} from './libs/client/src/react/use-quality-governor';
import {DEFAULT_GOVERNOR_CONFIG} from './libs/client/src/react/quality-governor';
import {useAvatarAdaptivePlayoutDelay} from './libs/client/src/react/use-adaptive-playout';
const params=new URLSearchParams(location.search), role=params.get('role'), arm=params.get('arm');
if(role==='viewer' && ${useRelay}){
  const rewrite=s=>s.replace(/(candidate:[^\\r\\n]*? 127\\.0\\.0\\.1 )${serverUdpPort}( )/g,'$1${proxyPort}$2');
  const add=RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate=function(candidate,...args){
    return add.call(this,candidate?{...candidate.toJSON?.()??candidate,candidate:rewrite(candidate.candidate)}:candidate,...args);
  };
  const set=RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription=function(description,...args){
    return set.call(this,{type:description.type,sdp:rewrite(description.sdp)},...args);
  };
}
const started=performance.now();
const report=window.report={arm,events:[],samples:[],frames:[],caps:[],playout:[]};
const now=()=>performance.now()-started;
const room=new Room({adaptiveStream:false,dynacast:false});
window.room=room;
window.ready=false;
const event=(type,extra={})=>report.events.push({at:now(),type,...extra});
room.on(RoomEvent.Connected,()=>event('connected'));
room.on(RoomEvent.Reconnecting,()=>event('reconnecting'));
room.on(RoomEvent.Reconnected,()=>event('reconnected'));
room.on(RoomEvent.TrackSubscribed,(track,pub)=>event('subscribed',{kind:track.kind,layers:pub.trackInfo?.layers}));
const cap=RemoteTrackPublication.prototype.setVideoQuality;
RemoteTrackPublication.prototype.setVideoQuality=function(quality){report.caps.push({at:now(),quality});return cap.call(this,quality);};
const playout=RemoteTrack.prototype.setPlayoutDelay;
RemoteTrack.prototype.setPlayoutDelay=function(seconds){
  const r=this.receiver;report.playout.push({at:now(),seconds,kind:this.kind,
    hintSupported:!!r && 'playoutDelayHint' in r,targetSupported:!!r && 'jitterBufferTarget' in r});
  return playout.call(this,seconds);
};
const smooth=()=>({freezeMsInWindow:0,inhibited:document.visibilityState!=='visible'});
const fasterPlayout={shrinkAlpha:0.25};
function App(){
  const [revision,render]=useState(0);
  useEffect(()=>{const t=setInterval(()=>render(n=>n+1),500);return()=>clearInterval(t);},[]);
  const stable=useMemo(()=>({...DEFAULT_GOVERNOR_CONFIG,openingCap:'high'}),[]);
  const {videoTrack,audioTrack}=useVoiceAssistant();
  useAvatarAdaptivePlayoutDelay(videoTrack,audioTrack,${recoveryMode} || arm!=='before',fasterPlayout);
  useAvatarQualityGovernor({enabled:!${recoveryMode} && arm==='before',freezeReading:smooth,
    config:arm==='before'?{...DEFAULT_GOVERNOR_CONFIG,openingCap:'high'}:stable});
  return <><AvatarVideoSurface data-testid='ramp-surface' idleVideoUrl='/clip.mp4' openingCap='high' adaptiveQuality
    adaptivePlayout={!${recoveryMode} && arm==='before'} crossfadeMs={150} showLiveBadge={false} fit='cover'/><RoomAudioRenderer/></>;
}
if(role==='publisher'){
  const source=document.createElement('video');source.src='/clip.mp4';source.muted=true;source.loop=true;source.playsInline=true;
  await source.play();
  const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;
  const ctx=canvas.getContext('2d');document.getElementById('app').append(canvas);
  const draw=()=>{
    ctx.drawImage(source,0,0,720,1280);
    ctx.fillStyle='#091321';ctx.fillRect(0,1080,720,200);
    ctx.fillStyle='#a1f0d2';ctx.font='26px monospace';ctx.fillText('LOCAL WEBRTC / 25 FPS',30,1125);
    ctx.fillStyle='white';ctx.font='22px monospace';ctx.fillText('Fine detail 0123456789 ABCDEF',30,1160);
    // Millisecond source timestamp, 24 bits plus an 8-bit marker. Survives 2x downscale.
    const stamp=Date.now()%16777216;
    for(let i=0;i<32;i++){
      const bit=i<8 ? ((0xa5>>(7-i))&1) : ((stamp>>(31-i))&1);
      ctx.fillStyle=bit?'white':'black';ctx.fillRect(i*22.5,1200,22.5,60);
    }
  };
  draw();setInterval(draw,40);
  await room.connect(${JSON.stringify(livekitUrl)},params.get('token'));
  const audio=new AudioContext(),oscillator=audio.createOscillator(),gain=audio.createGain();
  const destination=audio.createMediaStreamDestination();gain.gain.value=0.01;
  oscillator.connect(gain).connect(destination);oscillator.start();await audio.resume();
  await room.localParticipant.publishTrack(destination.stream.getAudioTracks()[0],{source:Track.Source.Microphone,name:'local-test-tone'});
  await room.localParticipant.publishTrack(canvas.captureStream(25).getVideoTracks()[0],{
    name:'avatar',source:Track.Source.Camera,videoCodec:'vp8',simulcast:true,
    videoEncoding:{maxBitrate:1800000,maxFramerate:25},
    videoSimulcastLayers:[new VideoPreset(360,640,400000,25)],
  });
  window.ready=true;
} else {
  createRoot(document.getElementById('app')).render(<RoomContext.Provider value={room}><App/></RoomContext.Provider>);
  event('connect-start');
  await room.connect(${JSON.stringify(livekitUrl)},params.get('token'));
  let video,previousStats;
  const probe=document.createElement('canvas');probe.width=32;probe.height=1;
  const ctx=probe.getContext('2d',{willReadFrequently:true});
  const frame=(_now,meta)=>{
    let sourceAgeMs=null;
    if(video.videoWidth){
      ctx.drawImage(video,0,video.videoHeight*1200/1280,video.videoWidth,video.videoHeight*60/1280,0,0,32,1);
      const px=ctx.getImageData(0,0,32,1).data;let marker=0,stamp=0;
      for(let i=0;i<32;i++){const bit=px[i*4]>128?1:0;if(i<8)marker=marker*2+bit;else stamp=stamp*2+bit;}
      if(marker===0xa5)sourceAgeMs=(Date.now()%16777216-stamp+16777216)%16777216;
    }
    report.frames.push({at:now(),width:meta.width,height:meta.height,sourceAgeMs,
      processingMs:meta.processingDuration==null?null:meta.processingDuration*1000,
      visible:document.querySelector('[data-testid="avatar-live-layer"]')?.style.opacity==='1'});
    video.requestVideoFrameCallback(frame);
  };
  let sampling=false;
  setInterval(async()=>{
    const element=document.querySelector('[data-testid="avatar-live-layer"] video');
    if(element && element!==video){video=element;video.requestVideoFrameCallback(frame);}
    if(sampling)return;sampling=true;
    try{
      for(const participant of room.remoteParticipants.values())for(const pub of participant.videoTrackPublications.values()){
        const stats=await pub.track?.getRTCStatsReport();if(!stats)continue;
        let inbound,pair,transport;const all=[...stats.values()];
        inbound=all.find(s=>s.type==='inbound-rtp'&&s.kind==='video');
        transport=all.find(s=>s.type==='transport');
        pair=all.find(s=>s.id===transport?.selectedCandidatePairId);
        if(!inbound)continue;
        const elapsed=previousStats?(inbound.timestamp-previousStats.timestamp)/1000:0;
        const emitted=previousStats?inbound.jitterBufferEmittedCount-previousStats.jitterBufferEmittedCount:0;
        report.samples.push({at:now(),width:inbound.frameWidth,height:inbound.frameHeight,fps:inbound.framesPerSecond,
          framesDecoded:inbound.framesDecoded,framesDropped:inbound.framesDropped,freezeCount:inbound.freezeCount,
          totalFreezesDuration:inbound.totalFreezesDuration,packetsLost:inbound.packetsLost,packetsReceived:inbound.packetsReceived,
          kbps:elapsed>0?(inbound.bytesReceived-previousStats.bytesReceived)*8/elapsed/1000:null,
          jitterMs:inbound.jitter*1000,bufferMs:emitted>0?(inbound.jitterBufferDelay-previousStats.jitterBufferDelay)*1000/emitted:null,
          rttMs:pair?.currentRoundTripTime*1000,protocol:all.find(s=>s.id===pair?.localCandidateId)?.protocol,
          remotePort:all.find(s=>s.id===pair?.remoteCandidateId)?.port,
          candidateType:all.find(s=>s.id===pair?.localCandidateId)?.candidateType});
        previousStats=inbound;
      }
    }finally{sampling=false;}
  },200);
  window.ready=true;
}
`;
const bundles={};
// The synthetic worker can select its own peer independently of the pinned
// receiver. Record that choice: a publisher that sends no upper stream cannot
// establish the receiver's full-resolution ramp, regardless of its requested cap.
for(const arm of [...arms,'publisher']){
  const packagePath=arm==='publisher'?undefined:arm==='after'?packageCandidate:packageBaseline;
  const selectedPeerRoot=arm==='publisher'?publisherPeerRoot:peerRoot;
  const built=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,
    ...(selectedPeerRoot?{alias:Object.fromEntries(['react','react-dom','livekit-client','@livekit/components-react'].map(name=>[name,resolve(selectedPeerRoot,name)]))}:{}),
    platform:"browser",format:"esm",define:{"process.env.NODE_ENV":'"production"'},plugins:packagePath?[{
      name:'installed-sdk',setup(b){
        b.onResolve({filter:/^\.\/libs\/client\/src\/react\//},()=>({path:'sdk',namespace:'installed-sdk'}));
        b.onLoad({filter:/.*/,namespace:'installed-sdk'},()=>({contents:'export {AvatarVideoSurface,useAvatarQualityGovernor,DEFAULT_GOVERNOR_CONFIG,useAvatarAdaptivePlayoutDelay} from '+JSON.stringify(resolve(packagePath,'dist/react.js'))+';',resolveDir:root}));
      },
    }]:arm==="after"||arm==="publisher"?[]:recoveryMode?[{
      name:"recovery-baseline",setup(b){b.onLoad({filter:/[/\\]quality-governor\.ts$/},args=>({
        contents:execFileSync("git",["show",`${baselineRef}:libs/client/src/react/quality-governor.ts`],{cwd:root,encoding:"utf8"}),
        loader:"ts",resolveDir:resolve(args.path,".."),
      }));},
    }]:[{
      name:"baseline-governor",setup(b){b.onLoad({filter:/use-quality-governor\.ts$/},args=>({
        contents:execFileSync("git",["show","40b0b02850ff2a12ca349d40d11b34986aa51b6e:libs/client/src/react/use-quality-governor.ts"],{cwd:root,encoding:"utf8"}),
        loader:"ts",resolveDir:resolve(args.path,".."),
      }));},
    }]});bundles[arm]=built.outputFiles[0].contents;
}
const server=createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost");
  if(url.pathname==="/clip.mp4"){res.setHeader("Content-Type","video/mp4");res.end(clip);return;}
  if(url.pathname==="/app.js"){res.setHeader("Content-Type","text/javascript");res.end(bundles[url.searchParams.get("arm")]);return;}
  res.setHeader("Content-Type","text/html");
  // Supply the SDK's utility-class geometry without requiring the host's Tailwind
  // build. Without this the 0.7.x live video sits below a full-size idle element,
  // outside the viewport: its frame callbacks and the measurement are invalid.
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#091321}canvas{width:100%;height:100%}[data-testid="ramp-surface"]{position:relative;width:100%;height:100%;overflow:hidden}[data-testid="avatar-live-layer"]{position:absolute;inset:0;z-index:20;width:100%;height:100%}[data-testid="avatar-idle-video"],[data-testid="avatar-live-layer"] video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 22%}</style><div id="app"></div><script type="module" src="/app.js?arm='+encodeURIComponent(url.searchParams.get('role')==='publisher'?'publisher':url.searchParams.get("arm"))+'"></script>');
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
let browser;const reports=[];
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || undefined,
    args:["--no-sandbox","--autoplay-policy=no-user-gesture-required","--disable-background-timer-throttling","--disable-renderer-backgrounding"]});
  for(let trial=0;trial<trials;trial++)for(const arm of (trial%2?[...arms].reverse():arms)){
    const name=arm+"-"+(trial+1),room="latency-local-"+Date.now()+"-"+name;
    const contexts=[];
    try{
      const pubContext=await browser.newContext();contexts.push(pubContext);
      const publisher=await pubContext.newPage();
      publisher.setDefaultTimeout(15000);
      const url=(role)=>`http://127.0.0.1:${server.address().port}/?`+new URLSearchParams({role,arm,token:token(room,role)});
      console.log(name+': publisher connecting');
      await publisher.goto(url("publisher"));await publisher.waitForFunction(()=>window.ready,{},{timeout:15000,polling:100});
      const viewerContext=await browser.newContext({viewport:{width:360,height:640},
        ...(trial===0?{recordVideo:{dir:reportDir,size:{width:360,height:640}}}:{})});contexts.push(viewerContext);
      const page=await viewerContext.newPage();const errors=[];
      page.setDefaultTimeout(15000);
      page.on("pageerror",e=>{errors.push(e.message);console.error(name+': '+e.message);});
      await page.bringToFront();
      activeSince=Date.now();mediaPackets=0;droppedPackets=0;impairedMediaPackets=0;
      shapedPackets=0;shapedBytes=0;shapingDrops=0;wireFreeAt.clear();
      console.log(name+': receiver connecting');
      await page.goto(url("viewer"));await page.waitForFunction(()=>window.ready,{},{timeout:15000,polling:100});
      console.log(name+': measuring');
      await page.waitForTimeout(durationMs);
      const report=await page.evaluate(()=>window.report);
      report.layout=await page.evaluate(()=>{
        const box=document.querySelector('[data-testid="avatar-live-layer"] video')?.getBoundingClientRect();
        return {visible:document.visibilityState,video:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null};
      });
      assert.equal(report.layout.visible,'visible');
      assert.deepEqual(report.layout.video,{x:0,y:0,width:360,height:640},'live video must fill the visible receiver viewport');
      report.trial=trial+1;report.errors=errors;report.browser=browser.version();
      report.network={lossEvery,lossStart,lossEnd,mediaPackets,impairedMediaPackets,droppedPackets,
        bandwidthBps,shapedPackets,shapedBytes,shapingDrops,queueMaxMs:125,
        shapedPayloadBps:bandwidthBps?Math.round(shapedBytes*8000/(lossEnd-lossStart)):null};
      if(recoveryMode){
        const topBeforeImpairment=report.frames.some(f=>f.width>=720 && f.at<lossStart);
        report.calibration={verdict:topBeforeImpairment?"PASS":"INCONCLUSIVE",
          topBeforeImpairment,scope:"Publisher delivered the top layer before impairment; recovery is judged separately"};
      }
      await page.screenshot({path:resolve(reportDir,name+".png"),timeout:15000});
      const video=page.video();await viewerContext.close();contexts.pop();
      if(video)await video.saveAs(resolve(reportDir,arm+".webm"));
      await writeFile(resolve(reportDir,name+".json"),JSON.stringify(report,null,2));reports.push(report);
      assert.equal(errors.length,0,name+" browser errors");assert.ok(report.frames.length>40,name+" must receive real frames");
      if(lossEvery){assert.ok(droppedPackets>0,"the relay must actually drop media");assert.ok(report.samples.some(s=>s.remotePort===proxyPort),"the selected ICE path must traverse the relay");}
      if(bandwidthBps){
        assert.ok(shapedPackets>0 && shapingDrops>0,"bandwidth cell must actually constrain media");
        assert.ok(report.samples.some(s=>s.remotePort===proxyPort),"the selected ICE path must traverse the shaper");
        assert.ok(report.network.shapedPayloadBps<=bandwidthBps*1.1,"shaped payload must fit the configured media budget");
      }
      console.log(JSON.stringify({name,firstFrameMs:report.frames[0].at,
        first720pMs:report.frames.find(f=>f.width>=720)?.at ?? null,caps:report.caps.length,
        widths:[...new Set(report.frames.map(f=>f.width))],frames:report.frames.length}));
    }finally{for(const context of contexts.reverse())await context.close();}
  }
  await writeFile(resolve(reportDir,"runs.json"),JSON.stringify({baselineRef:recoveryMode?baselineRef:"40b0b02850ff2a12ca349d40d11b34986aa51b6e",recoveryMode,packageBaseline,packageCandidate,peerRoot,publisherPeerRoot,trials,durationMs,reports},null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));if(useRelay){for(const handle of pendingSends)clearTimeout(handle);for(const socket of upstreams.values())socket.close();relay.close();}}
