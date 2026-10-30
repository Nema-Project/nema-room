import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerExtensionHandlers } from "../../src/extensions/handlers.js";
import { openExtensionStore } from "../../src/extensions/store.js";

let dir: string | undefined;
let outside: string | undefined;
afterEach(() => {
  for (const path of [dir, outside]) if (path) rmSync(path, { recursive: true, force: true });
  dir = undefined;
  outside = undefined;
});

test("extensions.list returns the bundled seeds", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const response = await router.handle({ type: "rpc.request", id: "1", method: "extensions.list", params: {} });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const rows = response.result as Array<{ id: string }>;
  expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
});

test("extensions.setUse disables a bundled extension and the list reflects it", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const response = await router.handle({ type: "rpc.request", id: "2", method: "extensions.setUse", params: { id: "grill", useState: "disabled" } });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect((response.result as { useState: string }).useState).toBe("disabled");
  const listed = await router.handle({ type: "rpc.request", id: "3", method: "extensions.list", params: {} });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const rows = listed.result as Array<{ id: string; useState: string }>;
  expect(rows.find((row) => row.id === "grill")?.useState).toBe("disabled");
  expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
});

test("extensions.setUse refuses malformed params without a write", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  for (const params of [{}, { id: "grill" }, { id: "grill", useState: "paused" }, { id: 7, useState: "enabled" }, { useState: "enabled" }]) {
    const response = await router.handle({ type: "rpc.request", id: "x", method: "extensions.setUse", params });
    expect(response.ok).toBe(false);
  }
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});

/** A record the store writes itself, so `extensions.remove` sees the same index the CLI would. */
function seed(id: string, provision: "managed" | "external", externalPath: string | null = null): void {
  const store = openExtensionStore(join(dir!, "extensions"));
  store.putManaged({
    id,
    kind: "skill",
    name: id,
    summary: "A skill",
    source: provision === "external" ? "https://example.com/skills" : "nema install",
    revision: "abc123",
    provision,
    installState: "installed",
    useState: "enabled",
    availability: "ready",
    externalPath,
    error: null,
  });
}

async function rpc(router: RpcRouter, id: string, method: string, params: unknown) {
  return router.handle({ type: "rpc.request", id, method, params });
}

test("extensions.remove deletes a managed extension directory and its record", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("skill", "managed");
  writeFileSync(join(dir, "extensions", "extensions", "skill", "SKILL.md"), "# skill");

  const response = await rpc(router, "1", "extensions.remove", { id: "skill" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toEqual({ id: "skill", removed: "managed" });
  expect(existsSync(join(dir, "extensions", "extensions", "skill"))).toBe(false);
  const listed = await rpc(router, "2", "extensions.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect((listed.result as Array<{ id: string }>).some((row) => row.id === "skill")).toBe(false);
});

test("extensions.remove detaches an external extension and keeps its files", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  outside = mkdtempSync(join(tmpdir(), "nema-ext-rpc-outside-"));
  writeFileSync(join(outside, "SKILL.md"), "# outside");
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("remote", "external", outside);

  const response = await rpc(router, "1", "extensions.remove", { id: "remote" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toEqual({ id: "remote", removed: "external" });
  expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("# outside");
  const listed = await rpc(router, "2", "extensions.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect((listed.result as Array<{ id: string }>).some((row) => row.id === "remote")).toBe(false);
});

test("extensions.remove refuses a bundled extension and leaves the list alone", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const before = await rpc(router, "1", "extensions.list", {});
  expect(before.ok).toBe(true);

  const response = await rpc(router, "2", "extensions.remove", { id: "code" });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error).toBe("bundled extensions cannot be removed");
  const after = await rpc(router, "3", "extensions.list", {});
  expect(after.ok).toBe(true);
  if (!after.ok || !before.ok) return;
  expect(after.result).toEqual(before.result);
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});

test("extensions.remove refuses a missing id or a non-string id without a write", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  for (const params of [{}, { id: "" }, { id: 7 }, { id: null }, null]) {
    const response = await rpc(router, "x", "extensions.remove", params);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toBe("extensions.remove needs a string id");
  }
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});

test("extensions.remove refuses an unknown id and leaves the store alone", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("skill", "managed");
  const before = await rpc(router, "1", "extensions.list", {});
  expect(before.ok).toBe(true);

  const response = await rpc(router, "2", "extensions.remove", { id: "nope" });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error).toBe("extension not found: nope");
  const after = await rpc(router, "3", "extensions.list", {});
  expect(after.ok).toBe(true);
  if (!after.ok || !before.ok) return;
  expect(after.result).toEqual(before.result);
  expect(existsSync(join(dir, "extensions", "extensions", "skill"))).toBe(true);
});

