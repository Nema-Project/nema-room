// Parameter objects are plain JSON Schema. They are what the model sees.

import { DIAGRAM_TYPES } from "./entry.js";

export type DataFlow = "local" | "external";

export type PluginFunction = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
};

export type GrillSettings = { strictness: "strict" | "lenient"; extraRules: string };

export const GRILL_EXTRA_RULES_MAX = 2000;
export const DEFAULT_GRILL_SETTINGS: GrillSettings = { strictness: "strict", extraRules: "" };

export type PluginManifest = {
  id: string;
  displayName: string;
  dataFlow: DataFlow;
  /** "hub": the hub answers the call itself and never sends it to the daemon. */
  runsOn: "hub" | "daemon";
  /** What a call is checked against: a bound repo id, the bound repos' GitHub remotes, or nothing. */
  scope: "repo" | "github" | "none";
  functions: PluginFunction[];
};

/** What an adapter declares to the model for one plugin function. */
export type PluginToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const PAGE = { type: "number", minimum: 1, description: "Page number for pagination." };
const PER_PAGE = { type: "number", minimum: 1, maximum: 100, description: "Results per page, at most 100." };
const OWNER = { type: "string", description: "Repository owner." };
const REPO_NAME = { type: "string", description: "Repository name." };

// The read tools of github-mcp-server's pull_requests and issues toolsets. Schemas follow the upstream
// README (tools not listed against a local server). Search tools take no owner/repo: the query itself
// must carry the one repo: qualifier.
const GITHUB_FUNCTIONS: PluginFunction[] = [
  {
    name: "github__pull_request_read",
    description: "Read one pull request of a bound repository on GitHub: details, diff, files, commits, reviews or comments.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO_NAME,
        pullNumber: { type: "number", minimum: 1, description: "Pull request number." },
        method: {
          type: "string",
          enum: ["get", "get_diff", "get_status", "get_files", "get_commits", "get_review_comments", "get_reviews", "get_comments", "get_check_runs"],
        },
        page: PAGE,
        perPage: PER_PAGE,
        after: { type: "string", description: "Cursor for get_review_comments pagination." },
      },
      required: ["owner", "repo", "pullNumber", "method"],
      additionalProperties: false,
    },
  },
  {
    name: "github__list_pull_requests",
    description: "List pull requests of a bound repository on GitHub.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO_NAME,
        state: { type: "string", enum: ["open", "closed", "all"] },
        base: { type: "string", description: "Filter by base branch." },
        head: { type: "string", description: "Filter by head user or org and branch." },
        sort: { type: "string" },
        direction: { type: "string" },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "github__search_pull_requests",
    description: "Search pull requests on GitHub with a query that names exactly one bound repository as repo:owner/name.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub search syntax, with exactly one repo:owner/name qualifier." },
        sort: { type: "string" },
        order: { type: "string" },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "github__issue_read",
    description: "Read one issue of a bound repository on GitHub: details, comments, sub-issues, parent or labels.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO_NAME,
        issue_number: { type: "number", minimum: 1, description: "Issue number." },
        method: { type: "string", enum: ["get", "get_comments", "get_sub_issues", "get_parent", "get_labels"] },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ["owner", "repo", "issue_number", "method"],
      additionalProperties: false,
    },
  },
  {
    name: "github__list_issues",
    description: "List issues of a bound repository on GitHub.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        owner: OWNER,
        repo: REPO_NAME,
        state: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        orderBy: { type: "string" },
        direction: { type: "string" },
        since: { type: "string", description: "ISO 8601 timestamp." },
        after: { type: "string", description: "Cursor from the previous page." },
        perPage: PER_PAGE,
      },
      required: ["owner", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "github__search_issues",
    description: "Search issues on GitHub with a query that names exactly one bound repository as repo:owner/name.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub search syntax, with exactly one repo:owner/name qualifier." },
        sort: { type: "string" },
        order: { type: "string" },
        page: PAGE,
        perPage: PER_PAGE,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export const PLUGINS: readonly PluginManifest[] = [
  {
    id: "code",
    displayName: "graphify",
    dataFlow: "local",
    runsOn: "daemon",
    scope: "repo",
    functions: [
      {
        name: "code__search",
        description: "Search the repository for code matching a query.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            query: { type: "string" },
          },
          required: ["repo", "query"],
          additionalProperties: false,
        },
      },
      {
        name: "code__explain",
        description: "Explain what a named symbol does in the repository.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            symbol: { type: "string" },
          },
          required: ["repo", "symbol"],
          additionalProperties: false,
        },
      },
      {
        name: "code__path",
        description: "Show the path from one symbol to another in the repository.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
          },
          required: ["repo", "from", "to"],
          additionalProperties: false,
        },
      },
      {
        name: "code__read",
        description: "Read a file from the repository, optionally limited to a line range.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["repo", "path"],
          additionalProperties: false,
        },
      },
      {
        name: "code__changes",
        description: "List changes in the repository between two refs.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            from: { type: "string" },
            to: { type: "string", description: "Defaults to the current main ref when omitted." },
          },
          required: ["repo", "from"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "diagram",
    displayName: "archify",
    dataFlow: "local",
    runsOn: "hub",
    scope: "repo",
    functions: [
      {
        name: "diagram__save",
        description:
          "Save an archify diagram of a bound repository as a knowledge entry; pass id to update that diagram in place, and fix the spec and retry when the result is ok:false with diagnostics.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string" },
            type: { type: "string", enum: [...DIAGRAM_TYPES] },
            title: { type: "string", minLength: 1, maxLength: 200 },
            summary: { type: "string", description: "Markdown shown above the diagram." },
            spec: { type: "object", description: "The archify JSON spec for this diagram type." },
            nodePaths: {
              type: "object",
              description: "archify node id -> repo-relative paths that node stands for.",
              additionalProperties: { type: "array", items: { type: "string" } },
            },
            id: { type: "string", pattern: "^G-[1-9][0-9]*$", description: "An existing diagram to update; omit to create one." },
          },
          required: ["repo", "type", "title", "summary", "spec", "nodePaths"],
          additionalProperties: false,
        },
      },
      {
        name: "diagram__read",
        description: "Read a saved diagram entry and its archify JSON spec.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^G-[1-9][0-9]*$" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "superpowers",
    displayName: "superpowers",
    dataFlow: "local",
    runsOn: "hub",
    scope: "none",
    functions: [
      {
        name: "workpackage__read",
        description: "Read a work package: its entry, spec, plan and the writing rules for spec and plan.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: { id: { type: "string", pattern: "^W-[1-9][0-9]*$" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      {
        name: "workpackage__save_spec",
        description: "Save the spec of a work package, and fix it and retry when the result is ok:false with an error.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: { id: { type: "string", pattern: "^W-[1-9][0-9]*$" }, markdown: { type: "string" } },
          required: ["id", "markdown"],
          additionalProperties: false,
        },
      },
      {
        name: "workpackage__save_plan",
        description: "Save the plan of a work package, and fix it and retry when the result is ok:false with an error.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: { id: { type: "string", pattern: "^W-[1-9][0-9]*$" }, markdown: { type: "string" } },
          required: ["id", "markdown"],
          additionalProperties: false,
        },
      },
      {
        name: "workpackage__block",
        description: "Mark a work package as blocked on an open question entry of this workspace.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: { id: { type: "string", pattern: "^W-[1-9][0-9]*$" }, questionId: { type: "string", pattern: "^Q-[1-9][0-9]*$" } },
          required: ["id", "questionId"],
          additionalProperties: false,
        },
      },
      {
        name: "workpackage__request",
        description: "Ask for a work package to be written from the given requirement entries.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            requirements: { type: "array", items: { type: "string", pattern: "^R-[1-9][0-9]*$" }, minItems: 1 },
            title: { type: "string", minLength: 1, maxLength: 200 },
          },
          required: ["requirements"],
          additionalProperties: false,
        },
      },
      {
        name: "workpackage__mark_task_inferred",
        description: "Mark a pending task of a work package as reported from the given main commits, inferred from the code.",
        readOnly: true,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^W-[1-9][0-9]*$" },
            task: { type: "integer", minimum: 1 },
            commits: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["id", "task", "commits"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    id: "grill",
    displayName: "grill-me",
    dataFlow: "local",
    runsOn: "hub",
    scope: "none",
    functions: [],
  },
  {
    id: "github",
    displayName: "GitHub",
    dataFlow: "external",
    runsOn: "daemon",
    scope: "github",
    functions: GITHUB_FUNCTIONS,
  },
];

export function pluginFunction(name: string): { plugin: PluginManifest; fn: PluginFunction } | null {
  for (const plugin of PLUGINS) {
    const fn = plugin.functions.find((candidate) => candidate.name === name);
    if (fn) return { plugin, fn };
  }
  return null;
}
