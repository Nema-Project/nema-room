import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { DaemonRpcError } from "../src/daemonRpc.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus, type HubEvent } from "../src/events.js";
import { PluginError, setPluginState } from "../src/plugins.js";
import { RepoError, applyRepoMoved, bindRepo, findRepoForWorkspace, getRepo, listRepos, previewRepo, syncBoundRepos, unbindRepo, updateRepo } from "../src/repos.js";
import { createWorkspace, deleteWorkspace, updateWorkspace } from "../src/workspaces.js";
import { listMessages } from "../src/messages.js";
import { listQueuedTasks } from "../src/tasks.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);

const inspected = {
  root: "/real/a",
  gitCommonDir: "/real/a/.git",
  defaultBranch: "main",
  hasOrigin: true,
  remoteUrl: "https://example.com/a.git",
};

function daemonOf(handlers: Record<string, (params: unknown) => Promise<unknown> | unknown>): { daemon: DaemonRpc; calls: { method: string; params: unknown; timeoutMs?: number }[] } {
  const calls: { method: string; params: unknown; timeoutMs?: number }[] = [];
  return {
    calls,
    daemon: {
      async call(method, params, timeoutMs) {
        calls.push({ method, params, timeoutMs });
        const handler = handlers[method] ?? (method === "repos.sync" ? () => ({ ok: true }) : undefined);
        if (!handler) throw new Error(`unexpected ${method}`);
        return handler(params);
      },
    },
  };
}

test("preview names the folder, reports a taken label, and does not index", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { daemon, calls } = daemonOf({
    "repo.inspect": () => ({ ...inspected, root: "/real/a", defaultBranch: "develop" }),
    "repo.index": () => ({ sha: "" }),
  });
  await expect(previewRepo(db, daemon, ws.id, "/a/x")).resolves.toEqual({
    root: "/real/a",
    defaultBranch: "develop",
    hasOrigin: true,
    remoteUrl: "https://example.com/a.git",
    label: "a",
    labelTaken: false,
  });
  await bindRepo(db, daemon, ws.id, { path: "/a/x", label: "a" });
  calls.length = 0;
  await expect(previewRepo(db, daemon, ws.id, "/a/x")).resolves.toMatchObject({ label: "a", labelTaken: true });
  expect(calls.map((call) => call.method)).toEqual(["repo.inspect"]);
});

test("binding stores the inspected repo and fires repo.index", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  let rejectIndex: (err: Error) => void = () => {};
  const indexHung = new Promise((_resolve, reject) => {
    rejectIndex = reject;
  });
  const { daemon, calls } = daemonOf({
    "repo.inspect": () => inspected,
    "repo.index": () => indexHung,
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const pending = bindRepo(db, daemon, ws.id, { path: "/a/x", label: "API", mainBranch: "develop" });
  const result = await Promise.race([
    pending.then((repo) => ({ done: true as const, repo })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 1000)),
  ]);

  expect(result.done).toBe(true);
  if (!result.done) return;
  expect(result.repo).toMatchObject({
    workspaceId: ws.id,
    path: "/real/a",
    gitCommonDir: "/real/a/.git",
    label: "API",
    mainBranch: "develop",
    hasOrigin: true,
    remoteUrl: "https://example.com/a.git",
    lastMainSha: null,
    lastFetchAt: null,
    lastFetchError: null,
  });
  expect(result.repo.id).toMatch(/^repo_[A-Za-z0-9_-]+$/);
  expect(calls.map((c) => c.method)).toEqual(["repo.inspect", "repo.index", "repos.sync"]);
  expect(calls[1]!.timeoutMs).toBe(300_000);
  expect(calls[0]?.params).toEqual({ path: "/a/x" });
  expect(calls[1]?.params).toEqual({
    workspaceId: ws.id,
    repoId: result.repo.id,
    path: "/real/a",
    mainBranch: "develop",
  });
  expect(await listRepos(db, ws.id)).toEqual([result.repo]);
  expect(await getRepo(db, result.repo.id)).toEqual(result.repo);

  rejectIndex(new Error("index failed"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors.mock.calls.some((args) => args.join(" ").includes("index failed"))).toBe(true);
  errors.mockRestore();
});

test("binding the same git common dir twice is 409 even through a different path spelling", async () => {
  const { db, dataDir } = await makeHubDeps();
  const alpha = await createWorkspace(db, dataDir, "Alpha");
  const beta = await createWorkspace(db, dataDir, "Beta");
  const { daemon } = daemonOf({
    "repo.inspect": (params) => {
      const requestPath = (params as { path: string }).path;
      expect(["/a/x", "/a/x/"]).toContain(requestPath);
      return { ...inspected, root: "/real/a", gitCommonDir: "/real/common" };
    },
    "repo.index": () => Promise.resolve({ sha: "abc" }),
  });

  await bindRepo(db, daemon, alpha.id, { path: "/a/x", label: "API" });
  const second = bindRepo(db, daemon, beta.id, { path: "/a/x/", label: "API" });
  await expect(second).rejects.toBeInstanceOf(RepoError);
  await expect(second).rejects.toMatchObject({ status: 409, message: "该仓库已绑定到 workspace Alpha" });
  expect(await listRepos(db, beta.id)).toEqual([]);
});

test("binding without a daemon is 503 daemon 未连接", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const daemon: DaemonRpc = {
    call: () => Promise.reject(new DaemonRpcError("daemon 未连接")),
  };
  const pending = bindRepo(db, daemon, ws.id, { path: "/a/x", label: "API" });
  await expect(pending).rejects.toBeInstanceOf(RepoError);
  await expect(pending).rejects.toMatchObject({ status: 503, message: "daemon 未连接" });
  expect(await listRepos(db, ws.id)).toEqual([]);
});