test("extensions.resolveSource previews a GitHub source pinned to one commit, with each skill's target folder", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const replies: Record<string, unknown> = {
    "https://api.github.com/repos/acme/skills": { full_name: "acme/skills", default_branch: "main", license: null },
    "https://api.github.com/repos/acme/skills/commits/main": { sha: commit },
    [`https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`]: { tree: [{ path: "SKILL.md", type: "blob", sha: "a".repeat(40) }] },
    [`https://raw.githubusercontent.com/acme/skills/${commit}/SKILL.md`]: "---\nname: notes\ndescription: Take notes\n---\n",
  };
  const fetch = async (url: string) => {
    if (!(url in replies)) throw new Error(`unexpected fetch: ${url}`);
    const body = replies[url];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => String(body), arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer as ArrayBuffer };
  };
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, { fetch });
  const response = await rpc(router, "r1", "extensions.resolveSource", { source: "https://github.com/acme/skills" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toMatchObject({
    repository: "https://github.com/acme/skills",
    commit,
    license: null,
    skills: [{ id: "notes", name: "notes", path: ".", target: join(dir, "extensions", "extensions", "notes"), installed: false }],
  });
  // A preview writes nothing: no record, no directory.
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
  expect(existsSync(join(dir, "extensions", "extensions", "notes"))).toBe(false);
});

test("extensions.resolveSource refuses an unsupported source before fetching anything", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const asked: string[] = [];
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, {
    fetch: async (url: string) => {
      asked.push(url);
      throw new Error("no network in tests");
    },
  });
  for (const params of [{}, { source: 7 }, { source: "https://gitlab.com/acme/skills" }]) {
    const response = await rpc(router, "r2", "extensions.resolveSource", params);
    expect(response.ok).toBe(false);
  }
  expect(asked).toEqual([]);
});

test("extensions.resolveSource does not call a cancelled install installed", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const store = openExtensionStore(join(dir, "extensions"));
  const base = { kind: "skill" as const, summary: "", source: "nema install", revision: "abc123", provision: "managed" as const, useState: "enabled" as const, availability: "ready" as const, externalPath: null, error: null };
  store.putManaged({ ...base, id: "gone", name: "gone", installState: "absent" });
  store.putManaged({ ...base, id: "here", name: "here", installState: "installed" });
  const replies: Record<string, unknown> = {
    "https://api.github.com/repos/acme/skills": { full_name: "acme/skills", default_branch: "main", license: null },
    "https://api.github.com/repos/acme/skills/commits/main": { sha: commit },
    [`https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`]: {
      tree: [{ path: "gone/SKILL.md", type: "blob", sha: "a".repeat(40) }, { path: "here/SKILL.md", type: "blob", sha: "b".repeat(40) }],
    },
    [`https://raw.githubusercontent.com/acme/skills/${commit}/gone/SKILL.md`]: "---\nname: gone\ndescription: d\n---\n",
    [`https://raw.githubusercontent.com/acme/skills/${commit}/here/SKILL.md`]: "---\nname: here\ndescription: d\n---\n",
  };
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, {
    fetch: async (url: string) => {
      const body = replies[url];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => String(body), arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer as ArrayBuffer };
    },
  });
  const response = await rpc(router, "r3", "extensions.resolveSource", { source: "acme/skills" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const skills = (response.result as { skills: Array<{ id: string; installed: boolean }> }).skills;
  expect(skills.map((skill) => [skill.id, skill.installed])).toEqual([["gone", false], ["here", true]]);
});

