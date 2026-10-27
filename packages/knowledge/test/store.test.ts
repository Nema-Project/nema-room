import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KnowledgeStore, git, history, parseCommitMessage } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nema-kb-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const req = (title: string, extra = {}) => ({ kind: "requirement" as const, title, body: "b", sourceMessages: ["m_1"], reason: "r", ...extra });

// Pre-plan frontmatter: no basis, ingested_at, confirmed_at, or quotes.
const LEGACY = `---
id: R-1
kind: requirement
title: legacy
status: active
business_date: null
related: []
source_messages:
  - m_1
---

kept
`;

async function commitLegacy(): Promise<void> {
  await writeFile(path.join(dir, "requirements", "R-1.md"), LEGACY);
  await git(dir, ["add", "--", "requirements/R-1.md"]);
  await git(dir, ["commit", "-m", "legacy"]);
}

describe("KnowledgeStore", () => {
  test("init creates dirs and an init commit", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    expect((await git(dir, ["log", "--format=%s"])).trim()).toBe("init");
    expect((await git(dir, ["ls-files"])).split("\n").filter(Boolean).sort()).toEqual(
      ["decisions", "diagrams", "questions", "requirements", "sources", "tradeoffs", "workpackages"].map((d) => `${d}/.gitkeep`),
    );
    expect((await git(dir, ["config", "user.name"])).trim()).toBe("Nema Room");
    expect(await s.list()).toEqual([]);
  });

  test("upsert assigns sequential ids per kind and commits with metadata", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const a = await s.upsert({ kind: "requirement", title: "流式输出", body: "Agent 回复改为流式", sourceMessages: ["m_1"], reason: "PdM 会议" }, { author: "agent", taskId: "t_1" });
    const b = await s.upsert({ kind: "requirement", title: "多轮优化", body: "延后", sourceMessages: ["m_1"], reason: "PdM 会议" }, { author: "agent" });
    expect([a.entry.id, b.entry.id, a.op]).toEqual(["R-1", "R-2", "add"]);
    expect(a.entry.status).toBe("active");
    expect(parseCommitMessage(await git(dir, ["log", "-1", "--format=%B", a.commit]))).toMatchObject({
      op: "add", id: "R-1", reason: "PdM 会议", sourceMessages: ["m_1"], author: "agent", taskId: "t_1",
    });
  });

  test("entriesCiting returns entries that name the message", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("cited"), { author: "agent" });
    await s.upsert({ ...req("other"), sourceMessages: ["m_2"] }, { author: "agent" });
    expect((await s.entriesCiting("m_1")).map((e) => e.id)).toEqual(["R-1"]);
    expect(await s.entriesCiting("m_9")).toEqual([]);
  });

  test("question defaults to open status", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const r = await s.upsert({ kind: "question", title: "q", body: "", sourceMessages: [], reason: "r", priority: 2 }, { author: "agent" });
    expect(r.entry.status).toBe("open");
    expect(r.entry.id).toBe("Q-1");
  });

  test("withdraw sets dropped and keeps basis", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const added = await s.upsert({ kind: "question", title: "q", body: "details", sourceMessages: [], reason: "r", priority: 2, basis: "stated" }, { author: "agent", now: new Date("2026-01-01T00:00:00Z") });
    const withdrawn = await s.withdraw(added.entry.id, { author: "user" });
    expect(withdrawn.entry).toMatchObject({ status: "dropped", basis: "stated", confirmedAt: added.entry.confirmedAt });
    expect((await s.get(added.entry.id))?.basis).toBe("stated");
  });

  test("update keeps id and records op=update", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    const u = await s.upsert(req("x", { id: "R-1", status: "superseded" }), { author: "user" });
    expect(u.op).toBe("update");
    expect((await s.get("R-1"))?.status).toBe("superseded");
    expect(parseCommitMessage(await git(dir, ["log", "-1", "--format=%B", u.commit]))).toMatchObject({ op: "update", id: "R-1", author: "user" });
  });

  test("no-op update returns HEAD without a new commit", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    const before = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const u = await s.upsert(req("x", { id: "R-1" }), { author: "agent" });
    expect(u.op).toBe("update");
    expect(u.commit).toBe(before);
    expect((await git(dir, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
  });

  test("unknown id or id/kind mismatch rejects", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await expect(s.upsert(req("x", { id: "R-9" }), { author: "agent" })).rejects.toThrow(/R-9/);
    await s.upsert({ kind: "decision", title: "d", body: "", sourceMessages: [], reason: "r" }, { author: "agent" });
    const before = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await expect(s.upsert(req("x", { id: "D-1" }), { author: "agent" })).rejects.toThrow(/id prefix does not match kind/);
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect((await s.get("D-1"))?.kind).toBe("decision");
  });

  test("update unions sourceMessages, keeps omitted fields, commit records only input sources", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x", { status: "dropped", businessDate: "2026-01-02", related: ["D-1"], sourceMessages: ["m_1"] }), { author: "agent" });
    const u = await s.upsert({ kind: "requirement", id: "R-1", title: "x2", body: "new", sourceMessages: ["m_2"], reason: "again" }, { author: "user" });
    expect(u.entry).toMatchObject({ status: "dropped", businessDate: "2026-01-02", related: ["D-1"], sourceMessages: ["m_1", "m_2"], title: "x2", body: "new" });
    expect(await s.get("R-1")).toEqual(u.entry);
    expect(parseCommitMessage(await git(dir, ["log", "-1", "--format=%B", u.commit]))).toMatchObject({ sourceMessages: ["m_2"], reason: "again" });
  });

  test("implementation round-trips with snake_case keys and survives an update", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    expect(await readFile(path.join(dir, "requirements", "R-1.md"), "utf8")).not.toContain("implementation");
    const file = (await readFile(path.join(dir, "requirements", "R-1.md"), "utf8")).replace(
      "---\n\n",
      "implementation:\n  status: reported\n  evidence:\n    report_message_id: m_9\n    commits:\n      - abc1234\n    inferred: false\n    note: null\n    confirmed_by: null\n---\n\n",
    );
    await writeFile(path.join(dir, "requirements", "R-1.md"), file);
    await git(dir, ["commit", "-am", "impl"]);
    const implementation = { status: "reported", evidence: { reportMessageId: "m_9", commits: ["abc1234"], inferred: false, note: null, confirmedBy: null } };
    expect((await s.get("R-1"))?.implementation).toEqual(implementation);
    const u = await s.upsert({ kind: "requirement", id: "R-1", title: "x2", body: "b", sourceMessages: ["m_2"], reason: "again" }, { author: "agent" });
    expect(u.entry.implementation).toEqual(implementation);
    const raw = await readFile(path.join(dir, "requirements", "R-1.md"), "utf8");
    expect(raw).toContain("report_message_id: m_9");
    expect(raw).toContain("confirmed_by: null");
    expect((await s.get("R-1"))?.implementation).toEqual(implementation);
  });

  test("concurrent updates to the same entry both land in history", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    await Promise.all([
      s.upsert(req("by user", { id: "R-1", body: "u" }), { author: "user" }),
      s.upsert(req("by agent", { id: "R-1", body: "a" }), { author: "agent" }),
    ]);
    const log = (await git(dir, ["log", "--format=%H", "--", "requirements/R-1.md"])).trim().split("\n");
    expect(log).toHaveLength(3);
    const authors = await Promise.all(log.map(async (h) => parseCommitMessage(await git(dir, ["log", "-1", "--format=%B", h])).author));
    expect(authors.sort()).toEqual(["agent", "agent", "user"]);
    const e = await s.get("R-1");
    expect(["by user", "by agent"]).toContain(e?.title);
    await git(dir, ["fsck"]);
  });

  test("get returns null for missing or invalid ids", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    expect(await s.get("R-1")).toBeNull();
    expect(await s.get("../../etc/passwd")).toBeNull();
  });

  test("list sorted by kind then numeric id", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    for (let i = 0; i < 10; i++) await s.upsert(req(`r${i}`), { author: "agent" });
    await s.upsert({ kind: "decision", title: "d", body: "", sourceMessages: [], reason: "r" }, { author: "agent" });
    const ids = (await s.list()).map((e) => e.id);
    expect(ids).toEqual(["R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8", "R-9", "R-10", "D-1"]);
  });

  test("concurrent upserts do not corrupt the repo", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        s.upsert({ kind: "decision", title: `d${i}`, body: "x", sourceMessages: ["m_1"], reason: "r" }, { author: i % 2 ? "agent" : "user" }),
      ),
    );
    expect((await s.list()).map((e) => e.id).sort()).toEqual(["D-1", "D-2", "D-3", "D-4", "D-5"]);
    await git(dir, ["fsck"]);
  });

  test("a failed commit restores the previous file and leaves the tree clean", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("old title"), { author: "agent" });
    const file = path.join(dir, "requirements", "R-1.md");
    const before = await readFile(file, "utf8");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    // Force `git commit` to fail; the local hooksPath beats any global core.hooksPath.
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    await chmod(path.join(dir, ".git", "hooks", "pre-commit"), 0o755);
    await git(dir, ["config", "core.hooksPath", ".git/hooks"]);

    await expect(s.upsert(req("new title", { id: "R-1" }), { author: "user" })).rejects.toThrow(/git commit/);
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await s.get("R-1"))?.title).toBe("old title");

    await expect(s.upsert(req("brand new"), { author: "agent" })).rejects.toThrow(/git commit/);
    expect(existsSync(path.join(dir, "requirements", "R-2.md"))).toBe(false);

    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  test("list skips (and warns about) a corrupt entry file instead of failing", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("good"), { author: "agent" });
    const bad = path.join(dir, "requirements", "R-2.md");
    await writeFile(bad, "---\nid: [unterminated\n---\nbody");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await s.list()).map((e) => e.id)).toEqual(["R-1"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(bad));
      // The corrupt file still reserves its id: the next add is R-3, not an overwrite of R-2.
      expect((await s.upsert(req("next"), { author: "agent" })).entry.id).toBe("R-3");
    } finally {
      warn.mockRestore();
    }
  });

  test("round-trips basis, times and quotes through the file", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const now = new Date("2026-10-23T01:02:03.000Z");
    const quote = { messageId: "m_1", text: "先流式" };
    const { entry } = await s.upsert(req("流式", { basis: "inferred", quotes: [quote] }), { author: "agent", now });
    const got = await s.get(entry.id);
    expect(got?.basis).toBe("inferred");
    expect(got?.quotes).toEqual([quote]);
    expect(got?.ingestedAt).toBe(now.toISOString());
    expect(got?.confirmedAt).toBe(now.toISOString());
    const raw = await readFile(path.join(dir, "requirements", `${entry.id}.md`), "utf8");
    expect(raw).toContain("basis: inferred");
    expect(raw).toContain("ingested_at:");
    expect(raw).toContain("confirmed_at:");
    expect(raw).toContain("2026-10-23T01:02:03.000Z");
    expect(raw).toContain("message_id: m_1");
    expect(raw).toContain("text: 先流式");
    expect(raw).not.toContain("ingestedAt");
    expect(raw).not.toContain("messageId");
  });

  test("loads a legacy file without the new keys", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await commitLegacy();
    expect(await s.get("R-1")).toMatchObject({ basis: null, ingestedAt: null, confirmedAt: null, quotes: [] });
    expect(await s.list()).toMatchObject([{ id: "R-1", basis: null, confirmedAt: null }]);
    expect(await readFile(path.join(dir, "requirements", "R-1.md"), "utf8")).toBe(LEGACY);
  });

  test("update keeps ingestedAt and only refreshes confirmedAt when confirmed is true", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const t1 = new Date("2026-10-23T01:00:00.000Z");
    const t2 = new Date("2026-10-23T02:00:00.000Z");
    const t3 = new Date("2026-10-23T03:00:00.000Z");
    await s.upsert(req("x"), { author: "agent", now: t1 });
    const added = await readFile(path.join(dir, "requirements", "R-1.md"), "utf8");
    expect(added).toContain("ingested_at:");
    expect(added).toContain("confirmed_at:");
    expect(added).not.toMatch(/^basis:/m);
    expect(added).not.toMatch(/^quotes:/m);
    const u2 = await s.upsert(req("x2", { id: "R-1" }), { author: "user", now: t2 });
    expect(u2.entry.ingestedAt).toBe(t1.toISOString());
    expect(u2.entry.confirmedAt).toBe(t1.toISOString());
    expect(u2.entry.basis).toBeNull();
    const u3 = await s.upsert(req("x3", { id: "R-1", confirmed: true }), { author: "user", now: t3 });
    expect(u3.entry.ingestedAt).toBe(t1.toISOString());
    expect(u3.entry.confirmedAt).toBe(t3.toISOString());
    expect(await s.get("R-1")).toMatchObject({ ingestedAt: t1.toISOString(), confirmedAt: t3.toISOString(), basis: null, quotes: [] });
  });

  test("updating a legacy entry leaves ingestedAt null", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await commitLegacy();
    const u = await s.upsert(req("renamed", { id: "R-1" }), { author: "user", now: new Date("2026-10-23T03:00:00.000Z") });
    expect(u.entry.ingestedAt).toBeNull();
    expect((await s.get("R-1"))?.ingestedAt).toBeNull();
    const raw = await readFile(path.join(dir, "requirements", "R-1.md"), "utf8");
    expect(raw).not.toMatch(/^ingested_at:/m);
    expect(raw).not.toMatch(/^confirmed_at:/m);
    expect(raw).not.toMatch(/^basis:/m);
    expect(raw).not.toMatch(/^quotes:/m);
  });

  test("quotes accumulate without duplicates across updates", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const q1 = { messageId: "m_1", text: "先流式" };
    const q2 = { messageId: "m_2", text: "再确认" };
    const sameIdOtherText = { messageId: "m_1", text: "另一句" };
    await s.upsert(req("x", { quotes: [q1] }), { author: "agent", now: new Date("2026-10-23T01:00:00.000Z") });
    const u = await s.upsert(req("x", { id: "R-1", quotes: [q1, q2, sameIdOtherText] }), { author: "user", now: new Date("2026-10-23T02:00:00.000Z") });
    expect(u.entry.quotes).toEqual([q1, q2, sameIdOtherText]);
    expect((await s.get("R-1"))?.quotes).toEqual([q1, q2, sameIdOtherText]);
  });

  test("confirm turns inferred into decided for a decision and stated for a requirement, sets confirmedAt, and commits as the given author", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const addedAt = "2026-10-23T01:00:00.000Z";
    const confirmedAt = "2026-10-23T04:00:00.000Z";
    const quote = { messageId: "m_1", text: "先流式" };
    await s.upsert(
      { kind: "decision", title: "d", body: "b", sourceMessages: ["m_1"], reason: "r", basis: "inferred", quotes: [quote] },
      { author: "agent", now: new Date(addedAt) },
    );
    await s.upsert(req("req", { basis: "inferred" }), { author: "agent", now: new Date(addedAt) });
    await s.upsert(req("plain"), { author: "agent", now: new Date(addedAt) });
    await s.upsert(
      { kind: "decision", title: "kept", body: "", sourceMessages: [], reason: "r", basis: "stated" },
      { author: "agent", now: new Date(addedAt) },
    );
    const d = await s.confirm("D-1", { author: "user", now: new Date(confirmedAt) });
    const r = await s.confirm("R-1", { author: "agent", now: new Date(confirmedAt) });
    const plain = await s.confirm("R-2", { author: "user", now: new Date(confirmedAt) });
    const kept = await s.confirm("D-2", { author: "user", now: new Date(confirmedAt) });
    expect(d.entry).toMatchObject({ basis: "decided", confirmedAt, ingestedAt: addedAt, quotes: [quote], sourceMessages: ["m_1"] });
    expect(r.entry).toMatchObject({ basis: "stated", confirmedAt, ingestedAt: addedAt });
    expect(plain.entry.basis).toBe("stated");
    expect(kept.entry.basis).toBe("stated");
    expect((await s.get("D-1"))?.basis).toBe("decided");
    expect((await s.get("R-1"))?.basis).toBe("stated");
    expect((await history(dir, "D-1"))[0]).toMatchObject({ op: "update", reason: "用户确认仍然有效", author: "user", sourceMessages: [] });
    expect((await history(dir, "R-1"))[0]).toMatchObject({ op: "update", reason: "用户确认仍然有效", author: "agent", sourceMessages: [] });
  });

  test("recovers a modified tracked entry as a system recover commit", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("original"), { author: "agent" });
    const file = path.join(dir, "requirements", "R-1.md");
    const raw = await readFile(file, "utf8");
    const edited = raw.replace("title: original", "title: edited");
    expect(edited).not.toBe(raw);
    await writeFile(file, edited);
    const result = await s.recoverUncommitted();
    expect(result.recovered[0]?.id).toBe("R-1");
    expect(result.skipped).toEqual([]);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await history(dir, "R-1"))[0]).toMatchObject({
      op: "recover",
      author: "system",
      reason: "hub 启动时发现的未提交改动（崩溃后恢复）",
    });
    expect((await s.get("R-1"))?.title).toBe("edited");
  });

  test("recovers an untracked new entry file", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await writeFile(path.join(dir, "requirements", "R-1.md"), LEGACY);
    const result = await s.recoverUncommitted();
    expect(result.recovered.map((e) => e.id)).toEqual(["R-1"]);
    expect(result.recovered[0]).toMatchObject({ title: "legacy", body: "kept\n" });
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await history(dir, "R-1"))[0]).toMatchObject({ op: "recover", author: "system" });
  });

  test("recovers a staged but uncommitted entry", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await writeFile(path.join(dir, "decisions", "D-1.md"), LEGACY.replaceAll("R-1", "D-1").replaceAll("requirement", "decision").replace("title: legacy", "title: staged"));
    await git(dir, ["add", "--", "decisions/D-1.md"]);
    const result = await s.recoverUncommitted();
    expect(result.recovered.map((e) => e.id)).toEqual(["D-1"]);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await history(dir, "D-1"))[0]).toMatchObject({ op: "recover", author: "system" });
  });

  test("leaves an unparseable untracked entry file untouched and still recovers a valid sibling", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const badRel = "requirements/R-1.md";
    const bad = path.join(dir, badRel);
    const broken = "---\nid: [unterminated\n---\nbody";
    await writeFile(bad, broken);
    await writeFile(path.join(dir, "requirements", "R-2.md"), LEGACY.replaceAll("R-1", "R-2").replace("title: legacy", "title: sibling"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await s.recoverUncommitted();
      expect(result.recovered.map((e) => e.id)).toEqual(["R-2"]);
      expect(result.skipped).toContain(badRel);
      expect(await readFile(bad, "utf8")).toBe(broken);
      expect((await git(dir, ["status", "--porcelain"])).trim()).toBe(`?? ${badRel}`);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(badRel));
    } finally {
      warn.mockRestore();
    }
  });

  test("skips deletions and non-entry paths without committing them", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    await rm(path.join(dir, "requirements", "R-1.md"));
    const extra = path.join(dir, "notes.txt");
    await writeFile(extra, "keep");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const result = await s.recoverUncommitted();
    expect(result.recovered).toEqual([]);
    expect(result.skipped.sort()).toEqual(["notes.txt", "requirements/R-1.md"]);
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await readFile(extra, "utf8")).toBe("keep");
    expect(existsSync(path.join(dir, "requirements", "R-1.md"))).toBe(false);
    const status = await git(dir, ["status", "--porcelain"]);
    expect(status).toContain("requirements/R-1.md");
    expect(status).toContain("notes.txt");
  });

  test("recoverUncommitted skips decisions/D-3.md whose frontmatter id is D-4", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const rel = "decisions/D-3.md";
    const content = LEGACY.replaceAll("R-1", "D-4").replaceAll("requirement", "decision");
    await writeFile(path.join(dir, rel), content);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await s.recoverUncommitted();
      expect(result.recovered).toEqual([]);
      expect(result.skipped).toEqual([rel]);
      expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
      expect(await readFile(path.join(dir, rel), "utf8")).toBe(content);
    } finally {
      warn.mockRestore();
    }
  });

  test("recoverUncommitted skips decisions/D-5.md whose frontmatter kind is requirement", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const rel = "decisions/D-5.md";
    await writeFile(path.join(dir, rel), LEGACY.replaceAll("R-1", "D-5"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await s.recoverUncommitted();
      expect(result.recovered).toEqual([]);
      expect(result.skipped).toEqual([rel]);
    } finally {
      warn.mockRestore();
    }
  });

  test("does nothing on a clean repo", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.upsert(req("x"), { author: "agent" });
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(await s.recoverUncommitted()).toEqual({ recovered: [], skipped: [] });
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  test("unicode round-trip", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const body = "日本語と中文と😀 — ".repeat(400) + "\n---\nkey: value\n";
    const title = "要件：ストリーミング 流式 😀";
    const { entry } = await s.upsert(req(title, { body, businessDate: "2026-10-22" }), { author: "agent" });
    const got = await s.get(entry.id);
    expect(got?.title).toBe(title);
    expect(got?.body).toBe(body);
    expect(got?.businessDate).toBe("2026-10-22");
    expect(Buffer.byteLength(body)).toBeGreaterThan(10_000);
  });

  test("writeDiagram commits the md and json together; readDiagramSpec returns the json", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const spec = { title: "Nema", nodes: [{ id: "hub" }] };
    const first = await s.writeDiagram(diagramInput(spec), { author: "agent", taskId: "t_1" });
    expect(first.op).toBe("add");
    expect(first.entry).toMatchObject({ id: "G-1", kind: "diagram", title: "系统架构", status: "active", sourceMessages: ["m_1"], diagram: DIAGRAM });
    expect(first.entry.body).toBe("总览");
    const files = (await git(dir, ["show", "--name-only", "--format=", first.commit])).split("\n").filter(Boolean).sort();
    expect(files).toEqual(["diagrams/G-1.json", "diagrams/G-1.md"]);
    expect(await readFile(path.join(dir, "diagrams", "G-1.json"), "utf8")).toBe(JSON.stringify(spec, null, 2));
    expect(await s.readDiagramSpec("G-1")).toEqual(spec);
    expect(await s.get("G-1")).toMatchObject({ diagram: DIAGRAM });
    expect((await history(dir, "G-1"))[0]).toMatchObject({ op: "add", reason: "画图：系统架构", author: "agent", taskId: "t_1" });
    expect(await s.readDiagramSpec("G-2")).toBeNull();
    expect(await s.readDiagramSpec("R-1")).toBeNull();

    const spec2 = { title: "Nema v2", nodes: [] };
    const second = await s.writeDiagram({ ...diagramInput(spec2), id: "G-1", sourceMessages: ["m_2"] }, { author: "agent" });
    expect(second.op).toBe("update");
    expect(second.entry.id).toBe("G-1");
    expect(second.entry.sourceMessages).toEqual(["m_1", "m_2"]);
    expect(await s.readDiagramSpec("G-1")).toEqual(spec2);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    await expect(s.writeDiagram({ ...diagramInput(spec), id: "G-9" }, { author: "agent" })).rejects.toThrow(/G-9/);
  });

  test("a knowledge repo without diagrams/ still lists and recovers", async () => {
    // A repo created before diagrams existed: no diagrams/ directory at all.
    await mkdir(dir, { recursive: true });
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["config", "user.email", "t@localhost"]);
    for (const d of ["requirements", "decisions", "tradeoffs", "questions", "sources"]) {
      await mkdir(path.join(dir, d), { recursive: true });
      await writeFile(path.join(dir, d, ".gitkeep"), "");
    }
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "init"]);
    await commitLegacy();
    const s = new KnowledgeStore(dir);
    expect(existsSync(path.join(dir, "diagrams"))).toBe(false);
    expect((await s.list()).map((e) => e.id)).toEqual(["R-1"]);
    expect(await s.get("G-1")).toBeNull();
    expect(await s.readDiagramSpec("G-1")).toBeNull();
    await writeFile(path.join(dir, "requirements", "R-1.md"), LEGACY.replace("title: legacy", "title: edited"));
    expect((await s.recoverUncommitted()).recovered.map((e) => e.id)).toEqual(["R-1"]);
    // A crash between writing the md and the json of a diagram recovers both in one commit.
    await mkdir(path.join(dir, "diagrams"));
    const { entry } = await s.writeDiagram(diagramInput({ v: 1 }), { author: "agent" });
    expect(entry.id).toBe("G-1");
    const md = await readFile(path.join(dir, "diagrams", "G-1.md"), "utf8");
    await writeFile(path.join(dir, "diagrams", "G-1.md"), md.replace("title: 系统架构", "title: 改过"));
    await writeFile(path.join(dir, "diagrams", "G-1.json"), JSON.stringify({ v: 2 }));
    const result = await s.recoverUncommitted();
    expect(result).toEqual({ recovered: [expect.objectContaining({ id: "G-1", title: "改过" })], skipped: [] });
    const files = (await git(dir, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter(Boolean).sort();
    expect(files).toEqual(["diagrams/G-1.json", "diagrams/G-1.md"]);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect(await s.readDiagramSpec("G-1")).toEqual({ v: 2 });
  });

  test("recoverUncommitted skips a diagram json whose md is not being recovered", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.writeDiagram(diagramInput({ v: 1 }), { author: "agent" });
    await writeFile(path.join(dir, "diagrams", "G-1.json"), JSON.stringify({ v: 2 }));
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    expect(await s.recoverUncommitted()).toEqual({ recovered: [], skipped: ["diagrams/G-1.json"] });
    expect((await git(dir, ["rev-parse", "HEAD"])).trim()).toBe(head);
  });
});

