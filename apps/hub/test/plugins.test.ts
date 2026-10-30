import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import WebSocket from "ws";
import { PLUGINS, bundledExtensions } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { postUserMessage } from "../src/messages.js";
import { roomRoutes } from "../src/roomApi.js";
import { claimNextTask } from "../src/tasks.js";
import { createWorkspace, getWorkspace, updateWorkspace } from "../src/workspaces.js";

const HUB = "http://127.0.0.1:4400";
const code = PLUGINS.find((plugin) => plugin.id === "code")!;
const codeFunctionNames = code.functions.filter((fn) => fn.readOnly).map((fn) => fn.name);
const diagramFunctionNames = ["diagram__save", "diagram__read"];
const workpackageFunctionNames = PLUGINS.find((plugin) => plugin.id === "superpowers")!.functions.map((fn) => fn.name);
const github = PLUGINS.find((plugin) => plugin.id === "github")!;

let db: Db;
let dataDir: string;
let events: EventBus;
let wsA: string;
let ui: Hono<any>;
let room: Hono<any>;
const daemonCalls: { method: string; params: unknown }[] = [];
let daemonCall: (method: string, params: unknown) => Promise<unknown> = async () => {
  throw new DaemonRpcError("daemon 未连接");
};
const daemon: DaemonRpc = {
  call(method, params) {
    daemonCalls.push({ method, params });
    return daemonCall(method, params);
  },
};

/**
 * Listing tools asks the daemon which extensions the install switched off. That read is the only
 * daemon traffic a refused call may cause; everything before it stays local.
 */
const nonExtensionCalls = () => daemonCalls.filter((call) => call.method !== "extensions.list");

beforeEach(async () => {
  daemonCalls.length = 0;
  // The daemon answers for extension state even while everything else is offline in these tests:
  // the tool list now asks which extensions the install turned off.
  daemonCall = async (method) => {
    if (method === "extensions.list") return bundledExtensions();
    throw new DaemonRpcError("daemon 未连接");
  };
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  events = new EventBus();
  wsA = (await createWorkspace(db, dataDir, "A")).id;
  ui = createApp({ db, dataDir, events, daemonStatus: () => true, daemon });
  room = new Hono().route("/room", roomRoutes({ db, dataDir, events, daemon }));
});
afterAll(cleanupHubDeps);

let repoSeq = 0;
async function insertRepo(workspaceId: string, label: string, remoteUrl: string | null = null) {
  repoSeq += 1;
  const id = `repo_${label}`;
  const path = `/repos/${workspaceId}/${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, created_at)
     values ($1, $2, $3, $4, $5, 'main', $7, $8, $6)`,
    [id, workspaceId, path, `${path}/.git`, label, new Date(Date.UTC(2026, 0, repoSeq)).toISOString(), remoteUrl !== null, remoteUrl],
  );
  return { id, label, path, mainBranch: "main" };
}

async function runningTask(workspaceId = wsA) {
  await postUserMessage(db, workspaceId, "memo");
  const task = await claimNextTask(db, "d1");
  expect(task?.workspaceId).toBe(workspaceId);
  return { runToken: task!.runToken!, taskId: task!.id };
}

