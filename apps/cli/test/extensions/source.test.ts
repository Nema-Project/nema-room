import { describe, expect, test } from "vitest";
import { parseSkillSource } from "@nema/shared";
import { pinnedSkillRecord, resolveSkillSource, type SourceFetch } from "../../src/extensions/source.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** A fake GitHub: every URL the resolver asks for must be listed, so no test can reach the network. */
function fakeGithub(routes: Record<string, Reply>): { fetch: SourceFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: SourceFetch = async (url, init) => {
    asked.push(url);
    expect(init.headers["User-Agent"]).toBeTruthy();
    const reply = routes[url];
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      json: async () => reply.json,
      text: async () => reply.text ?? JSON.stringify(reply.json),
      arrayBuffer: async () => new TextEncoder().encode(reply.text ?? JSON.stringify(reply.json)).buffer as ArrayBuffer,
    };
  };
  return { fetch, asked };
}

const skillFile = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function multiSkillRepo(overrides: Record<string, Reply> = {}) {
  return fakeGithub({
    "https://api.github.com/repos/acme/skills": { json: { full_name: "Acme/skills", default_branch: "main", license: { spdx_id: "MIT" } } },
    "https://api.github.com/repos/acme/skills/commits/main": { json: { sha: COMMIT } },
    [`https://api.github.com/repos/acme/skills/git/trees/${COMMIT}?recursive=1`]: {
      json: {
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", sha: "1".repeat(40) },
          { path: "skills", type: "tree", sha: "2".repeat(40) },
          { path: "skills/pdf/SKILL.md", type: "blob", sha: "a".repeat(40) },
          { path: "skills/pdf/reference.md", type: "blob", sha: "3".repeat(40) },
          { path: "skills/docx/SKILL.md", type: "blob", sha: "b".repeat(40) },
          { path: "skills/notes/NOT_SKILL.md", type: "blob", sha: "4".repeat(40) },
        ],
      },
    },
    [`https://raw.githubusercontent.com/Acme/skills/${COMMIT}/skills/pdf/SKILL.md`]: { text: skillFile("pdf", "Read and fill PDF forms") },
    [`https://raw.githubusercontent.com/Acme/skills/${COMMIT}/skills/docx/SKILL.md`]: { text: `---\nname: "Word Docs"\ndescription: >\n  Edit Word files\n  with tracked changes\n---\nbody\n` },
    ...overrides,
  });
}

describe("resolveSkillSource", () => {
  test("pins a repository's default branch to one commit and lists every SKILL.md at that commit", async () => {
    const github = multiSkillRepo();
    const resolved = await resolveSkillSource(parseSkillSource("https://github.com/acme/skills"), { fetch: github.fetch });
    expect(resolved).toMatchObject({ repository: "https://github.com/Acme/skills", ref: "main", commit: COMMIT, license: "MIT", truncated: false });
    expect(resolved.skills).toEqual([
      { id: "word-docs", name: "Word Docs", description: "Edit Word files with tracked changes", path: "skills/docx", digest: "b".repeat(40), problem: null },
      { id: "pdf", name: "pdf", description: "Read and fill PDF forms", path: "skills/pdf", digest: "a".repeat(40), problem: null },
    ]);
    // Once the commit is known, nothing is read through a branch name that could move underneath.
    for (const url of github.asked.slice(2)) expect(url).toContain(COMMIT);
  });

  test("keeps only the skills under a subdirectory link and asks for the ref the link names", async () => {
    const github = multiSkillRepo({ "https://api.github.com/repos/acme/skills/commits/v2": { json: { sha: COMMIT } } });
    const resolved = await resolveSkillSource(parseSkillSource("https://github.com/acme/skills/tree/v2/skills/pdf"), { fetch: github.fetch });
    expect(resolved.ref).toBe("v2");
    expect(resolved.skills.map((skill) => skill.path)).toEqual(["skills/pdf"]);
    expect(github.asked).not.toContain("https://api.github.com/repos/acme/skills/commits/main");
  });

  test("a skills.sh page selects the one skill it names", async () => {
    const github = multiSkillRepo();
    const resolved = await resolveSkillSource(parseSkillSource("https://skills.sh/acme/skills/pdf"), { fetch: github.fetch });
    expect(resolved.skills.map((skill) => skill.id)).toEqual(["pdf"]);
    await expect(resolveSkillSource(parseSkillSource("https://skills.sh/acme/skills/pptx"), { fetch: multiSkillRepo().fetch })).rejects.toThrow(
      `skill pptx not found in acme/skills at ${COMMIT}`,
    );
  });

  test("a folder without any SKILL.md is reported instead of resolving to nothing", async () => {
    await expect(
      resolveSkillSource(parseSkillSource("https://github.com/acme/skills/tree/main/docs"), { fetch: multiSkillRepo().fetch }),
    ).rejects.toThrow(`no SKILL.md under docs in acme/skills at ${COMMIT}`);
  });

  test("a SKILL.md without name and description is listed but cannot be installed", async () => {
    const github = multiSkillRepo({ [`https://raw.githubusercontent.com/Acme/skills/${COMMIT}/skills/docx/SKILL.md`]: { text: "# no frontmatter\n" } });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills.find((skill) => skill.path === "skills/docx")).toMatchObject({ id: null, problem: "missing-frontmatter" });
    expect(() => pinnedSkillRecord(resolved, resolved.skills.find((skill) => skill.path === "skills/docx")!)).toThrow(/cannot be installed/);
  });

  test("a skill whose name collides with a bundled extension is flagged", async () => {
    const github = multiSkillRepo({ [`https://raw.githubusercontent.com/Acme/skills/${COMMIT}/skills/docx/SKILL.md`]: { text: skillFile("github", "clash") } });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills.find((skill) => skill.path === "skills/docx")).toMatchObject({ id: null, problem: "bundled-id" });
  });

  test("refuses a ref that does not come back as a 40-character commit", async () => {
    const github = multiSkillRepo({ "https://api.github.com/repos/acme/skills/commits/main": { json: { sha: "main" } } });
    await expect(resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch })).rejects.toThrow("main in acme/skills did not resolve to a commit");
  });

  test("says what went wrong on GitHub's side", async () => {
    const missing = fakeGithub({ "https://api.github.com/repos/acme/skills": { status: 404, json: { message: "Not Found" } } });
    await expect(resolveSkillSource(parseSkillSource("acme/skills"), { fetch: missing.fetch })).rejects.toThrow("GitHub repository not found: acme/skills");
    const limited = fakeGithub({
      "https://api.github.com/repos/acme/skills": { status: 403, json: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } },
    });
    await expect(resolveSkillSource(parseSkillSource("acme/skills"), { fetch: limited.fetch })).rejects.toThrow("GitHub API rate limit reached");
    const noRef = multiSkillRepo({ "https://api.github.com/repos/acme/skills/commits/main": { status: 422, json: { message: "No commit found" } } });
    await expect(resolveSkillSource(parseSkillSource("acme/skills"), { fetch: noRef.fetch })).rejects.toThrow("ref not found in acme/skills: main");
  });
});

