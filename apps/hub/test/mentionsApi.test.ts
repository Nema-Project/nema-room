import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { createWorkspace, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
let db: Db;
let dataDir: string;
let ws: string;
let app: Hono<any>;
let daemon: DaemonRpc;
let connected: boolean;
let calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }>;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  ws = (await createWorkspace(db, dataDir, "A")).id;
  calls = [];
  connected = true;
  daemon = { call: () => Promise.reject(new Error("unexpected call")) };
  app = createApp({
    db, dataDir, events: new EventBus(), daemonStatus: () => connected,
    daemon: {
      call: (method, params, timeoutMs) => {
        calls.push({ method, params: params as Record<string, unknown>, timeoutMs });
        return daemon.call(method, params, timeoutMs);
      },
    },
  });
});
afterAll(cleanupHubDeps);

async function insertRepo(label: string, workspace = ws) {
  const id = `repo_${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, created_at)
     values ($1, $2, $3, $4, $5, 'main', false, $6)`,
    [id, workspace, `/repos/${label}`, `/repos/${label}/.git`, label, new Date().toISOString()],
  );
  return id;
}

const listing: Record<string, { commit: string; paths: string[]; truncated?: boolean }> = {};
const serveListings = () => {
  daemon = {
    call: async (method, params) => {
      if (method !== "repo.files") throw new Error(`unexpected ${method}`);
      const l = listing[(params as { repoId: string }).repoId];
      if (!l) throw new Error("no such repo");
      return { commit: l.commit, paths: l.paths, truncated: l.truncated ?? false };
    },
  };
};
const search = (q: string | undefined, workspace = ws) =>
  app.request(`${HUB}/api/workspaces/${workspace}/mention-files${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`);

describe("GET /api/workspaces/:id/mention-files", () => {
  test("merges both bound repositories, ranked by fuzzyScore, with repo id, label, path and commit only", async () => {
    const web = await insertRepo("web");
    const hub = await insertRepo("hub");
    listing[web] = { commit: SHA_A, paths: ["apps/web/lib/slashy/x.ts", "apps/web/lib/slash.ts", "README.md"] };
    listing[hub] = { commit: SHA_B, paths: ["src/slash.ts", "src/other.ts"] };
    serveListings();
    const res = await search("slash");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; truncated: boolean; files: Array<Record<string, string>> };
    expect(body.status).toBe("ok");
    expect(body.truncated).toBe(false);
    expect(body.files).toEqual([
      { repoId: hub, label: "hub", path: "src/slash.ts", commit: SHA_B },
      { repoId: web, label: "web", path: "apps/web/lib/slash.ts", commit: SHA_A },
      { repoId: web, label: "web", path: "apps/web/lib/slashy/x.ts", commit: SHA_A },
    ]);
    for (const f of body.files) expect(Object.keys(f).sort()).toEqual(["commit", "label", "path", "repoId"]);
    expect(calls.map((c) => c.params)).toEqual(expect.arrayContaining([
      { workspaceId: ws, repoId: web, path: "/repos/web", mainBranch: "main" },
      { workspaceId: ws, repoId: hub, path: "/repos/hub", mainBranch: "main" },
    ]));
    expect(calls.every((c) => c.timeoutMs === 5000)).toBe(true);
  });

  test("returns at most 50 files and says the list is cut", async () => {
    const web = await insertRepo("web");
    listing[web] = { commit: SHA_A, paths: Array.from({ length: 80 }, (_, i) => `src/file${i}.ts`) };
    serveListings();
    const body = (await (await search("file")).json()) as { files: unknown[]; truncated: boolean };
    expect(body.files).toHaveLength(50);
    expect(body.truncated).toBe(true);
  });

  test("a repository listing the daemon cut short marks the result truncated", async () => {
    const web = await insertRepo("web");
    listing[web] = { commit: SHA_A, paths: ["a.ts"], truncated: true };
    serveListings();
    expect(await (await search("a")).json()).toMatchObject({ status: "ok", truncated: true });
  });

  test("an empty query returns no files and does not call the daemon", async () => {
    await insertRepo("web");
    for (const q of [undefined, "", "   "]) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", files: [], truncated: false });
    }
    expect(calls).toEqual([]);
  });

  test("an old daemon without repo.files is unsupported; a missing daemon is offline; both are 200", async () => {
    await insertRepo("web");
    daemon = { call: () => Promise.reject(new DaemonRpcError("未知方法 repo.files")) };
    let res = await search("a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unsupported", files: [], truncated: false });

    daemon = { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) };
    res = await search("a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "offline", files: [], truncated: false });

    connected = false;
    calls = [];
    res = await search("a");
    expect(await res.json()).toEqual({ status: "offline", files: [], truncated: false });
    expect(calls).toEqual([]);
  });

  test("a repository that times out is skipped and the others still answer", async () => {
    const slow = await insertRepo("slow");
    const web = await insertRepo("web");
    listing[web] = { commit: SHA_A, paths: ["a.ts"] };
    daemon = {
      call: async (_m, params) => {
        if ((params as { repoId: string }).repoId === slow) throw new DaemonRpcError("daemon 响应超时");
        return { commit: SHA_A, paths: ["a.ts"], truncated: false };
      },
    };
    const body: unknown = await (await search("a")).json();
    expect(body).toEqual({ status: "ok", files: [{ repoId: web, label: "web", path: "a.ts", commit: SHA_A }], truncated: false });
  });

  test("a malformed daemon answer skips that repository", async () => {
    const web = await insertRepo("web");
    daemon = { call: async () => ({ commit: "nope", paths: [1] }) };
    expect(await (await search("a")).json()).toEqual({ status: "ok", files: [], truncated: false });
    expect(web).toBeTruthy();
  });

  test("an unknown workspace is 404; an archived one can still be searched", async () => {
    expect((await search("a", "ws_missing")).status).toBe(404);
    const web = await insertRepo("web");
    listing[web] = { commit: SHA_A, paths: ["a.ts"] };
    serveListings();
    await updateWorkspace(db, ws, { archived: true });
    const body = (await (await search("a")).json()) as { files: unknown[] };
    expect(body.files).toHaveLength(1);
  });

  test("another workspace's repositories are never listed", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const foreign = await insertRepo("foreign", other);
    listing[foreign] = { commit: SHA_A, paths: ["a.ts"] };
    serveListings();
    expect(await (await search("a")).json()).toEqual({ status: "ok", files: [], truncated: false });
    expect(calls).toEqual([]);
  });

  test("an overlong query is refused", async () => {
    expect((await search("x".repeat(201))).status).toBe(400);
  });
});
