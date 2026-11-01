import { expect, test } from "vitest";
import { AgentMessageMeta, isBranchName } from "../src/index.js";

test("isBranchName rejects HEAD, main~3, x^, a b, a..b, -x, x.lock, x/ and accepts feature/a-b", () => {
  for (const bad of ["HEAD", "main~3", "x^", "a b", "a..b", "-x", "x.lock", "x/", "", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{1}", "a//b", "/a"]) {
    expect(isBranchName(bad), bad).toBe(false);
  }
  for (const good of ["main", "develop", "feature/a-b", "release/1.2", "v1.0"]) {
    expect(isBranchName(good), good).toBe(true);
  }
});

test("AgentMessageMeta keeps the old shape and takes an optional route decision", () => {
  // Every message written before this version parses; nothing about it changed.
  expect(AgentMessageMeta.parse({ changes: [], askedQuestion: null })).toEqual({ changes: [], askedQuestion: null });
  const route = {
    accountId: "acct_abc1234567",
    accountName: "Personal",
    model: "gpt-5.5",
    mode: "manual",
    reason: "user_workspace",
  };
  const parsed = AgentMessageMeta.parse({ changes: [], askedQuestion: null, route });
  expect(parsed.route).toEqual(route);
  expect(() => AgentMessageMeta.parse({ changes: [], askedQuestion: null, route: { ...route, accountId: 1 } })).toThrow();
});
