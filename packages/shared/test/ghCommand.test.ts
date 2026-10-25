import { expect, test } from "vitest";
import { parseGhCommand } from "../src/ghCommand.js";

const bound = [{ owner: "acme", repo: "web" }, { owner: "acme", repo: "api" }];
const parse = (args: unknown) => parseGhCommand(args, bound);

test("classifies read commands and pins them to a bound repo", () => {
  expect(parse(["issue", "list", "--repo", "Acme/Web", "--state", "open", "--limit", "5"])).toEqual({
    ok: true, mode: "read", argv: ["issue", "list", "--repo=Acme/Web", "--state=open", "--limit=5"],
  });
  expect(parse(["pr", "view", "12", "-R", "acme/api", "--json", "title,state"])).toMatchObject({ ok: true, mode: "read", argv: ["pr", "view", "12", "--repo=acme/api", "--json=title,state"] });
  expect(parse(["pr", "diff", "3", "--repo=acme/web"])).toMatchObject({ ok: true, mode: "read" });
});

test("classifies writes and keeps free text as a single --flag=value argument", () => {
  const result = parse(["issue", "create", "--repo", "acme/web", "--title", "-rf broken", "--body", "line1\nline2", "--label", "bug", "--label", "p1"]);
  expect(result).toEqual({
    ok: true, mode: "write",
    argv: ["issue", "create", "--repo=acme/web", "--title=-rf broken", "--body=line1\nline2", "--label=bug", "--label=p1"],
  });
  expect(parse(["issue", "comment", "7", "--repo", "acme/web", "--body", "hi"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["issue", "edit", "7", "--repo", "acme/web", "--add-label", "x", "--remove-label", "y"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["issue", "close", "7", "--repo", "acme/web", "--reason", "completed"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["pr", "comment", "9", "--repo", "acme/web", "--body", "lgtm"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["label", "create", "triage", "--repo", "acme/web", "--color", "ededed"])).toMatchObject({ ok: true, mode: "write" });
});

test("projects are owner-scoped to the owners of bound repos", () => {
  expect(parse(["project", "list", "--owner", "acme"])).toMatchObject({ ok: true, mode: "read", argv: ["project", "list", "--owner=acme"] });
  expect(parse(["project", "item-list", "4", "--owner", "acme", "--format", "json"])).toMatchObject({ ok: true, mode: "read" });
  expect(parse(["project", "item-add", "4", "--owner", "acme", "--url", "https://github.com/acme/web/issues/5"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["project", "item-create", "4", "--owner", "acme", "--title", "t", "--body", "b"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["project", "item-edit", "--id", "PVTI_1", "--project-id", "PVT_1", "--field-id", "F_1", "--text", "x"])).toMatchObject({ ok: true, mode: "write" });
  expect(parse(["project", "list", "--owner", "@me"])).toMatchObject({ ok: false });
  expect(parse(["project", "list", "--owner", "other"])).toMatchObject({ ok: false, error: expect.stringMatching(/owner/) });
  expect(parse(["project", "list"])).toMatchObject({ ok: false });
  expect(parse(["project", "item-add", "4", "--owner", "acme", "--url", "https://github.com/other/x/issues/5"])).toMatchObject({ ok: false });
});

test("rejects other repositories, missing or repeated repo, and non-numeric targets", () => {
  expect(parse(["issue", "list", "--repo", "other/web"])).toMatchObject({ ok: false });
  expect(parse(["issue", "list"])).toMatchObject({ ok: false });
  expect(parse(["issue", "list", "--repo", "acme/web", "--repo", "acme/api"])).toMatchObject({ ok: false });
  expect(parse(["issue", "list", "--repo", "github.example.com/acme/web"])).toMatchObject({ ok: false });
  expect(parse(["issue", "view", "https://github.com/other/x/issues/1", "--repo", "acme/web"])).toMatchObject({ ok: false });
  expect(parse(["issue", "view", "1; rm", "--repo", "acme/web"])).toMatchObject({ ok: false });
});

test("refuses everything outside the table, dangerous flags and malformed input", () => {
  for (const bad of [
    ["api", "repos/acme/web"], ["auth", "token"], ["repo", "delete", "acme/web"], ["pr", "merge", "1", "--repo", "acme/web"],
    ["issue", "delete", "1", "--repo", "acme/web"], ["issue", "transfer", "1", "x/y", "--repo", "acme/web"],
    ["alias", "set", "x", "y"], ["extension", "install", "a/b"], ["secret", "set", "X"], ["workflow", "run", "x.yml"],
    ["issue", "list", "--repo", "acme/web", "--web"], ["issue", "create", "--repo", "acme/web", "--body-file", "C:/secret.txt", "--title", "t"],
    ["issue", "create", "--repo", "acme/web", "--editor", "--title", "t"], ["issue", "list", "--repo", "acme/web", "--template", "{{.}}"],
    ["issue", "list", "--repo", "acme/web", "--unknown", "x"], ["issue", "list", "--repo", "acme/web", "stray"],
    ["issue", "create", "--repo", "acme/web", "--title"], [], ["issue"], [1, 2], "issue list", null, ["issue", "list", "--repo", "acme/web", "--limit", "x"],
    ["issue", "list", "--repo", "acme/web", "--limit", "1001"], ["issue", "list", "--repo", "acme/web", "--state", "weird"],
  ]) expect(parse(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  expect(parse(["issue", "comment", "1", "--repo", "acme/web", "--body", "x\0y"])).toMatchObject({ ok: false });
  expect(parse(["issue", "comment", "1", "--repo", "acme/web", "--body", "x".repeat(70_000)])).toMatchObject({ ok: false });
  expect(parseGhCommand(["issue", "list", "--repo", "acme/web"], [])).toMatchObject({ ok: false });
});
