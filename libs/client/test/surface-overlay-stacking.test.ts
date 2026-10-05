import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomContext } from "@livekit/components-react";
import { Room } from "livekit-client";
import type { AvatarVideoSurface as Surface } from "../src/react/index.ts";

/**
 * `AvatarVideoSurface`'s children — and so `AvatarCall`'s overlay — sit ABOVE both media layers
 * and the live badge, as the prop has always said they do.
 *
 * They were appended to the box bare. The live layer is `position: absolute; z-index: 20`, so a
 * consumer's positioned child with no z-index painted underneath it, and once the call went live
 * the live layer took the clicks: measured in Chromium 148, `elementFromPoint` at the centre of an
 * `absolute bottom-4 left-4` End button returned the live layer, not the button. An app's own
 * hang-up control became unclickable exactly when the call was billing.
 */
const sdk: { AvatarVideoSurface: typeof Surface } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

function render(children?: ReactNode): string {
  return renderToStaticMarkup(
    createElement(RoomContext.Provider, { value: new Room() },
      createElement(sdk.AvatarVideoSurface, { idleVideoUrl: null, poster: "/poster.png" }, children)),
  );
}

function zIndexOf(tag: string): number {
  return Number(/z-index:(\d+)/.exec(tag)?.[1] ?? Number.NaN);
}

test("overlay children are wrapped in a layer stacked above the live video and badge", () => {
  const html = render(createElement("button", { id: "end" }, "End"));
  const overlay = /<div[^>]*data-testid="avatar-overlay"[^>]*>/.exec(html)?.[0];
  assert.ok(overlay, "children are appended bare, beneath the z-index:20 live layer");
  assert.ok(html.indexOf(overlay) < html.indexOf('id="end"'), "the button is not inside the overlay layer");
  const live = /<div[^>]*data-testid="avatar-live-layer"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(zIndexOf(overlay) > zIndexOf(live), `overlay z ${zIndexOf(overlay)} is not above live z ${zIndexOf(live)}`);
  assert.ok(zIndexOf(overlay) > 30, "the overlay must also sit above the live badge (z 30)");
  assert.match(overlay, /position:absolute/);
  assert.match(overlay, /inset:0/);
});

test("no overlay layer is rendered when there is nothing to overlay", () => {
  assert.doesNotMatch(render(), /avatar-overlay/);
});
