import { describe, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerRepoHandlers } from "../../src/repos/handlers.js";
import { normalizePickedPath, pickDirectory, pickerCommand, type CommandRunner } from "../../src/repos/pickDirectory.js";
import type { GithubReader } from "../../src/github/gh.js";

const github = { call: async () => ({}), status: async () => ({ installed: false, loggedIn: false, detail: "" }), close: async () => {} } as GithubReader;

describe("folder dialog", () => {
  test("asks the host OS for one directory", () => {
    expect(pickerCommand("win32").cmd).toBe("powershell.exe");
    expect(pickerCommand("win32").args).toContain("-STA");
    expect(pickerCommand("darwin")).toEqual({ cmd: "osascript", args: ["-e", "POSIX path of (choose folder)"] });
    expect(pickerCommand("linux").args).toContain("--directory");
  });

  test("keeps one absolute path and drops a cancel or a relative path", () => {
    expect(normalizePickedPath("C:\\src\\app\r\n", "win32")).toBe("C:\\src\\app");
    expect(normalizePickedPath("/src/app/", "linux")).toBe("/src/app");
    expect(normalizePickedPath("", "win32")).toBeNull();
    expect(normalizePickedPath("src/app", "linux")).toBeNull();
    expect(normalizePickedPath("/src/app\n/etc", "linux")).toBeNull();
  });

  test("a cancelled dialog is null and a broken picker is an error", async () => {
    const cancel: CommandRunner = async () => {
      const error = new Error("cancel") as Error & { code: number; stderr: string };
      error.code = 1;
      error.stderr = "User canceled. (-128)";
      throw error;
    };
    expect(await pickDirectory("darwin", cancel)).toBeNull();

    const broken: CommandRunner = async () => {
      throw new Error("zenity missing");
    };
    await expect(pickDirectory("linux", broken)).rejects.toThrow("无法打开文件夹选择器");
  });

  test("dialog.pickDirectory returns the injected folder", async () => {
    const router = new RpcRouter();
    registerRepoHandlers(router, { nemaHome: "/tmp/nema", github, pickDirectory: async () => "/src/app" });
    expect(await router.handle({ type: "rpc.request", id: "1", method: "dialog.pickDirectory", params: {} })).toEqual({
      type: "rpc.response",
      id: "1",
      ok: true,
      result: { path: "/src/app" },
    });
  });
});
