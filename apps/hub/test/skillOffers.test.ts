import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { bundledExtensions } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";
import { postSystemTask, postUserMessage } from "../src/messages.js";
import { claimNextTask } from "../src/tasks.js";
import { EventBus } from "../src/events.js";
import { roomRoutes } from "../src/roomApi.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { clearSkillOffers, listSkillOffers, MAX_SKILL_OFFERS } from "../src/skillOffers.js";

const COMMIT = "a".repeat(40);
const skill = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  description: `${name} skill`,
  path: `skills/${name}`,
  digest: "d".repeat(64),
  problem: null,
  target: `/home/me/.nema/extensions/extensions/${name}`,
  installed: false,
  ...extra,
});
const preview = (skills: unknown[]) => ({
  repository: "https://github.com/acme/skills",
  owner: "acme",
  repo: "skills",
  ref: "main",
  commit: COMMIT,
  license: "MIT",
  path: null,
  truncated: false,
  skills,
});

let db: Db;
let app: Hono<any>;
let ws: string;
let resolved: unknown;
const calls: { method: string; params: unknown }[] = [];
const daemon: DaemonRpc = {
  async call(method, params) {
    if (method === "extensions.list") return bundledExtensions();
    calls.push({ method, params });
    if (method === "extensions.resolveSource") {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    }
    throw new Error(`unexpected daemon call ${method}`);
  },
};

beforeEach(async () => {
  calls.length = 0;
  resolved = preview([skill("pdf")]);
  const deps = await makeHubDeps();
  db = deps.db;
  ws = (await createWorkspace(db, deps.dataDir, "A")).id;
  app = new Hono().route("/room", roomRoutes({ db, dataDir: deps.dataDir, events: new EventBus(), daemon }));
});
afterAll(cleanupHubDeps);

async function userTask() {
  await postUserMessage(db, ws, "install the pdf skill from acme/skills");
  const task = await claimNextTask(db, "d1");
  return { token: task!.runToken!, taskId: task!.id };
}
const offer = (token: string, body: unknown) =>
  app.request("/room/extensions/offer", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /room/extensions/offer", () => {
  test("pins the source through the daemon and records the one installable skill as an offer", async () => {
    const { token, taskId } = await userTask();
    const res = await offer(token, { source: "acme/skills" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offer: unknown; note: string };
    const expected = {
      id: "pdf",
      name: "pdf",
      description: "pdf skill",
      source: "acme/skills",
      repository: "https://github.com/acme/skills",
      commit: COMMIT,
      path: "skills/pdf",
      license: "MIT",
      target: "/home/me/.nema/extensions/extensions/pdf",
    };
    expect(body.offer).toEqual(expected);
    // The agent is told plainly that nothing was installed.
    expect(body.note).toMatch(/Nothing was installed/);
    expect(calls).toEqual([{ method: "extensions.resolveSource", params: { source: "acme/skills" } }]);
    expect(await listSkillOffers(db, taskId)).toEqual([expected]);
  });

  test("asks for a path when several skills could be meant, and offers nothing", async () => {
    resolved = preview([skill("pdf"), skill("docx")]);
    const { token, taskId } = await userTask();
    const res = await offer(token, { source: "acme/skills" });
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("skills/pdf");
    expect(error).toContain("skills/docx");
    expect(await listSkillOffers(db, taskId)).toEqual([]);
  });

  test("a path picks one of several skills", async () => {
    resolved = preview([skill("pdf"), skill("docx")]);
    const { token, taskId } = await userTask();
    const res = await offer(token, { source: "acme/skills", path: "skills/docx" });
    expect(res.status).toBe(200);
    expect((await listSkillOffers(db, taskId)).map((row) => row.id)).toEqual(["docx"]);
  });

  test("a path that is not in the preview is 404 and lists what is there", async () => {
    const { token } = await userTask();
    const res = await offer(token, { source: "acme/skills", path: "skills/nope" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("skills/pdf");
  });

  test("an installed skill or one with a problem is not offered", async () => {
    resolved = preview([skill("pdf", { installed: true }), skill("bad", { id: null, problem: "missing-frontmatter", target: null })]);
    const { token, taskId } = await userTask();
    for (const path of ["skills/pdf", "skills/bad", undefined]) {
      const res = await offer(token, path === undefined ? { source: "acme/skills" } : { source: "acme/skills", path });
      expect(res.status).toBe(409);
    }
    expect(await listSkillOffers(db, taskId)).toEqual([]);
  });

  test("a task the user did not start cannot offer installs, and the daemon is not asked", async () => {
    await postSystemTask(db, ws, "system request");
    const task = await claimNextTask(db, "d1");
    const res = await offer(task!.runToken!, { source: "acme/skills" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("a body without a usable source or path is 400", async () => {
    const { token } = await userTask();
    for (const body of [{}, { source: "" }, { source: 1 }, { source: "x".repeat(2001) }, { source: "acme/skills", path: 3 }, []]) {
      expect((await offer(token, body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("a daemon error passes through with its status, and a malformed preview is 502", async () => {
    const { token } = await userTask();
    resolved = new DaemonRpcError("daemon 未连接");
    expect((await offer(token, { source: "acme/skills" })).status).toBe(503);
    resolved = { ...preview([skill("pdf")]), commit: "main" };
    expect((await offer(token, { source: "acme/skills" })).status).toBe(502);
  });

  test("the same skill is offered once per task, and a task offers at most a few", async () => {
    const { token, taskId } = await userTask();
    expect((await offer(token, { source: "acme/skills" })).status).toBe(200);
    expect((await offer(token, { source: "acme/skills" })).status).toBe(200);
    expect(await listSkillOffers(db, taskId)).toHaveLength(1);
    for (let i = 1; i < MAX_SKILL_OFFERS; i++) {
      resolved = preview([skill(`s${i}`)]);
      expect((await offer(token, { source: "acme/skills" })).status).toBe(200);
    }
    resolved = preview([skill("one-too-many")]);
    expect((await offer(token, { source: "acme/skills" })).status).toBe(409);
    expect(await listSkillOffers(db, taskId)).toHaveLength(MAX_SKILL_OFFERS);
    await clearSkillOffers(db, taskId);
    expect(await listSkillOffers(db, taskId)).toEqual([]);
  });
});
