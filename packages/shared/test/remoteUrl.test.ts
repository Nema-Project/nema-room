import { expect, test } from "vitest";
import { normalizeRemoteUrl, normalizeRemoteUrls } from "../src/remoteUrl.js";

test("scp-like and https forms of one repo unify", () => {
  expect(normalizeRemoteUrl("git@github.com:Nema-Project/nema-room.git")).toBe("github.com/nema-project/nema-room");
  expect(normalizeRemoteUrl("https://github.com/Nema-Project/nema-room.git")).toBe("github.com/nema-project/nema-room");
  expect(normalizeRemoteUrl("https://github.com/Nema-Project/nema-room")).toBe("github.com/nema-project/nema-room");
  expect(normalizeRemoteUrl("git@GitHub.com:nema-project/nema-room")).toBe("github.com/nema-project/nema-room");
});

test("ssh://, git:// and http:// forms unify, userinfo and port kept apart", () => {
  expect(normalizeRemoteUrl("ssh://git@github.com/Nema-Project/nema-room.git")).toBe("github.com/nema-project/nema-room");
  expect(normalizeRemoteUrl("ssh://git@example.com:2222/team/repo.git")).toBe("example.com:2222/team/repo");
  expect(normalizeRemoteUrl("git://example.com/team/repo")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("http://example.com/team/repo/")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("https://token@example.com/team/repo")).toBe("example.com/team/repo");
});

test("trailing slashes, .git suffix and case of the path are handled", () => {
  expect(normalizeRemoteUrl("https://example.com/team/repo.git/")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("https://example.com/team/Repo")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("  git@example.com:team/repo.git  ")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("https://EXAMPLE.COM/Team/Repo")).toBe("example.com/team/repo");
});

test("already-normalized host/path values pass through unchanged (idempotent)", () => {
  expect(normalizeRemoteUrl("github.com/acme/widget")).toBe("github.com/acme/widget");
  expect(normalizeRemoteUrl("example.com:2222/team/repo")).toBe("example.com:2222/team/repo");
  expect(normalizeRemoteUrl("GITHUB.COM/Acme/Widget")).toBe("github.com/acme/widget");
});

test("an explicit port survives a second normalization (ssh on the https default port)", () => {
  // The daemon normalizes holdings before reporting them and the hub normalizes them again: the
  // second pass must keep :443, or the holder no longer matches the bound repo's first-pass form.
  expect(normalizeRemoteUrl("ssh://git@example.com:443/team/repo.git")).toBe("example.com:443/team/repo");
  expect(normalizeRemoteUrl("example.com:443/team/repo")).toBe("example.com:443/team/repo");
  // A default port on its own scheme is the same server with or without it, so it stays dropped.
  expect(normalizeRemoteUrl("https://example.com:443/team/repo")).toBe("example.com/team/repo");
  expect(normalizeRemoteUrl("example.com/team/repo")).toBe("example.com/team/repo");
});

test("not a remote URL gives null", () => {
  expect(normalizeRemoteUrl(null)).toBeNull();
  expect(normalizeRemoteUrl(undefined)).toBeNull();
  expect(normalizeRemoteUrl("")).toBeNull();
  expect(normalizeRemoteUrl("   ")).toBeNull();
  expect(normalizeRemoteUrl("not a url")).toBeNull();
  expect(normalizeRemoteUrl("https://example.com")).toBeNull();
  expect(normalizeRemoteUrl("https://example.com/")).toBeNull();
  expect(normalizeRemoteUrl("ftp://example.com/team/repo")).toBeNull();
  expect(normalizeRemoteUrl("/local/path/to/repo")).toBeNull();
  expect(normalizeRemoteUrl("git@example.com:")).toBeNull();
  expect(normalizeRemoteUrl("https://example.com/%zz")).toBeNull();
});

test("normalizeRemoteUrls dedupes in first-seen order and drops the unparseable", () => {
  expect(
    normalizeRemoteUrls([
      "git@github.com:a/b.git",
      "https://github.com/a/b",
      null,
      "https://example.com/x/y",
      "garbage",
      "https://example.com/x/y/",
    ]),
  ).toEqual(["github.com/a/b", "example.com/x/y"]);
});
