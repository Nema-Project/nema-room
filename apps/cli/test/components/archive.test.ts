// TAR symlink safety checks under case-sensitive (Linux) and case-insensitive (Windows/macOS) path semantics.
// The platform is passed explicitly, so both semantics run on every host without mocking the OS.
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { archivePathKey, extractTarGz } from "../../src/components/archive.js";
import { tarGz } from "./fixtures.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-archive-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Mirrors python/share/terminfo/N/NCR260VT300WPP -> ../n/ncr260vt300wpp in the pinned Linux CPython archives.
const caseDifferingLink = () => tarGz([
  { name: "n/foo", body: "terminfo entry\n" },
  { name: "N/FOO", type: "symlink", link: "../n/foo" },
]);

describe("archivePathKey", () => {
  test("folds case only on case-insensitive platforms", () => {
    expect(archivePathKey("/x/N/FOO", "win32")).toBe("/x/n/foo");
    expect(archivePathKey("/x/N/FOO", "darwin")).toBe("/x/n/foo");
    expect(archivePathKey("/x/N/FOO", "linux")).toBe("/x/N/FOO");
  });
});

describe("extractTarGz symlink checks", () => {
  test("linux: a symlink whose target differs only in case is not a chain", async () => {
    const dest = path.join(root, "out");
    await extractTarGz(caseDifferingLink(), dest, "linux");
    expect(readFileSync(path.join(dest, "n", "foo"), "utf8")).toBe("terminfo entry\n");
    expect(readlinkSync(path.join(dest, "N", "FOO"))).toBe("../n/foo");
  });

  test.each(["win32", "darwin"] as const)("%s: a symlink whose target differs only in case is rejected as a chain", async (platform) => {
    await expect(extractTarGz(caseDifferingLink(), path.join(root, "out"), platform)).rejects.toThrow("TAR symlink chain is not supported");
  });

  test("linux: an exact-case symlink chain is rejected", async () => {
    const archive = tarGz([
      { name: "real", body: "x\n" },
      { name: "a", type: "symlink", link: "real" },
      { name: "b", type: "symlink", link: "a" },
    ]);
    await expect(extractTarGz(archive, path.join(root, "out"), "linux")).rejects.toThrow("TAR symlink chain is not supported");
  });

  test("linux: an entry under an exact-case symlink parent is rejected", async () => {
    const archive = tarGz([
      { name: "dir", type: "symlink", link: "sub" },
      { name: "dir/file", body: "x\n" },
    ]);
    await expect(extractTarGz(archive, path.join(root, "out"), "linux")).rejects.toThrow("TAR symlink parent is not supported");
  });
});
