import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const root = fileURLToPath(new URL(".", import.meta.url));
export const config = JSON.parse(readFileSync(join(root, "integration.json"), "utf8"));
export function build() {
  const repo = resolve(root, "../..");
  const target = join(repo, "plugins/realtime-avatar");
  const dist = join(root, "dist");
  const json = (path, value) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
  mkdirSync(target, { recursive: true });
  mkdirSync(dist, { recursive: true });
  const metadata = { name: config.name, version: config.version, description: config.description,
    author: { name: "The Influence Company", email: "support@realtimeavatar.ai" },
    homepage: config.homepage, repository: config.repository, license: "MIT", keywords: ["avatar", "video", "voice", "realtime", "mcp"] };
  const preview = { type: "http", url: config.previewUrl };
  const account = (pluginRoot, key, writes) => ({ type: "stdio", command: "node", args: [pluginRoot + "/account.mjs"],
    env: { RTA_PLUGIN_API_KEY: key, RTA_PLUGIN_ALLOW_WRITES: writes } });
  json(join(target, ".claude-plugin/plugin.json"), { ...metadata, displayName: config.displayName, mcpServers: "./mcp.claude.json", userConfig: {
    api_key: { type: "string", title: "RTA API key", description: "Your server-side RTA key. Leave blank to use REALTIME_AVATAR_API_KEY from the environment.", sensitive: true, default: "" },
    allow_writes: { type: "string", title: "Enable account writes", description: "0 keeps account tools read-only; 1 enables changes and potentially billable operations.", default: "0" }
  } });
  json(join(target, "mcp.claude.json"), { mcpServers: {
    "realtime-avatar": account("${CLAUDE_PLUGIN_ROOT}", "${user_config.api_key}", "${user_config.allow_writes}"),
    "realtime-avatar-preview": preview
  } });
  json(join(target, ".cursor-plugin/plugin.json"), { ...metadata, mcpServers: "./mcp.cursor.json", variables: {
    type: "object", properties: {
      RTA_API_KEY: { type: "string", title: "RTA API key", description: "Your server-side RTA API key. Configure it here; keep it out of chat." },
      RTA_ALLOW_WRITES: { type: "string", title: "Enable account writes", enum: ["0", "1"], default: "0" }
    }, required: ["RTA_API_KEY"]
  } });
  json(join(target, "mcp.cursor.json"), { mcpServers: {
    "realtime-avatar": account("${CURSOR_PLUGIN_ROOT}", "${RTA_API_KEY}", "${RTA_ALLOW_WRITES}"),
    "realtime-avatar-preview": preview
  } });
  for (const file of ["account.mjs", "integration.json", "README.md"]) copyFileSync(join(root, file), join(target, file));
  copyFileSync(join(repo, "LICENSE"), join(target, "LICENSE"));
  cpSync(join(root, "skills"), join(target, "skills"), { recursive: true });
  cpSync(join(root, "assets"), join(target, "assets"), { recursive: true });
  copyFileSync(join(root, "assets/logo.svg"), join(dist, "logo.svg"));
  const marketplace = { name: "realtime-avatar-tools", owner: metadata.author,
    metadata: { description: "Realtime Avatar account tools and integration skills for coding agents." },
    plugins: [{ name: config.name, source: "./plugins/realtime-avatar", description: config.description, version: config.version }] };
  json(join(repo, ".claude-plugin/marketplace.json"), marketplace);
  json(join(repo, ".cursor-plugin/marketplace.json"), marketplace);
  const zip = join(dist, `realtime-avatar-claude-cursor-${config.version}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", zip, "realtime-avatar"], { cwd: join(repo, "plugins") });
  const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
  const versioned = `realtime-avatar-claude-cursor-${config.version}-${sha256.slice(0, 12)}.zip`;
  copyFileSync(zip, join(dist, versioned));
  const cursorLink = new URL("cursor://anysphere.cursor-deeplink/mcp/install");
  cursorLink.searchParams.set("name", "realtime-avatar-preview");
  cursorLink.searchParams.set("config", Buffer.from(JSON.stringify({ url: config.previewUrl })).toString("base64"));
  const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const branchUrl = config.repository + "/tree/feat/claude-cursor-integration-20261004/plugins/realtime-avatar";
  writeFileSync(join(dist, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Realtime Avatar for Claude and Cursor</title><style>body{font:16px system-ui;margin:0;background:#f6f8f7;color:#203229}main{max-width:860px;margin:auto;padding:32px 20px}h1{font-size:30px}h2{font-size:20px;margin-top:30px}p,li{line-height:1.6}a{color:#126744}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}nav{display:flex;gap:20px;flex-wrap:wrap}img{width:32px;height:32px;vertical-align:middle;margin-right:10px}</style><main><h1><img src="logo.svg" alt="">Realtime Avatar</h1><p>Claude Code and Cursor integration · v${config.version}</p><nav><a href="${versioned}" download>Download plugin ZIP</a><a href="${escape(cursorLink.href)}">Add hosted preview to Cursor</a><a href="${branchUrl}">Source on GitHub</a></nav><h2>Your RTA account</h2><p>Inspect avatars, credits, usage and clips with the published realtime-avatar-mcp server. Writes are opt-in. Configure your API key in the plugin settings; keys are never included in this download.</p><h2>Claude Code</h2><p>Unpack the ZIP, then launch:</p><pre>claude --plugin-dir ./realtime-avatar</pre><p>The repository also includes a Claude marketplace manifest. Use the feature branch until the change merges.</p><h2>Cursor</h2><p>Put the unpacked realtime-avatar folder in <code>~/.cursor/plugins/local</code>, reload Cursor, and configure the plugin. The preview install link above installs only the separate hosted review connection.</p><h2>Claude web connector</h2><p>Add this remote MCP URL with Authentication: None:</p><pre>${config.previewUrl}</pre><p>This is the operator-funded review, ending February 1, 2027, with a shared three-call limit and 45-second calls. It does not expose your personal account. Local account tools require Claude Code or Cursor; remote account OAuth is not implemented.</p><h2>Try an integration task</h2><p>Use Realtime Avatar to inspect my ready avatars and credits, then add a voice and video call page to this app. Keep the key on the server and do not start a paid call.</p><p>Marketplace approval and actual Claude/Cursor media testing are separate from package and protocol verification.</p><nav><a href="${config.homepage}">realtimeavatar.ai</a><a href="${config.documentation}">Documentation</a><a href="${config.support}">Support</a><a href="${config.privacy}">Privacy</a><a href="${config.terms}">Terms</a></nav></main></html>`);
  const report = { version: config.version, file: versioned, sha256, cursorPreviewInstall: cursorLink.href, previewUrl: config.previewUrl };
  json(join(dist, "release.json"), report);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(), null, 2));
