import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * Pins the ONE platform split the react-native surface is allowed to have.
 *
 * The surface had two different ideas riding a single `IS_ANDROID` constant. One is real:
 * Android's <VideoTrack> is a SurfaceView on its own hardware layer, so it ignores view
 * opacity and draws below the RN window — genuine COMPOSITING facts that iOS's UIView does
 * not share. The other was not: whether a remote track counts as PRODUCING is a
 * react-native-webrtc fact, identical on both platforms, and gating it on `IS_ANDROID` left
 * iOS on the strict browser-shaped predicate (`enabled && !muted`) that a remote RN track
 * does not drive. Measured on a physical iPhone: subscribed, H.264 frames arriving, strict
 * predicate false, live layer held at opacity 0, avatar frozen on its poster. The consumer's
 * workaround was to bypass this surface and reach into `room.engine.pcManager` — an
 * `@internal` API — which is the debt 0.7.0 retires.
 *
 * So the assertions below are deliberately two-sided. Decoupling the predicate is only half
 * the fix; the other half is that the SurfaceView branches KEEP their Android gate, because
 * "delete IS_ANDROID" is the plausible over-correction and it would put the Android
 * voice-only bug straight back.
 *
 * These are SOURCE pins, not imports, for the reason busy-retry-floor.test.ts documents:
 * `avatar-video-surface.ts` uses the upstream's extensionless internal imports
 * (`"./livekit"`), which node's type-stripping runner cannot resolve, and the react-native
 * twin additionally imports `react-native` itself. Re-shaping either file to be importable
 * would be a bigger change than the one under test.
 */

const NATIVE = new URL("../src/react-native/avatar-video-surface.ts", import.meta.url);
const WEB = new URL("../src/react/avatar-video-surface.ts", import.meta.url);
const NATIVE_INDEX = new URL("../src/react-native/index.ts", import.meta.url);

