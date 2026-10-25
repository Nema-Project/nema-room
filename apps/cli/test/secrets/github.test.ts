import { expectPrivate } from "../nativePermissions.js";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, test } from "vitest";
import { authGithub, githubTokenPath, readGithubToken } from "../../src/secrets/github.js";

function capture() {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, text: () => lines.join("\n") };
}

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-github-token-test-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("nema auth github writes the token 0600 and never prints it", async () => {
  const c = capture();
  expect(await authGithub({ nemaHome: home, out: c.out, stdin: Readable.from(["  ghp_sekret  \nignored\n"]) })).toBe(0);
  expect(c.text()).toBe("已保存 GitHub 令牌");
  expect(githubTokenPath(home)).toBe(join(home, "github-token"));
  expect(readFileSync(githubTokenPath(home), "utf8")).toBe("ghp_sekret");
  expectPrivate(githubTokenPath(home), 0o600);
  expect(readGithubToken(home)).toBe("ghp_sekret");

  const bad = capture();
  expect(await authGithub({ nemaHome: home, out: bad.out, stdin: Readable.from(["\n"]) })).toBe(1);
  expect(bad.text()).toContain("必须是一行非空文本");
  expect(readFileSync(githubTokenPath(home), "utf8")).toBe("ghp_sekret");
});

test("reading a missing token gives the Chinese hint", () => {
  expect(() => readGithubToken(home)).toThrow("nema auth github");
});
