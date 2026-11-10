import { createHash } from "node:crypto";
import type { Entry } from "@nema/shared";
import { afterEach, describe, expect, test } from "vitest";
import { createShare, listShares, resolveShare, revokeActiveShares, revokeShare, toPublicEntry, toPublicSummary } from "../src/shares.js";
import { createWorkspace, updateWorkspace, type Workspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";

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
    await updateWorkspace(db, ws.id, { confidential: false });
    expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
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

    await updateWorkspace(db, ws.id, { archived: true });
    expect(await resolveShare(db, hidden.token)).toEqual({ found: true, available: false });
    const omitted = await createShare(db, ws.id, {});
    expect(omitted.expiresAt).toBeNull();
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