/**
 * Code only. Every claim here is about what the module DOES, and the comments explaining the
 * split necessarily quote the shapes being asserted against — including the old one — so a
 * scan over raw text would read a cautionary note as a live call site.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const nativeSource = await readFile(NATIVE, "utf8");
const webSource = await readFile(WEB, "utf8");
const nativeCode = code(nativeSource);
const webCode = code(webSource);

test("the producing predicate is not gated on the platform — react-native means BOTH", () => {
  // The default is named after the shim, not the OS, so the two ideas cannot re-merge under
  // one identifier the way they did.
  assert.match(
    nativeCode,
    /const RN_WEBRTC_IS_PRODUCING = isNativeLiveTrackSubscribed;/,
    "the RN surface must default the producing predicate to the react-native predicate",
  );
  assert.match(
    nativeCode,
    /isProducing = RN_WEBRTC_IS_PRODUCING/,
    "the isProducing prop must default to the react-native predicate",
  );
  assert.match(
    nativeCode,
    /const trackProducing = useLiveTrackProducing\(videoTrack, isProducing\);/,
    "the producing call must pass the (defaulted, overridable) predicate straight through",
  );
  // The exact shape that shipped in 0.6.x and stranded iOS on the strict web predicate.
  assert.doesNotMatch(
    nativeCode,
    /IS_ANDROID\s*\?\s*isNativeLiveTrackSubscribed/,
    "iOS is back on the strict web predicate — it will freeze on its poster mid-turn",
  );
  // Any platform condition anywhere near the producing call is the same bug wearing a
  // different expression, so assert on the call's whole argument list rather than one shape.
  const call = nativeCode.match(/useLiveTrackProducing\([\s\S]*?\);/)?.[0];
  assert.ok(call, "no useLiveTrackProducing call found in the react-native surface");
  assert.doesNotMatch(
    call,
    /IS_ANDROID|Platform\.OS|isNativeLiveTrackSubscribed|isLiveTrackProducing/,
    "the producing predicate is being chosen at the call site again — it belongs at the default",
  );
});

test("the SurfaceView branches still key off Android — the over-correction is also a bug", () => {
  assert.match(
    nativeCode,
    /const IS_ANDROID = Platform\.OS === "android";/,
    "IS_ANDROID must survive: the compositing differences are real",
  );
  // 1. Alpha: a SurfaceView ignores view opacity, so the live layer is mount-gated there and
  //    opacity-crossfaded on iOS.
  assert.match(
    nativeCode,
    /const frontLayer = IS_ANDROID/,
    "the mount-vs-opacity split for the live layer must stay Android-only",
  );
  // 2. Z-order: the remote video draws below the RN window on Android, so the opaque floor
  //    has to be suppressed while it shows — and must NOT be on iOS, where the floor is
  //    simply covered.
  assert.match(
    nativeCode,
    /const floorHidden = IS_ANDROID && showLive;/,
    "hiding the poster/idle floor must stay Android-only",
  );
  assert.match(
    nativeCode,
    /IS_ANDROID \? \{ zOrder: ANDROID_REMOTE_ZORDER \}/,
    "the explicit background zOrder must stay Android-only",
  );
});

test("the platform is read in exactly one place, for exactly the compositing branches", () => {
  const platformReads = nativeCode.match(/Platform\.OS/g) ?? [];
  assert.equal(
    platformReads.length,
    1,
    `Platform.OS is read ${platformReads.length} times; it must be read once, to define IS_ANDROID.` +
      ` A second read is how a non-compositing concern gets platform-gated again.`,
  );
  // One definition + the three compositing uses above. A fourth use is a new platform branch
  // that this test has not reasoned about — justify it here or it does not ship.
  const androidUses = nativeCode.match(/IS_ANDROID/g) ?? [];
  assert.equal(
    androidUses.length,
    4,
    `IS_ANDROID appears ${androidUses.length} times (expected 1 definition + 3 compositing uses).` +
      ` If the new use is genuinely about how the layer is PAINTED, add it here with its reason.`,
  );
});

test("the web surface keeps the strict predicate — the coarse gate is native-only", () => {
  // No second argument: web takes the default, which must remain the strict one.
  assert.match(
    webCode,
    /const trackProducing = useLiveTrackProducing\(videoTrack\);/,
    "the web surface must keep the strict default — a browser <video> DOES drive enabled/muted",
  );
  assert.match(
    webCode,
    /isProducing:[\s\S]{0,120}=> boolean = isLiveTrackProducing,/,
    "useLiveTrackProducing must still default to the strict predicate, so web callers are unchanged",
  );
});

test("the two predicates still mean what the surfaces assume they mean", () => {
  // Strict: browser-shaped micro-signals. This is what a remote react-native-webrtc track
  // does not drive, and the reason the native surface cannot use it by default.
  assert.match(
    webCode,
    /readyState === "live" && mst\.enabled && !mst\.muted/,
    "isLiveTrackProducing must stay the strict gate",
  );
  // Coarse: subscribed and not ended. Deliberately says nothing about mute, which is why the
  // live layer stays up between turns — the documented price of the video appearing at all.
  assert.match(
    webCode,
    /readyState !== "ended"/,
    "isNativeLiveTrackSubscribed must stay the coarse subscribed-and-not-ended gate",
  );
});

test("the escape hatch is real: the prop is declared and both predicates are exported", async () => {
  assert.match(
    nativeSource,
    /isProducing\?: \(videoTrack: TrackReferenceOrPlaceholder \| undefined\) => boolean;/,
    "AvatarVideoSurfaceProps must declare isProducing — the coarse default is a judgement about"
      + " a shim this SDK does not own, and a consumer needs a way past it without a release",
  );
  // A prop that typechecks and is never read is the failure mode the adaptivePlayout suite
  // already caught once on this same pair of files.
  assert.match(
    nativeCode,
    /\bisProducing\b[\s\S]*?useLiveTrackProducing\(videoTrack, isProducing\)/,
    "isProducing is declared but never threaded into the hook",
  );
  const index = code(await readFile(NATIVE_INDEX, "utf8"));
  for (const name of ["isLiveTrackProducing", "isNativeLiveTrackSubscribed"]) {
    assert.match(
      index,
      new RegExp(`\\b${name}\\b`),
      `realtime-avatar/react-native must export ${name} — the isProducing prop is unusable without it`,
    );
  }
});
