import { expectPrivate } from "../nativePermissions.js";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HookSignal } from "@nema/shared";
import { runReport, runReportHook } from "../../src/report/commands.js";
import { appendSpool, flushSpool, spoolPath, SPOOL_MAX_BYTES } from "../../src/report/send.js";
import { ensureReportToken, reportTokenHash, reportTokenPath } from "../../src/report/token.js";
import { collectOut, deadHubUrl, fakeHub, git, makeRepo, stdinOf, tmp, type FakeHub } from "./helpers.js";

let hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  vi.restoreAllMocks();
});
const hub = async () => {
  const h = await fakeHub();
  hubs.push(h);
  return h;
};

describe("nema report hook", () => {
  test("hook from a worktree reports the main repo's common dir", async () => {
    const repo = makeRepo();
    const wt = path.join(tmp("nema-wt-"), "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", wt);
    mkdirSync(path.join(wt, "sub"));
    const h = await hub();
    const nemaHome = tmp("nema-home-");
    const code = await runReportHook({ agent: "claude-code", nemaHome, hubUrl: h.url, stdin: stdinOf(JSON.stringify({ cwd: path.join(wt, "sub"), session_id: "s1" })) });
    expect(code).toBe(0);
    expect(h.received).toHaveLength(1);
    const body = h.received[0]!.body as HookSignal;
    expect(h.received[0]!.path).toBe("/report/hook");
    expect(body.gitCommonDir).toBe(realpathSync(path.join(repo, ".git")));
    expect(body.branch).toBe("feature");
    expect(body.head).toBe(git(repo, "rev-parse", "HEAD"));
    expect(body.sessionId).toBe("s1");
    expect(h.received[0]!.auth).toBe(`Bearer ${ensureReportToken(nemaHome)}`);
  });

  test("hook strips everything but cwd and session_id from the agent payload", async () => {
    const repo = makeRepo();
    const h = await hub();
    const payload = { cwd: repo, session_id: "abc", transcript_path: "/secret/t.jsonl", prompt: "hello", hook_event_name: "Stop" };
    await runReportHook({ agent: "claude-code", nemaHome: tmp("nema-home-"), hubUrl: h.url, stdin: stdinOf(JSON.stringify(payload)) });
    const body = h.received[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent", "at", "branch", "cwd", "gitCommonDir", "head", "sessionId"]);
    expect(HookSignal.strict().safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("hello");
  });

  test("hook outside a repo sends nothing and exits 0", async () => {
    const h = await hub();
    const write = vi.spyOn(process.stdout, "write");
    const code = await runReportHook({ agent: "codex", nemaHome: tmp("nema-home-"), hubUrl: h.url, stdin: stdinOf(JSON.stringify({ cwd: tmp("nema-norepo-") })) });
    expect(code).toBe(0);
    expect(h.received).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });

  test("hook with the hub down spools, and the next successful hook replays the spool first, in order", async () => {
    const repo = makeRepo();
    const nemaHome = tmp("nema-home-");
    const dead = await deadHubUrl();
    const write = vi.spyOn(process.stdout, "write");
    expect(await runReportHook({ agent: "claude-code", nemaHome, hubUrl: dead, stdin: stdinOf(JSON.stringify({ cwd: repo, session_id: "one" })) })).toBe(0);
    expect(await runReportHook({ agent: "claude-code", nemaHome, hubUrl: dead, stdin: stdinOf(JSON.stringify({ cwd: repo, session_id: "two" })) })).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expectPrivate(spoolPath(nemaHome), 0o600);
    expect(readFileSync(spoolPath(nemaHome), "utf8").trim().split("\n")).toHaveLength(2);

    const h = await hub();
    await runReportHook({ agent: "claude-code", nemaHome, hubUrl: h.url, stdin: stdinOf(JSON.stringify({ cwd: repo, session_id: "three" })) });
    expect(h.received.map((r) => (r.body as HookSignal).sessionId)).toEqual(["one", "two", "three"]);
    expect(existsSync(spoolPath(nemaHome))).toBe(false);
  });

  test("spool stops growing at 5 MB", async () => {
    const nemaHome = tmp("nema-home-");
    writeFileSync(spoolPath(nemaHome), "x".repeat(SPOOL_MAX_BYTES - 10) + "\n", { mode: 0o600 });
    const before = statSync(spoolPath(nemaHome)).size;
    const ok = appendSpool(nemaHome, { path: "/report/hook", body: { agent: "a", pad: "y".repeat(100) }, spooledAt: new Date().toISOString() });
    expect(ok).toBe(false);
    expect(statSync(spoolPath(nemaHome)).size).toBe(before);
  });

  test("spool flush drops lines older than 7 days", async () => {
    const nemaHome = tmp("nema-home-");
    const now = Date.now();
    appendSpool(nemaHome, { path: "/report/hook", body: { n: "old" }, spooledAt: new Date(now - 8 * 86_400_000).toISOString() });
    appendSpool(nemaHome, { path: "/report/hook", body: { n: "new" }, spooledAt: new Date(now - 86_400_000).toISOString() });
    appendSpool(nemaHome, { path: "/report", body: { n: "later" }, spooledAt: new Date(now).toISOString() });
    const sent: unknown[] = [];
    let calls = 0;
    const r = await flushSpool(nemaHome, async (line) => {
      calls++;
      if (calls === 2) return "failed";
      sent.push(line.body);
      return "ok";
    });
    expect(r).toBe("failed");
    expect(sent).toEqual([{ n: "new" }]);
    const rest = readFileSync(spoolPath(nemaHome), "utf8").trim().split("\n").map((l) => JSON.parse(l).body);
    expect(rest).toEqual([{ n: "later" }]);
    expectPrivate(spoolPath(nemaHome), 0o600);
  });
});

describe("nema report", () => {
  test("report sends commits, entries and files and prints 已上报到 Nema", async () => {
    const repo = makeRepo();
    const sha = git(repo, "rev-parse", "HEAD");
    const h = await hub();
    const o = collectOut();
    const code = await runReport({
      nemaHome: tmp("nema-home-"),
      hubUrl: h.url,
      cwd: repo,
      out: o.out,
      flags: { agent: "claude-code", summary: "做完了登录", commits: sha.slice(0, 7), entries: "R-1,D-2", files: "a.txt" },
    });
    expect(code).toBe(0);
    expect(o.logs).toEqual(["已上报到 Nema"]);
    expect(h.received[0]!.path).toBe("/report");
    expect(h.received[0]!.body).toEqual({
      agent: "claude-code",
      gitCommonDir: realpathSync(path.join(repo, ".git")),
      summary: "做完了登录",
      progress: "completed",
      entries: ["R-1", "D-2"],
      commits: [sha.slice(0, 7)],
      files: ["a.txt"],
    });
  });

  test("report reads its fields as JSON from stdin with --json", async () => {
    const repo = makeRepo();
    const sha = git(repo, "rev-parse", "HEAD");
    const h = await hub();
    const o = collectOut();
    const code = await runReport({
      nemaHome: tmp("nema-home-"),
      hubUrl: h.url,
      cwd: repo,
      out: o.out,
      flags: { json: true },
      stdin: stdinOf(JSON.stringify({ summary: "s", commits: [sha], agent: "codex" })),
    });
    expect(code).toBe(0);
    expect(h.received[0]!.body).toMatchObject({ agent: "codex", summary: "s", commits: [sha], entries: [], files: [] });
  });

  test("report outside a repo exits 1 with 不在 git 仓库里，无法上报", async () => {
    const h = await hub();
    const o = collectOut();
    const code = await runReport({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: tmp("nema-norepo-"), out: o.out, flags: { summary: "s", commits: "abcdef1" } });
    expect(code).toBe(1);
    expect(o.errors).toEqual(["不在 git 仓库里，无法上报"]);
    expect(h.received).toHaveLength(0);
  });

  test("report on a 4xx exits 1 with the hub's error text", async () => {
    const repo = makeRepo();
    const h = await hub();
    h.status = 400;
    h.reply = JSON.stringify({ error: "提交号格式不对" });
    const o = collectOut();
    const code = await runReport({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: repo, out: o.out, flags: { summary: "s", commits: "abcdef1" } });
    expect(code).toBe(1);
    expect(o.errors.join("\n")).toContain("提交号格式不对");
  });

  test("report with the hub down spools and says so", async () => {
    const repo = makeRepo();
    const nemaHome = tmp("nema-home-");
    const o = collectOut();
    const code = await runReport({ nemaHome, hubUrl: await deadHubUrl(), cwd: repo, out: o.out, flags: { summary: "s", commits: "abcdef1" } });
    expect(code).toBe(0);
    expect(o.logs).toEqual(["Nema 暂时不可达，已暂存，稍后补发"]);
    expect(JSON.parse(readFileSync(spoolPath(nemaHome), "utf8").trim()).path).toBe("/report");
  });

  test("the report token file is 0600 and never printed", async () => {
    const repo = makeRepo();
    const nemaHome = tmp("nema-home-");
    const h = await hub();
    const o = collectOut();
    const write = vi.spyOn(process.stdout, "write");
    const errWrite = vi.spyOn(process.stderr, "write");
    await runReport({ nemaHome, hubUrl: h.url, cwd: repo, out: o.out, flags: { summary: "s", commits: "abcdef1" } });
    await runReportHook({ agent: "x", nemaHome, hubUrl: h.url, stdin: stdinOf(JSON.stringify({ cwd: repo })) });
    const token = readFileSync(reportTokenPath(nemaHome), "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expectPrivate(reportTokenPath(nemaHome), 0o600);
    const printed = [...o.logs, ...o.errors, ...write.mock.calls.map((c) => String(c[0])), ...errWrite.mock.calls.map((c) => String(c[0]))].join("\n");
    expect(printed).not.toContain(token);
    expect(ensureReportToken(nemaHome)).toBe(token);
    expect(reportTokenHash(nemaHome)).toMatch(/^[0-9a-f]{64}$/);
    expect(reportTokenHash(nemaHome)).not.toBe(token);
  });

  test("a report token file that is not 0600 is refused", () => {
    const nemaHome = tmp("nema-home-");
    writeFileSync(reportTokenPath(nemaHome), "a".repeat(64), { mode: 0o644 });
    expect(() => ensureReportToken(nemaHome)).toThrow();
  });

  test("reportTokenHash is null when there is no token file", () => {
    expect(reportTokenHash(tmp("nema-home-"))).toBeNull();
  });
});
