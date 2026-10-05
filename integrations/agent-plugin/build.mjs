import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, rmSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
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
    "realtime-avatar": account("${CLAUDE_PLUGIN_ROOT}", "${user_config.api_key}", "${user_config.allow_writes}")
  } });
  json(join(target, ".cursor-plugin/plugin.json"), { ...metadata, mcpServers: "./mcp.cursor.json", variables: {
    type: "object", properties: {
      RTA_API_KEY: { type: "string", title: "RTA API key", description: "Your server-side RTA API key. Configure it here; keep it out of chat." },
      RTA_ALLOW_WRITES: { type: "string", title: "Enable account writes", enum: ["0", "1"], default: "0" }
    }, required: ["RTA_API_KEY"]
  } });
  json(join(target, "mcp.cursor.json"), { mcpServers: {
    "realtime-avatar": account("${CURSOR_PLUGIN_ROOT}", "${RTA_API_KEY}", "${RTA_ALLOW_WRITES}")
  } });
  json(join(target, "optional/preview.mcp.json"), { mcpServers: { "realtime-avatar-preview": preview } });
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
  const staging = mkdtempSync(join(tmpdir(), "rta-plugin-zip-"));
  try {
    cpSync(target, join(staging, "realtime-avatar"), { recursive: true });
    const files = readdirSync(join(staging, "realtime-avatar"), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => resolve(entry.parentPath ?? entry.path, entry.name).slice(staging.length + 1))
      .sort();
    for (const file of files) utimesSync(join(staging, file), 315532800, 315532800);
    execFileSync("zip", ["-q", "-X", zip, ...files], { cwd: staging, env: { ...process.env, TZ: "UTC" } });
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
  const versioned = `realtime-avatar-claude-cursor-${config.version}-${sha256.slice(0, 12)}.zip`;
  copyFileSync(zip, join(dist, versioned));
  const cursorLink = new URL("cursor://anysphere.cursor-deeplink/mcp/install");
  cursorLink.searchParams.set("name", "realtime-avatar-preview");
  cursorLink.searchParams.set("config", Buffer.from(JSON.stringify({ url: config.previewUrl })).toString("base64"));
  const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const branchUrl = config.repository + "/tree/main/plugins/realtime-avatar";
  const releaseTag = "agent-plugin-v" + config.version;
  const releaseUrl = config.repository + "/releases/tag/" + releaseTag;
  writeFileSync(join(dist, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Realtime Avatar for Claude and Cursor</title><style>body{font:16px system-ui;margin:0;background:#f6f8f7;color:#203229}main{max-width:860px;margin:auto;padding:32px 20px}h1{font-size:30px}h2{font-size:20px;margin-top:30px}p,li{line-height:1.6}a{color:#126744}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}nav{display:flex;gap:20px;flex-wrap:wrap}img{width:32px;height:32px;vertical-align:middle;margin-right:10px}details{border-top:1px solid #d3dfd6;padding-top:18px;margin-top:30px}summary{cursor:pointer}</style><main><h1><img src="logo.svg" alt="">Realtime Avatar</h1><p>Claude Code and Cursor integration · v${config.version}</p><nav><a href="${versioned}" download>Download plugin ZIP</a><a href="${releaseUrl}">GitHub release</a><a href="${branchUrl}">Source on main</a><a href="verification.json">Verification report</a></nav><h2>Your RTA account</h2><p>Inspect avatars, credits, usage and clips with ${config.mcpPackage}. Writes are opt-in. Configure your API key in the plugin settings; keys are never included in this download. The default install connects only to your account.</p><h2>Claude Code</h2><p>Unpack the ZIP, then launch:</p><pre>claude --plugin-dir ./realtime-avatar</pre><p>Or install from the repository marketplace:</p><pre>/plugin marketplace add theinfluencecompany/realtime-avatar-sdk\n/plugin install realtime-avatar@realtime-avatar-tools</pre><h2>Cursor</h2><p>Put the unpacked realtime-avatar folder in <code>~/.cursor/plugins/local</code>, reload Cursor, and configure <code>RTA_API_KEY</code> in the plugin settings. Teams can import the repository from Plugins &amp; MCPs.</p><h2>Try an integration task</h2><p>Use Realtime Avatar to inspect my ready avatars and credits, then add a voice and video call page to this app. Keep the key on the server and do not start a paid call.</p><details><summary>Optional hosted preview</summary><p>The preview is not installed or contacted by default. It has a shared three-call allowance, 45-second calls and a February 1, 2027 expiry. It is separate from your RTA account and is not a production account connection.</p><p><a href="${escape(cursorLink.href)}">Add preview to Cursor</a></p><p>For Claude Code, explicitly add it with:</p><pre>claude mcp add --transport http realtime-avatar-preview ${config.previewUrl}</pre><p>Claude web can use the same remote URL with Authentication: None. Personal-account OAuth for the web connector is not implemented.</p></details><p>Directory review is handled by each marketplace. See the verification report for the exact client, account and media checks completed for this release.</p><nav><a href="${config.homepage}">realtimeavatar.ai</a><a href="${config.documentation}">Documentation</a><a href="${config.support}">Support</a><a href="${config.privacy}">Privacy</a><a href="${config.terms}">Terms</a></nav></main></html>`);
  writeFileSync(join(dist, "SHA256SUMS"), `${sha256}  ${versioned}\n${sha256}  realtime-avatar-claude-cursor-${config.version}.zip\n`);
  const report = { version: config.version, mcpPackage: config.mcpPackage, file: versioned, sha256, releaseTag, releaseUrl, sourceUrl: branchUrl, previewIncludedByDefault: false, cursorPreviewInstall: cursorLink.href, previewUrl: config.previewUrl };
  json(join(dist, "release.json"), report);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(build(), null, 2));
