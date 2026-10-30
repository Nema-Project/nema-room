import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listResources, normalizeSkillPath, readInsideRoot } from "../../src/skills/safeRead.js";

const posix = process.platform !== "win32";
let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-safe-read-")));
  root = join(base, "skill");
  outside = join(base, "outside");
  mkdirSync(join(root, "references"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
  writeFileSync(join(root, "references", "a.md"), "inside");
  writeFileSync(join(outside, "a.md"), "secret");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("normalizeSkillPath", () => {
  test("accepts relative paths and tidies them", () => {
    expect(normalizeSkillPath("references/a.md")).toBe("references/a.md");
    expect(normalizeSkillPath("./references//a.md")).toBe("references/a.md");
    expect(normalizeSkillPath("references\\a.md")).toBe("references/a.md");
  });
  test("refuses anything that could leave the Skill", () => {
    for (const raw of ["", ".", "../x", "a/../../x", "a/..", "/etc/passwd", "C:\\x", "c:x", "\\\\server\\share\\x", "//server/x", "a\0b"]) {
      expect(normalizeSkillPath(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("readInsideRoot", () => {
  test("reads a file inside the root", async () => {
    const r = await readInsideRoot(root, "references/a.md", 1024);
    expect(r).toEqual({ ok: true, bytes: Buffer.from("inside") });
  });

  test("a missing file, a directory and an oversized file", async () => {
    expect(await readInsideRoot(root, "nope.md", 1024)).toEqual({ ok: false, reason: "missing" });
    expect(await readInsideRoot(root, "references", 1024)).toEqual({ ok: false, reason: "not-file" });
    expect(await readInsideRoot(root, "references/a.md", 3)).toEqual({ ok: false, reason: "too-large" });
  });

  test("refuses a path that normalizeSkillPath refuses", async () => {
    expect(await readInsideRoot(root, "../outside/a.md", 1024)).toEqual({ ok: false, reason: "outside" });
  });

  test.skipIf(!posix)("refuses a linked file and a linked directory", async () => {
    symlinkSync(join(outside, "a.md"), join(root, "link.md"));
    symlinkSync(outside, join(root, "linked"));
    expect(await readInsideRoot(root, "link.md", 1024)).toEqual({ ok: false, reason: "link" });
    expect(await readInsideRoot(root, "linked/a.md", 1024)).toEqual({ ok: false, reason: "link" });
  });

  test.skipIf(!posix)("a file swapped for a link between the check and the open is refused", async () => {
    const r = await readInsideRoot(root, "references/a.md", 1024, {
      afterCheck: () => {
        renameSync(join(root, "references", "a.md"), join(root, "references", "moved.md"));
        symlinkSync(join(outside, "a.md"), join(root, "references", "a.md"));
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["link", "changed"]).toContain(r.reason);
  });

  test.skipIf(!posix)("a parent directory swapped for a link between the check and the open is refused", async () => {
    const r = await readInsideRoot(root, "references/a.md", 1024, {
      afterCheck: () => {
        renameSync(join(root, "references"), join(root, "references-old"));
        symlinkSync(outside, join(root, "references"));
      },
    });
    expect(r).toEqual({ ok: false, reason: "changed" });
  });

  test("a file replaced by another file between the check and the open is refused", async () => {
    const r = await readInsideRoot(root, "references/a.md", 1024, {
      afterCheck: () => {
        rmSync(join(root, "references", "a.md"));
        writeFileSync(join(root, "references", "other.md"), "x");
        writeFileSync(join(root, "references", "a.md"), "replaced");
      },
    });
    expect(r).toEqual({ ok: false, reason: "changed" });
  });
});

describe("listResources", () => {
  test("lists files, skipping .git, node_modules and links", async () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "x");
    mkdirSync(join(root, "node_modules", "p"), { recursive: true });
    writeFileSync(join(root, "node_modules", "p", "i.js"), "x");
    if (posix) symlinkSync(outside, join(root, "linked"));
    expect(await listResources(root, { maxItems: 200, maxDepth: 4 })).toEqual({ items: ["SKILL.md", "references/a.md"], truncated: false });
  });

  test("stops at the item and depth limits", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.md`), "x");
    mkdirSync(join(root, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(root, "a", "b", "c", "d", "deep.md"), "x");
    writeFileSync(join(root, "a", "b", "c", "d", "e", "deeper.md"), "x");
    const all = await listResources(root, { maxItems: 200, maxDepth: 4 });
    expect(all.items).toContain("a/b/c/d/deep.md");
    expect(all.items).not.toContain("a/b/c/d/e/deeper.md");
    expect(await listResources(root, { maxItems: 3, maxDepth: 4 })).toMatchObject({ truncated: true, items: { length: 3 } });
  });
});