test("unbinding fires repo.forget and deleting the workspace removes its repos", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const other = await createWorkspace(db, dataDir, "Beta");
  const { daemon, calls } = daemonOf({
    "repo.inspect": (params) => {
      const requestPath = (params as { path: string }).path;
      return { ...inspected, root: requestPath, gitCommonDir: `${requestPath}/.git` };
    },
    // Never resolves, so the indexed sha does not change the rows compared below.
    "repo.index": () => new Promise(() => {}),
    "repo.forget": () => {
      const rejected = Promise.reject(new Error("forget failed"));
      rejected.catch(() => {});
      return rejected;
    },
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const kept = await bindRepo(db, daemon, ws.id, { path: "/keep", label: "Keep" });
  const gone = await bindRepo(db, daemon, ws.id, { path: "/gone", label: "Gone" });
  const elsewhere = await bindRepo(db, daemon, other.id, { path: "/else", label: "Else" });

  await unbindRepo(db, daemon, gone.id);
  expect(await getRepo(db, gone.id)).toBeNull();
  expect(calls.filter((c) => c.method === "repo.forget").map((c) => c.params)).toEqual([
    { workspaceId: ws.id, repoId: gone.id, path: "/gone", mainBranch: "main" },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors.mock.calls.some((args) => args.join(" ").includes("forget failed"))).toBe(true);
  errors.mockRestore();

  await deleteWorkspace(db, dataDir, ws.id);
  expect(await listRepos(db, ws.id)).toEqual([]);
  expect(await getRepo(db, kept.id)).toBeNull();
  expect(await getRepo(db, elsewhere.id)).toEqual(elsewhere);
});

test("findRepoForWorkspace matches id or label and never another workspace's repo", async () => {
  const { db, dataDir } = await makeHubDeps();
  const alpha = await createWorkspace(db, dataDir, "Alpha");
  const beta = await createWorkspace(db, dataDir, "Beta");
  const { daemon } = daemonOf({
    "repo.inspect": (params) => {
      const requestPath = (params as { path: string }).path;
      return { ...inspected, root: requestPath, gitCommonDir: `${requestPath}/.git`, defaultBranch: "trunk" };
    },
    "repo.index": () => new Promise(() => {}),
  });
  const api = await bindRepo(db, daemon, alpha.id, { path: "/api", label: "API" });
  const web = await bindRepo(db, daemon, alpha.id, { path: "/web", label: "Web" });
  const other = await bindRepo(db, daemon, beta.id, { path: "/beta-api", label: "API" });

  expect(api.mainBranch).toBe("trunk");
  expect(await findRepoForWorkspace(db, alpha.id, api.id)).toEqual(api);
  expect(await findRepoForWorkspace(db, alpha.id, "API")).toEqual(api);
  expect(await findRepoForWorkspace(db, alpha.id, "Web")).toEqual(web);
  expect(await findRepoForWorkspace(db, alpha.id, "api")).toBeNull();
  expect(await findRepoForWorkspace(db, alpha.id, other.id)).toBeNull();
  expect(await findRepoForWorkspace(db, alpha.id, "missing")).toBeNull();
  expect(await findRepoForWorkspace(db, beta.id, "API")).toEqual(other);
  expect(await findRepoForWorkspace(db, beta.id, api.id)).toBeNull();
});

test("binding stores the indexed sha as lastMainSha, re-syncs it, and unbinding drops the repo", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  let finishIndex: (value: { sha: string }) => void = () => {};
  const indexed = new Promise<{ sha: string }>((resolve) => {
    finishIndex = resolve;
  });
  const { daemon, calls } = daemonOf({
    "repo.inspect": () => inspected,
    "repo.index": () => indexed,
    "repo.forget": () => ({ ok: true }),
    "repos.sync": () => ({ ok: true }),
  });

  const repo = await bindRepo(db, daemon, ws.id, { path: "/a/x", label: "API", mainBranch: "develop" });
  expect(calls.map((call) => call.method)).toEqual(["repo.inspect", "repo.index", "repos.sync"]);
  expect(calls[2]?.params).toEqual({
    repos: [
      {
        workspaceId: ws.id,
        repoId: repo.id,
        path: "/real/a",
        mainBranch: "develop",
        lastMainSha: null,
      },
    ],
  });

  finishIndex({ sha: "abc" });
  await until(async () => (await getRepo(db, repo.id))?.lastMainSha === "abc");
  await until(async () => calls.length === 4);
  expect(calls.at(-1)).toEqual({
    method: "repos.sync",
    params: { repos: [{ workspaceId: ws.id, repoId: repo.id, path: "/real/a", mainBranch: "develop", lastMainSha: "abc" }] },
  });

  await updateRepo(db, repo.id, { mainBranch: "trunk" }, daemon);
  expect(calls.at(-1)).toEqual({
    method: "repos.sync",
    params: {
      repos: [
        {
          workspaceId: ws.id,
          repoId: repo.id,
          path: "/real/a",
          mainBranch: "trunk",
          lastMainSha: "abc",
        },
      ],
    },
  });

  await unbindRepo(db, daemon, repo.id);
  expect(calls.at(-1)).toEqual({ method: "repos.sync", params: { repos: [] } });
});

test("welcome sends repos.sync with the stored lastMainSha", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, last_main_sha)
     values ('repo_sync', $1, '/real/a', '/real/a/.git', 'API', 'main', true, 'https://example.com/a.git', 'abc1234')`,
    [ws.id],
  );
  const events = new EventBus();
  const server = http.createServer();
  attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl: "http://hub.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
  const client = await connectDaemon(url);
  try {
    expect((await client.next("welcome")).type).toBe("welcome");
    const sync = await client.next("rpc.request");
    expect(sync).toMatchObject({
      type: "rpc.request",
      method: "repos.sync",
      params: {
        repos: [
          {
            workspaceId: ws.id,
            repoId: "repo_sync",
            path: "/real/a",
            mainBranch: "main",
            lastMainSha: "abc1234",
          },
        ],
      },
    });
    client.send({ type: "rpc.response", id: sync.id, ok: true, result: { ok: true } });
    await db.query("delete from workspace_repos where id = 'repo_sync'");
    events.emit(ws.id, { type: "workspace.deleted", workspaceId: ws.id });
    const again = await client.next("rpc.request");
    expect(again).toMatchObject({ method: "repos.sync", params: { repos: [] } });
    client.send({ type: "rpc.response", id: again.id, ok: true, result: { ok: true } });
  } finally {
    client.ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("repo.moved updates last_main_sha; a failed repo.fetched keeps the last successful last_fetch_at", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
     values ('repo_moved', $1, '/real/a', '/real/a/.git', 'API', 'main', true, 'https://example.com/a.git')`,
    [ws.id],
  );
  const events = new EventBus();
  const seen: HubEvent[] = [];
  events.subscribeAll((_workspaceId, event) => {
    if (event.type === "repo.moved") seen.push(event);
  });
  const server = http.createServer();
  attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl: "http://hub.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
  const client = await connectDaemon(url);
  try {
    await client.next("welcome");
    client.send({ type: "repo.moved", repoId: "repo_moved", mainRef: "origin/main", from: "oldsha1", to: "newsha1" });
    await until(async () => (await getRepo(db, "repo_moved"))?.lastMainSha === "newsha1");
    expect(seen).toEqual([
      { type: "repo.moved", repoId: "repo_moved", mainRef: "origin/main", from: "oldsha1", to: "newsha1" },
    ]);

    const okAt = "2026-10-23T03:04:05.000Z";
    client.send({ type: "repo.fetched", repoId: "repo_moved", ok: true, at: okAt });
    await until(async () => (await getRepo(db, "repo_moved"))?.lastFetchAt === okAt);

    client.send({ type: "repo.fetched", repoId: "repo_moved", ok: false, error: "fetch failed", at: "2026-10-23T04:05:06.000Z" });
    await until(async () => (await getRepo(db, "repo_moved"))?.lastFetchError === "fetch failed");
    const failed = await getRepo(db, "repo_moved");
    expect(failed?.lastFetchAt).toBe(okAt);
    expect(failed?.lastMainSha).toBe("newsha1");

    const laterAt = "2026-10-23T05:06:07.000Z";
    client.send({ type: "repo.fetched", repoId: "repo_moved", ok: true, at: laterAt });
    await until(async () => (await getRepo(db, "repo_moved"))?.lastFetchError === null);
    const ok = await getRepo(db, "repo_moved");
    expect(ok?.lastFetchAt).toBe(laterAt);
    expect(ok?.lastMainSha).toBe("newsha1");
  } finally {
    client.ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

function connectDaemon(url: string): Promise<{ ws: WebSocket; next(type?: string): Promise<Record<string, unknown>>; send(message: unknown): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (data) => {
      queue.push(JSON.parse(String(data)) as Record<string, unknown>);
      waiters.shift()?.();
    });
    const client = {
      ws,
      send: (message: unknown) => ws.send(JSON.stringify(message)),
      async next(type?: string) {
        const deadline = Date.now() + 3000;
        for (;;) {
          const index = queue.findIndex((message) => !type || message.type === type);
          if (index >= 0) return queue.splice(index, 1)[0]!;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${type ?? "message"}`);
          await new Promise<void>((done) => {
            waiters.push(done);
            setTimeout(done, 50);
          });
        }
      },
    };
    ws.on("error", reject);
    ws.on("open", () => {
      client.send({ type: "hello", token: "tok", version: "0", adapters: ["codex-direct"] });
      resolve(client);
    });
  });
}

test("binding to an archived workspace is 409 and never calls the daemon", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  await updateWorkspace(db, ws.id, { archived: true });
  const { daemon, calls } = daemonOf({ "repo.inspect": () => inspected });

  const err = await bindRepo(db, daemon, ws.id, { path: "/real/a", label: "API" }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(RepoError);
  expect(err).toMatchObject({ status: 409, message: "workspace 已归档，取消归档后才能绑定仓库" });
  expect(calls).toEqual([]);
});

test("binding to a missing workspace is 404 and never calls the daemon", async () => {
  const { db } = await makeHubDeps();
  const { daemon, calls } = daemonOf({ "repo.inspect": () => inspected });

  const err = await bindRepo(db, daemon, "ws_missing", { path: "/real/a", label: "API" }).catch((e: unknown) => e);

  expect(err).toMatchObject({ status: 404, message: "找不到 workspace：ws_missing" });
  expect(calls).toEqual([]);
});

test("repos.sync leaves out repos of archived workspaces", async () => {
  const { db, dataDir } = await makeHubDeps();
  const live = await createWorkspace(db, dataDir, "Live");
  const parked = await createWorkspace(db, dataDir, "Parked");
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin)
     values ('repo_live', $1, '/real/live', '/real/live/.git', 'L', 'main', false),
            ('repo_parked', $2, '/real/parked', '/real/parked/.git', 'P', 'main', false)`,
    [live.id, parked.id],
  );
  await updateWorkspace(db, parked.id, { archived: true });
  const { daemon, calls } = daemonOf({});

  await syncBoundRepos(db, daemon);

  const sync = calls.find((c) => c.method === "repos.sync")!;
  expect((sync.params as { repos: { repoId: string }[] }).repos.map((r) => r.repoId)).toEqual(["repo_live"]);
});

test("setting plugin state for a missing workspace is 404", async () => {
  const { db } = await makeHubDeps();

  const err = await setPluginState(db, "ws_missing", "code", { enabled: false }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(PluginError);
  expect(err).toMatchObject({ status: 404, message: "找不到 workspace：ws_missing" });
});

test("binding a second repo with the same label is 409", async () => {
  const { db, dataDir } = await makeHubDeps();
  const alpha = await createWorkspace(db, dataDir, "Alpha");
  const beta = await createWorkspace(db, dataDir, "Beta");
  let n = 0;
  const { daemon } = daemonOf({
    "repo.inspect": () => {
      n += 1;
      return { ...inspected, root: `/real/${n}`, gitCommonDir: `/real/${n}/.git` };
    },
    "repo.index": () => Promise.resolve({ sha: "abc" }),
  });

  const first = await bindRepo(db, daemon, alpha.id, { path: "/a/1", label: "API" });
  const second = bindRepo(db, daemon, alpha.id, { path: "/a/2", label: "API" });
  await expect(second).rejects.toMatchObject({ status: 409, message: "本 workspace 已有用途为 API 的仓库" });
  expect((await listRepos(db, alpha.id)).map((r) => r.id)).toEqual([first.id]);

  await expect(bindRepo(db, daemon, beta.id, { path: "/a/3", label: "API" })).resolves.toMatchObject({ label: "API" });
  const other = await bindRepo(db, daemon, alpha.id, { path: "/a/4", label: "Web" });
  await expect(updateRepo(db, other.id, { label: "API" }, daemon)).rejects.toMatchObject({
    status: 409,
    message: "本 workspace 已有用途为 API 的仓库",
  });
});

test("labels must be 1-40 characters without control characters", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { daemon, calls } = daemonOf({
    "repo.inspect": () => inspected,
    "repo.index": () => Promise.resolve({ sha: "abc" }),
  });
  for (const label of ["", "x".repeat(41), "a\nb", "a\u0000b"]) {
    await expect(bindRepo(db, daemon, ws.id, { path: "/a/x", label })).rejects.toMatchObject({
      status: 400,
      message: "用途说明需为 1–40 个字符",
    });
  }
  expect(calls).toEqual([]);
  const repo = await bindRepo(db, daemon, ws.id, { path: "/a/x", label: "用".repeat(40) });
  await expect(updateRepo(db, repo.id, { label: "a\tb" }, daemon)).rejects.toMatchObject({ status: 400, message: "用途说明需为 1–40 个字符" });
});

test("an invalid defaultBranch from repo.inspect is stored as main", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { daemon } = daemonOf({
    "repo.inspect": () => ({ ...inspected, defaultBranch: "a..b" }),
    "repo.index": () => Promise.resolve({ sha: "abc" }),
  });
  await expect(bindRepo(db, daemon, ws.id, { path: "/a/x", label: "API" })).resolves.toMatchObject({ mainBranch: "main" });
});

