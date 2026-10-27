import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function regularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function insideRepo(file) {
  const rel = relative(root, resolve(root, file));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const parsed = args(process.argv.slice(2));
const adapter = parsed.adapter;
const out = typeof parsed.out === "string" ? parsed.out : join(tmpdir(), `nema-thread-semantic-${adapter || "run"}.json`);

function blocked(blocker) {
  writeFileSync(out, JSON.stringify({
    status: "blocked",
    semantic: "not-run",
    adapter: adapter ?? null,
    configuredModel: typeof parsed.model === "string" ? parsed.model : null,
    commit: null,
    blocker,
    checks: [],
  }, null, 2) + "\n");
  console.error(blocker);
  console.error(out);
  process.exit(2);
}

if (insideRepo(out)) blocked("refusing to write acceptance output inside the repository");
if (adapter !== "codex-direct" && adapter !== "claude-code") blocked("adapter must be codex-direct or claude-code");

const codexHome = (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
const claudeTokenFile = typeof parsed["claude-token-file"] === "string" ? parsed["claude-token-file"] : "";
if (adapter === "codex-direct" && !regularFile(join(codexHome, "auth.json"))) {
  blocked("Codex auth.json is missing or not a regular file");
}
if (adapter === "claude-code" && !regularFile(claudeTokenFile)) {
  blocked("Claude Code token file is missing or not a regular file");
}

const runner = join(root, "apps/local/dist/test/threadSemanticRun.js");
if (!regularFile(runner)) blocked("compiled acceptance runner missing; run npm run typecheck");

const child = spawnSync(process.execPath, [runner, ...process.argv.slice(2), "--out", out], { stdio: "inherit", env: process.env, cwd: root });
process.exit(child.status ?? 1);
