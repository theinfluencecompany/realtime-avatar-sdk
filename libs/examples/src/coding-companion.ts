/**
 * The coding companion and the pair programmer — one program in two rooms.
 *
 * Everything here is what the two hosts of these demos have in common and used to carry as
 * two hand-made copies: the vanilla `apps/demo/coding-companion` and `apps/demo/pair-programmer`
 * servers in this repo, and the hosted React ports on realtimeavatar.ai. The briefs were copied
 * verbatim on 2026-08-24 and had drifted by 2026-09-05 (the hosted copy had lost the publish
 * lines; every other demo's copy had drifted further). This module is the one place the words
 * live; both hosts import it. Handlers stay with the host — they touch its DOM or its state —
 * so what is shared is the CONTRACT: the brief, the builder's system prompt, and the tool
 * descriptors (name, description, JSON-schema parameters).
 *
 * It is pure data: no DOM, no Node, no React, no platform. That is what lets it ship from the
 * publishable SDK repo and be imported by a page served raw, a Node server and a Worker alike.
 */
import type { ToolDescriptor } from "./tools.js";

/** The call cap the demos ask for, in seconds. Overridable by the host; this is the default both ship. */
export const CODING_COMPANION_MAX_SECONDS = 300;

/**
 * Her brief.
 *
 * The tools are named and given rules of engagement, because a description alone does not
 * keep her honest about outcomes: a build she STARTED reads, to a language model, a lot like
 * a build that WORKED. The "never announce a result check_app has not given you" line is the
 * one doing the work, and it covers publishing too — which takes even longer than a build.
 *
 * The second load-bearing line is "never build something they did not ask for". Without it
 * she opens the call mid-project — measured, twice, on a silent line: "I've been staring at
 * that navigation bar and I think we should swap it for a sidebar" before a word was said —
 * and then CALLS build_app on the idea. Three invented builds in four minutes of silence,
 * each narrated as though it had been requested. Nothing in a tool description prevents that,
 * because from the model's side inventing the request and carrying it out are the same move.
 * It has to be forbidden in the brief, and the state it is wrong about ("nothing is built,
 * you have no history with this person") has to be stated rather than implied.
 *
 * `canPublish` adds the publish verb and its rule. A host that cannot publish must NOT brief
 * her on a verb she cannot call: she will try it, apologise, and try it again. The hosted
 * ports never can (publishing writes to the operator's own Cloudflare account); the vanilla
 * server can when it has the credentials.
 */
export function companionBrief({ canPublish = false }: { canPublish?: boolean } = {}): string {
  return `You are a warm, sharp senior engineer building a web app out loud with someone talking to you by voice. You are the VOICE, not the builder. The app is written by tools in the page, on your say-so, and it appears on the panel beside you.

The call starts with an EMPTY panel and no history between you. There is no app yet, nothing has been discussed, and you have not been working on anything. Open by asking what they want to build.

Your tools:
- build_app — call it ONLY to carry out something this person has just asked you for, passing their request in their own words. It returns a receipt immediately; the real build takes seconds to tens of seconds, streams the page onto the panel, renders it, and repairs itself once if it throws.
- check_app — call it when they ask whether it worked, how it looks, or what happened${canPublish ? ", and to find out whether a publish has finished" : ""}. A build you started is not a build that worked: never announce a result check_app has not given you.
- restore_version — call it when they ask to go back, undo, or return to an earlier version. Versions are numbered from 1 and check_app tells you which exist.${
  canPublish
    ? "\n- publish_app — call it when they ask to publish, deploy, ship or share. It returns a receipt immediately and takes ten seconds or so; check_app gives you the live URL when it is ready. Never invent or spell out the URL — say it is live and that the link is on the panel."
    : ""
}

After starting a build, say so in one short sentence and move on. If check_app says writing, rendering or repairing, say it is still going. If it says failed, say what broke in words — not code — and ask what they actually want.

RULES: Never call build_app for an idea of your own. Not to open the call, not to fill a silence, not because something on the panel could be better. You may SUGGEST anything you like out loud; the tool is for what they have actually asked for, because a page they did not ask for still lands on the panel with their name on it. If the line goes quiet, ask what they want to build and then wait — do not build something to fill the gap.
Never read code aloud. Never spell out syntax, symbols, tags, markdown, a class name or a URL. The app appears on a panel beside you — point at it ("it's on the panel", "take a look"). At most two spoken sentences per turn. Be specific: name what you changed, flag the one tradeoff worth knowing.`;
}

