import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RealtimeAvatar, isQueued } from "realtime-avatar";

/**
 * Mirrors this package's `version`. It reaches the wire twice — as the MCP server's own
 * identity, and inside the `User-Agent` — so a stale value misattributes real traffic.
 * `test/server.test.ts` asserts the two stay equal; the equivalent constant in
 * `realtime-avatar` had that guard and this one did not, which is how it drifted.
 */
export const MCP_VERSION = "0.2.1";

/**
 * The Realtime Avatar MCP server.
 *
 * `AGENTS.md` tells an agent what the API is. This lets it *look* — at your avatars, your
 * balance, your bill — instead of guessing ids and inventing shapes. Reading docs is the
 * 2024 answer; the 2026 one is that the agent can just ask.
 *
 * ## Why almost everything here is read-only
 *
 * An agent exploring your account should not be able to spend your money or mutate your
 * avatars by accident. So the default surface is entirely reads. Everything that writes —
 * starting a call, creating an avatar, syncing clips, uploading a file — is behind an
 * explicit opt-in (`allowWrites`).
 *
 * Of those, only `start_call` spends credits, and it additionally refuses a live key. The
 * rest mutate account state without billing. `upload_asset` is the other one to understand
 * before arming: it reads a path off this machine's disk. Read `libs/mcp/README.md` first.
 */
export interface CreateServerOptions {
  apiKey: string;
  baseUrl?: string;
  /**
   * Expose the tools that cost credits or change account state. Default `false`.
   *
   * Off, this server can be pointed at a production key with no more risk than a dashboard
   * you left open. On, an agent can start billable calls.
   */
  allowWrites?: boolean;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const MICROS_PER_CREDIT = 1_000_000;

/** Extension -> asset kind, so a caller does not have to restate what the filename says. */
const KIND_BY_EXT: Record<string, "image" | "video" | "audio"> = {
  ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
};

/** Refuse early rather than streaming a gigabyte at the API to be rejected there. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Credit micros as something a human reads without counting zeros. */
function credits(micros: number | null): string {
  if (micros === null) return "—";
  return `${(micros / MICROS_PER_CREDIT).toFixed(2)} credits`;
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** A tool-level error the model can read and correct, not a thrown exception. */
const fail = (body: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: body }],
});

