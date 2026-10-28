import test from "node:test";
import assert from "node:assert/strict";

// Through the package's own exports map, as a consumer imports it: `realtime-avatar` for the
// server half and `realtime-avatar/react` for the keyless half. Both resolve to the built dist.
import * as server from "realtime-avatar";
import * as react from "realtime-avatar/react";
import { publishedFishModel } from "../../client/test/published-fish-model.fixture.ts";

/**
 * A consumer that stores a Fish model id (a free string in its own database) has to turn it into
 * the SDK's `FishTtsModel` before it can build a `VoiceSpecInput`. Without a public validator its
 * only options were a cast or a copy of the model list, and a copy is the hand-kept list that once
 * refused `drama-3` and `s2.1-pro` while the platform accepted both.
 *
 * So the generated schema and default are public, and this asserts them against the committed
 * contract, not against the generated file they come from.
 */
const entries = [
  ["realtime-avatar", server],
  ["realtime-avatar/react", react],
] as const;

for (const [name, entry] of entries) {
  test(`${name} validates every Fish model id the published contract lists`, async () => {
    const { ids } = await publishedFishModel();
    assert.ok(ids.includes("s2.1-pro") && ids.includes("speech-1.6"), "the contract lists live and deprecated ids");
    for (const id of ids) {
      const parsed = entry.fishTtsModelSchema.safeParse(id);
      assert.ok(parsed.success, `${name} refused ${id}`);
      assert.equal(parsed.data, id);
    }
  });

  test(`${name} rejects a Fish model id the contract does not list`, () => {
    for (const stored of ["speech-2", "S2.1-PRO", "", null, 2]) {
      assert.equal(entry.fishTtsModelSchema.safeParse(stored).success, false, `${name} accepted ${String(stored)}`);
    }
  });

  test(`${name} exports the contract's Fish default`, async () => {
    const published = await publishedFishModel();
    assert.equal(entry.DEFAULT_FISH_TTS_MODEL, published.default);
    assert.ok(entry.fishTtsModelSchema.safeParse(entry.DEFAULT_FISH_TTS_MODEL).success);
  });
}
