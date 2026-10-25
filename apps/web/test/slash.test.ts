import { DIAGRAM_TYPES } from "@nema/shared";
import { describe, expect, it } from "vitest";
import { applySlash, matchingCommands, slashToken } from "@/lib/slash";

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
    expect(matchingCommands("").map((item) => item.id)).toEqual(["progress", ...DIAGRAM_TYPES.map((type) => `diagram:${type}`), "update"]);
    expect(matchingCommands("diagram:w").map((item) => item.id)).toEqual(["diagram:workflow", "diagram:waterfall"]);
    expect(matchingCommands("diagram:s").map((item) => item.id)).toEqual(["diagram:sequence"]);
    expect(matchingCommands("z")).toEqual([]);
    const value = "keep\n/diagram:seq";
    const token = slashToken(value, value.length)!;
    const insert = "Draw a sequence code diagram.";
    expect(applySlash(value, token, insert)).toEqual({ text: `keep\n${insert}`, cursor: `keep\n${insert}`.length });
  });
});