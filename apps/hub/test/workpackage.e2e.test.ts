import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { KnowledgeStore } from "@nema/knowledge";
import { afterAll, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { getRepo, type Repo } from "../src/repos.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterAll(cleanupHubDeps);

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`git ${args.join(" ")} failed\n${stderr}`, { cause: e });
  }
}

/** Commits only the named paths: the worktree also holds `.nema/` files that must stay out. */
function commitPaths(dir: string, paths: string[], message: string): string {
  git(dir, ["add", ...paths]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function writeGraphify(file: string): void {
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[2];
if (cmd === "extract" || cmd === "update") {
  fs.mkdirSync("graphify-out", { recursive: true });
  fs.writeFileSync("graphify-out/graph.json", "{}\\n");
  process.exit(0);
}
process.stderr.write("unexpected graphify args\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(file, 0o755);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout: ${label}`);
}

type StartedDaemon = { close(): void; watcher: { tick(): Promise<void> } };
type Out = { log(s: string): void; error(s: string): void };
type SendOpts = { connectMs: number; totalMs: number };
type CliModules = {
  startDaemon(o: { hubUrl: string; token: string; nemaHome: string; userCodexHome: string; version: string; cliEntry: string; graphify: { bin: string } }): StartedDaemon;
  runReport(o: {
    nemaHome: string;
    hubUrl: string;
    cwd: string;
    out: Out;
    flags: { agent?: string; summary?: string; commits?: string; entries?: string; files?: string; task?: string };
    sendOpts?: SendOpts;
  }): Promise<number>;
  runWpGet(o: { nemaHome: string; hubUrl: string; cwd: string; out: Out; id: string; dir?: string }): Promise<number>;
  ensureReportToken(nemaHome: string): string;
  saveByokKey(nemaHome: string, key: string): void;
};

/** Hub's project root stops at apps/hub, so the real daemon, `nema report` and `nema wp get` are loaded at runtime. */
async function loadCli(): Promise<CliModules> {
  const load = (rel: string) => import(new URL(`../../cli/src/${rel}`, import.meta.url).href) as Promise<Record<string, never>>;
  const [setup, report, token, wp, byok] = await Promise.all([
    load("daemon/setup.ts"),
    load("report/commands.ts"),
    load("report/token.ts"),
    load("wp/commands.ts"),
    load("direct/byok.ts"),
  ]);
  return {
    startDaemon: setup.startDaemon,
    runReport: report.runReport,
    runWpGet: wp.runWpGet,
    ensureReportToken: token.ensureReportToken,
    saveByokKey: byok.saveByokKey,
  } as CliModules;
}

async function request(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the raw body so a non-JSON failure is visible.
  }
  return { status: res.status, json };
}

const SEND: SendOpts = { connectMs: 5_000, totalMs: 10_000 };

const SPEC = `## 意图与原因

让 API 输出流式结果。

## 已定的做法

- 先改 README 说明流式输出 [R-1]
- 再补文档页 [R-2]

## 验收标准

- 两个需求都有对应改动
`;

const PLAN = `### 任务 1：说明流式输出
- 修改：API:README.md
- 满足：R-1

改 README。

### 任务 2：补文档页
- 新建：API:docs/stream.md
- 满足：R-2

新增文档。
`;

type Step = { name: string; args: unknown } | { text: string };

/** A scripted fake Responses server: generation tasks follow the current phase's script, every other task just answers. */
async function startFakeModel(script: {
  phase: () => "question" | "write";
  sourceMessageId: () => Promise<string>;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/v1/responses") {
          res.writeHead(404).end();
          return;
        }
        const body = JSON.parse(raw) as { instructions?: string; input?: { type: string; output?: string }[] };
        const outputs = (body.input ?? []).filter((i) => i.type === "function_call_output");
        const step = outputs.length;
        let next: Step = { text: "好的，已处理。" };
        if ((body.instructions ?? "").includes("# 开发包 W-1")) {
          if (script.phase() === "question") {
            const questionId = () => (JSON.parse(outputs[0]!.output ?? "{}") as { entry?: { id?: string } }).entry?.id ?? "Q-0";
            const steps: Step[] = [
              {
                name: "upsert_entry",
                args: {
                  kind: "question",
                  title: "流式输出用哪种协议",
                  body: "SSE 还是 WebSocket？",
                  priority: 1,
                  basis: "inferred",
                  sourceMessages: [await script.sourceMessageId()],
                  reason: "开发包就绪检查发现的不确定点",
                },
              },
              { name: "workpackage__block", args: { id: "W-1", questionId: step >= 1 ? questionId() : "" } },
              { text: "开发包卡在问题上，等待回答。" },
            ];
            next = steps[Math.min(step, steps.length - 1)]!;
          } else {
            const steps: Step[] = [
              { name: "workpackage__save_spec", args: { id: "W-1", markdown: SPEC } },
              { name: "workpackage__save_plan", args: { id: "W-1", markdown: PLAN } },
              { text: "开发包已写好：2 个任务。" },
            ];
            next = steps[Math.min(step, steps.length - 1)]!;
          }
        }
        const item =
          "text" in next
            ? { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: next.text, annotations: [] }] }
            : { type: "function_call", id: `fc_${step}`, call_id: `call_${step}`, name: next.name, arguments: JSON.stringify(next.args), status: "completed" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (o: { type: string }) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
        res.write(frame({ type: "response.created", response: { id: "resp_1" } } as never));
        res.write(frame({ type: "response.output_item.done", output_index: 0, item } as never));
        res.write(frame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } } as never));
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("a work package goes from request through the grill question, approval, handoff and per-task reports to done", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nema-wp-e2e-")));
  const savedHome = process.env.HOME;
  const home = path.join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  const graphify = path.join(root, "graphify.cjs");
  writeGraphify(graphify);
  const nemaHome = path.join(root, "nema-home");
  mkdirSync(nemaHome, { mode: 0o700 });

  const bare = path.join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  const mainBefore = commitPaths(repo, ["README.md"], "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);

  const { db, dataDir } = await makeHubDeps();
  const workspace = await createWorkspace(db, dataDir, "API");
  const store = new KnowledgeStore(repoPath(dataDir, workspace.id));
  const events = new EventBus();

  let phase: "question" | "write" = "question";
  const model = await startFakeModel({
    phase: () => phase,
    sourceMessageId: async () => {
      const rows = await db.query<{ id: string }>(`select id from messages where workspace_id = $1 order by created_at desc limit 1`, [workspace.id]);
      return rows[0]!.id;
    },
  });

  const cli = await loadCli();
  cli.ensureReportToken(nemaHome);
  // The daemon's own task runs go through codex-direct in BYOK mode, against the scripted fake model.
  cli.saveByokKey(nemaHome, "sk-test-fake");
  writeFileSync(
    path.join(nemaHome, "config.json"),
    JSON.stringify({ adapter: "codex-direct", reasoningEffort: "medium", authMode: "byok", model: "fake-model", byokBaseUrl: model.baseUrl }),
  );

  let listener: http.RequestListener = (_req, res) => res.end();
  const server = http.createServer((req, res) => listener(req, res));
  let daemon: StartedDaemon | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const attached = attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl });
    listener = getRequestListener(
      createApp({ db, dataDir, nemaHome, events, daemonStatus: () => attached.isConnected(), daemon: attached.rpc, port }).fetch,
    );
    daemon = cli.startDaemon({ hubUrl, token: "tok", nemaHome, userCodexHome: path.join(root, "codex"), version: "0.0.0", cliEntry: path.join(root, "index.js"), graphify: { bin: graphify } });
    await waitFor("daemon", async () => attached.isConnected());
    await waitFor("report token", async () => (await db.query(`select 1 from report_tokens`)).length > 0);
    const api = `${hubUrl}/api/workspaces/${workspace.id}`;

    // 1. Bind the repo, and give the workspace two active requirements.
    const bound = await request("POST", `${api}/repos`, { path: repo, label: "API" });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const boundRepo = bound.json as Repo;
    await waitFor("indexed sha", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === mainBefore);
    for (const title of ["流式输出", "文档页"]) {
      await store.upsert({ kind: "requirement", title, body: title, status: "active", reason: "e2e", sourceMessages: [], basis: "stated" } as never, { author: "user" });
    }

    // 2. Request a package for R-1 and R-2. The scripted model blocks it on a question.
    const requested = await request("POST", `${api}/workpackages`, { requirements: ["R-1", "R-2"] });
    expect(requested.status, JSON.stringify(requested.json)).toBe(200);
    const blocked = await waitFor("blocked on the question", async () => {
      const w = await store.get("W-1");
      return w?.workpackage?.blockedOn ? w : null;
    });
    expect(blocked.status).toBe("draft");
    const questionId = blocked.workpackage!.blockedOn!;
    expect((await store.get(questionId))!.kind).toBe("question");
    expect((await store.readWorkPackage("W-1"))!.spec).toBeNull();
    await waitFor("first generation done", async () => (await db.query(`select 1 from tasks where status = 'done' and kind = 'workpackage'`)).length === 1);

    // 3. Answering the question re-runs generation, which now saves a spec and a plan.
    phase = "write";
    const answered = await request("PUT", `${api}/entries/${questionId}`, {
      kind: "question",
      title: "流式输出用哪种协议",
      body: "用 SSE。",
      status: "resolved",
      priority: 1,
      reason: "用户回答",
      sourceMessages: [],
    });
    expect(answered.status, JSON.stringify(answered.json)).toBe(200);
    const written = await waitFor("spec and plan saved", async () => {
      const w = await store.readWorkPackage("W-1");
      return w?.spec && w.plan ? w : null;
    });
    expect(written.entry.workpackage!.blockedOn).toBeNull();
    expect(written.entry.status).toBe("draft");
    expect(written.entry.workpackage!.tasks.map((t) => [t.n, t.status])).toEqual([
      [1, "pending"],
      [2, "pending"],
    ]);
    await waitFor("second generation done", async () => (await db.query(`select 1 from tasks where status = 'done' and kind = 'workpackage'`)).length === 2);

    // 4. Only the user's approve makes it servable.
    const out: string[] = [];
    const errors: string[] = [];
    const sink: Out = { log: (s) => out.push(s), error: (s) => errors.push(s) };
    const wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-b", "feature", wt]);
    const handoff = path.join(root, "handoff");
    expect(await cli.runWpGet({ nemaHome, hubUrl, cwd: wt, out: sink, id: "W-1", dir: handoff })).toBe(1);
    expect(existsSync(path.join(handoff, ".nema"))).toBe(false);
    const approved = await request("POST", `${api}/workpackages/W-1/approve`, {});
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect((await store.get("W-1"))!.status).toBe("approved");

    // 5. `nema wp get` writes the spec and the plan, and nothing lands in the bound repo.
    out.length = 0;
    errors.length = 0;
    expect(await cli.runWpGet({ nemaHome, hubUrl, cwd: wt, out: sink, id: "W-1", dir: handoff })).toBe(0);
    expect(errors).toEqual([]);
    expect(readFileSync(path.join(handoff, ".nema", "W-1", "spec.md"), "utf8")).toBe(SPEC);
    expect(readFileSync(path.join(handoff, ".nema", "W-1", "plan.md"), "utf8")).toContain(PLAN);
    expect(git(repo, ["status", "--porcelain"])).toBe("");

    // 6. Task 1 is committed to origin/main and reported: verified, and the package is in progress.
    writeFileSync(path.join(wt, "README.md"), "hello\nstreaming over SSE\n");
    const task1 = commitPaths(wt, ["README.md"], "docs: streaming");
    git(wt, ["push", "origin", "feature:main"]);
    const report = async (flags: { summary: string; commits: string; files: string; task: string }) => {
      errors.length = 0;
      const code = await cli.runReport({ nemaHome, hubUrl, cwd: wt, out: sink, flags: { agent: "claude-code", entries: "W-1", ...flags }, sendOpts: SEND });
      expect({ code, errors }).toEqual({ code: 0, errors: [] });
    };
    await report({ summary: "任务 1 完成", commits: task1, files: "README.md", task: "1" });
    const afterOne = await waitFor("task 1 verified", async () => {
      const w = await store.get("W-1");
      return w?.workpackage?.tasks[0]?.status === "verified" ? w : null;
    });
    expect(afterOne.status).toBe("in_progress");
    expect(afterOne.workpackage!.tasks[1]!.status).toBe("pending");

    // 7. Task 2 is reported from a commit that is not on main yet: reported. The user confirms it: done, but its requirements stay unmarked.
    mkdirSync(path.join(wt, "docs"));
    writeFileSync(path.join(wt, "docs", "stream.md"), "# stream\n");
    const task2 = commitPaths(wt, ["docs/stream.md"], "docs: stream page");
    await report({ summary: "任务 2 完成", commits: task2, files: "docs/stream.md", task: "2" });
    const reported = await waitFor("task 2 reported", async () => {
      const w = await store.get("W-1");
      return w?.workpackage?.tasks[1]?.status === "reported" ? w : null;
    });
    expect(reported.status).toBe("in_progress");
    const confirmed = await request("POST", `${api}/workpackages/W-1/tasks/2/confirm`, {});
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    const done = (await store.get("W-1"))!;
    expect(done.status).toBe("done");
    expect(done.workpackage!.tasks.map((t) => t.status)).toEqual(["verified", "verified"]);
    expect(done.workpackage!.tasks[1]!.confirmedBy).toBe("user");
    // A task the user confirmed has no passing report of its own, so the package's requirements are not
    // marked as commits-checked: done is not acceptance, and a user confirmation is not a git check.
    for (const id of ["R-1", "R-2"]) expect((await store.get(id))!.implementation?.status, id).toBeUndefined();
  } finally {
    daemon?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await model.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