test("extensions.install runs end to end over RPC, and remove waits for a running install", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const { createHash } = await import("node:crypto");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const skill = Buffer.from("---\nname: notes\ndescription: Take notes\n---\n");
  const extra = Buffer.from("helper\n");
  const sha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const replies: Record<string, Buffer> = {
    "https://api.github.com/repos/acme/skills": Buffer.from(JSON.stringify({ full_name: "acme/skills", default_branch: "main", license: null })),
    [`https://api.github.com/repos/acme/skills/commits/${commit}`]: Buffer.from(JSON.stringify({ sha: commit })),
    [`https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`]: Buffer.from(JSON.stringify({
      tree: [
        { path: "notes/SKILL.md", type: "blob", mode: "100644", sha: sha(skill), size: skill.length },
        { path: "notes/helper.txt", type: "blob", mode: "100644", sha: sha(extra), size: extra.length },
      ],
    })),
    [`https://raw.githubusercontent.com/acme/skills/${commit}/notes/SKILL.md`]: skill,
    [`https://raw.githubusercontent.com/acme/skills/${commit}/notes/helper.txt`]: extra,
  };
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, {
    fetch: async (url: string) => {
      const body = replies[url];
      if (!body) throw new Error(`unexpected fetch: ${url}`);
      if (url.endsWith("helper.txt")) await gate;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(body.toString()), text: async () => body.toString(), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer };
    },
  });
  const started = await rpc(router, "i1", "extensions.install", { source: "acme/skills", commit, path: "notes" });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  expect(started.result).toMatchObject({ id: "notes", state: "running" });
  const refused = await rpc(router, "i2", "extensions.remove", { id: "notes" });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.error).toBe("notes is installing; cancel the install and wait for it to stop first");
  release();
  let status: { state: string } = { state: "running" };
  for (let i = 0; i < 100 && status.state === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const polled = await rpc(router, "i3", "extensions.installStatus", { id: "notes" });
    if (polled.ok) status = polled.result as { state: string };
  }
  expect(status).toMatchObject({ state: "installed", done: 2, total: 2 });
  expect(readFileSync(join(dir, "extensions", "extensions", "notes", "helper.txt"), "utf8")).toBe("helper\n");
  for (const method of ["extensions.install", "extensions.installStatus", "extensions.cancelInstall", "extensions.retryInstall"]) {
    const bad = await rpc(router, "bad", method, {});
    expect(bad.ok, method).toBe(false);
    // Refused by the handler's own check, not by the router for an unknown method.
    if (!bad.ok) expect(bad.error, method).toMatch(/needs/);
  }
});

test("extensions.cancelInstall and extensions.retryInstall reach the installer over RPC", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const { createHash } = await import("node:crypto");
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const skill = Buffer.from("---\nname: notes\ndescription: Take notes\n---\n");
  const extra = Buffer.from("helper\n");
  const sha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  let hold = true;
  const replies: Record<string, Buffer> = {
    "https://api.github.com/repos/acme/skills": Buffer.from(JSON.stringify({ full_name: "acme/skills", default_branch: "main", license: null })),
    [`https://api.github.com/repos/acme/skills/commits/${commit}`]: Buffer.from(JSON.stringify({ sha: commit })),
    [`https://api.github.com/repos/acme/skills/git/trees/${commit}?recursive=1`]: Buffer.from(JSON.stringify({
      tree: [
        { path: "notes/SKILL.md", type: "blob", mode: "100644", sha: sha(skill), size: skill.length },
        { path: "notes/helper.txt", type: "blob", mode: "100644", sha: sha(extra), size: extra.length },
      ],
    })),
    [`https://raw.githubusercontent.com/acme/skills/${commit}/notes/SKILL.md`]: skill,
    [`https://raw.githubusercontent.com/acme/skills/${commit}/notes/helper.txt`]: extra,
  };
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, {
    fetch: async (url: string, init: { signal?: AbortSignal }) => {
      const body = replies[url];
      if (!body) throw new Error(`unexpected fetch: ${url}`);
      if (url.endsWith("helper.txt") && hold) {
        await new Promise((_, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(body.toString()), text: async () => body.toString(), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) as ArrayBuffer };
    },
  });
  const poll = async () => {
    for (let i = 0; i < 200; i++) {
      const polled = await rpc(router, "p", "extensions.installStatus", { id: "notes" });
      const listed = await rpc(router, "l", "extensions.list", {});
      const row = listed.ok ? (listed.result as Array<{ id: string; installState: string }>).find((r) => r.id === "notes") : undefined;
      if (polled.ok && (polled.result as { state: string }).state !== "running" && row?.installState !== "installing") return polled.result as { state: string };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("install did not settle");
  };
  expect((await rpc(router, "a", "extensions.install", { source: "acme/skills", commit, path: "notes" })).ok).toBe(true);
  const cancelled = await rpc(router, "b", "extensions.cancelInstall", { id: "notes" });
  expect(cancelled.ok).toBe(true);
  if (cancelled.ok) expect(cancelled.result).toMatchObject({ id: "notes", state: "cancelled" });
  expect(await poll()).toMatchObject({ state: "cancelled" });
  hold = false;
  const retried = await rpc(router, "c", "extensions.retryInstall", { id: "notes" });
  expect(retried.ok).toBe(true);
  if (retried.ok) expect(retried.result).toMatchObject({ id: "notes", state: "running", commit, path: "notes" });
  expect(await poll()).toMatchObject({ state: "installed", done: 2, total: 2 });
});

