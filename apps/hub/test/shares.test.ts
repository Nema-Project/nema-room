import { createHash } from "node:crypto";
import { KnowledgeStore, git } from "@nema/knowledge";
import type { Entry } from "@nema/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { createShare, listShares, resolveShare, revokeActiveShares, revokeShare, toPublicEntry, toPublicSummary } from "../src/shares.js";
import { createWorkspace, repoPath, updateWorkspace, type Workspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);

/** Workspaces default to confidential. A share of that row is unavailable until the flag is off. */
async function shareableWorkspace(db: Db, dataDir: string, name: string): Promise<Workspace> {
  const ws = await createWorkspace(db, dataDir, name);
  return updateWorkspace(db, ws.id, { confidential: false });
}

function baseEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "kind" | "status">): Entry {
  return {
    title: "Ship the share",
    businessDate: null,
    related: ["D-2"],
    sourceMessages: ["secret-chat-marker"],
    sourceRefs: [],
    confirmedRevision: null,
    basis: "decided",
    ingestedAt: "2026-01-01T00:00:00.000Z",
    confirmedAt: "2026-01-02T00:00:00.000Z",
    quotes: [{ messageId: "m-secret", text: "public quote" }],
    body: "visible body",
    ...overrides,
  };
}

describe("knowledge share rows", () => {
  test("stores only the sha256 of a 43-char token", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, { note: "  one reader  " });
    expect(created.id).toMatch(/^ks_[A-Za-z0-9_-]{16}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.note).toBe("one reader");
    expect(created.expiresAt).toBeNull();
    expect(created.revokedAt).toBeNull();
    const rows = await db.query<{ token_hash: string; note: string | null }>("select token_hash, note from knowledge_shares");
    expect(rows).toEqual([{ token_hash: createHash("sha256").update(created.token).digest("hex"), note: "one reader" }]);
    expect(JSON.stringify(rows)).not.toContain(created.token);
  });

  test("revoke is immediate and does not revive", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const a = await createShare(db, ws.id, {});
    const b = await createShare(db, ws.id, {});
    expect(await resolveShare(db, a.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
    await revokeShare(db, ws.id, a.id);
    expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
    expect(await resolveShare(db, b.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
    await updateWorkspace(db, ws.id, { confidential: true });
    await updateWorkspace(db, ws.id, { confidential: false });
    expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
    expect(await resolveShare(db, b.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
    expect(await resolveShare(db, "a".repeat(43))).toEqual({ found: false });
    const other = await shareableWorkspace(db, dataDir, "Beta");
    expect(await revokeShare(db, other.id, a.id)).toBeNull();
    expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
  });

  test("rejects an expiry that is not a future zoned timestamp", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    await expect(createShare(db, ws.id, { expiresAt: "2000-01-01T00:00:00.000Z" })).rejects.toMatchObject({ status: 400 });
    await expect(createShare(db, ws.id, { expiresAt: "2999-01-01T00:00:00" })).rejects.toMatchObject({ status: 400 });
    await expect(createShare(db, ws.id, { note: "x".repeat(201) })).rejects.toMatchObject({ status: 400 });
    const blank = await createShare(db, ws.id, { note: "   " });
    expect(blank.note).toBeNull();
    expect(await db.query("select count(*)::int as n from knowledge_shares")).toEqual([{ n: 1 }]);
  });

  test("expired, confidential, and archived shares stay found but unavailable", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const expiring = await createShare(db, ws.id, { expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(await resolveShare(db, expiring.token)).toMatchObject({ found: true, available: true, workspaceId: ws.id });
    await db.query("update knowledge_shares set expires_at = '2000-01-01T00:00:00Z' where id = $1", [expiring.id]);
    expect(await resolveShare(db, expiring.token)).toEqual({ found: true, available: false });

    const hidden = await createShare(db, ws.id, {});
    await updateWorkspace(db, ws.id, { confidential: true });
    expect(await resolveShare(db, hidden.token)).toEqual({ found: true, available: false });
    await updateWorkspace(db, ws.id, { confidential: false });

    const omitted = await createShare(db, ws.id, {});
    expect(omitted.expiresAt).toBeNull();
    await updateWorkspace(db, ws.id, { archived: true });
    expect(await resolveShare(db, hidden.token)).toEqual({ found: true, available: false });
    expect(await resolveShare(db, omitted.token)).toEqual({ found: true, available: false });
    await updateWorkspace(db, ws.id, { archived: false });
    expect(await resolveShare(db, omitted.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
  });

  test("lists shares without the token, newest first", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const older = await createShare(db, ws.id, { note: "older" });
    const newer = await createShare(db, ws.id, { note: "newer" });
    await db.query("update knowledge_shares set created_at = '2020-01-01T00:00:00Z' where id = $1", [older.id]);
    const listed = await listShares(db, ws.id);
    expect(listed.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(JSON.stringify(listed)).not.toContain(older.token);
    expect(JSON.stringify(listed)).not.toContain(newer.token);
    expect(listed[0]).toMatchObject({ note: "newer", revokedAt: null });
  });

  test("revokeActiveShares marks only the live rows", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const already = await createShare(db, ws.id, {});
    const live = await createShare(db, ws.id, {});
    await revokeShare(db, ws.id, already.id);
    await revokeActiveShares(db, ws.id);
    expect(await resolveShare(db, already.token)).toEqual({ found: true, available: false });
    expect(await resolveShare(db, live.token)).toEqual({ found: true, available: false });
    const rows = await db.query<{ revoked_at: Date | null }>("select revoked_at from knowledge_shares");
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });
});

describe("public knowledge projection", () => {
  test("drops chat, evidence internals, and work-package files", () => {
    const decision = baseEntry({ id: "D-1", kind: "decision", status: "dropped" });
    decision.sourceRefs = [{
      sourceEntryId: "S-1",
      revision: "rev-secret",
      snapshotHash: "ab".repeat(32),
      locator: "L1",
      quote: "quoted bit",
    }];
    const summary = toPublicSummary(decision);
    expect(summary).toEqual({
      id: "D-1",
      kind: "decision",
      title: "Ship the share",
      status: "dropped",
      businessDate: null,
      basis: "decided",
      confirmedAt: "2026-01-02T00:00:00.000Z",
      related: ["D-2"],
    });
    const entry = toPublicEntry(decision);
    expect(entry.quotes).toEqual([{ text: "public quote" }]);
    expect(entry.sourceRefs).toEqual([{ sourceEntryId: "S-1", locator: "L1", quote: "quoted bit" }]);
    expect(entry.body).toBe("visible body");
    const json = JSON.stringify(entry);
    for (const hidden of ["secret-chat-marker", "m-secret", "rev-secret", "messageId", "snapshotHash", "sourceMessages", "ingestedAt", "confirmedRevision"]) {
      expect(json).not.toContain(hidden);
    }

    const requirement = baseEntry({
      id: "R-1",
      kind: "requirement",
      status: "active",
      implementation: {
        status: "verified",
        evidence: {
          reportMessageId: "msg-private",
          commits: ["abc1234dead"],
          inferred: false,
          note: "private-note",
          confirmedBy: null,
          acceptanceReview: null,
          reportEvidence: [{ reportMessageId: "msg-private", commits: ["abc1234dead"] }],
        },
      },
    });
    expect(toPublicSummary(requirement).implementationStatus).toBe("verified");
    expect(JSON.stringify(toPublicEntry(requirement))).not.toContain("abc1234dead");
    expect(JSON.stringify(toPublicEntry(requirement))).not.toContain("reportMessageId");
    expect(JSON.stringify(toPublicEntry(requirement))).not.toContain("private-note");

    const diagram = baseEntry({
      id: "G-1",
      kind: "diagram",
      status: "active",
      diagram: {
        repoId: "repo-secret",
        type: "architecture",
        sourceCommits: { "repo-secret": "deadbeefcafebabe" },
        nodePaths: { n1: ["secret/path.ts"] },
      },
    });
    expect(toPublicSummary(diagram).diagramType).toBe("architecture");
    const diagramJson = JSON.stringify(toPublicEntry(diagram));
    expect(diagramJson).not.toContain("secret/path.ts");
    expect(diagramJson).not.toContain("repo-secret");
    expect(diagramJson).not.toContain("nodePaths");
    expect(diagramJson).not.toContain("deadbeefcafebabe");

    const pack = baseEntry({
      id: "W-1",
      kind: "workpackage",
      status: "draft",
      workpackage: {
        requirements: ["R-1"],
        repos: ["repo-secret"],
        approvedAt: null,
        approvedCommit: null,
        blockedOn: "Q-1",
        tasks: [{
          n: 1,
          title: "Write the page",
          satisfies: ["R-1"],
          files: [{ op: "modify", repo: "repo-secret", path: "secret/file.ts" }],
          status: "pending",
          inferred: false,
          reportMessageId: "msg-task",
          confirmedBy: null,
        }],
      },
    });
    expect(toPublicSummary(pack).workpackage).toEqual({ blockedOn: "Q-1", taskCount: 1 });
    expect(toPublicEntry(pack).workpackage).toEqual({
      blockedOn: "Q-1",
      taskCount: 1,
      tasks: [{ n: 1, title: "Write the page", status: "pending" }],
    });
    const packJson = JSON.stringify(toPublicEntry(pack));
    expect(packJson).not.toContain("secret/file.ts");
    expect(packJson).not.toContain("msg-task");
    expect(packJson).not.toContain("repo-secret");

    const question = baseEntry({ id: "Q-1", kind: "question", status: "open", priority: 2, basis: "stated" });
    expect(toPublicSummary(question).priority).toBe(2);
    const source = baseEntry({ id: "S-1", kind: "source", status: "active", url: "https://example.com/doc", basis: "stated" });
    expect(toPublicSummary(source).url).toBe("https://example.com/doc");
  });
});

const HUB = "http://127.0.0.1:4400";
const NOT_FOUND = { error: "not found" };

function shareApp(db: Db, dataDir: string, extra: { sharesEnabled?: boolean; uiAuth?: boolean } = {}) {
  return createApp({
    db,
    dataDir,
    events: new EventBus(),
    daemonStatus: () => true,
    daemon: { call: () => Promise.reject(new Error("daemon offline")) },
    ...(extra.sharesEnabled === false ? { sharesEnabled: false } : {}),
    ...(extra.uiAuth
      ? {
          uiAuth: async (c, next) => {
            if (c.req.header("x-nema-gateway-credential") !== "fake-gateway") return c.json({ error: "Unauthorized" }, 401);
            await next();
          },
        }
      : {}),
  });
}

describe("public share routes", () => {
  test("public share omits chat and private entry fields", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    await postUserMessage(db, ws.id, "secret-chat-marker");
    const store = new KnowledgeStore(repoPath(dataDir, ws.id));
    const decision = await store.upsert(
      {
        kind: "decision",
        title: "Ship it",
        body: "visible body",
        reason: "record",
        sourceMessages: ["secret-chat-marker"],
        quotes: [{ messageId: "m-secret", text: "public quote" }],
        sourceRefs: [{ sourceEntryId: "S-1", revision: "rev-secret", snapshotHash: "ab".repeat(32), locator: "L1", quote: "quoted bit" }],
      },
      { author: "user" },
    );
    await store.writeDiagram(
      {
        title: "Boxes",
        body: "diagram body",
        diagram: { repoId: "repo-secret", type: "architecture", sourceCommits: { "repo-secret": "deadbeef" }, nodePaths: { n1: ["secret/path.ts"] } },
        spec: { nodes: [] },
        reason: "draw",
        sourceMessages: [],
      },
      { author: "user" },
    );
    const pack = await store.createWorkPackage({ title: "Pack", requirements: ["R-1"], repos: ["repo-secret"], reason: "r", sourceMessages: [] }, { author: "user" });
    const task = {
      n: 1,
      title: "Write",
      satisfies: ["R-1"],
      files: [{ op: "modify" as const, repo: "repo-secret", path: "secret/file.ts" }],
      status: "pending" as const,
      inferred: false,
      reportMessageId: "msg-task",
      confirmedBy: null,
    };
    await store.writeWorkPackageDoc(pack.id, "plan", "### 任务 1：Write\n", { tasks: [task] }, "p", [], { author: "user" });
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir);
    const res = await app.request(`${HUB}/share/${created.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("Alpha");
    expect(body).toContain("Ship it");
    expect(body).not.toContain("secret-chat-marker");
    expect(body).not.toContain("secret/path.ts");
    expect(body).not.toContain("secret/file.ts");
    expect(body).not.toContain("sourceMessages");
    expect(body).not.toContain("repo-secret");
    expect(body).not.toContain(ws.id);
    const entry = await app.request(`${HUB}/share/${created.token}/entries/${decision.entry.id}`);
    const entryBody = await entry.text();
    expect(entry.status).toBe(200);
    expect(entryBody).toContain("public quote");
    expect(entryBody).not.toContain("messageId");
    expect(entryBody).not.toContain("snapshotHash");
    expect(entryBody).not.toContain("rev-secret");
    const missingEntry = await app.request(`${HUB}/share/${created.token}/entries/nope`);
    expect(missingEntry.status).toBe(404);
    expect(await missingEntry.json()).toEqual(NOT_FOUND);
    expect(JSON.stringify(NOT_FOUND)).not.toContain("Alpha");
  });

  test("wrong host is forbidden even with a live token", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir);
    for (const host of ["evil.example:4400", "192.168.1.5:4400", "hub:4400"]) {
      const res = await app.request(`${HUB}/share/${created.token}`, { headers: { host } });
      expect(res.status, host).toBe(403);
    }
  });

  test("share routes reject writes and do not accept the gateway credential", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const store = new KnowledgeStore(repoPath(dataDir, ws.id));
    await store.upsert({ kind: "decision", title: "Ship it", body: "visible body", reason: "record", sourceMessages: [] }, { author: "user" });
    const head = (await git(repoPath(dataDir, ws.id), ["rev-parse", "HEAD"])).trim();
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir);
    const posted = await app.request(`${HUB}/share/${created.token}`, {
      method: "POST",
      headers: { host: "127.0.0.1:4400", "content-type": "application/json" },
      body: "{}",
    });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
    expect((await git(repoPath(dataDir, ws.id), ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await db.query("select revoked_at from knowledge_shares")).toEqual([{ revoked_at: null }]);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`${HUB}/share/${created.token}`, { method });
      expect(res.status, method).toBe(405);
    }
  });

  test("revoked, expired, confidential, archived, disabled, and unknown tokens share one 404", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const live = await createShare(db, ws.id, { expiresAt: "2999-01-01T00:00:00.000Z" });
    const app = shareApp(db, dataDir);
    const unknown = await app.request(`${HUB}/share/${"a".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const unknownBody = await unknown.text();
    expect(unknownBody).toBe(JSON.stringify(NOT_FOUND));
    expect(unknownBody).not.toContain("Alpha");

    await db.query("update knowledge_shares set expires_at = '2000-01-01T00:00:00Z' where id = $1", [live.id]);
    const expired = await app.request(`${HUB}/share/${live.token}`);
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(unknownBody);

    const revoked = await createShare(db, ws.id, {});
    await revokeShare(db, ws.id, revoked.id);
    expect(await (await app.request(`${HUB}/share/${revoked.token}`)).text()).toBe(unknownBody);

    const hidden = await createShare(db, ws.id, {});
    await updateWorkspace(db, ws.id, { confidential: true });
    expect(await (await app.request(`${HUB}/share/${hidden.token}`)).text()).toBe(unknownBody);
    await updateWorkspace(db, ws.id, { confidential: false, archived: true });
    expect(await (await app.request(`${HUB}/share/${hidden.token}`)).text()).toBe(unknownBody);

    const off = shareApp(db, dataDir, { sharesEnabled: false });
    expect(await (await off.request(`${HUB}/share/${hidden.token}`)).text()).toBe(unknownBody);
    expect((await app.request(`${HUB}/share/${"short"}`)).status).toBe(404);
  });

  test("uiAuth does not cover share reads", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir, { uiAuth: true });
    expect((await app.request(`${HUB}/share/${created.token}`)).status).toBe(200);
    expect((await app.request(`${HUB}/api/workspaces`)).status).toBe(401);
  });

  test("a disabled switch and a malformed token do not look up the share table", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, {});
    const query = db.query.bind(db);
    let lookups = 0;
    vi.spyOn(db, "query").mockImplementation(async (sql, params) => {
      if (String(sql).includes("from knowledge_shares")) lookups += 1;
      return query(sql, params);
    });
    const off = shareApp(db, dataDir, { sharesEnabled: false });
    expect((await off.request(`${HUB}/share/${created.token}`)).status).toBe(404);
    expect((await off.request(`${HUB}/share/not-a-token`)).status).toBe(404);
    expect(lookups).toBe(0);
  });
});

