import { describe, expect, test } from "vitest";
import { CodedError, codedFields, isErrorCode, parseDaemonToHub, readCoded, readCodedTexts } from "../src/index.js";

describe("error codes (#299 batch 1)", () => {
  test("a code is lowercase dotted segments; anything else is not one", () => {
    expect(isErrorCode("repo.not-git-root")).toBe(true);
    expect(isErrorCode("daemon.timed-out")).toBe(true);
    for (const bad of ["", "Repo.x", "repo..x", "repo/x", "../x", "x.", 1, null, "a".repeat(81)]) expect(isErrorCode(bad)).toBe(false);
  });

  test("readCoded keeps a valid code and its string/number params, and drops the rest", () => {
    expect(readCoded("repo.label-taken", { label: "web", n: 2, nested: { x: 1 }, list: [1], nan: Number.NaN, "bad key": "x" }))
      .toEqual({ code: "repo.label-taken", params: { label: "web", n: 2 } });
    expect(readCoded("repo.label-invalid", undefined)).toEqual({ code: "repo.label-invalid" });
    // A malformed code means the params mean nothing: the caller falls back to the text.
    expect(readCoded("<script>", { label: "web" })).toEqual({});
    expect(readCoded(undefined, undefined)).toEqual({});
  });

  test("only a CodedError yields fields: a Node error's code is not a UI code", () => {
    expect(codedFields(new CodedError("repo.not-git-root", "不是 git 仓库的根目录", { path: "/x" }))).toEqual({ code: "repo.not-git-root", params: { path: "/x" } });
    expect(codedFields(Object.assign(new Error("gone"), { code: "ENOENT" }))).toEqual({});
    expect(codedFields("not an error")).toEqual({});
  });

  test("readCodedTexts keeps each item's text, and its code only when valid", () => {
    expect(readCodedTexts([
      { text: "a", code: "skill.repo-moved", params: { repo: "web" } },
      { text: "b", code: "NOT VALID" },
      { text: "c" },
      { code: "skill.repo-moved" },
      "loose",
    ])).toEqual([
      { text: "a", code: "skill.repo-moved", params: { repo: "web" } },
      { text: "b" },
      { text: "c" },
    ]);
    expect(readCodedTexts("nope")).toBeUndefined();
  });

  test("the protocol accepts a coded RPC error and a coded progress event, and still accepts the old shapes", () => {
    expect(parseDaemonToHub({ type: "rpc.response", id: "1", ok: false, error: "x", code: "repo.not-git-root", params: { path: "/a" } }))
      .toMatchObject({ code: "repo.not-git-root", params: { path: "/a" } });
    expect(parseDaemonToHub({ type: "rpc.response", id: "1", ok: false, error: "x" })).toEqual({ type: "rpc.response", id: "1", ok: false, error: "x" });
    // A field this hub cannot read never fails the message that carries it.
    expect(() => parseDaemonToHub({ type: "rpc.response", id: "1", ok: false, error: "x", code: 42, params: "?" })).not.toThrow();
    expect(parseDaemonToHub({ type: "task.event", taskId: "t", event: { type: "progress", text: "部分 Skill 未载入：a", code: "skills.not-loaded", items: [{ text: "a" }] } }))
      .toMatchObject({ event: { code: "skills.not-loaded", items: [{ text: "a" }] } });
    expect(parseDaemonToHub({ type: "task.event", taskId: "t", event: { type: "progress", text: "plain" } }))
      .toEqual({ type: "task.event", taskId: "t", event: { type: "progress", text: "plain" } });
  });
});
