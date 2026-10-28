import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";

import type * as server from "../../sdk-server/src/index.ts";
import type * as react from "../../sdk-server/src/react.ts";
import type * as native from "../../sdk-server/src/react-native.ts";

/**
 * The public Fish validator is only worth exporting if what it returns IS the public
 * `FishTtsModel`, with no cast between them. These are type assertions against each entry's
 * source, checked by `npm run typecheck`; the runtime half is libs/sdk-server/test/fish-tts-model.test.ts.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type AssertTrue<Value extends true> = Value;

type _ReactParsesToItsType = AssertTrue<Equal<z.infer<typeof react.fishTtsModelSchema>, react.FishTtsModel>>;
type _NativeParsesToItsType = AssertTrue<Equal<z.infer<typeof native.fishTtsModelSchema>, native.FishTtsModel>>;
type _ServerParsesToItsType = AssertTrue<Equal<z.infer<typeof server.fishTtsModelSchema>, server.FishTtsModel>>;
type _OneTypeAcrossEntries = AssertTrue<Equal<server.FishTtsModel, react.FishTtsModel>>;
type _NativeMatchesWeb = AssertTrue<Equal<native.FishTtsModel, react.FishTtsModel>>;
type _DefaultIsAModel = AssertTrue<typeof react.DEFAULT_FISH_TTS_MODEL extends react.FishTtsModel ? true : false>;
// A validated id fits the voice a consumer passes to the call, with no cast.
type _FitsVoiceSpecInput = AssertTrue<
  { provider: "fish"; voice_id: string; model: react.FishTtsModel } extends react.VoiceSpecInput ? true : false
>;

test("every entry's Fish validator returns that entry's public FishTtsModel", () => {
  const checked: [
    _ReactParsesToItsType,
    _NativeParsesToItsType,
    _ServerParsesToItsType,
    _OneTypeAcrossEntries,
    _NativeMatchesWeb,
    _DefaultIsAModel,
    _FitsVoiceSpecInput,
  ] = [true, true, true, true, true, true, true];
  assert.equal(checked.length, 7);
});
