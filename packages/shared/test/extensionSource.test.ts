import { describe, expect, test } from "vitest";
import { parseSkillSource } from "../src/extensionSource.js";

describe("parseSkillSource", () => {
  test("reads a bare GitHub repository in every common spelling", () => {
    for (const input of [
      "https://github.com/vercel-labs/agent-skills",
      "https://github.com/vercel-labs/agent-skills/",
      "https://github.com/vercel-labs/agent-skills.git",
      "github.com/vercel-labs/agent-skills",
      "vercel-labs/agent-skills",
      "  vercel-labs/agent-skills  ",
    ]) {
      expect(parseSkillSource(input)).toEqual({ via: "github", owner: "vercel-labs", repo: "agent-skills", ref: null, path: null, skill: null });
    }
  });

  test("keeps the ref and subdirectory of a tree link, and the folder of a SKILL.md blob link", () => {
    expect(parseSkillSource("https://github.com/acme/skills/tree/main/skills/pdf")).toEqual({
      via: "github", owner: "acme", repo: "skills", ref: "main", path: "skills/pdf", skill: null,
    });
    expect(parseSkillSource("https://github.com/acme/skills/tree/v1.2.0")).toEqual({
      via: "github", owner: "acme", repo: "skills", ref: "v1.2.0", path: null, skill: null,
    });
    expect(parseSkillSource("https://github.com/acme/skills/blob/0123456789abcdef0123456789abcdef01234567/skills/pdf/SKILL.md")).toEqual({
      via: "github", owner: "acme", repo: "skills", ref: "0123456789abcdef0123456789abcdef01234567", path: "skills/pdf", skill: null,
    });
    expect(parseSkillSource("https://github.com/acme/skills/blob/main/SKILL.md")).toEqual({
      via: "github", owner: "acme", repo: "skills", ref: "main", path: null, skill: null,
    });
  });

  test("turns a skills.sh page into the GitHub repository behind it and the skill it names", () => {
    expect(parseSkillSource("https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices")).toEqual({
      via: "skills.sh", owner: "vercel-labs", repo: "agent-skills", ref: null, path: null, skill: "vercel-react-best-practices",
    });
    expect(parseSkillSource("https://www.skills.sh/vercel-labs/agent-skills")).toEqual({
      via: "skills.sh", owner: "vercel-labs", repo: "agent-skills", ref: null, path: null, skill: null,
    });
  });

  test("refuses anything that is not a GitHub repository or a skills.sh page", () => {
    for (const input of [
      "",
      "   ",
      "http://github.com/acme/skills",
      "https://gitlab.com/acme/skills",
      "https://github.com/acme",
      "https://github.com/acme/skills/pulls",
      "https://github.com/acme/skills/blob/main/README.md",
      "https://github.com/acme/skills/tree/main/../../etc",
      "https://github.com/acme/skills/tree/main/a%2F..%2Fb",
      "https://github.com/acme/..",
      "https://github.com/-acme/skills",
      "https://user:pass@github.com/acme/skills",
      "https://github.com:8443/acme/skills",
      "https://github.com/acme/skills?tab=readme",
      "https://skills.sh/acme",
      "https://skills.sh/acme/skills/one/two",
      "acme/skills; rm -rf /",
      "file:///etc/passwd",
      "x".repeat(2049),
    ]) {
      expect(() => parseSkillSource(input), input).toThrow(/unsupported extension source/);
    }
  });
});