describe("pinnedSkillRecord", () => {
  test("records the immutable commit as the revision and a source link that cannot move", async () => {
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: multiSkillRepo().fetch });
    const record = pinnedSkillRecord(resolved, resolved.skills.find((skill) => skill.id === "pdf")!);
    expect(record).toEqual({
      id: "pdf",
      kind: "skill",
      name: "pdf",
      summary: "Read and fill PDF forms",
      source: `https://github.com/Acme/skills/tree/${COMMIT}/skills/pdf`,
      revision: COMMIT,
      provision: "managed",
      installState: "installing",
      useState: "enabled",
      availability: "ready",
      externalPath: null,
      error: null,
      provenance: { repository: "https://github.com/Acme/skills", commit: COMMIT, path: "skills/pdf", digest: "a".repeat(40), license: "MIT" },
    });
  });
});

/** A repository at COMMIT whose tree is `entries` and whose SKILL.md files say `files[path]`. */
function repoWith(entries: Array<{ path: string; sha?: string; size?: number }>, files: Record<string, string>, extra: Record<string, Reply> = {}) {
  const routes: Record<string, Reply> = {
    "https://api.github.com/repos/acme/skills": { json: { full_name: "acme/skills", default_branch: "main", license: null } },
    "https://api.github.com/repos/acme/skills/commits/main": { json: { sha: COMMIT } },
    [`https://api.github.com/repos/acme/skills/git/trees/${COMMIT}?recursive=1`]: {
      json: { tree: entries.map((entry, index) => ({ type: "blob", sha: entry.sha ?? index.toString(16).padStart(40, "0"), size: entry.size ?? 100, path: entry.path })) },
    },
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) routes[`https://raw.githubusercontent.com/acme/skills/${COMMIT}/${path}`] = { text };
  return fakeGithub(routes);
}

