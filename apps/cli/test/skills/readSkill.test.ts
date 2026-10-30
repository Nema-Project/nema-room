import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openExtensionStore } from "../../src/extensions/store.js";
import { PAGE_BYTES, SkillReader, TASK_BYTES, readSkillTool } from "../../src/skills/readSkill.js";
import { takeSnapshot, type SkillSnapshot } from "../../src/skills/snapshot.js";
import { COMMIT, managedSkill, skillText } from "./helpers.js";

let base: string;
let nemaHome: string;
let reads: string[];
let activations: string[];
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-read-skill-")));
  nemaHome = join(base, "nema");
  reads = [];
  activations = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function reader(snapshot: SkillSnapshot, onActivated?: () => Promise<void>) {
  return new SkillReader({
    nemaHome,
    snapshot,
    onRead: (text) => reads.push(text),
    onActivated: async (id, revision) => {
      activations.push(`${id}@${revision}`);
      await onActivated?.();
    },
  });
}
const call = (r: SkillReader, args: unknown) => r.read(JSON.stringify(args));

test("the tool takes only the listed names", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  managedSkill(nemaHome, "deploy", { "SKILL.md": skillText("deploy", "d", "b\n", "disable-model-invocation: true\n") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  const tool = readSkillTool(snapshot)!;
  expect(tool.name).toBe("read_skill");
  expect((tool.parameters as { properties: { name: { enum: string[] } } }).properties.name.enum).toEqual(["tdd"]);
  expect(readSkillTool({ skills: [], warnings: [] })).toBeNull();
  const r = reader(snapshot);
  expect(JSON.parse(await call(r, { name: "deploy" }))).toEqual({ error: expect.stringContaining("deploy") });
  expect(JSON.parse(await call(r, { name: "nope" }))).toEqual({ error: expect.stringContaining("nope") });
  expect(JSON.parse(await r.read("not json"))).toHaveProperty("error");
  expect(JSON.parse(await call(r, { name: "tdd", offset: -1 }))).toHaveProperty("error");
});

test("the body comes without front matter, with its revision and the resource list", async () => {
  managedSkill(nemaHome, "tdd", {
    "SKILL.md": skillText("tdd", "d", "# TDD\n\nSee references/a.md.\n"),
    "references/a.md": "A",
    "scripts/run.sh": "x",
  });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  const out = await call(r, { name: "tdd" });
  expect(out).toBe(
    [
      `<skill_content name="tdd" revision="${COMMIT}">`,
      "# TDD\n\nSee references/a.md.\n",
      "</skill_content>",
      "Skill 目录：skill://tdd/，正文中的相对路径相对于该目录。",
      "<skill_resources>",
      "<file>references/a.md</file>",
      "<file>scripts/run.sh</file>",
      "</skill_resources>",
    ].join("\n"),
  );
  expect(reads).toEqual([`读取 Skill tdd（${COMMIT}）`]);
  expect(activations).toEqual([`tdd@${COMMIT}`]);
});

test("a resource by path; links out and missing files are refused", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "references/a.md": "Alpha <b>" });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  expect(await call(r, { name: "tdd", path: "references/a.md" })).toBe(`<skill_file name="tdd" path="references/a.md" revision="${COMMIT}">\nAlpha <b>\n</skill_file>`);
  expect(reads).toEqual([`读取 Skill tdd（${COMMIT}）references/a.md`]);
  expect(activations).toEqual([]);
  expect(JSON.parse(await call(r, { name: "tdd", path: "../x" })).error).toContain("路径");
  expect(JSON.parse(await call(r, { name: "tdd", path: "nope.md" })).error).toContain("没有");
});

test("binary files are described, not read", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  expect(await call(r, { name: "tdd", path: "logo.png" })).toBe("logo.png 是二进制文件（7 字节，.png），Nema 读不出它的内容。");
});

test("long files come in pages that join back up, cut on character boundaries", async () => {
  const text = "汉字".repeat(18_000) + "end"; // 108 KB of UTF-8
  managedSkill(nemaHome, "big", { "SKILL.md": skillText("big"), "long.md": text });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  let offset = 0;
  let joined = "";
  for (let page = 0; page < 5; page++) {
    const out = await call(r, { name: "big", path: "long.md", offset });
    const match = /^<skill_file[^>]*>\n([\s\S]*)\n<\/skill_file>(?:\n（未完：下一页用 offset=(\d+)）)?$/.exec(out);
    expect(match, out.slice(-200)).not.toBeNull();
    joined += match![1];
    expect(Buffer.byteLength(match![1]!)).toBeLessThanOrEqual(PAGE_BYTES);
    if (!match![2]) break;
    offset = Number(match![2]);
  }
  expect(joined).toBe(text);
  expect(JSON.parse(await call(r, { name: "big", path: "long.md", offset: 1 })).error).toContain("字符边界");
});

test("the same page twice is not sent again; a new offset is", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "a.md": "x".repeat(PAGE_BYTES + 10) });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  await call(r, { name: "tdd" });
  expect(await call(r, { name: "tdd" })).toBe("Skill tdd 的这一部分已经载入，见前文。");
  await call(r, { name: "tdd", path: "a.md" });
  expect(await call(r, { name: "tdd", path: "a.md" })).toBe("Skill tdd 的这一部分已经载入，见前文。");
  expect(await call(r, { name: "tdd", path: "a.md", offset: PAGE_BYTES })).toContain("xxxxxxxxxx");
  expect(activations).toHaveLength(1);
});

test("a task reads at most 512 KB of Skills", async () => {
  const files: Record<string, string> = { "SKILL.md": skillText("big") };
  for (let i = 0; i < 12; i++) files[`f${i}.md`] = "z".repeat(PAGE_BYTES);
  managedSkill(nemaHome, "big", files);
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  let refused = "";
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const out = await call(r, { name: "big", path: `f${i}.md` });
    if (out.startsWith("{")) {
      refused = JSON.parse(out).error;
      break;
    }
    total += PAGE_BYTES;
  }
  expect(total).toBeLessThanOrEqual(TASK_BYTES);
  expect(refused).toContain("512 KB");
});

test("disabled, removed or changed Skills are refused at the next read", async () => {
  const root = managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "a.md": "one", "b.md": "two" });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  writeFileSync(join(root, "a.md"), "changed");
  expect(JSON.parse(await call(r, { name: "tdd", path: "a.md" })).error).toBe("该 Skill 已更新，新版本下个任务生效。");
  openExtensionStore(join(nemaHome, "extensions")).setUseState("tdd", "disabled");
  expect(JSON.parse(await call(r, { name: "tdd", path: "b.md" })).error).toBe("该 Skill 已停用或已卸载。");
});

test("settle waits for activation reports, but not forever", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  let release!: () => void;
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }), () => new Promise<void>((resolve) => (release = resolve)));
  await call(r, { name: "tdd" });
  let settled = false;
  const waiting = r.settle(5000).then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  release();
  await waiting;
  expect(settled).toBe(true);

  const stuck = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }), () => new Promise<void>(() => {}));
  await call(stuck, { name: "tdd" });
  const started = Date.now();
  expect(await stuck.settle(30)).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("markLoaded makes the first body page count as already read", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const r = reader(await takeSnapshot({ nemaHome, claudeCodeOk: true }));
  r.markLoaded("tdd");
  expect(await call(r, { name: "tdd" })).toBe("Skill tdd 的这一部分已经载入，见前文。");
  expect(activations).toEqual([]);
});
