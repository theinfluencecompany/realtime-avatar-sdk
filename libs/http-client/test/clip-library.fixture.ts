import type { ClipLibrary, ClipLibraryDeclaration, ClipLibraryUpdate } from "../src/types.ts";

export const CLIP_DECLARATION = {
  expectedRevision: 0,
  clips: {
    rest: { source: { assetId: "ast_rest" } },
    nod: { source: { motionPrompt: "nods attentively" } },
    wave: { source: { motionPrompt: "waves hello", durationSeconds: 6 } },
  },
  idle: { clips: ["rest", "nod"], weight: 0.25 },
  on: {
    userSpeechStarted: { clips: ["nod"] },
  },
  actions: {
    greet: {
      description: "When greeting the user",
      clips: ["wave", "rest"],
    },
  },
} satisfies ClipLibraryDeclaration;

export const CLIP_LIBRARY = {
  data: [{
    clipId: "rest", status: "ready", url: "https://cdn.example/rest.mp4",
    source: "uploaded", uploadAssetId: "ast_rest",
    motionPrompt: null, durationSeconds: null, anchorVersion: 1, poseCheck: null, error: null,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  }, {
    clipId: "nod", status: "ready", url: "https://cdn.example/nod.mp4",
    source: "generated", uploadAssetId: null,
    motionPrompt: "nods attentively", durationSeconds: 5, anchorVersion: 1,
    poseCheck: null, error: null,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  }, {
    clipId: "wave", status: "queued", url: null,
    source: "generated", uploadAssetId: null,
    motionPrompt: "waves hello", durationSeconds: 6, anchorVersion: 1,
    poseCheck: null, error: null,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  }],
  avatarId: "ava_1", revision: 1, anchorVersion: 1,
  anchor: { url: "https://cdn.example/rest.png", source: "portrait", timeMs: null },
  clipLibraryEligible: true,
  defaultSourceAssetId: "ast_default",
  behavior: {
    idle: CLIP_DECLARATION.idle,
    on: CLIP_DECLARATION.on,
    actions: CLIP_DECLARATION.actions,
  },
} satisfies ClipLibrary;

export const CLIP_UPDATE = {
  ...CLIP_LIBRARY,
  plan: { kept: ["rest", "nod"], queued: ["wave"], retired: ["old_idle"] },
} satisfies ClipLibraryUpdate;

export const INVALID_CLIP_DECLARATIONS: {
  name: string;
  body: Record<string, unknown>;
  path: (string | number)[];
}[] = [];

for (const lane of ["idle", "userSpeechStarted", "actions"] as const) {
  const path = lane === "idle" ? ["idle", "clips"] : lane === "userSpeechStarted"
    ? ["on", lane, "clips"] : ["actions", "greet", "clips"];
  for (const [name, clips, index] of [
    ["unknown reference", ["missing"], 0],
    ["duplicate", ["rest", "rest"], 1],
  ] as const) {
    const behavior = lane === "idle" ? { idle: { clips: [...clips] } } : lane === "userSpeechStarted"
      ? { on: { userSpeechStarted: { clips: [...clips] } } }
      : { actions: { greet: { description: "Greeting", clips: [...clips] } } };
    INVALID_CLIP_DECLARATIONS.push({
      name: `${lane} ${name}`, body: { ...CLIP_DECLARATION, ...behavior }, path: [...path, index],
    });
  }
}

for (const id of ["__proto__", "constructor", "prototype"]) {
  INVALID_CLIP_DECLARATIONS.push({
    name: `reserved clip key ${id}`,
    body: { expectedRevision: 0, clips: Object.fromEntries([[id, { source: { assetId: "ast_1" } }]]) },
    path: ["clips", id],
  }, {
    name: `reserved action key ${id}`,
    body: {
      ...CLIP_DECLARATION,
      actions: Object.fromEntries([[id, { description: "Greeting", clips: ["rest"] }]]),
    },
    path: ["actions", id],
  }, {
    name: `reserved clip reference ${id}`,
    body: { ...CLIP_DECLARATION, idle: { clips: [id] } },
    path: ["idle", "clips", 0],
  });
}

// "primary" is the implicit rest state — the avatar's stored source — never authored media.
INVALID_CLIP_DECLARATIONS.push({
  name: "reserved clip key primary",
  body: {
    ...CLIP_DECLARATION,
    clips: { ...CLIP_DECLARATION.clips, primary: { source: { motionPrompt: "rests" } } },
  },
  path: ["clips", "primary"],
});

for (const field of ["assetId", "motionPrompt"]) {
  INVALID_CLIP_DECLARATIONS.push({
    name: `whitespace source ${field}`,
    body: { expectedRevision: 0, clips: { wave: { source: { [field]: " \t\n " } } } },
    path: ["clips", "wave", "source", field],
  });
}
INVALID_CLIP_DECLARATIONS.push({
  name: "whitespace action description",
  body: { ...CLIP_DECLARATION, actions: { greet: { description: " \t\n ", clips: ["wave"] } } },
  path: ["actions", "greet", "description"],
});
