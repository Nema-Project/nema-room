import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KnowledgeStore, blameParagraphs, history, versionAt } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nema-hist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const s = new KnowledgeStore(dir);
  await s.init();
  const base = { kind: "requirement" as const, title: "T", sourceMessages: ["m_1"] };
  const v1 = await s.upsert({ ...base, body: "## 背景\n客户嫌慢\n\n## 验收标准\n待确认", reason: "初稿" }, { author: "agent" });
  await s.upsert({ ...base, id: "R-1", body: "## 背景\n客户嫌慢\n\n## 验收标准\n首字 < 2s", reason: "Q-4 的回答" }, { author: "user" });
  await s.upsert({ ...base, id: "R-1", body: "## 背景\n客户嫌慢\n\n## 验收标准\n首字 < 2s", status: "superseded", reason: "已上线" }, { author: "agent" });
  return { s, v1 };
}

describe("history", () => {
  test("versions newest first, add is oldest", async () => {
    await setup();
    const h = await history(dir, "R-1");
    expect(h.map((x) => x.version)).toEqual([3, 2, 1]);
    expect(h[2].op).toBe("add");
    expect(h[1]).toMatchObject({ op: "update", reason: "Q-4 的回答", author: "user", sourceMessages: ["m_1"] });
    expect(new Date(h[0].committedAt).toString()).not.toBe("Invalid Date");
  });

  test("versionAt returns old content", async () => {
    const { v1 } = await setup();
    expect((await versionAt(dir, "R-1", v1.commit)).body).toContain("待确认");
  });

  test("blameParagraphs attributes per paragraph", async () => {
    await setup();
    const p = await blameParagraphs(dir, "R-1");
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ version: 1, text: "## 背景\n客户嫌慢", reason: "初稿" });
    expect(p[1]).toMatchObject({ version: 2, reason: "Q-4 的回答", author: "user" });
  });

  test("blame attributes a recovered paragraph to system", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(
      { kind: "requirement", title: "T", body: "## 背景\n客户嫌慢\n", sourceMessages: ["m_1"], reason: "初稿" },
      { author: "agent" },
    );
    const file = path.join(dir, "requirements", "R-1.md");
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("客户嫌慢\n")).toBe(true);
    await writeFile(file, `${raw}\n## 补充\n崩溃前写下\n`);
    await s.recoverUncommitted();
    const p = await blameParagraphs(dir, "R-1");
    expect(p[0]).toMatchObject({ author: "agent", text: "## 背景\n客户嫌慢" });
    expect(p[1]).toMatchObject({
      author: "system",
      reason: "hub 启动时发现的未提交改动（崩溃后恢复）",
      text: "## 补充\n崩溃前写下",
    });
  });

  test("missing id", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    expect(await history(dir, "R-9")).toEqual([]);
    await expect(versionAt(dir, "R-9", "HEAD")).rejects.toThrow();
    expect(await blameParagraphs(dir, "R-9")).toEqual([]);
  });
});
