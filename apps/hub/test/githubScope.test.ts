import { describe, expect, it, test } from "vitest";
import { checkGithubCall, githubObservationGate, githubTarget } from "../src/githubScope.js";

const OWNER_REPO_ERROR = (target: string) => `只能访问本 workspace 绑定仓库的 GitHub：${target}`;
const SEARCH_ERROR = "搜索必须且只能限定为本 workspace 绑定的仓库（repo:owner/name）";
const allowed = [{ owner: "o", repo: "r" }];

describe("githubTarget", () => {
  test("githubTarget parses the four URL forms and returns null for gitlab", () => {
    expect(githubTarget("https://github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(githubTarget("git@github.com:o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(githubTarget("ssh://git@github.com/o/r")).toEqual({ owner: "o", repo: "r" });
    expect(githubTarget("https://github.com/O/R")).toEqual({ owner: "o", repo: "r" });
    expect(githubTarget("https://github.com/o/r/")).toEqual({ owner: "o", repo: "r" });
    expect(githubTarget("https://gitlab.com/o/r.git")).toBeNull();
    expect(githubTarget("git@gitlab.com:o/r.git")).toBeNull();
    expect(githubTarget("https://git.example.com/o/r")).toBeNull();
    expect(githubTarget("https://github.com.evil.com/o/r")).toBeNull();
    expect(githubTarget("https://github.com/o")).toBeNull();
    expect(githubTarget("https://github.com/o/r/tree/main")).toBeNull();
    expect(githubTarget("/local/path/repo")).toBeNull();
    expect(githubTarget(null)).toBeNull();
    expect(githubTarget("")).toBeNull();
  });
});

describe("checkGithubCall", () => {
  test("owner/repo calls pass only for a bound remote", () => {
    expect(checkGithubCall("github__list_issues", { owner: "o", repo: "r" }, allowed)).toEqual({ ok: true });
    expect(checkGithubCall("github__pull_request_read", { owner: "O", repo: "R", pullNumber: 1, method: "get" }, allowed)).toEqual({ ok: true });
    expect(checkGithubCall("github__issue_read", { owner: "x", repo: "r", issue_number: 1, method: "get" }, allowed)).toEqual({
      ok: false,
      error: OWNER_REPO_ERROR("x/r"),
    });
    expect(checkGithubCall("github__list_pull_requests", { owner: "o", repo: "other" }, allowed)).toEqual({
      ok: false,
      error: OWNER_REPO_ERROR("o/other"),
    });
    expect(checkGithubCall("github__list_issues", { owner: "o" }, allowed).ok).toBe(false);
    expect(checkGithubCall("github__list_issues", { owner: "o", repo: "r" }, []).ok).toBe(false);
    expect(checkGithubCall("github__create_issue", { owner: "o", repo: "r" }, allowed)).toEqual({ ok: false, error: "不支持的 GitHub 调用" });
    expect(checkGithubCall("github__get_me", {}, allowed)).toEqual({ ok: false, error: "不支持的 GitHub 调用" });
  });

  test("search queries need exactly one bound repo: qualifier and no org: or user:", () => {
    const search = (query: string, extra: Record<string, unknown> = {}) => checkGithubCall("github__search_issues", { query, ...extra }, allowed);
    // The five rejected cases of Review Focus 1.
    expect(search("is:open login")).toEqual({ ok: false, error: SEARCH_ERROR });
    expect(search("repo:x/y login")).toEqual({ ok: false, error: SEARCH_ERROR });
    expect(search("repo:o/r org:x login")).toEqual({ ok: false, error: SEARCH_ERROR });
    expect(search("repo:o/r user:x login")).toEqual({ ok: false, error: SEARCH_ERROR });
    expect(search("repo:o/r repo:x/y login")).toEqual({ ok: false, error: SEARCH_ERROR });
    // The one passing shape, case-insensitive on the remote.
    expect(search("repo:o/r is:open login")).toEqual({ ok: true });
    expect(search("login repo:O/R")).toEqual({ ok: true });
    expect(checkGithubCall("github__search_pull_requests", { query: "repo:o/r is:merged" }, allowed)).toEqual({ ok: true });
    // Tricks that would widen the search.
    expect(search("-repo:o/r login").ok).toBe(false);
    expect(search("repo:o/r OR is:open").ok).toBe(false);
    expect(search("NOT repo:o/r").ok).toBe(false);
    expect(search("REPO:o/r Org:x").ok).toBe(false);
    expect(search("repo:o/r", { owner: "x", repo: "y" }).ok).toBe(false);
    expect(search("repo:o/r", { owner: "o", repo: "r" })).toEqual({ ok: true });
    expect(checkGithubCall("github__search_issues", {}, allowed)).toEqual({ ok: false, error: SEARCH_ERROR });
  });
});

it("gates a github read in a fixed order", () => {
  const on = { installed: true, loggedIn: true };
  const one = [{ owner: "example", repo: "repo" }];
  expect(githubObservationGate({ pr: undefined, pluginEnabled: true, gh: on, targets: one })).toEqual({ state: "not_requested" });
  expect(githubObservationGate({ pr: 7, pluginEnabled: false, gh: on, targets: one })).toEqual({ state: "unavailable", reasonCode: "plugin_disabled" });
  expect(githubObservationGate({ pr: 7, pluginEnabled: true, gh: { installed: false, loggedIn: false }, targets: one })).toEqual({ state: "unavailable", reasonCode: "gh_unavailable" });
  expect(githubObservationGate({ pr: 7, pluginEnabled: true, gh: { installed: true, loggedIn: false }, targets: one })).toEqual({ state: "unavailable", reasonCode: "gh_logged_out" });
  expect(githubObservationGate({ pr: 7, pluginEnabled: true, gh: on, targets: [] })).toEqual({ state: "unavailable", reasonCode: "remote_missing" });
  const two = githubObservationGate({ pr: 7, pluginEnabled: true, gh: on, targets: [...one, { owner: "other", repo: "repo" }] });
  expect(two).toEqual({ state: "unavailable", reasonCode: "remote_not_unique" });
  expect("target" in two).toBe(false);
  expect(githubObservationGate({ pr: 7, pluginEnabled: true, gh: on, targets: one })).toEqual({ state: "read", target: one[0] });
});

it("reads a remote with a malformed percent escape as no GitHub target", () => {
  expect(githubTarget("https://github.com/example/re%E0po.git")).toBeNull();
  expect(githubTarget("https://github.com/example/%")).toBeNull();
});