const uiReq = (method: string, path: string, body?: unknown) =>
  ui.request(`${HUB}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const roomReq = (method: string, path: string, token: string, body?: unknown) =>
  room.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("workspace plugins", () => {
  test("local plugins default to enabled, also in a confidential workspace", async () => {
    expect((await getWorkspace(db, wsA))!.confidential).toBe(true);
    const first = await uiReq("GET", `/api/workspaces/${wsA}/plugins`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([
      expect.objectContaining({
        enabled: true,
        disabledFunctions: [],
        plugin: expect.objectContaining({ id: "code", dataFlow: "local", displayName: "graphify" }),
      }),
      expect.objectContaining({
        enabled: true,
        disabledFunctions: [],
        plugin: expect.objectContaining({ id: "diagram", dataFlow: "local", displayName: "archify", runsOn: "hub" }),
      }),
      expect.objectContaining({
        enabled: true,
        disabledFunctions: [],
        plugin: expect.objectContaining({ id: "superpowers", dataFlow: "local", displayName: "superpowers", runsOn: "hub", scope: "none" }),
      }),
      expect.objectContaining({
        enabled: true,
        disabledFunctions: [],
        settings: { strictness: "strict", extraRules: "" },
        plugin: expect.objectContaining({ id: "grill", dataFlow: "local", displayName: "grill-me", runsOn: "hub", scope: "none" }),
      }),
      // An external plugin is off by default, confidential or not.
      expect.objectContaining({
        enabled: false,
        disabledFunctions: [],
        plugin: expect.objectContaining({ id: "github", dataFlow: "external", displayName: "GitHub", runsOn: "daemon" }),
      }),
    ]);
    expect(await db.query("select 1 from workspace_plugins")).toEqual([]);

    await updateWorkspace(db, wsA, { confidential: false });
    const second = await uiReq("GET", `/api/workspaces/${wsA}/plugins`);
    expect(second.status).toBe(200);
    expect((await second.json()) as { enabled: boolean }[]).toMatchObject([
      { enabled: true, disabledFunctions: [] },
      { enabled: true, disabledFunctions: [] },
      { enabled: true, disabledFunctions: [] },
      { enabled: true, disabledFunctions: [] },
      { enabled: false, disabledFunctions: [] },
    ]);
  });

  test("code functions are not offered when the workspace has no repo", async () => {
    const task = await runningTask();
    const listed = await roomReq("GET", "/room/plugins", task.runToken);
    expect(listed.status).toBe(200);
    // Only the superpowers plugin needs no repo.
    expect(((await listed.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(workpackageFunctionNames);
    const call = await roomReq("POST", "/room/plugins/code__search", task.runToken, { repo: "repo_missing", query: "q" });
    expect(call.status).toBe(403);
    expect(((await call.json()) as { error: string }).error).toBe("函数 code__search 未在本 workspace 开启");
    expect(nonExtensionCalls()).toEqual([]);
    expect(await db.query("select 1 from plugin_calls")).toEqual([]);
  });

  test("github tools are off by default, also in a confidential workspace, and offered after enabling", async () => {
    const githubNames = github.functions.filter((fn) => fn.readOnly).map((fn) => fn.name);
    await insertRepo(wsA, "api", "git@github.com:Acme/API.git");
    await insertRepo(wsA, "web", "https://github.com/acme/web");
    await insertRepo(wsA, "lab", "https://gitlab.com/acme/lab.git");
    const task = await runningTask();
    for (const confidential of [true, false]) {
      await updateWorkspace(db, wsA, { confidential });
      const listed = await roomReq("GET", "/room/plugins", task.runToken);
      const names = ((await listed.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
      expect(names).toEqual([...codeFunctionNames, ...diagramFunctionNames, ...workpackageFunctionNames]);
      const call = await roomReq("POST", "/room/plugins/github__list_issues", task.runToken, { owner: "acme", repo: "api" });
      expect(call.status).toBe(403);
    }
    expect(nonExtensionCalls()).toEqual([]);

    const on = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { enabled: true });
    expect(on.status).toBe(200);
    const listed = await roomReq("GET", "/room/plugins", task.runToken);
    const tools = ((await listed.json()) as { tools: { name: string; description: string; parameters: { properties: Record<string, { description?: string }> } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...codeFunctionNames, ...diagramFunctionNames, ...workpackageFunctionNames, ...githubNames]);
    const listIssues = tools.find((tool) => tool.name === "github__list_issues")!;
    // The allowed remotes are listed; the GitLab repo is not, and repo ids never replace the repo-name schema.
    expect(listIssues.description).toContain("acme/api, acme/web");
    expect(listIssues.description).not.toContain("lab");
    expect(listIssues.parameters.properties.repo!.description).toBe("Repository name.");
  });

  test("github gh commands: reads are scoped to bound repos, writes are off until the workspace allows them", async () => {
    await insertRepo(wsA, "api", "https://github.com/Acme/API.git");
    await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { enabled: true });
    const task = await runningTask();
    const names = async () => ((await (await roomReq("GET", "/room/plugins", task.runToken)).json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(await names()).toContain("github__gh_read");
    expect(await names()).not.toContain("github__gh_write");

    daemonCall = async (method) => {
      if (method === "extensions.list") return bundledExtensions();
      return "ok";
    };
    const read = await roomReq("POST", "/room/plugins/github__gh_read", task.runToken, { args: ["issue", "list", "-R", "acme/api", "--limit", "5"] });
    expect(read.status).toBe(200);
    expect(daemonCalls.at(-1)).toMatchObject({ method: "plugin.call", params: { name: "github__gh_read", args: { args: ["issue", "list", "--repo=acme/api", "--limit=5"], bound: [{ owner: "acme", repo: "api" }] } } });
    const stranger = await roomReq("POST", "/room/plugins/github__gh_read", task.runToken, { args: ["issue", "list", "--repo", "acme/other"] });
    expect(stranger.status).toBe(400);
    const wrongTool = await roomReq("POST", "/room/plugins/github__gh_read", task.runToken, { args: ["issue", "create", "--repo", "acme/api", "--title", "t", "--body", "b"] });
    expect(wrongTool.status).toBe(400);

    const write = { args: ["issue", "create", "--repo", "acme/api", "--title", "t", "--body", "b"] };
    const calls = nonExtensionCalls().length;
    expect((await roomReq("POST", "/room/plugins/github__gh_write", task.runToken, write)).status).toBe(403);
    // A refused write never reaches plugin.call; the only daemon read is the extension index.
    expect(nonExtensionCalls()).toHaveLength(calls);

    const bad = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { settings: { allowWrites: "yes" } });
    expect(bad.status).toBe(400);
    const allowed = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { settings: { allowWrites: true } });
    expect(await allowed.json()).toMatchObject({ enabled: true, settings: { allowWrites: true } });
    expect(await names()).toContain("github__gh_write");
    expect((await roomReq("POST", "/room/plugins/github__gh_write", task.runToken, write)).status).toBe(200);
    expect(daemonCalls.at(-1)).toMatchObject({ params: { name: "github__gh_write", args: { args: ["issue", "create", "--repo=acme/api", "--title=t", "--body=b"] } } });
    const mismatched = await roomReq("POST", "/room/plugins/github__gh_write", task.runToken, { args: ["issue", "list", "--repo", "acme/api"] });
    expect(mismatched.status).toBe(400);
    const off = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { disabledFunctions: ["github__gh_write"] });
    expect(off.status).toBe(200);
    expect(await names()).not.toContain("github__gh_write");
  });

  test("github tools are not offered when no bound repo has a GitHub remote", async () => {
    await insertRepo(wsA, "lab", "https://gitlab.com/acme/lab.git");
    await insertRepo(wsA, "local");
    await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/github`, { enabled: true });
    const task = await runningTask();
    const listed = await roomReq("GET", "/room/plugins", task.runToken);
    const names = ((await listed.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names).toEqual([...codeFunctionNames, ...diagramFunctionNames, ...workpackageFunctionNames]);
    const call = await roomReq("POST", "/room/plugins/github__list_issues", task.runToken, { owner: "acme", repo: "lab" });
    expect(call.status).toBe(403);
    expect(nonExtensionCalls()).toEqual([]);
  });

  test("repo descriptions list every bound repo as id (label)", async () => {
    const api = await insertRepo(wsA, "api");
    const web = await insertRepo(wsA, "web");
    const task = await runningTask();
    const listed = await roomReq("GET", "/room/plugins", task.runToken);
    expect(listed.status).toBe(200);
    const all = ((await listed.json()) as { tools: { name: string; parameters: { properties: { repo: { type: string; description: string } } } }[] }).tools;
    expect(all.map((tool) => tool.name)).toEqual([...codeFunctionNames, ...diagramFunctionNames, ...workpackageFunctionNames]);
    const tools = all.filter((tool) => tool.name.startsWith("code__"));
    const description = `${api.id} (${api.label}), ${web.id} (${web.label})`;
    expect(tools.map((tool) => tool.parameters.properties.repo.description)).toEqual(codeFunctionNames.map(() => description));
    expect(tools[0]?.parameters.properties.repo.type).toBe("string");
    const original = (code.functions[0]!.parameters as { properties: { repo: unknown } }).properties.repo;
    expect(original).toEqual({ type: "string" });
  });

  test("PATCH persists enabled and disabled functions and rejects unknown ones", async () => {
    const unknownPlugin = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/nope`, { enabled: false });
    expect(unknownPlugin.status).toBe(404);
    expect(await unknownPlugin.text()).toContain("nope");

    const unknownFn = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/code`, { disabledFunctions: ["code__read", "nope"] });
    expect(unknownFn.status).toBe(400);
    expect(((await unknownFn.json()) as { error: string }).error).toBe("未知函数 nope");
    expect(await db.query("select 1 from workspace_plugins")).toEqual([]);

    const disabled = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/code`, { disabledFunctions: ["code__read"] });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: true, disabledFunctions: ["code__read"], plugin: { id: "code" } });

    const off = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/code`, { enabled: false });
    expect(off.status).toBe(200);
    const listed = (await (await uiReq("GET", `/api/workspaces/${wsA}/plugins`)).json()) as { enabled: boolean; disabledFunctions: string[] }[];
    expect(listed[0]).toMatchObject({ enabled: false, disabledFunctions: ["code__read"] });

    await insertRepo(wsA, "api");
    const task = await runningTask();
    const tools = await roomReq("GET", "/room/plugins", task.runToken);
    expect(((await tools.json()) as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual([...diagramFunctionNames, ...workpackageFunctionNames]);
    const call = await roomReq("POST", "/room/plugins/code__search", task.runToken, { repo: "repo_api", query: "q" });
    expect(call.status).toBe(403);
    expect(await db.query("select 1 from plugin_calls")).toEqual([]);
  });

  test("grill-me settings are stored, validated and default to strict", async () => {
    const tooLong = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/grill`, { settings: { strictness: "lenient", extraRules: "x".repeat(2001) } });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "补充追问规则最多 2000 字" });
    const bad = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/grill`, { settings: { strictness: "harsh" } });
    expect(bad.status).toBe(400);
    expect(await db.query("select 1 from workspace_plugins")).toEqual([]);
    const ok = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/grill`, { settings: { strictness: "lenient", extraRules: "先问预算" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ enabled: true, settings: { strictness: "lenient", extraRules: "先问预算" } });
    const off = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/grill`, { enabled: false });
    expect(await off.json()).toMatchObject({ enabled: false, settings: { strictness: "lenient", extraRules: "先问预算" } });
    const other = await uiReq("PATCH", `/api/workspaces/${wsA}/plugins/code`, { settings: { a: 1 } });
    expect(other.status).toBe(400);
  });

  test("GET /api/plugins returns the registry plus install status", async () => {
    daemonCall = async () => ({ code: { installed: true, detail: "graphify 0.1" } });
    const r = await uiReq("GET", "/api/plugins");
    expect(r.status).toBe(200);
    expect(daemonCalls).toEqual([{ method: "plugins.status", params: {} }]);
    const body = (await r.json()) as { id: string; displayName: string; dataFlow: string; installed: boolean; detail: string; functions: { name: string }[] }[];
    expect(body).toHaveLength(5);
    // The daemon did not report github, so it shows as not installed.
    expect(body[4]).toMatchObject({ id: "github", displayName: "GitHub", dataFlow: "external", installed: false, detail: "" });
    expect(body[3]).toMatchObject({ id: "grill", displayName: "grill-me", installed: true });
    expect(body[2]).toMatchObject({ id: "superpowers", displayName: "superpowers", installed: true });
    // archify runs on the hub, so it is installed whatever the daemon reports.
    expect(body[1]).toMatchObject({ id: "diagram", displayName: "archify", dataFlow: "local", installed: true });
    expect(body[0]).toMatchObject({
      id: "code",
      displayName: "graphify",
      dataFlow: "local",
      installed: true,
      detail: "graphify 0.1",
    });
    expect(body[0]!.functions.map((fn) => fn.name)).toEqual(codeFunctionNames);
  });

  test("GET /api/plugins passes GitHub's login state through", async () => {
    daemonCall = async () => ({ github: { installed: false, loggedIn: false, detail: "令牌不存在" } });
    const body = (await (await uiReq("GET", "/api/plugins")).json()) as { id: string; loggedIn?: boolean }[];
    expect(body.find((row) => row.id === "github")).toMatchObject({ installed: false, loggedIn: false, detail: "令牌不存在" });
    expect(body.find((row) => row.id === "code")).not.toHaveProperty("loggedIn");
    daemonCall = async () => ({ github: { installed: true, loggedIn: true, detail: "v1" } });
    const saved = (await (await uiReq("GET", "/api/plugins")).json()) as { id: string; loggedIn?: boolean }[];
    expect(saved.find((row) => row.id === "github")?.loggedIn).toBe(true);
  });

  test("PATCH /api/extensions/:id forwards the use state and returns the daemon record", async () => {
    const updated = { id: "grill", installState: "installed", provision: "bundled", useState: "disabled", error: null };
    daemonCall = async (method, params) => {
      expect(method).toBe("extensions.setUse");
      expect(params).toEqual({ id: "grill", useState: "disabled" });
      return updated;
    };
    const response = await uiReq("PATCH", "/api/extensions/grill", { useState: "disabled" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(updated);
    expect(daemonCalls.at(-1)).toEqual({ method: "extensions.setUse", params: { id: "grill", useState: "disabled" } });
  });

  test("PATCH /api/extensions/:id rejects an unknown use state before the daemon sees it", async () => {
    for (const body of [{}, { useState: "paused" }, { useState: true }, { useState: null }]) {
      const response = await uiReq("PATCH", "/api/extensions/grill", body);
      expect(response.status).toBe(400);
    }
    expect(daemonCalls).toHaveLength(0);
  });

  test("PATCH /api/extensions/:id reports a daemon refusal as 503 and any other failure as 502", async () => {
    daemonCall = async () => {
      throw new DaemonRpcError("daemon 已断开");
    };
    expect((await uiReq("PATCH", "/api/extensions/grill", { useState: "enabled" })).status).toBe(503);

    daemonCall = async () => {
      throw new DaemonRpcError("extension is not installed here");
    };
    const refused = await uiReq("PATCH", "/api/extensions/nope", { useState: "enabled" });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: string }).error).toBe("extension is not installed here");
  });

  test("PATCH /api/extensions/:id does not accept an install or removal through the same route", async () => {
    // Installing and removing have their own staging rules; this route must never carry one.
    for (const body of [{ install: true }, { remove: true }, { action: "install" }, { useState: "enabled", install: true }]) {
      const response = await uiReq("PATCH", "/api/extensions/grill", body);
      expect(response.status).toBe(400);
    }
    expect(daemonCalls).toHaveLength(0);
  });

  test("DELETE /api/extensions/:id forwards the removal and returns what happened", async () => {
    daemonCall = async (method, params) => {
      expect(method).toBe("extensions.remove");
      expect(params).toEqual({ id: "skill" });
      return { id: "skill", removed: "managed" };
    };
    const response = await uiReq("DELETE", "/api/extensions/skill");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "skill", removed: "managed" });
    expect(daemonCalls.at(-1)).toEqual({ method: "extensions.remove", params: { id: "skill" } });

    daemonCall = async () => ({ id: "remote", removed: "external" });
    const detached = await uiReq("DELETE", "/api/extensions/remote");
    expect(detached.status).toBe(200);
    expect(await detached.json()).toEqual({ id: "remote", removed: "external" });
  });

  test("DELETE /api/extensions/:id reports a daemon refusal as 503 and any other failure as 502", async () => {
    daemonCall = async () => {
      throw new DaemonRpcError("daemon 已断开");
    };
    const offline = await uiReq("DELETE", "/api/extensions/skill");
    expect(offline.status).toBe(503);
    expect(((await offline.json()) as { error: string }).error).toBe("daemon 已断开");

    daemonCall = async () => {
      throw new DaemonRpcError("bundled extensions cannot be removed");
    };
    const bundled = await uiReq("DELETE", "/api/extensions/code");
    expect(bundled.status).toBe(502);
    expect(((await bundled.json()) as { error: string }).error).toBe("bundled extensions cannot be removed");
  });

  test("DELETE /api/extensions/:id refuses a result that is not a removal", async () => {
    daemonCall = async () => "ok";
    const response = await uiReq("DELETE", "/api/extensions/skill");
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe("extensions.remove returned an invalid result");
  });

  test("DELETE /api/extensions/:id refuses a result with a wrong shape or a different id", async () => {
    // A dropped or truncated reply must not read as a successful removal: the page would drop the row
    // for an extension that is still on disk.
    const replies: unknown[] = [
      [],
      {},
      { id: "grill" },
      { id: "grill", removed: "weird" },
      { id: "other", removed: "managed" },
    ];
    for (const reply of replies) {
      daemonCall = async () => reply;
      const response = await uiReq("DELETE", "/api/extensions/grill");
      expect(response.status, JSON.stringify(reply)).toBe(502);
      expect(((await response.json()) as { error: string }).error).toBe("extensions.remove returned an invalid result");
    }
  });

  test("GET /api/extensions returns daemon records, and bundled seeds when the daemon is down", async () => {
    const custom = [{ id: "pending", installState: "installing", provision: "managed", error: null }];
    daemonCall = async (method) => (method === "extensions.list" ? custom : {});
    const up = await uiReq("GET", "/api/extensions");
    expect(up.status).toBe(200);
    expect(daemonCalls.at(-1)).toEqual({ method: "extensions.list", params: {} });
    expect(await up.json()).toEqual(custom);

    daemonCall = async () => {
      throw new DaemonRpcError("daemon 未连接");
    };
    const down = await uiReq("GET", "/api/extensions");
    expect(down.status).toBe(200);
    const seeds = (await down.json()) as { id: string; error: string | null; loggedIn?: boolean }[];
    expect(seeds.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
    expect(seeds.find((row) => row.id === "code")?.error).toBe("bundled-runtime-missing");
    expect(seeds.find((row) => row.id === "github")).not.toHaveProperty("loggedIn");

    daemonCall = async () => {
      throw new DaemonRpcError("graphify 缺失");
    };
    const failed = await uiReq("GET", "/api/extensions");
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("graphify 缺失");
  });

  test("plugin install status is 503 when the daemon is offline and 502 for other daemon errors", async () => {
    const offline = await uiReq("GET", "/api/plugins");
    expect(offline.status).toBe(503);
    expect(((await offline.json()) as { error: string }).error).toBe("daemon 未连接");

    for (const message of ["daemon 已断开", "daemon 响应超时"]) {
      daemonCall = async () => {
        throw new DaemonRpcError(message);
      };
      const r = await uiReq("GET", "/api/plugins");
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: string }).error).toBe(message);
    }

    daemonCall = async () => {
      throw new DaemonRpcError("graphify 缺失");
    };
    const failed = await uiReq("GET", "/api/plugins");
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toBe("graphify 缺失");
  });

  test("task.assign carries the enabled plugin tools", async () => {
    const repo = await insertRepo(wsA, "api");
    await postUserMessage(db, wsA, "look at login");
    const server = http.createServer();
    const sockets: WebSocket[] = [];
    attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl: "http://hub.test" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
    try {
      const client = await new Promise<{ ws: WebSocket; next(type: string): Promise<Record<string, any>> }>((resolve, reject) => {
        const ws = new WebSocket(url);
        sockets.push(ws);
        const queue: Record<string, any>[] = [];
        const waiters: Array<() => void> = [];
        ws.on("message", (data) => {
          queue.push(JSON.parse(String(data)));
          waiters.shift()?.();
        });
        ws.on("error", reject);
        const next = async (type: string) => {
          const deadline = Date.now() + 3000;
          for (;;) {
            const index = queue.findIndex((message) => message.type === type);
            if (index >= 0) return queue.splice(index, 1)[0]!;
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`);
            await new Promise<void>((wake) => {
              waiters.push(wake);
              setTimeout(wake, 50);
            });
          }
        };
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "hello", token: "tok", version: "0", adapters: ["codex-direct"] }));
          resolve({ ws, next });
        });
      });
      const assign = await client.next("task.assign");
      expect(assign.confidential).toBe(true);
      expect(assign.pluginTools.map((tool: { name: string }) => tool.name)).toEqual([...codeFunctionNames, ...diagramFunctionNames, ...workpackageFunctionNames]);
      expect(assign.pluginTools[0].parameters.properties.repo.description).toBe(`${repo.id} (${repo.label})`);
      expect((code.functions[0]!.parameters as { properties: { repo: unknown } }).properties.repo).toEqual({ type: "string" });
    } finally {
      for (const socket of sockets) socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("extension list while the daemon is down", () => {
  const offline = async () => {
    throw new DaemonRpcError("daemon 未连接");
  };

  /** An index file written the way the CLI writes it: only the rows that differ from the seeds. */
  function writeIndex(rows: unknown[], body = JSON.stringify(rows)) {
    const home = mkdtempSync(path.join(tmpdir(), "nema-home-"));
    mkdirSync(path.join(home, "extensions"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "index.json"), body);
    const app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => false, daemon: { call: offline } as unknown as DaemonRpc, nemaHome: home });
    return app;
  }

  const list = async (app: Hono<any>) => {
    const res = await app.request(`${HUB}/api/extensions`, { headers: { Host: "127.0.0.1:4400" } });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; useState: string; provision: string }[];
  };

  test("shows the choice the person made instead of the shipped default", async () => {
    const app = writeIndex([{ ...bundledExtensions().find((row) => row.id === "github")!, useState: "disabled" }]);
    const rows = await list(app);
    expect(rows.find((row) => row.id === "github")?.useState).toBe("disabled");
    // Every other seed keeps what it shipped with.
    expect(rows.filter((row) => row.id !== "github").every((row) => row.useState === "enabled")).toBe(true);
  });

  test("keeps managed and external extensions, which exist only in the index", async () => {
    const app = writeIndex([
      { id: "remote", kind: "skill", name: "remote", summary: "", source: "https://example.com", revision: "abc", provision: "external", installState: "installed", useState: "enabled", availability: "ready", externalPath: "/tmp/remote", error: null },
    ]);
    const rows = await list(app);
    expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github", "remote"]);
    expect(rows.at(-1)).toMatchObject({ id: "remote", provision: "external" });
  });

  test("falls back to the seeds when the index is missing, unreadable, or not a list", async () => {
    for (const body of [null, "{not json", '{"id":"github"}']) {
      const app = body === null
        ? createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => false, daemon: { call: offline } as unknown as DaemonRpc, nemaHome: mkdtempSync(path.join(tmpdir(), "nema-home-")) })
        : writeIndex([], body);
      const rows = await list(app);
      expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
      expect(rows.every((row) => row.useState === "enabled")).toBe(true);
    }
  });
});