const DIAGRAM = {
  repoId: "repo_api",
  type: "architecture" as const,
  sourceCommits: { repo_api: "abc123" },
  nodePaths: { hub: ["apps/hub/src"] },
};

function diagramInput(spec: unknown) {
  return { title: "系统架构", body: "总览", diagram: DIAGRAM, spec, reason: "画图：系统架构", sourceMessages: ["m_1"] };
}

describe("work packages", () => {
  const wpInput = { title: "导出功能", requirements: ["R-1"], repos: ["api"], reason: "开始生成", sourceMessages: ["m_1"] };
  const task = (n: number) => ({
    n, title: `t${n}`, satisfies: ["R-1"], files: [{ op: "modify" as const, repo: "api", path: "src/x.ts" }],
    status: "pending" as const, inferred: false, reportMessageId: null, confirmedBy: null,
  });

  test("createWorkPackage makes W-1 as draft", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    const e = await s.createWorkPackage(wpInput, { author: "agent" });
    expect(e).toMatchObject({ id: "W-1", kind: "workpackage", status: "draft", body: "" });
    expect(e.workpackage).toEqual({ requirements: ["R-1"], repos: ["api"], approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] });
    expect(existsSync(path.join(dir, "workpackages", "W-1.md"))).toBe(true);
    const back = await s.readWorkPackage("W-1");
    expect(back).toMatchObject({ spec: null, plan: null });
    expect(back?.entry.workpackage).toEqual(e.workpackage);
    expect((await s.createWorkPackage(wpInput, { author: "agent" })).id).toBe("W-2");
    expect((await s.list()).map((x) => x.id)).toEqual(["W-1", "W-2"]);
  });

  test("writing spec then plan keeps both and resets approval", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "spec", "# spec\n", {}, "写 spec", ["m_2"], { author: "agent" });
    const e = await s.writeWorkPackageDoc("W-1", "plan", "# plan\n", { tasks: [task(1), task(2)] }, "写 plan", [], { author: "agent" });
    expect(e.status).toBe("draft");
    const r = await s.readWorkPackage("W-1");
    expect(r).toMatchObject({ spec: "# spec\n", plan: "# plan\n" });
    expect(r?.entry.workpackage?.tasks).toEqual([task(1), task(2)]);
    expect(r?.entry.sourceMessages).toEqual(["m_1", "m_2"]);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  test("readWorkPackage never pairs a new plan with the entry's old tasks", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "spec", "# spec\n", {}, "写 spec", [], { author: "agent" });
    // Hold the reader between reading the entry and reading the plan, and let a plan write land in that gap.
    const get = s.get.bind(s);
    let calls = 0;
    vi.spyOn(s, "get").mockImplementation(async (id) => {
      const entry = await get(id);
      // Only the reader's call (the first) pauses; the writer's own lookup runs at full speed.
      if (calls++ === 0) await new Promise((resolve) => setTimeout(resolve, 200));
      return entry;
    });
    const reading = s.readWorkPackage("W-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const writing = s.writeWorkPackageDoc("W-1", "plan", "# plan\n", { tasks: [task(1), task(2)] }, "写 plan", [], { author: "agent" });
    const [read] = await Promise.all([reading, writing]);
    if (read?.plan !== null) expect(read?.entry.workpackage?.tasks).toEqual([task(1), task(2)]);
    else expect(read?.entry.workpackage?.tasks).toEqual([]);
  });

  test("setWorkPackageMeta approves and records the commit", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "plan", "# plan\n", { tasks: [task(1)] }, "写 plan", [], { author: "agent" });
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    const e = await s.setWorkPackageMeta("W-1", { status: "approved", approvedAt: "2026-10-23T10:00:00.000Z", approvedCommit: head }, "用户批准", { author: "user" });
    expect(e.status).toBe("approved");
    const r = await s.readWorkPackage("W-1");
    expect(r?.entry).toMatchObject({ status: "approved", workpackage: { approvedAt: "2026-10-23T10:00:00.000Z", approvedCommit: head } });
    expect(r?.entry.workpackage?.tasks).toHaveLength(1);
    expect(r?.plan).toBe("# plan\n");
  });

  test("a later plan write sets status back to draft and clears approval", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "plan", "# plan\n", { tasks: [task(1)] }, "写 plan", [], { author: "agent" });
    await s.setWorkPackageMeta("W-1", { status: "approved", approvedAt: "2026-10-23T10:00:00.000Z", approvedCommit: "abc" }, "用户批准", { author: "user" });
    await s.writeWorkPackageDoc("W-1", "plan", "# plan v2\n", {}, "用户改 plan", [], { author: "user" });
    const r = await s.readWorkPackage("W-1");
    expect(r?.entry.status).toBe("draft");
    expect(r?.entry.workpackage).toMatchObject({ approvedAt: null, approvedCommit: null });
    expect(r?.plan).toBe("# plan v2\n");
    await expect(s.writeWorkPackageDoc("W-9", "spec", "x", {}, "r", [], { author: "agent" })).rejects.toThrow(/not found/);
  });

  test("recover handles W-n siblings", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    const w = path.join(dir, "workpackages");
    await writeFile(path.join(w, "W-1.spec.md"), "# spec\n");
    await writeFile(path.join(w, "W-1.plan.md"), "# plan\n");
    // The entry itself is dirty too, so all three go in one recover commit.
    await writeFile(path.join(w, "W-1.md"), (await readFile(path.join(w, "W-1.md"), "utf8")).replace("导出功能", "导出功能2"));
    const result = await s.recoverUncommitted();
    expect(result.recovered.map((e) => e.id)).toEqual(["W-1"]);
    expect(result.skipped).toEqual([]);
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(dir, ["show", "--name-only", "--format=", "HEAD"])).split("\n").filter(Boolean).sort()).toEqual(
      ["workpackages/W-1.md", "workpackages/W-1.plan.md", "workpackages/W-1.spec.md"],
    );
    // A spec whose entry is clean is not recovered.
    await writeFile(path.join(w, "W-1.spec.md"), "# edited\n");
    expect(await s.recoverUncommitted()).toEqual({ recovered: [], skipped: ["workpackages/W-1.spec.md"] });
    expect((await s.list()).map((e) => e.id)).toEqual(["W-1"]);
  });

  test("history of W-1 includes spec and plan commits", async () => {
    const s = new KnowledgeStore(dir);
    await s.init();
    await s.createWorkPackage(wpInput, { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "spec", "# spec\n", {}, "写 spec", [], { author: "agent" });
    await s.writeWorkPackageDoc("W-1", "plan", "# plan\n", {}, "写 plan", [], { author: "agent" });
    const h = await history(dir, "W-1");
    expect(h.map((x) => [x.version, x.op, x.reason])).toEqual([[3, "update", "写 plan"], [2, "update", "写 spec"], [1, "add", "开始生成"]]);
  });
});

test("readers never observe truncated frontmatter during an entry update", async () => {
  const store = new KnowledgeStore(dir);
  await store.init();
  await store.upsert(req("initial"), { author: "user" });
  if (process.platform !== "win32") await chmod(path.join(dir, "requirements", "R-1.md"), 0o600);
  // The hub and direct readers may hold distinct store instances for the same repo.
  const readerStore = new KnowledgeStore(dir);
  let done = false;
  const failures: unknown[] = [];
  const writer = (async () => {
    try {
      for (let i = 0; i < 40; i++) {
        await store.upsert(req(`revision ${i}`, { id: "R-1", body: "x".repeat(16_384) }), { author: "user" });
      }
    } finally {
      done = true;
    }
  })();
  const reader = async () => {
    while (!done) {
      try {
        const entry = await readerStore.get("R-1");
        if (entry?.id !== "R-1") failures.push(entry);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all([writer, ...Array.from({ length: 4 }, reader)]);
  expect(failures).toEqual([]);
  expect((await store.get("R-1"))?.title).toBe("revision 39");
  if (process.platform !== "win32") expect((await stat(path.join(dir, "requirements", "R-1.md"))).mode & 0o777).toBe(0o600);
  expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
});
