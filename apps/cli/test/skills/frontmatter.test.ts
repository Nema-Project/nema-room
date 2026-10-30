import { expect, test } from "vitest";
import { parseSkillFile } from "../../src/skills/frontmatter.js";

const file = (front: string, body = "# Body\n\nDo the thing.\n") => `---\n${front}\n---\n${body}`;

test("the spec's minimal example", () => {
  const r = parseSkillFile(file("name: pdf-tools\ndescription: Extract text from PDFs. Use when handling PDFs."), "pdf-tools");
  expect(r).toMatchObject({ ok: true, body: "# Body\n\nDo the thing.\n", diagnostics: [] });
  if (!r.ok) throw new Error("expected ok");
  expect(r.meta).toEqual({
    name: "pdf-tools",
    description: "Extract text from PDFs. Use when handling PDFs.",
    whenToUse: null,
    license: null,
    compatibility: null,
    metadata: {},
    allowedTools: null,
    disableModelInvocation: false,
    userInvocable: true,
    context: null,
    agent: null,
    hooks: false,
    paths: null,
    model: null,
    effort: null,
  });
});

test("optional fields, metadata and allowed-tools", () => {
  const r = parseSkillFile(
    file(
      [
        "name: data",
        "description: \"Analyse data\"",
        "when_to_use: When a CSV shows up",
        "license: Apache-2.0",
        "compatibility: Requires python3",
        "metadata:",
        "  author: example-org",
        "  version: \"1.0\"",
        "allowed-tools: Bash(git:*) Read",
        "context: fork",
        "agent: Explore",
        "model: sonnet",
        "effort: high",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: Bash",
      ].join("\n"),
    ),
    "data",
  );
  if (!r.ok) throw new Error("expected ok");
  expect(r.meta).toMatchObject({
    description: "Analyse data",
    whenToUse: "When a CSV shows up",
    license: "Apache-2.0",
    compatibility: "Requires python3",
    metadata: { author: "example-org", version: "1.0" },
    allowedTools: "Bash(git:*) Read",
    context: "fork",
    agent: "Explore",
    model: "sonnet",
    effort: "high",
    hooks: true,
  });
});

test("an unquoted colon in a value keeps the whole line", () => {
  const r = parseSkillFile(file("name: x\ndescription: Use when: the user asks for x"), "x");
  expect(r.ok && r.meta.description).toBe("Use when: the user asks for x");
});

test("folded and literal blocks", () => {
  const folded = parseSkillFile(file("name: x\ndescription: >\n  first line\n  second line"), "x");
  expect(folded.ok && folded.meta.description).toBe("first line second line");
  const literal = parseSkillFile(file("name: x\ndescription: |\n  first\n  second"), "x");
  expect(literal.ok && literal.meta.description).toBe("first\nsecond");
});

test("invocation flags", () => {
  const manual = parseSkillFile(file("name: x\ndescription: d\ndisable-model-invocation: true"), "x");
  expect(manual.ok && manual.meta.disableModelInvocation).toBe(true);
  const hidden = parseSkillFile(file("name: x\ndescription: d\nuser-invocable: false"), "x");
  expect(hidden.ok && hidden.meta.userInvocable).toBe(false);
});

test("paths as a list or a single string", () => {
  const list = parseSkillFile(file("name: x\ndescription: d\npaths:\n  - \"src/**/*.ts\"\n  - docs/**"), "x");
  expect(list.ok && list.meta.paths).toEqual(["src/**/*.ts", "docs/**"]);
  const one = parseSkillFile(file("name: x\ndescription: d\npaths: src/**"), "x");
  expect(one.ok && one.meta.paths).toEqual(["src/**"]);
});

test("lenient problems load with a diagnostic", () => {
  const r = parseSkillFile(file(`name: Other_Name\ndescription: ${"d".repeat(1100)} <b>x</b>`), "folder");
  if (!r.ok) throw new Error("expected ok");
  expect(r.meta.name).toBe("Other_Name");
  expect(r.diagnostics).toEqual([
    "name-format",
    "name-folder-mismatch",
    "description-too-long",
    "xml-tags",
  ]);
  const reserved = parseSkillFile(file("name: claude-helper\ndescription: d"), "claude-helper");
  expect(reserved.ok && reserved.diagnostics).toEqual(["reserved-word"]);
});

test("files that cannot load", () => {
  expect(parseSkillFile("# no front matter", "x")).toEqual({ ok: false, reason: "no-frontmatter" });
  expect(parseSkillFile(file("name: x\ndescription:   "), "x")).toEqual({ ok: false, reason: "no-description" });
  expect(parseSkillFile(file("description: d"), "x")).toEqual({ ok: false, reason: "unparseable" });
});

test("CRLF line endings", () => {
  const r = parseSkillFile("---\r\nname: x\r\ndescription: d\r\n---\r\nbody\r\n", "x");
  expect(r).toMatchObject({ ok: true, meta: { name: "x", description: "d" }, body: "body\r\n" });
});

test("block values keep their later paragraphs", () => {
  const folded = parseSkillFile("---\nname: tdd\ndescription: >\n  First line\n  goes on.\n\n  Second paragraph.\nlicense: MIT\n---\nbody\n", "tdd");
  expect(folded.ok && folded.meta.description).toBe("First line goes on.\nSecond paragraph.");
  expect(folded.ok && folded.meta.license).toBe("MIT");
  const literal = parseSkillFile("---\nname: tdd\ndescription: |\n  One\n\n  Two\n\n---\nbody\n", "tdd");
  expect(literal.ok && literal.meta.description).toBe("One\n\nTwo");
});
