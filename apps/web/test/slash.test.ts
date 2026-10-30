import { DIAGRAM_TYPES } from "@nema/shared";
import { describe, expect, it } from "vitest";
import { applySlash, matchingCommands, matchingItems, slashToken } from "@/lib/slash";

describe("slash commands", () => {
  it("reads a slash token only at the start of the line, while the caret is in the name", () => {
    expect(slashToken("/", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(slashToken("/diagram:ar", 11)).toEqual({ query: "diagram:ar", start: 0, end: 11 });
    expect(slashToken("note\n/di", 8)).toEqual({ query: "di", start: 5, end: 8 });
    expect(slashToken("hello /pro", 10)).toBeNull();
    expect(slashToken("/progress ", 10)).toBeNull();
    expect(slashToken("/progress extra", 4)).toBeNull();
    expect(slashToken("/", 0)).toBeNull();
  });

  it("lists every diagram type and filters on the typed prefix", () => {
    expect(matchingCommands("").map((item) => item.id)).toEqual(["thread", "progress", ...DIAGRAM_TYPES.map((type) => `diagram:${type}`), "update"]);
    expect(matchingCommands("diagram:w").map((item) => item.id)).toEqual(["diagram:workflow", "diagram:waterfall"]);
    expect(matchingCommands("diagram:s").map((item) => item.id)).toEqual(["diagram:sequence"]);
    expect(matchingCommands("z")).toEqual([]);
    const value = "keep\n/diagram:seq";
    const token = slashToken(value, value.length)!;
    const insert = "Draw a sequence code diagram.";
    expect(applySlash(value, token, insert)).toEqual({ text: `keep\n${insert}`, cursor: `keep\n${insert}`.length });
  });
});
describe("Skills in the slash menu", () => {
  const skills = [
    { id: "tdd", description: "Write the test first.", command: "/tdd" },
    { id: "thread", description: "A Skill that shares a built-in name.", command: "/skill:thread" },
    { id: "web:deploy", description: "Ship the web app.", command: "/skill:web:deploy" },
  ];
  const ids = (items: { id: string }[]) => items.map((i) => i.id);

  it("comes after the commands, only at the start of the message", () => {
    expect(ids(matchingItems("td", { atMessageStart: true, skills, threadMode: false }))).toEqual(["skill:tdd"]);
    expect(ids(matchingItems("td", { atMessageStart: false, skills, threadMode: false }))).toEqual([]);
    expect(ids(matchingItems("thr", { atMessageStart: true, skills, threadMode: false }))).toEqual(["thread", "skill:thread"]);
    expect(ids(matchingItems("thr", { atMessageStart: true, skills, threadMode: true }))).toEqual(["skill:thread"]);
  });

  it("matches the /skill: form, the id, and words in the description", () => {
    expect(ids(matchingItems("skill:t", { atMessageStart: true, skills, threadMode: false }))).toEqual(["skill:thread"]);
    expect(ids(matchingItems("web", { atMessageStart: true, skills, threadMode: false }))).toEqual(["skill:web:deploy"]);
    expect(ids(matchingItems("ship", { atMessageStart: true, skills, threadMode: false }))).toEqual(["skill:web:deploy"]);
  });

  it("a Skill row inserts its command and a space", () => {
    const [row] = matchingItems("thread", { atMessageStart: true, skills, threadMode: true });
    expect(row).toMatchObject({ insert: "/skill:thread ", skill: { id: "thread" } });
  });
});
