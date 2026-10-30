import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SkillInstaller } from "../../src/extensions/install.js";
import type { SourceFetch } from "../../src/extensions/source.js";
import { openExtensionStore } from "../../src/extensions/store.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_DEFAULT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT2 = "89abcdef0123456789abcdef0123456789abcdef";
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const SKILL = Buffer.from("---\nname: pdf\ndescription: Fill PDF forms\n---\n\n# pdf\n");

type Entry = { path: string; content?: Buffer; mode?: string; type?: string; size?: number; sha?: string };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A fake GitHub holding one repository at COMMIT. Every URL must be one it knows, so nothing here can
 * reach the network. `hold` makes raw downloads wait for the request's abort signal.
 */
type FakeOptions = { hold?: boolean; corrupt?: string; gate?: Promise<void>; gateResolve?: Promise<void>; commit?: string };

function fakeRepo(entries: Entry[], o: FakeOptions = {}) {
  const COMMIT = o.commit ?? COMMIT_DEFAULT;
  const asked: string[] = [];
  const blobs = new Map<string, Buffer>();
  const tree = entries.map((entry) => {
    const content = entry.content ?? Buffer.from(`content of ${entry.path}\n`);
    const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
    blobs.set(`https://raw.githubusercontent.com/acme/skills/${COMMIT}/${encoded}`, o.corrupt === entry.path ? Buffer.from("tampered") : content);
    return { path: entry.path, mode: entry.mode ?? (entry.type === "tree" ? "040000" : "100644"), type: entry.type ?? "blob", sha: entry.sha ?? blobSha(content), size: entry.size ?? content.length };
  });
  const json: Record<string, unknown> = {
    "https://api.github.com/repos/acme/skills": { full_name: "acme/skills", default_branch: "main", license: { spdx_id: "MIT" } },
    [`https://api.github.com/repos/acme/skills/commits/${COMMIT}`]: { sha: COMMIT },
    [`https://api.github.com/repos/acme/skills/git/trees/${COMMIT}?recursive=1`]: { truncated: false, tree },
  };
  const fetch: SourceFetch = async (url, init) => {
    asked.push(url);
    const reply = (body: Buffer | string, status = 200) => {
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      return {
        ok: status < 300,
        status,
        headers: { get: () => null },
        json: async () => JSON.parse(bytes.toString("utf8")),
        text: async () => bytes.toString("utf8"),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
      };
    };
    if (url.includes("/commits/") && o.gateResolve) await o.gateResolve;
    if (url in json) return reply(JSON.stringify(json[url]));
    const blob = blobs.get(url);
    if (!blob) throw new Error(`unexpected fetch: ${url}`);
    if (o.gate && !url.endsWith("/SKILL.md")) await o.gate;
    if (o.hold && !url.endsWith("/SKILL.md")) {
      await new Promise((_, reject) => {
        if (init.signal?.aborted) reject(init.signal.reason);
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return reply(blob);
  };
  return { fetch, asked };
}

const standard = (): Entry[] => [
  { path: "README.md" },
  { path: "skills/pdf/SKILL.md", content: SKILL },
  { path: "skills/pdf/scripts/fill.py" },
  { path: "skills/pdf/reference/forms.md" },
  { path: "skills/docx/SKILL.md", content: Buffer.from("---\nname: docx\ndescription: Word\n---\n") },
];

function setup(entries: Entry[] = standard(), o: FakeOptions = {}) {
  dir = mkdtempSync(join(tmpdir(), "nema-install-"));
  const root = join(dir, "extensions");
  const store = openExtensionStore(root);
  const github = fakeRepo(entries, o);
  const installer = new SkillInstaller({ root, store, fetch: github.fetch });
  return { root, store, github, installer };
}

const request = { source: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf" };

describe("SkillInstaller", () => {
  test("downloads only the chosen folder at the pinned commit and activates it with provenance", async () => {
    const { root, store, github, installer } = setup();
    const started = await installer.start(request);
    expect(started).toMatchObject({ id: "pdf", state: "running", commit: COMMIT, path: "skills/pdf" });
    expect(store.list().find((row) => row.id === "pdf")?.installState).toBe("installing");
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ id: "pdf", state: "installed", done: 3, total: 3, error: null });
    const target = join(root, "extensions", "pdf");
    expect(readFileSync(join(target, "SKILL.md"))).toEqual(SKILL);
    expect(readFileSync(join(target, "scripts", "fill.py"), "utf8")).toBe("content of skills/pdf/scripts/fill.py\n");
    expect(existsSync(join(target, "reference", "forms.md"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(false);
    expect(store.list().find((row) => row.id === "pdf")).toMatchObject({
      provision: "managed",
      installState: "installed",
      revision: COMMIT,
      source: `https://github.com/acme/skills/tree/${COMMIT}/skills/pdf`,
      error: null,
      provenance: { repository: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf", digest: blobSha(SKILL), license: "MIT" },
    });
    // Nothing is read through a branch name, and nothing outside the chosen folder is downloaded.
    for (const url of github.asked.slice(1)) expect(url).toContain(COMMIT);
    expect(github.asked.some((url) => url.includes("README.md") || url.includes("docx"))).toBe(false);
    expect(existsSync(join(root, "staging")) ? readdirSync(join(root, "staging")) : []).toEqual([]);
  });

  test("an install saves the per-file manifest taken from the tree", async () => {
    const { root, installer } = setup();
    await installer.start(request);
    await installer.settled("pdf");
    const manifest = JSON.parse(readFileSync(join(root, "extensions", "pdf", ".nema-manifest.json"), "utf8"));
    const content = (p: string) => Buffer.from(`content of ${p}\n`);
    expect(manifest).toEqual({
      files: [
        { path: "SKILL.md", size: SKILL.length, blob: blobSha(SKILL), executable: false, binary: false },
        { path: "reference/forms.md", size: content("skills/pdf/reference/forms.md").length, blob: blobSha(content("skills/pdf/reference/forms.md")), executable: false, binary: false },
        { path: "scripts/fill.py", size: content("skills/pdf/scripts/fill.py").length, blob: blobSha(content("skills/pdf/scripts/fill.py")), executable: false, binary: false },
      ],
    });
  });

  test("a skill that ships its own .nema-manifest.json is refused", async () => {
    const { store, installer } = setup([...standard(), { path: "skills/pdf/.nema-manifest.json" }]);
    await installer.start(request);
    await installer.settled("pdf");
    expect(store.list().find((row) => row.id === "pdf")).toMatchObject({ installState: "failed", error: expect.stringContaining(".nema-manifest.json") });
  });

  test("refuses a request that is not pinned, names no installable skill, or is already installed", async () => {
    const { installer } = setup();
    await expect(installer.start({ ...request, commit: "main" })).rejects.toThrow("install needs a 40-character commit");
    await expect(installer.start({ ...request, path: "../etc" })).rejects.toThrow("invalid skill path");
    await expect(installer.start({ ...request, path: "skills/none" })).rejects.toThrow(/no SKILL.md under skills\/none/);
    await expect(installer.start({ ...request, source: "https://gitlab.com/acme/skills" })).rejects.toThrow(/unsupported extension source/);
    await installer.start(request);
    await installer.settled("pdf");
    await expect(installer.start(request)).rejects.toThrow("pdf is already installed");
  });

  test("a second install of the same skill is refused while the first is still downloading", async () => {
    const { installer } = setup(standard(), { hold: true });
    await installer.start(request);
    await expect(installer.start(request)).rejects.toThrow("pdf is already being installed");
    await expect(installer.retry("pdf")).rejects.toThrow("pdf is already being installed");
    installer.cancel("pdf");
    await installer.settled("pdf");
  });

  test("a file whose bytes do not match the tree's blob hash fails the install and leaves nothing behind", async () => {
    const { root, store, installer } = setup(standard(), { corrupt: "skills/pdf/scripts/fill.py" });
    await installer.start(request);
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ state: "failed", error: "skills/pdf/scripts/fill.py does not match its Git blob hash" });
    expect(store.list().find((row) => row.id === "pdf")).toMatchObject({ installState: "failed", error: "skills/pdf/scripts/fill.py does not match its Git blob hash" });
    expect(existsSync(join(root, "extensions", "pdf"))).toBe(false);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  test("retry reinstalls a failed skill from the commit and folder kept on its record", async () => {
    const first = setup(standard(), { corrupt: "skills/pdf/scripts/fill.py" });
    await first.installer.start(request);
    await first.installer.settled("pdf");
    // Same home, a GitHub that now serves the right bytes.
    const installer = new SkillInstaller({ root: first.root, store: first.store, fetch: fakeRepo(standard()).fetch });
    expect(installer.status("pdf").state).toBe("failed");
    expect((await installer.retry("pdf")).state).toBe("running");
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ state: "installed", error: null });
    expect(first.store.list().find((row) => row.id === "pdf")?.revision).toBe(COMMIT);
    await expect(installer.retry("pdf")).rejects.toThrow("pdf is already installed");
    await expect(installer.retry("nope")).rejects.toThrow("nope has no install to retry");
  });

  test("cancel stops the download, removes the partial copy, and the record can be retried", async () => {
    const { root, store, installer } = setup(standard(), { hold: true });
    await installer.start(request);
    expect(installer.cancel("pdf").state).toBe("cancelled");
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ state: "cancelled" });
    expect(store.list().find((row) => row.id === "pdf")?.installState).toBe("absent");
    expect(existsSync(join(root, "extensions", "pdf"))).toBe(false);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
    expect(() => installer.cancel("pdf")).toThrow("pdf is not installing");
  });

  test("limits: oversized files, symbolic links, submodules and unsafe names fail the install", async () => {
    const cases: Array<[Entry, string]> = [
      [{ path: "skills/pdf/big.bin", size: 6 * 1024 * 1024 }, "skills/pdf/big.bin is larger than 5 MiB"],
      [{ path: "skills/pdf/link", mode: "120000" }, "skills/pdf/link is a symbolic link"],
      [{ path: "skills/pdf/vendor", type: "commit", mode: "160000" }, "skills/pdf/vendor is a submodule"],
      [{ path: "skills/pdf/a\\b.md" }, "unsafe file name in skills/pdf/a\\b.md"],
      [{ path: "skills/pdf/con:x" }, "unsafe file name in skills/pdf/con:x"],
    ];
    for (const [extra, error] of cases) {
      const { root, installer } = setup([...standard(), extra]);
      await installer.start(request);
      await installer.settled("pdf");
      expect(installer.status("pdf"), extra.path).toMatchObject({ state: "failed", error });
      expect(existsSync(join(root, "extensions", "pdf"))).toBe(false);
      rmSync(dir!, { recursive: true, force: true });
    }
    const many = Array.from({ length: 501 }, (_, index) => ({ path: `skills/pdf/f${index}.md` }));
    const { installer } = setup([...standard(), ...many]);
    await installer.start(request);
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ state: "failed", error: "skills/pdf has more than 500 files" });
  });

  test("two names that only differ in case would overwrite each other on macOS and Windows, so they fail", async () => {
    const { installer } = setup([...standard(), { path: "skills/pdf/Notes.md" }, { path: "skills/pdf/notes.md" }]);
    await installer.start(request);
    await installer.settled("pdf");
    expect(installer.status("pdf")).toMatchObject({ state: "failed", error: "skills/pdf/notes.md differs from another file only in case" });
  });

  test("after a restart an unfinished install is marked failed, its leftovers removed, and retried from its own record", async () => {
    const { root, store } = setup();
    const docx = Buffer.from("---\nname: docx\ndescription: Word\n---\n");
    store.putManaged({
      id: "docx", kind: "skill", name: "docx", summary: "", source: `https://github.com/acme/skills/tree/${COMMIT2}/skills/docx`, revision: COMMIT2, provision: "managed",
      installState: "installing", useState: "enabled", availability: "ready", externalPath: null, error: null,
      provenance: { repository: "https://github.com/acme/skills", commit: COMMIT2, path: "skills/docx", digest: blobSha(docx), license: "MIT" },
    });
    writeFileSync(join(root, "extensions", "docx", "partial.txt"), "half");
    mkdirSync(join(root, "staging", "docx-old"), { recursive: true });
    writeFileSync(join(root, "staging", "docx-old", "SKILL.md"), "half");

    // This GitHub only knows COMMIT2, so a retry that used anything but the record would fail.
    const github = fakeRepo([...standard().filter((entry) => !entry.path.startsWith("skills/docx")), { path: "skills/docx/SKILL.md", content: docx }, { path: "skills/docx/a.md" }], { commit: COMMIT2 });
    const installer = new SkillInstaller({ root, store, fetch: github.fetch });
    expect(installer.recover()).toEqual(["docx"]);
    expect(store.list().find((row) => row.id === "docx")).toMatchObject({ installState: "failed", error: "interrupted: the daemon stopped before the install finished" });
    expect(existsSync(join(root, "extensions", "docx"))).toBe(false);
    expect(readdirSync(join(root, "staging"))).toEqual([]);

    await installer.retry("docx");
    await installer.settled("docx");
    expect(installer.status("docx")).toMatchObject({ state: "installed", commit: COMMIT2, path: "skills/docx" });
    expect(readFileSync(join(root, "extensions", "docx", "a.md"), "utf8")).toBe("content of skills/docx/a.md\n");
    expect(github.asked.some((url) => url.includes("skills/pdf"))).toBe(false);
  });

  test("a choice to disable the skill made while it installs survives activation, and a retry keeps it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { store, installer } = setup(standard(), { gate });
    await installer.start(request);
    store.setUseState("pdf", "disabled");
    release();
    await installer.settled("pdf");
    expect(store.list().find((row) => row.id === "pdf")).toMatchObject({ installState: "installed", useState: "disabled" });

    const failed = setup(standard(), { corrupt: "skills/pdf/scripts/fill.py" });
    await failed.installer.start(request);
    await failed.installer.settled("pdf");
    failed.store.setUseState("pdf", "disabled");
    const again = new SkillInstaller({ root: failed.root, store: failed.store, fetch: fakeRepo(standard()).fetch });
    await again.retry("pdf");
    await again.settled("pdf");
    expect(failed.store.list().find((row) => row.id === "pdf")).toMatchObject({ installState: "installed", useState: "disabled" });
  });

  test("a staging folder that cannot be created fails the install instead of leaving it running", async () => {
    const { root, store, installer } = setup();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "staging"), "not a folder");
    await installer.start(request);
    await installer.settled("pdf");
    expect(installer.status("pdf").state).toBe("failed");
    expect(store.list().find((row) => row.id === "pdf")?.installState).toBe("failed");
  });

  test.skipIf(process.platform === "win32")("an executable file keeps its execute bit and a regular one does not get one", async () => {
    const { root, installer } = setup([...standard(), { path: "skills/pdf/run.sh", mode: "100755" }]);
    await installer.start(request);
    await installer.settled("pdf");
    expect(statSync(join(root, "extensions", "pdf", "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(root, "extensions", "pdf", "SKILL.md")).mode & 0o111).toBe(0);
  });

  test("Windows device names and names ending in a dot or space are refused", async () => {
    for (const name of ["CON", "con.txt", "Aux.md", "nul", "COM1.log", "lpt9", "trailing.", "space "]) {
      const { installer } = setup([...standard(), { path: `skills/pdf/${name}` }]);
      await installer.start(request);
      await installer.settled("pdf");
      expect(installer.status("pdf"), name).toMatchObject({ state: "failed", error: `unsafe file name in skills/pdf/${name}` });
      rmSync(dir!, { recursive: true, force: true });
    }
  });

  test("a retry counts as running from the moment it is asked for, before the commit is re-read", async () => {
    const first = setup(standard(), { corrupt: "skills/pdf/scripts/fill.py" });
    await first.installer.start(request);
    await first.installer.settled("pdf");
    let release: () => void = () => {};
    const gateResolve = new Promise<void>((resolve) => { release = resolve; });
    const installer = new SkillInstaller({ root: first.root, store: first.store, fetch: fakeRepo(standard(), { gateResolve }).fetch });
    const retried = installer.retry("pdf");
    expect(installer.running("pdf")).toBe(true);
    release();
    await retried;
    await installer.settled("pdf");
    expect(installer.running("pdf")).toBe(false);
    expect(installer.status("pdf").state).toBe("installed");
  });

  test("a cancelled install still blocks removal until its cleanup has finished", async () => {
    const { installer } = setup(standard(), { hold: true });
    await installer.start(request);
    installer.cancel("pdf");
    expect(installer.running("pdf")).toBe(true);
    await installer.settled("pdf");
    expect(installer.running("pdf")).toBe(false);
  });

  test("status does not report an install that was removed afterwards", async () => {
    const { store, installer } = setup();
    await installer.start(request);
    await installer.settled("pdf");
    store.removeManaged("pdf");
    expect(() => installer.status("pdf")).toThrow("pdf has no install");
  });
});
