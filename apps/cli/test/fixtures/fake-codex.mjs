#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const argv = process.argv.slice(2);
// Grandchild modes: spawn the grandchild and record its pid before anything else, so tests can rely on .gcpid.
if ((mode === "grandchild-hang" || mode === "grandchild-foreign") && process.env.FAKE_CODEX_DUMP) {
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_CODEX_DUMP + ".gcpid", String(gc.pid));
}
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const c of process.stdin) stdin += c;

if (process.env.FAKE_CODEX_DUMP) {
  writeFileSync(process.env.FAKE_CODEX_DUMP, JSON.stringify({ argv, envKeys: Object.keys(process.env).filter((k) => !k.startsWith("FAKE_CODEX_")).sort(), stdin }));
}
const oIdx = argv.indexOf("-o");
const outFile = oIdx >= 0 ? argv[oIdx + 1] : undefined;
const sample = () => readFileSync(new URL("./codex-ok.jsonl", import.meta.url), "utf8");

if (mode === "ok" || mode === "replace-auth") {
  process.stdout.write(sample());
  writeFileSync(outFile, "已更新：需求 R-1");
  if (mode === "replace-auth") {
    // simulate Codex refreshing tokens by atomic rename: symlink replaced by a regular file
    const link = path.join(process.env.CODEX_HOME, "auth.json");
    rmSync(link);
    writeFileSync(link, '{"token":"refreshed"}', { mode: 0o644 });
  }
  process.exit(0);
} else if (mode === "exit1") {
  process.stderr.write("boom\n");
  process.exit(1);
} else if (mode === "badjson") {
  process.stdout.write("garbage\n{not json\n");
  process.exit(0);
} else if (mode === "foreign-mcp") {
  if (process.env.FAKE_CODEX_DUMP) writeFileSync(process.env.FAKE_CODEX_DUMP + ".pid", String(process.pid));
  process.stdout.write(JSON.stringify({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "github", tool: "x", status: "in_progress" } }) + "\n");
  setInterval(() => {}, 1000);
} else if (mode === "grandchild-hang" || mode === "grandchild-foreign") {
  if (mode === "grandchild-foreign") {
    process.stdout.write(JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "x" } }) + "\n");
  }
  setInterval(() => {}, 1000);
} else if (mode === "utf8-split") {
  const bytes = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "已更新：需求" } }) + "\n");
  const cut = bytes.indexOf(Buffer.from("更")) + 1; // mid-character
  process.stdout.write(bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 100));
  process.stdout.write(bytes.subarray(cut));
  process.exit(0);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
}
