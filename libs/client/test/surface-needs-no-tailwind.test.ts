import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomContext } from "@livekit/components-react";
import { Room } from "livekit-client";
import type { AvatarVideoSurface as Surface } from "../src/react/index.ts";

/**
 * The video surface lays itself out with no help from the consumer's CSS build.
 *
 * It used to style everything with Tailwind utility strings. Tailwind only generates a rule for a
 * class it finds in a file it scans, and it does not scan `node_modules`, so an app had to add an
 * `@source` for this package's `dist/react.js` or the layout was purged: the face crop
 * (`[object-position:center_22%]`) appears in no app's own code, and without `absolute inset-0`
 * the poster, idle clip and live video stack in flow instead of over each other. An app without
 * Tailwind had no layout at all. Inline styles need no build step and no configuration.
 *
 * Renders the SHIPPED entry (built by `pretest`) to static markup inside a LiveKit room context.
 */
const sdk: { AvatarVideoSurface: typeof Surface } = await import(
  new URL("../../sdk-server/dist/react.js", import.meta.url).href
);

function render(children?: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      RoomContext.Provider,
      { value: new Room() },
      createElement(sdk.AvatarVideoSurface, { idleVideoUrl: "/idle.mp4", poster: "/poster.png", fit: "cover" }, children),
    ),
  );
}

/** The inline style of the element carrying `data-testid`, as a property map. */
function styleOf(html: string, testId: string): Record<string, string> {
  const tag = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  assert.ok(tag, `no element with data-testid=${testId}`);
  const style = /style="([^"]*)"/.exec(tag)?.[1] ?? "";
  return Object.fromEntries(
    style.split(";").filter(Boolean).map((rule) => {
      const at = rule.indexOf(":");
      return [rule.slice(0, at).trim(), rule.slice(at + 1).trim()];
    }),
  );
}

test("every media layer positions and crops itself inline", () => {
  const html = render();
  for (const layer of ["avatar-poster", "avatar-idle-video", "avatar-live-layer"]) {
    const style = styleOf(html, layer);
    assert.equal(style.position, "absolute", `${layer} relies on a Tailwind class to sit over the box`);
    assert.equal(style.inset, "0", layer);
  }
  for (const media of ["avatar-poster", "avatar-idle-video"]) {
    const style = styleOf(html, media);
    assert.equal(style["object-position"], "center 22%", `${media}: the face crop is a class no app's build generates`);
    assert.equal(style["object-fit"], "cover", media);
  }
});

test("the box establishes the containing block the layers fill", () => {
  const html = render();
  const style = styleOf(html, "avatar-video-surface");
  assert.equal(style.position, "relative");
  assert.equal(style.overflow, "hidden");
  assert.equal(style.width, "100%");
  assert.equal(style.height, "100%");
});