describe("review follow-ups", () => {
  test("a SKILL.md larger than the front matter budget is not downloaded", async () => {
    const github = repoWith([{ path: "big/SKILL.md", size: 10 * 1024 * 1024 }, { path: "ok/SKILL.md" }], { "ok/SKILL.md": skillFile("ok", "fine") });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills.find((skill) => skill.path === "big")).toMatchObject({ id: null, problem: "too-large" });
    expect(github.asked.some((url) => url.includes("big/SKILL.md"))).toBe(false);
  });

  test("two skills whose names map to the same id are both blocked instead of sharing a target", async () => {
    const github = repoWith([{ path: "a/SKILL.md" }, { path: "b/SKILL.md" }, { path: "c/SKILL.md" }], {
      "a/SKILL.md": skillFile("Pdf Tools", "one"),
      "b/SKILL.md": skillFile("pdf-tools", "two"),
      "c/SKILL.md": skillFile("other", "three"),
    });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills.map((skill) => [skill.path, skill.id, skill.problem])).toEqual([
      ["a", null, "duplicate-id"],
      ["b", null, "duplicate-id"],
      ["c", "other", null],
    ]);
  });

  test("a skills.sh skill past the listing cap is still found", async () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({ path: `s${String(index).padStart(2, "0")}/SKILL.md` }));
    const files = Object.fromEntries(entries.map((entry, index) => [entry.path, skillFile(`n${index}`, `skill ${index}`)]));
    const github = repoWith(entries, files);
    const resolved = await resolveSkillSource(parseSkillSource("https://skills.sh/acme/skills/s59"), { fetch: github.fetch });
    expect(resolved.skills.map((skill) => [skill.name, skill.path])).toEqual([["n59", "s59"]]);
    // A whole-repository preview of the same tree still stops at the listing cap and says so.
    const listed = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: repoWith(entries, files).fetch });
    expect(listed.skills).toHaveLength(50);
    expect(listed.truncated).toBe(true);
  });

  test("a skills.sh name that matches two skills at the same rank is refused, and a name match beats a folder match", async () => {
    const files = { "x/pdf/SKILL.md": skillFile("alpha", "one"), "y/pdf/SKILL.md": skillFile("beta", "two"), "z/SKILL.md": skillFile("pdf", "three") };
    const entries = Object.keys(files).map((path) => ({ path }));
    const chosen = await resolveSkillSource(parseSkillSource("https://skills.sh/acme/skills/pdf"), { fetch: repoWith(entries, files).fetch });
    expect(chosen.skills.map((skill) => skill.path)).toEqual(["z"]);
    const ambiguous = { "x/pdf/SKILL.md": files["x/pdf/SKILL.md"], "y/pdf/SKILL.md": files["y/pdf/SKILL.md"] };
    await expect(
      resolveSkillSource(parseSkillSource("https://skills.sh/acme/skills/pdf"), { fetch: repoWith(Object.keys(ambiguous).map((path) => ({ path })), ambiguous).fetch }),
    ).rejects.toThrow(`skill pdf is ambiguous in acme/skills at ${COMMIT}: x/pdf, y/pdf`);
  });

  test("a branch with a slash in a tree link is found by trying longer refs", async () => {
    const github = repoWith([{ path: "skills/pdf/SKILL.md" }, { path: "other/SKILL.md" }], { "skills/pdf/SKILL.md": skillFile("pdf", "forms") }, {
      "https://api.github.com/repos/acme/skills/commits/feature": { status: 404, json: { message: "No commit found for SHA: feature" } },
      "https://api.github.com/repos/acme/skills/commits/feature/x": { json: { sha: COMMIT } },
    });
    const resolved = await resolveSkillSource(parseSkillSource("https://github.com/acme/skills/tree/feature/x/skills/pdf"), { fetch: github.fetch });
    expect(resolved).toMatchObject({ ref: "feature/x", path: "skills/pdf", commit: COMMIT });
    expect(resolved.skills.map((skill) => skill.path)).toEqual(["skills/pdf"]);
  });

  test("paths with reserved URL characters are encoded in every URL built from them", async () => {
    const github = repoWith([{ path: "odd dir/a#1?/SKILL.md", sha: "c".repeat(40) }], { "odd%20dir/a%231%3F/SKILL.md": skillFile("odd", "odd path") });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills[0]).toMatchObject({ id: "odd", path: "odd dir/a#1?" });
    expect(pinnedSkillRecord(resolved, resolved.skills[0]!).source).toBe(`https://github.com/acme/skills/tree/${COMMIT}/odd%20dir/a%231%3F`);
  });

  test("a blob link selects only the SKILL.md it names, not skills nested under it", async () => {
    const github = repoWith([{ path: "skills/pdf/SKILL.md" }, { path: "skills/pdf/nested/SKILL.md" }], { "skills/pdf/SKILL.md": skillFile("pdf", "forms") });
    const resolved = await resolveSkillSource(parseSkillSource("https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md"), { fetch: github.fetch });
    expect(resolved.skills.map((skill) => skill.path)).toEqual(["skills/pdf"]);
  });

  test("front matter comments are not part of the name or description", async () => {
    const github = repoWith([{ path: "SKILL.md" }], { "SKILL.md": `---\nname: pdf   # the short name\ndescription: "Fill # forms" # trailing\n---\n` });
    const resolved = await resolveSkillSource(parseSkillSource("acme/skills"), { fetch: github.fetch });
    expect(resolved.skills[0]).toMatchObject({ id: "pdf", name: "pdf", description: "Fill # forms" });
  });
});
