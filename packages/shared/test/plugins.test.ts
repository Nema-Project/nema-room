import { expect, test } from "vitest";
import { PLUGINS, pluginFunction } from "../src/index.js";

const GITHUB_NAMES = [
  "github__pull_request_read",
  "github__list_pull_requests",
  "github__search_pull_requests",
  "github__issue_read",
  "github__list_issues",
  "github__search_issues",
];

type JsonSchema = {
  type: string;
  properties: Record<string, { type: string; minimum?: number; description?: string }>;
  required: string[];
  additionalProperties: boolean;
};

function schema(name: string): JsonSchema {
  const hit = pluginFunction(name);
  expect(hit).not.toBeNull();
  return hit!.fn.parameters as JsonSchema;
}

test("every registered function is named <pluginId>__<fn> and read-only", () => {
  expect(
    PLUGINS.map((p) => ({ id: p.id, displayName: p.displayName, dataFlow: p.dataFlow, runsOn: p.runsOn, scope: p.scope })),
  ).toEqual([
    { id: "code", displayName: "graphify", dataFlow: "local", runsOn: "daemon", scope: "repo" },
    { id: "diagram", displayName: "archify", dataFlow: "local", runsOn: "hub", scope: "repo" },
    { id: "superpowers", displayName: "superpowers", dataFlow: "local", runsOn: "hub", scope: "none" },
    { id: "grill", displayName: "grill-me", dataFlow: "local", runsOn: "hub", scope: "none" },
    { id: "github", displayName: "GitHub", dataFlow: "external", runsOn: "daemon", scope: "github" },
  ]);
  const names = PLUGINS.flatMap((p) => p.functions.map((fn) => fn.name));
  expect(names).toEqual([
    "code__search",
    "code__explain",
    "code__path",
    "code__read",
    "code__changes",
    "diagram__save",
    "diagram__read",
    "workpackage__read",
    "workpackage__save_spec",
    "workpackage__save_plan",
    "workpackage__block",
    "workpackage__request",
    "workpackage__mark_task_inferred",
    ...GITHUB_NAMES,
  ]);
  for (const plugin of PLUGINS) {
    for (const fn of plugin.functions) {
      // superpowers' functions are the workpackage__ family.
      expect(fn.name.startsWith(`${plugin.id === "superpowers" ? "workpackage" : plugin.id}__`)).toBe(true);
      expect(fn.readOnly).toBe(true);
      expect(fn.description).toMatch(/^[^.]+[.]$/);
    }
  }
});

test("pluginFunction resolves code__read and rejects an unknown name", () => {
  const hit = pluginFunction("code__read");
  expect(hit?.plugin.id).toBe("code");
  expect(hit?.fn).toBe(PLUGINS[0]?.functions.find((fn) => fn.name === "code__read"));
  expect(pluginFunction("code__missing")).toBeNull();
});

test("every code__ function requires repo", () => {
  const names = ["code__search", "code__explain", "code__path", "code__read", "code__changes"];
  for (const name of names) {
    const s = schema(name);
    expect(s).toMatchObject({ type: "object", additionalProperties: false });
    expect(s.required).toContain("repo");
    expect(s.properties.repo).toEqual({ type: "string" });
  }

  expect(Object.keys(schema("code__search").properties).sort()).toEqual(["query", "repo"]);
  expect(schema("code__search").required.sort()).toEqual(["query", "repo"]);
  expect(schema("code__search").properties.query).toEqual({ type: "string" });

  expect(Object.keys(schema("code__explain").properties).sort()).toEqual(["repo", "symbol"]);
  expect(schema("code__explain").required.sort()).toEqual(["repo", "symbol"]);
  expect(schema("code__explain").properties.symbol).toEqual({ type: "string" });

  expect(Object.keys(schema("code__path").properties).sort()).toEqual(["from", "repo", "to"]);
  expect(schema("code__path").required.sort()).toEqual(["from", "repo", "to"]);
  expect(schema("code__path").properties.from).toEqual({ type: "string" });
  expect(schema("code__path").properties.to).toEqual({ type: "string" });

  const read = schema("code__read");
  expect(Object.keys(read.properties).sort()).toEqual(["endLine", "path", "repo", "startLine"]);
  expect(read.required.sort()).toEqual(["path", "repo"]);
  expect(read.properties.path).toEqual({ type: "string" });
  expect(read.properties.startLine).toEqual({ type: "integer", minimum: 1 });
  expect(read.properties.endLine).toEqual({ type: "integer", minimum: 1 });

  const changes = schema("code__changes");
  expect(Object.keys(changes.properties).sort()).toEqual(["from", "repo", "to"]);
  expect(changes.required.sort()).toEqual(["from", "repo"]);
  expect(changes.properties.from).toEqual({ type: "string" });
  expect(changes.properties.to).toMatchObject({ type: "string", description: expect.stringMatching(/main/i) });
});

test("diagram__save requires repo, type, title, summary, spec and nodePaths; diagram__read requires id", () => {
  const save = schema("diagram__save") as JsonSchema & { properties: Record<string, { enum?: string[] }> };
  expect(save).toMatchObject({ type: "object", additionalProperties: false });
  expect(save.required.sort()).toEqual(["nodePaths", "repo", "spec", "summary", "title", "type"]);
  expect(Object.keys(save.properties).sort()).toEqual(["id", "nodePaths", "repo", "spec", "summary", "title", "type"]);
  expect(save.properties.repo).toEqual({ type: "string" });
  expect(save.properties.type?.enum).toContain("architecture");
  expect(schema("diagram__read").required).toEqual(["id"]);
  expect(pluginFunction("diagram__read")?.plugin.runsOn).toBe("hub");
});

test("github functions are the fixed read tools: owner/repo tools require both, search tools require a query", () => {
  for (const name of GITHUB_NAMES) {
    const hit = pluginFunction(name);
    expect(hit?.plugin.id).toBe("github");
    expect(hit?.fn.readOnly).toBe(true);
    expect(schema(name)).toMatchObject({ type: "object", additionalProperties: false });
  }
  for (const name of ["github__pull_request_read", "github__list_pull_requests", "github__issue_read", "github__list_issues"]) {
    const s = schema(name);
    expect(s.required).toEqual(expect.arrayContaining(["owner", "repo"]));
    expect(s.properties.owner).toMatchObject({ type: "string" });
    expect(s.properties.repo).toMatchObject({ type: "string" });
  }
  for (const name of ["github__search_pull_requests", "github__search_issues"]) {
    const s = schema(name);
    expect(s.required).toEqual(["query"]);
    expect(s.properties.owner).toBeUndefined();
    expect(s.properties.repo).toBeUndefined();
  }
  expect(schema("github__pull_request_read").required.sort()).toEqual(["method", "owner", "pullNumber", "repo"]);
  expect(schema("github__issue_read").required.sort()).toEqual(["issue_number", "method", "owner", "repo"]);
});