describe("share admin", () => {
  test("create returns the token once and list never does", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const app = shareApp(db, dataDir);
    const created = await app.request(`${HUB}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "ada" }),
    });
    expect(created.status).toBe(201);
    const payload = await created.json() as { token: string };
    const listed = await app.request(`${HUB}/api/workspaces/${ws.id}/shares`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(payload.token);
  });

  test("marking confidential revokes active links in one step", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir);
    const marked = await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confidential: true }),
    });
    expect(marked.status).toBe(200);
    expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
    const again = await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confidential: false }),
    });
    expect(again.status).toBe(200);
    expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
  });

  test("archiving revokes links and unarchiving does not restore them", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, {});
    const app = shareApp(db, dataDir);
    expect((await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    })).status).toBe(200);
    expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
    expect((await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    })).status).toBe(200);
    expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
  });

  test("confidential and archived workspaces cannot create a share", async () => {
    const { db, dataDir } = await makeHubDeps();
    const secret = await createWorkspace(db, dataDir, "Secret");
    const app = shareApp(db, dataDir);
    const denied = await app.request(`${HUB}/api/workspaces/${secret.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "confidential workspace cannot be shared" });
    const open = await shareableWorkspace(db, dataDir, "Open");
    await updateWorkspace(db, open.id, { archived: true });
    const archived = await app.request(`${HUB}/api/workspaces/${open.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toEqual({ error: "archived workspace cannot be shared" });
  });

  test("a disabled switch blocks create and still allows list and revoke", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const created = await createShare(db, ws.id, { note: "keep" });
    const app = shareApp(db, dataDir, { sharesEnabled: false });
    const blocked = await app.request(`${HUB}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "sharing disabled" });
    expect((await app.request(`${HUB}/api/workspaces/${ws.id}/shares`)).status).toBe(200);
    const revoked = await app.request(`${HUB}/api/workspaces/${ws.id}/shares/${created.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(revoked.status).toBe(200);
    const again = await app.request(`${HUB}/api/workspaces/${ws.id}/shares/${created.id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(again.status).toBe(200);
    expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
  });

  test("a create racing a confidential patch leaves no live share", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const app = shareApp(db, dataDir);
    const [created, patched] = await Promise.all([
      createShare(db, ws.id, {}).then((row) => ({ ok: true as const, token: row.token }), (error: { status?: number }) => ({ ok: false as const, status: error.status })),
      app.request(`${HUB}/api/workspaces/${ws.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confidential: true }),
      }),
    ]);
    expect(patched.status).toBe(200);
    expect((await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confidential: false }),
    })).status).toBe(200);
    const live = await db.query("select id from knowledge_shares where revoked_at is null");
    if (!created.ok) {
      expect(created.status).toBe(409);
      expect(live).toEqual([]);
    } else {
      expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
      expect(live).toEqual([]);
    }
  });

  test("create and a restrictive patch lock the workspace row before writing", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const log: string[] = [];
    const record = (inner: Db): Db => ({
      query: (sql, params) => {
        log.push(sql.replace(/\s+/g, " ").trim());
        return inner.query(sql, params);
      },
      tx: (fn) => inner.tx((tx) => fn(record(tx))),
    });
    await createShare(record(db), ws.id, {});
    const createLock = log.findIndex((sql) => /from workspaces where id = \$1 for update/i.test(sql));
    const insert = log.findIndex((sql) => /insert into knowledge_shares/i.test(sql));
    expect(createLock).toBeGreaterThanOrEqual(0);
    expect(createLock).toBeLessThan(insert);
    expect(log.slice(0, createLock).some((sql) => /workspaces/i.test(sql))).toBe(false);

    log.length = 0;
    const app = shareApp(record(db), dataDir);
    expect((await app.request(`${HUB}/api/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    })).status).toBe(200);
    const patchLock = log.findIndex((sql) => /from workspaces where id = \$1 for update/i.test(sql));
    const revoke = log.findIndex((sql) => /update knowledge_shares/i.test(sql));
    expect(patchLock).toBeGreaterThanOrEqual(0);
    expect(patchLock).toBeLessThan(revoke);
    expect(log.slice(0, patchLock).some((sql) => /workspaces/i.test(sql))).toBe(false);
  });

  test("a create body that is not JSON is 400", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await shareableWorkspace(db, dataDir, "Alpha");
    const app = shareApp(db, dataDir);
    const bad = await app.request(`${HUB}/api/workspaces/${ws.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "request body must be valid JSON" });
  });
});