test("a daemon start turns an install that was cut off into a failed one", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  openExtensionStore(join(dir, "extensions")).putManaged({
    id: "notes", kind: "skill", name: "notes", summary: "", source: `https://github.com/acme/skills/tree/${commit}/notes`, revision: commit,
    provision: "managed", installState: "installing", useState: "enabled", availability: "ready", externalPath: null, error: null,
    provenance: { repository: "https://github.com/acme/skills", commit, path: "notes", digest: "a".repeat(40), license: null },
  });
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, { fetch: async () => { throw new Error("no network in tests"); } });
  const status = await rpc(router, "s", "extensions.installStatus", { id: "notes" });
  expect(status.ok).toBe(true);
  if (status.ok) expect(status.result).toMatchObject({ state: "failed", error: "interrupted: the daemon stopped before the install finished", commit, path: "notes" });
});

test("extensions.list says what each installed Skill can do under each runtime", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const { managedSkill, skillText } = await import("../skills/helpers.js");
  managedSkill(dir, "pdf", { "SKILL.md": skillText("pdf"), "scripts/fill.py": "print(1)" });
  const unreadable = managedSkill(dir, "gone", { "SKILL.md": skillText("gone") });
  rmSync(unreadable, { recursive: true, force: true });
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir, { claudeSkillsOk: async () => true });
  const listed = await router.handle({ type: "rpc.request", id: "1", method: "extensions.list", params: {} });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const rows = listed.result as Array<{ id: string; skill?: { runtimes: Array<{ adapter: string; support: string; missing: string[] }> } }>;
  const pdf = rows.find((row) => row.id === "pdf")!;
  expect(pdf.skill?.runtimes.map((r) => [r.adapter, r.support, r.missing])).toEqual([
    ["claude-code", "partial", ["scripts"]],
    ["codex-direct", "partial", ["scripts"]],
  ]);
  expect(rows.find((row) => row.id === "gone")).not.toHaveProperty("skill");
  expect(rows.find((row) => row.id === "grill")).not.toHaveProperty("skill");

  const old = new RpcRouter();
  registerExtensionHandlers(old, dir, { claudeSkillsOk: async () => false });
  const listedOld = await old.handle({ type: "rpc.request", id: "2", method: "extensions.list", params: {} });
  const pdfOld = (listedOld.ok ? (listedOld.result as typeof rows) : []).find((row) => row.id === "pdf")!;
  expect(pdfOld.skill?.runtimes.map((r) => [r.adapter, r.support, r.missing])).toEqual([
    ["claude-code", "none", ["claude-code-too-old"]],
    ["codex-direct", "partial", ["scripts"]],
  ]);
});
