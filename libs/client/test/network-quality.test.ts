import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initNetworkQuality, NETWORK_QUALITY_POLICY, readNetworkVideoSample, stepNetworkQuality,
  type NetworkVideoSample,
} from "../src/react/network-quality.ts";

const fixture = () => {
  let state = initNetworkQuality(0);
  let now = 0;
  let sample: NetworkVideoSample = {
    id: "video:1", timestamp: 0, framesDecoded: 0, packetsReceived: 0, packetsLost: 0, jitter: 0.01,
  };
  const tick = (opts: {
    frames?: number; received?: number; lost?: number; jitter?: number; dt?: number;
    paused?: boolean; inhibited?: boolean; id?: string; stale?: boolean; missing?: boolean;
  } = {}) => {
    now += opts.dt ?? 1000;
    if (!opts.stale) sample = {
      id: opts.id ?? sample.id, timestamp: now,
      framesDecoded: sample.framesDecoded + (opts.frames ?? 25),
      packetsReceived: sample.packetsReceived + (opts.received ?? 100),
      packetsLost: sample.packetsLost + (opts.lost ?? 0),
      jitter: opts.jitter ?? 0.01,
    };
    state = stepNetworkQuality(state, opts.missing ? null : sample, now, {
      paused: opts.paused ?? false, inhibited: opts.inhibited ?? false,
    });
    return state;
  };
  const warm = () => { for (let i = 0; i < 5; i++) tick(); };
  return { tick, warm, state: () => state };
};

const weak = { frames: 0, received: 92, lost: 8 };
describe("Network-only quality policy", () => {
  it("keeps HIGH on a healthy link for an entire call", () => {
    const f = fixture();
    for (let i = 0; i < 1800; i++) assert.equal(f.tick().cap, "high");
    assert.equal(f.state().status, "healthy");
  });
  it("does not blame startup, rendering/GPU freezes or low fps without network evidence", () => {
    const f = fixture();
    for (let i = 0; i < 60; i++) {
      const s = f.tick({ frames: 0, received: 0 });
      assert.equal(s.cap, "high"); assert.notEqual(s.status, "poor");
    }
  });
  it("ignores an isolated weak interval and jitter while decoding smoothly", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 60; i++) {
      assert.equal(f.tick(i % 3 === 0 ? weak : { jitter: 0.2 }).cap, "high");
    }
    assert.notEqual(f.state().status, "poor");
  });
  it("smooths loss, reduces after 2s bad, and warns after 5s more impairment following the downgrade", () => {
    const f = fixture(); f.warm();
    // First loss sample is diluted by the two preceding healthy samples.
    assert.equal(f.tick(weak).cap, "high");
    assert.equal(f.tick(weak).cap, "high");
    assert.equal(f.tick(weak).cap, "reduced");
    assert.equal(f.tick(weak).cap, "reduced");
    assert.equal(f.tick(weak).cap, "floor");
    assert.notEqual(f.state().status, "poor");
    assert.notEqual(f.tick(weak).status, "poor");
    assert.notEqual(f.tick(weak).status, "poor");
    assert.equal(f.tick(weak).status, "poor");
  });
  it("does not go to the floor when reduced video still makes progress", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 10; i++) f.tick({ ...weak, frames: 8 });
    assert.equal(f.state().cap, "reduced"); assert.equal(f.state().status, "poor");
  });
  it("recovers after 5s of healthy receiving, clears notice after 10s, with no rVFC noise input", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 8; i++) f.tick(weak);
    // One clean receive interval still has >=5% loss in its trailing packet window.
    assert.equal(f.tick().cleanMs, 0);
    for (let i = 0; i < 4; i++) assert.equal(f.tick().cap, "floor");
    assert.equal(f.tick().cap, "high");
    assert.equal(f.state().status, "poor");
    for (let i = 0; i < 5; i++) f.tick();
    assert.equal(f.state().status, "healthy");
  });
  it("handles sustained SFU pause before native freeze totals advance", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 7; i++) f.tick({ frames: 0, received: 0, paused: true });
    assert.equal(f.state().cap, "floor"); assert.equal(f.state().status, "poor");
  });
  it("uses jitter only with impaired decode and fresh packet evidence", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 5; i++) f.tick({ frames: 0, received: 0, jitter: 1 });
    assert.equal(f.state().cap, "high");
    for (let i = 0; i < 7; i++) f.tick({ frames: 3, received: 30, jitter: 0.1 });
    assert.equal(f.state().cap, "reduced"); assert.equal(f.state().status, "poor");
  });
  for (const interruption of [
    { stale: true }, { missing: true }, { dt: 5000 }, { inhibited: true }, { id: "video:2" },
  ]) {
    it(`breaks both bad and clean continuity on ${JSON.stringify(interruption)}`, () => {
      const f = fixture(); f.warm();
      f.tick(weak); f.tick({ ...weak, ...interruption });
      assert.equal(f.state().cap, "high");
      f.tick(weak);
      assert.notEqual(f.state().status, "poor");
      for (let i = 0; i < 6; i++) f.tick(weak);
      for (let i = 0; i < 4; i++) f.tick();
      f.tick({ ...interruption, ...(interruption.id ? { id: "video:3" } : {}) });
      assert.equal(f.state().cap, "floor");
    });
  }
  it("does not extrapolate from fewer than 20 packets", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 10; i++) f.tick({ frames: 0, received: 1, lost: 1 });
    assert.equal(f.state().cap, "high");
  });
  it("accepts late-arrival corrections, but rejects receiver counter resets", () => {
    const f = fixture(); f.warm();
    f.tick({ lost: -2 }); assert.equal(f.state().cap, "high");
    for (let i = 0; i < 5; i++) f.tick(weak);
    const s = f.tick({ frames: -200 });
    assert.equal(s.cleanMs, 0); assert.equal(s.badMs, 0);
  });
  it("does not misclassify loss at healthy fps, or exactly healthy threshold fps", () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 10; i++) f.tick({ ...weak, frames: NETWORK_QUALITY_POLICY.impairedFps });
    assert.equal(f.state().cap, "high"); assert.notEqual(f.state().status, "poor");
  });
});

describe("Network stats validation", () => {
  const row = { id: "inbound", ssrc: 1, type: "inbound-rtp", kind: "video", timestamp: 1000,
    framesDecoded: 10, packetsReceived: 100, packetsLost: 0, jitter: 0.01 };
  const report = (...rows: object[]) => new Map(rows.map((r, i) => [String(i), r])) as RTCStatsReport;
  it("selects video only and includes receiver identity", () => {
    assert.equal(readNetworkVideoSample(report(row, { ...row, kind: "audio" }))?.id, "inbound:1");
  });
  it("rejects unsupported, ambiguous, missing and non-finite data", () => {
    for (const input of [undefined, report(), report(row, { ...row, ssrc: 2 }),
      report({ ...row, framesDecoded: undefined }), report({ ...row, jitter: NaN }),
      report({ ...row, timestamp: -1 })]) assert.equal(readNetworkVideoSample(input), null);
  });
});
