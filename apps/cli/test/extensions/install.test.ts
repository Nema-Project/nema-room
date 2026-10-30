import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SkillInstaller } from "../../src/extensions/install.js";
import type { SourceFetch } from "../../src/extensions/source.js";
import { openExtensionStore } from "../../src/extensions/store.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
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
function fakeRepo(entries: Entry[], o: { hold?: boolean; corrupt?: string } = {}) {
  const asked: string[] = [];
  const blobs = new Map<string, Buffer>();
  const tree = entries.map((entry) => {
    const content = entry.content ?? Buffer.from(`content of ${entry.path}\n`);
    const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
    blobs.set(`https://raw.githubusercontent.com/acme/skills/${COMMIT}/${encoded}`, o.corrupt === entry.path ? Buffer.from("tampered") : content);
    return { path: entry.path, mode: entry.mode ?? "100644", type: entry.type ?? "blob", sha: entry.sha ?? blobSha(content), size: entry.size ?? content.length };
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
    if (url in json) return reply(JSON.stringify(json[url]));
    const blob = blobs.get(url);
    if (!blob) throw new Error(`unexpected fetch: ${url}`);
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

function setup(entries: Entry[] = standard(), o: { hold?: boolean; corrupt?: string } = {}) {
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

  test("after a restart an unfinished install is marked failed, its leftovers removed, and it can be retried", async () => {
    const { root, store } = setup();
    const commitSource = `https://github.com/acme/skills/tree/${COMMIT}/skills/pdf`;
    store.putManaged({
      id: "pdf", kind: "skill", name: "pdf", summary: "", source: commitSource, revision: COMMIT, provision: "managed",
      installState: "installing", useState: "enabled", availability: "ready", externalPath: null, error: null,
      provenance: { repository: "https://github.com/acme/skills", commit: COMMIT, path: "skills/pdf", digest: blobSha(SKILL), license: "MIT" },
    });
    writeFileSync(join(root, "extensions", "pdf", "partial.txt"), "half");
    mkdirSync(join(root, "staging", "pdf-old"), { recursive: true });
    writeFileSync(join(root, "staging", "pdf-old", "SKILL.md"), "half");

    const installer = new SkillInstaller({ root, store, fetch: fakeRepo(standard()).fetch });
    expect(installer.recover()).toEqual(["pdf"]);
    expect(store.list().find((row) => row.id === "pdf")).toMatchObject({ installState: "failed", error: "interrupted: the daemon stopped before the install finished" });
    expect(existsSync(join(root, "extensions", "pdf"))).toBe(false);
    expect(readdirSync(join(root, "staging"))).toEqual([]);

    await installer.retry("pdf");
    await installer.settled("pdf");
    expect(installer.status("pdf").state).toBe("installed");
  });
});
