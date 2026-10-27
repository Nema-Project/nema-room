import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { backupHome, captureHome, dataView, migrateExtra, restoreHome, seedPriorHome } from "./upgradeRecoveryHarness.js";

const dirs: string[] = [];

async function temp(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), name));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("desktop data upgrade and backup restore", () => {
  test("reopening keeps chats, the thread, the work package, and knowledge history", async () => {
    const home = await temp("nema-upgrade-");
    await seedPriorHome(home);
    const first = await captureHome(home);
    const second = await captureHome(home);
    expect(second).toEqual(first);
    expect(first.messages.map((row) => row.content)).toEqual(["old main chat", "old reply", "old thread anchor", "old thread reply"]);
    expect(first.threads).toEqual([expect.objectContaining({ title: "old thread", openedBy: "user" })]);
    expect(first.entries.map((entry) => entry.kind).sort()).toEqual(["decision", "requirement", "workpackage"]);
    expect(first.commits.length).toBeGreaterThanOrEqual(4);
    expect(first.probeColumn).toBe(false);
    console.log(`upgrade-recovery reopen ${process.platform} ${process.arch} ${process.version}`);
  }, 120_000);

  test("a pending migration keeps the same rows and git commits", async () => {
    const home = await temp("nema-upgrade-");
    await seedPriorHome(home);
    const before = await captureHome(home);
    await migrateExtra(home, [{ name: "012_upgrade_probe.sql", sql: "alter table workspaces add column upgrade_probe text;" }]);
    const after = await captureHome(home);
    expect(dataView(after)).toEqual(dataView(before));
    expect(after.probeColumn).toBe(true);
    expect(after.migrations).toContain("012_upgrade_probe.sql");
    console.log(`upgrade-recovery migrate ${process.platform} ${process.arch} ${process.version}`);
  }, 120_000);

  test("a failed migration rolls back and a damaged directory restores from backup", async () => {
    const home = await temp("nema-upgrade-");
    const backup = path.join(await temp("nema-upgrade-backup-"), "copy");
    await seedPriorHome(home);
    const before = await captureHome(home);
    await backupHome(home, backup);
    await expect(migrateExtra(home, [{ name: "999_fail.sql", sql: "select * from upgrade_relation_missing;" }])).rejects.toThrow();
    const rolledBack = await captureHome(home);
    expect(rolledBack.migrations).not.toContain("999_fail.sql");
    expect(dataView(rolledBack)).toEqual(dataView(before));
    await rm(path.join(home, "db"), { recursive: true, force: true });
    await rm(path.join(home, "data"), { recursive: true, force: true });
    await restoreHome(backup, home);
    expect(await captureHome(home)).toEqual(before);
    console.log(`upgrade-recovery restore ${process.platform} ${process.arch} ${process.version}`);
  }, 120_000);
});