test("repo.moved for an unknown repo is ignored without a broadcast", async () => {
  const { db } = await makeHubDeps();
  const events = new EventBus();
  const seen: HubEvent[] = [];
  events.subscribeAll((_workspaceId, event) => seen.push(event));
  await applyRepoMoved(db, events, { repoId: "repo_gone", mainRef: "origin/main", from: "a", to: "b" });
  expect(seen).toEqual([]);
});

test("binding a repo queues one architecture task naming that repo", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { daemon } = daemonOf({
    "repo.inspect": (params) => {
      const requestPath = (params as { path: string }).path;
      return { ...inspected, root: requestPath, gitCommonDir: `${requestPath}/.git` };
    },
    "repo.index": () => new Promise(() => {}),
    "repo.forget": () => ({ ok: true }),
  });
  const events = new EventBus();
  const seen: HubEvent[] = [];
  events.subscribe(ws.id, (e) => seen.push(e));
  const architectureTasks = async () => {
    const messages = await listMessages(db, ws.id);
    const tasks = await listQueuedTasks(db, ws.id);
    return messages
      .filter((m) => m.role === "system")
      .map((m) => ({ content: m.content, queued: tasks.filter((t) => t.messageId === m.id).length }));
  };

  const api = await bindRepo(db, daemon, ws.id, { path: "/api", label: "API" }, events);
  expect(await architectureTasks()).toEqual([
    { content: `为仓库 API（${api.id}）画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。`, queued: 1 },
  ]);
  expect(seen.map((e) => e.type)).toEqual(["message.created", "task.updated"]);

  const web = await bindRepo(db, daemon, ws.id, { path: "/web", label: "Web" }, events);
  let list = await architectureTasks();
  expect(list).toHaveLength(2);
  expect(list[1]!.content).toContain(`为仓库 Web（${web.id}）`);
  expect(list[1]!.queued).toBe(1);

  await unbindRepo(db, daemon, web.id);
  expect(await architectureTasks()).toHaveLength(2);
  const again = await bindRepo(db, daemon, ws.id, { path: "/web", label: "Web" }, events);
  list = await architectureTasks();
  expect(list).toHaveLength(3);
  expect(list[2]!.content).toContain(`为仓库 Web（${again.id}）`);
  expect(list[2]!.queued).toBe(1);
});

test("a failed bind queues no architecture task", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { daemon } = daemonOf({ "repo.inspect": () => inspected, "repo.index": () => new Promise(() => {}) });
  await bindRepo(db, daemon, ws.id, { path: "/a", label: "A" });
  await expect(bindRepo(db, daemon, ws.id, { path: "/a", label: "B" })).rejects.toThrow(RepoError);
  expect((await listMessages(db, ws.id)).filter((m) => m.role === "system")).toHaveLength(1);
});
