import { describe, expect, test } from "vitest";
import { EXTRA_GIT_DIRECTORIES, FINDER_GIT_PATH, MIN_GIT_VERSION, gitPathForFinderLaunch, parseGitVersion, requireSystemGit } from "../src/systemGit.js";

describe("system git", () => {
  test("parses the version lines that Git for Windows, Apple Git and Linux print", () => {
    expect(parseGitVersion("git version 2.54.0.windows.1\n")).toEqual([2, 54, 0]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
    expect(parseGitVersion("git version 2.31")).toEqual([2, 31, 0]);
    expect(parseGitVersion("xcrun: error: invalid active developer path")).toBeNull();
  });

  test("accepts the minimum version and newer", async () => {
    expect(MIN_GIT_VERSION).toEqual([2, 31, 0]);
    await expect(requireSystemGit(async () => "git version 2.31.0")).resolves.toBe("git version 2.31.0");
    await expect(requireSystemGit(async () => "git version 3.0.1")).resolves.toBe("git version 3.0.1");
  });

  test("a missing git asks the user to install it", async () => {
    const missing = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const error = await requireSystemGit(async () => { throw missing; }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "NEMA_GIT_UNAVAILABLE" });
    expect((error as Error).message).toMatch(/git-scm\.com\/downloads/);
    expect((error as Error).message).toMatch(/2\.31/);
  });

  test("a Finder launch on macOS also sees Homebrew and MacPorts git", () => {
    const finder = FINDER_GIT_PATH.join(":");
    expect(gitPathForFinderLaunch(finder, ["/opt/homebrew/bin", "/usr/local/bin"], "darwin")).toBe(`/opt/homebrew/bin:/usr/local/bin:${finder}`);
    expect(gitPathForFinderLaunch(finder, ["/opt/local/bin"], "darwin")).toBe(`/opt/local/bin:${finder}`);
    expect(gitPathForFinderLaunch(`/opt/homebrew/bin:${finder}`, ["/opt/homebrew/bin"], "darwin")).toBe(`/opt/homebrew/bin:${finder}`);
    expect(gitPathForFinderLaunch(finder, [], "darwin")).toBe(finder);
    expect(gitPathForFinderLaunch("C:\\Users\\dev\\bin", EXTRA_GIT_DIRECTORIES, "win32")).toBe("C:\\Users\\dev\\bin");
    expect(gitPathForFinderLaunch("D:\\temp\\no-git", ["/opt/homebrew/bin"], "darwin")).toBe("D:\\temp\\no-git");
  });

  test("an old or unreadable git is refused with its version", async () => {
    const old = await requireSystemGit(async () => "git version 2.30.9").catch((e: unknown) => e);
    expect(old).toMatchObject({ code: "NEMA_GIT_UNAVAILABLE" });
    expect((old as Error).message).toMatch(/2\.30\.9/);
    const odd = await requireSystemGit(async () => "not git").catch((e: unknown) => e);
    expect(odd).toMatchObject({ code: "NEMA_GIT_UNAVAILABLE" });
  });
});