export function createServer(options: CreateServerOptions): McpServer {
  const rta = new RealtimeAvatar({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    userAgent: `realtime-avatar-mcp/${MCP_VERSION}`,
  });
  const isLiveKey = options.apiKey.startsWith("tic_live_");

  const server = new McpServer(
    { name: "realtime-avatar-mcp", version: MCP_VERSION },
    {
      instructions:
        "Realtime Avatar: a live character your users can talk to. Start calls from your " +
        "server, relay the connection payload to the browser untouched. Use list_avatars to " +
        "find a real avatarId before writing code — never invent one. Every call is full " +
        "duplex; mode:'avatar' (the default) adds video, mode:'voice' is cheaper audio-only. " +
        "Billing is per second.",
    },
  );

  // ── reads ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_avatars",
    {
      title: "List avatars",
      description:
        "Every avatar on this account, with the id you pass to startCall. Call this before " +
        "writing code — avatar ids cannot be guessed. `sourceKind: 'image'` avatars publish " +
        "a BLACK video track on a live call; prefer 'video'.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const avatars = await rta.listAvatars();
      if (avatars.length === 0) {
        return text("No avatars yet. Create one from a video URL before starting a call.");
      }
      const rows = avatars.map(
        (a) => `${a.id}  ${a.status.padEnd(13)} ${a.sourceKind.padEnd(5)} ${a.displayName}`,
      );
      const usable = avatars.filter((a) => a.status === "ready" && a.sourceKind === "video");
      return text(
        `${avatars.length} avatar(s). ${usable.length} ready + video-sourced (usable for a live call).\n\n` +
          `id                                    status        kind  name\n${rows.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "get_avatar",
    {
      title: "Get one avatar",
      description: "Full detail for a single avatar, including its clip set and voice.",
      inputSchema: { avatarId: z.string().describe("e.g. ava_1234…") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ avatarId }) => text(JSON.stringify(await rta.getAvatar(avatarId), null, 2)),
  );

  server.registerTool(
    "credit_balance",
    {
      title: "Credit balance",
      description: "Current balance and how much is reserved by in-flight calls.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const balance = await rta.creditBalance();
      return text(
        `balance  ${credits(balance.balanceCreditMicros)}\n` +
          `reserved ${credits(balance.reservedCreditMicros)} (held by calls in flight)`,
      );
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List billable sessions",
      description:
        "The itemised bill: every session with when it ran, how long it was billable for, " +
        "and what it cost. Billing is per SECOND — activeSeconds is real wall time, never " +
        "rounded up to a minute. Pass endUserId to see one of your own users, which works " +
        "only if the call was started with metadata.user_id.",
      inputSchema: {
        from: z.string().optional().describe("ISO timestamp. Defaults to 30 days ago."),
        to: z.string().optional().describe("ISO timestamp. Defaults to now."),
        endUserId: z.string().optional().describe("Your own user id, from metadata.user_id"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, endUserId, limit }) => {
      const page = await rta.listSessions({ from, to, endUserId, limit });
      if (page.sessions.length === 0) return text(`No sessions between ${page.from} and ${page.to}.`);
      const rows = page.sessions.map((s) => {
        const seconds = s.activeSeconds === null ? "—" : `${s.activeSeconds.toFixed(1)}s`;
        const user = typeof s.metadata.user_id === "string" ? s.metadata.user_id : "";
        return `${(s.startedAt ?? s.createdAt).slice(0, 19)}  ${seconds.padStart(8)}  ${credits(s.billedCreditMicros).padStart(14)}  ${user}`;
      });
      const total = page.sessions.reduce((sum, s) => sum + (s.billedCreditMicros ?? 0), 0);
      return text(
        `${page.sessions.length} session(s), ${page.from.slice(0, 10)} → ${page.to.slice(0, 10)}\n\n` +
          `started              duration           cost  user\n${rows.join("\n")}\n\n` +
          `total ${credits(total)}` +
          (page.nextCursor ? "\n(more pages available)" : ""),
      );
    },
  );

  if (!options.allowWrites) return server;

  // ── writes, opt-in only ────────────────────────────────────────────────────

  server.registerTool(
    "start_call",
    {
      title: "Start a call (SPENDS CREDITS)",
      description:
        "Mint a live session to verify an integration end to end. This starts a real call " +
        "and bills for it by the second. maxSeconds is the cap and you should keep it small. " +
        "Returns the connection payload, which a browser client relays UNTOUCHED.",
      inputSchema: {
        avatarId: z.string(),
        maxSeconds: z.number().int().min(1).max(300).default(60)
          .describe("Hard cap. Keep it small — this is billed."),
        mode: z.enum(["voice", "avatar"]).optional().describe("'avatar' for video"),
        endUserId: z.string().optional().describe("Tags the session so it shows on the bill"),
      },
      // Not destructive (it creates nothing you must undo), but it is emphatically not
      // read-only and it touches the outside world. Say so, so a host can gate it.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ avatarId, maxSeconds, mode, endUserId }) => {
      // A live key bills a real customer account. An agent poking at an integration should
      // never be able to do that, whatever the operator turned on.
      if (isLiveKey) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Refusing: this is a tic_live_ key and this tool spends real credits. " +
              "Point the server at a tic_test_ key to start calls.",
          }],
        };
      }
      const call = await rta.startCall({
        avatarId,
        maxSeconds,
        mode,
        ...(endUserId ? { metadata: { user_id: endUserId } } : {}),
      });
      if (isQueued(call)) {
        return text(`Queued at position ${call.position ?? "?"} — retry in ${call.retryAfterMs}ms.`);
      }
      return text(
        `Started ${call.raw.session_id}\nroom ${call.raw.room_name}\n\n` +
          "Relay this payload to the browser byte-for-byte — the client SDK validates it " +
          "strictly and rejects a reshaped object.",
      );
    },
  );

  server.registerTool(
    "sync_clips",
    {
      title: "Sync an avatar's clips",
      description:
        "Prepare an avatar's clip set. Clips are prepared once and cached by URL hash, and " +
        "the serve path only LOADS that cache — so a clip you added but never synced does " +
        "nothing at all on the next call, silently. Idempotent: call it after every clip " +
        "change. Pass the complete set you want live; anything omitted is retired. This does " +
        "not spend credits.",
      inputSchema: {
        avatarId: z.string(),
        clipUrls: z.array(z.string().url()).max(64)
          .describe("The COMPLETE set that should be live. Omitted clips are retired."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ avatarId, clipUrls }) => {
      const result = await rta.syncClips(avatarId, clipUrls);
      const line = (label: string, urls: string[]) =>
        urls.length ? `${label} (${urls.length})\n  ${urls.join("\n  ")}` : `${label} (0)`;
      return text(
        [
          line("queued — preparing now", result.queued),
          line("ready — already cached", result.ready),
          line("retired — no longer live", result.retired),
        ].join("\n") +
          (result.queued.length
            ? "\n\nQueued clips are not usable until they finish preparing."
            : ""),
      );
    },
  );

  server.registerTool(
    "upload_asset",
    {
      title: "Upload a local file",
      description:
        "Upload a file FROM THIS MACHINE'S DISK and get back a public URL usable as a clip " +
        "or avatar source. Give an absolute path. Kind is inferred from the extension when " +
        "you omit it. Does not spend credits. If the file is already on the internet, use " +
        "create_remote_asset instead — it needs no local copy.",
      inputSchema: {
        path: z.string().describe("Absolute path on the machine running this server"),
        kind: z.enum(["image", "video", "audio"]).optional()
          .describe("Inferred from the extension when omitted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ path, kind }) => {
      // This tool reads local disk. Require an absolute path so a relative one cannot resolve
      // against whatever directory the host happened to spawn the server in.
      if (!isAbsolute(path)) {
        return fail(`Give an absolute path — got "${path}".`);
      }
      const full = resolve(path);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) return fail(`No file at ${full}`);
      if (info.size > MAX_UPLOAD_BYTES) {
        return fail(`${full} is ${(info.size / 1e6).toFixed(0)}MB — over the ${MAX_UPLOAD_BYTES / 1e6}MB limit.`);
      }
      const resolvedKind = kind ?? KIND_BY_EXT[extname(full).toLowerCase()];
      if (!resolvedKind) {
        return fail(`Cannot tell what ${extname(full) || "this file"} is — pass kind explicitly.`);
      }
      const asset = await rta.uploadAsset(await openAsBlob(full), {
        kind: resolvedKind,
        filename: basename(full),
      });
      return text(`Uploaded ${asset.id} (${resolvedKind}, ${(info.size / 1e6).toFixed(1)}MB)\n${asset.url}`);
    },
  );

  server.registerTool(
    "create_remote_asset",
    {
      title: "Register a file already on the internet",
      description:
        "Point at a public URL and get an asset back without downloading it locally. Use " +
        "this instead of upload_asset whenever the file is already hosted somewhere.",
      inputSchema: {
        remoteUrl: z.string().url(),
        kind: z.enum(["image", "video", "audio"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ remoteUrl, kind }) => {
      const asset = await rta.createRemoteAsset({ kind, remoteUrl });
      return text(`Created ${asset.id} (${kind})\n${asset.url}`);
    },
  );

  server.registerTool(
    "create_avatar_from_video",
    {
      title: "Create an avatar from a video",
      description:
        "Build an avatar from a looping video URL. Use a VIDEO source: an avatar built from " +
        "a still image reaches 'ready' and then publishes a black track on every call.",
      inputSchema: {
        displayName: z.string(),
        videoUrl: z.string().url().describe("Publicly reachable mp4, opening and closing on the same rest pose"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ displayName, videoUrl }) => {
      const avatar = await rta.createAvatarFromVideo({ displayName, videoUrl });
      return text(`Created ${avatar.id} (${avatar.status}). Poll get_avatar until it is ready.`);
    },
  );

  return server;
}