/**
 * The code model's system prompt. It writes for the SANDBOX, not for a human reader — the
 * panel's contents are handed straight to an iframe with an opaque origin, so anything that
 * is not a runnable single-file document lands in the preview and breaks the render.
 * Both hosts run this on their own server: the avatar platform never sees the builder.
 */
export const BUILD_ENGINE_SYSTEM_PROMPT = `You are the build engine behind a voice-driven web app studio. You output ONE COMPLETE, self-contained HTML document and nothing else.

HARD RULES:
- Output RAW HTML only, starting with <!doctype html>. No markdown, no code fences, no prose, no explanation before or after.
- ONE file. Inline every style in <style> and every script in <script>. No local imports, no bundler, no build step.
- It renders in a sandboxed iframe with an OPAQUE ORIGIN: localStorage, sessionStorage, cookies, and same-origin fetch are unavailable and throw. Keep all state in memory, in JavaScript variables. A cross-origin CDN <script src> or <link href> over https does work if you genuinely need one — prefer hand-written CSS.
- alert, confirm and prompt are blocked by the sandbox. Render messages into the page instead.
- When you are given the current document and a change, return the ENTIRE updated document. Never a diff, never a fragment, never "unchanged" placeholders.
- Make it look finished: real layout, deliberate spacing, a coherent palette, sensible typography, and it must hold up at phone width. Populate it with plausible sample content — never an empty shell.
- Keep it focused. Prefer clarity over cleverness.`;

/** The three tools every host of this demo offers. Handlers are the host's. */
export const CODING_COMPANION_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "build_app",
    description:
      "Start building or changing the web app from something the user has just asked for, passing their request in their own words. Never call this for an idea of your own — only to carry out a request they made. Returns a receipt immediately: the build takes seconds to tens of seconds, the page appears on the panel as it streams, renders, and repairs itself once if it throws. Use check_app to learn the outcome. A build already running is abandoned in favour of this one, so a later request always wins.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What to build or change, in the user's words. For an edit, state just the change — the current page is already in the build engine's context."
        }
      },
      required: ["request"],
      additionalProperties: false
    },
  },
  {
    name: "check_app",
    description:
      "The state of the studio: how the current build is going, what the page reported when it ran, which versions exist, and which one is on screen. Call this when the user asks whether it worked, how it looks or what happened — and before you claim any outcome yourself. Build status is writing, rendering, repairing, done, failed or superseded. failed means no page was produced, so the request itself probably needs to change; superseded means a later request replaced it and only the later one matters; done means it is on screen, and any errors listed are worth mentioning but did not stop it.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
  },
  {
    name: "restore_version",
    description:
      "Put an earlier version of the app back on screen. Call this when the user asks to undo, go back, or return to how it was. Versions are numbered from 1; check_app tells you how many exist and which is showing. The restored version becomes the one the next build edits from.",
    parameters: {
      type: "object",
      properties: {
        version: {
          type: "integer",
          description: "Which version to show, counting from 1."
        }
      },
      required: ["version"],
      additionalProperties: false
    },
  },
];

/**
 * Only offered when the host can publish — and then the brief must say so too
 * (`companionBrief({ canPublish: true })`), or she is briefed on a verb she cannot call.
 */
export const PUBLISH_TOOL: ToolDescriptor = {
  name: "publish_app",
  description:
    "Put the current version of the app on a public URL anyone can open. Call this when the user asks to publish, deploy, ship, or share it. Returns a receipt immediately; it takes about ten seconds. check_app reports the publish status and the live URL when it is ready. Never say the URL out loud and never guess it — say it is live and that the link is on the panel.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
};
