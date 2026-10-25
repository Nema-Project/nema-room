// The only `gh` commands the Agent may run: a fixed table of issue, PR, label, run and Project commands.
// The hub uses it to scope a call to the bound GitHub repos and to tell reads from writes; the daemon
// parses again before spawning, and runs the normalized argv (`--flag=value`, so free text can never be
// taken for a flag). No `gh api`, no file or editor flags, no merge, delete, auth or other account commands.

export type GhRepoTarget = { owner: string; repo: string };
export type GhCommandResult = { ok: true; mode: "read" | "write"; argv: string[] } | { ok: false; error: string };

type Flag = "bool" | "str" | "int" | "json" | { enum: string[] };
type Spec = {
  mode: "read" | "write";
  /** Which flag pins the target: a bound `--repo`, a bound Project `--owner`, or nothing. */
  scope: "repo" | "owner" | "none";
  positional: "none" | "number" | "name";
  flags: Record<string, Flag | { kind: Flag; repeat: true }>;
  required?: string[];
};

const OUT = { json: "json", jq: "str" } as const;
const rep = (kind: Flag) => ({ kind, repeat: true as const });
const STATE = { enum: ["open", "closed", "all"] };

const SPECS: Record<string, Spec> = {
  "issue list": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT, state: STATE, limit: "int", label: rep("str"), assignee: "str", author: "str", milestone: "str", mention: "str" } },
  "issue view": { mode: "read", scope: "repo", positional: "number", flags: { ...OUT, comments: "bool" } },
  "issue status": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT } },
  "issue create": { mode: "write", scope: "repo", positional: "none", flags: { title: "str", body: "str", label: rep("str"), assignee: rep("str"), milestone: "str", project: rep("str") }, required: ["title", "body"] },
  "issue comment": { mode: "write", scope: "repo", positional: "number", flags: { body: "str" }, required: ["body"] },
  "issue edit": { mode: "write", scope: "repo", positional: "number", flags: { title: "str", body: "str", "add-label": rep("str"), "remove-label": rep("str"), "add-assignee": rep("str"), "remove-assignee": rep("str"), milestone: "str", "remove-milestone": "bool", "add-project": rep("str"), "remove-project": rep("str") } },
  "issue close": { mode: "write", scope: "repo", positional: "number", flags: { comment: "str", reason: { enum: ["completed", "not planned", "duplicate"] } } },
  "issue reopen": { mode: "write", scope: "repo", positional: "number", flags: { comment: "str" } },
  "pr list": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT, state: { enum: ["open", "closed", "merged", "all"] }, limit: "int", label: rep("str"), assignee: "str", author: "str", base: "str", head: "str" } },
  "pr view": { mode: "read", scope: "repo", positional: "number", flags: { ...OUT, comments: "bool" } },
  "pr diff": { mode: "read", scope: "repo", positional: "number", flags: { "name-only": "bool", patch: "bool" } },
  "pr checks": { mode: "read", scope: "repo", positional: "number", flags: { ...OUT, required: "bool" } },
  "pr status": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT } },
  "pr comment": { mode: "write", scope: "repo", positional: "number", flags: { body: "str" }, required: ["body"] },
  "pr edit": { mode: "write", scope: "repo", positional: "number", flags: { title: "str", body: "str", base: "str", milestone: "str", "add-label": rep("str"), "remove-label": rep("str"), "add-assignee": rep("str"), "remove-assignee": rep("str"), "add-reviewer": rep("str"), "remove-reviewer": rep("str") } },
  "label list": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT, limit: "int" } },
  "label create": { mode: "write", scope: "repo", positional: "name", flags: { color: "str", description: "str", force: "bool" } },
  "label edit": { mode: "write", scope: "repo", positional: "name", flags: { color: "str", description: "str", name: "str" } },
  "run list": { mode: "read", scope: "repo", positional: "none", flags: { ...OUT, limit: "int", workflow: "str", branch: "str", status: "str" } },
  "run view": { mode: "read", scope: "repo", positional: "number", flags: { ...OUT, log: "bool", "log-failed": "bool" } },
  "project list": { mode: "read", scope: "owner", positional: "none", flags: { owner: "str", limit: "int", format: { enum: ["json"] }, jq: "str", closed: "bool" } },
  "project view": { mode: "read", scope: "owner", positional: "number", flags: { owner: "str", format: { enum: ["json"] }, jq: "str" } },
  "project field-list": { mode: "read", scope: "owner", positional: "number", flags: { owner: "str", limit: "int", format: { enum: ["json"] }, jq: "str" } },
  "project item-list": { mode: "read", scope: "owner", positional: "number", flags: { owner: "str", limit: "int", format: { enum: ["json"] }, jq: "str" } },
  "project item-add": { mode: "write", scope: "owner", positional: "number", flags: { owner: "str", url: "str" }, required: ["url"] },
  "project item-create": { mode: "write", scope: "owner", positional: "number", flags: { owner: "str", title: "str", body: "str" }, required: ["title"] },
  "project item-archive": { mode: "write", scope: "owner", positional: "number", flags: { owner: "str", id: "str", undo: "bool" }, required: ["id"] },
  // Node ids cannot be tied to an owner; the Agent only gets them by reading a bound owner's Project.
  "project item-edit": { mode: "write", scope: "none", positional: "none", flags: { id: "str", "project-id": "str", "field-id": "str", text: "str", number: "str", date: "str", "single-select-option-id": "str", "iteration-id": "str", clear: "bool" }, required: ["id"] },
};

const MAX_ITEMS = 80;
const MAX_VALUE = 65_536;
const MAX_TOTAL = 200_000;
const NAME = /^[A-Za-z0-9._-]+$/;
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/\d{1,9}$/;

const fail = (error: string): GhCommandResult => ({ ok: false, error });

function boundRepo(value: string, bound: GhRepoTarget[]): boolean {
  const [owner, repo, extra] = value.split("/");
  if (extra !== undefined || !owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return false;
  return bound.some((target) => target.owner.toLowerCase() === owner.toLowerCase() && target.repo.toLowerCase() === repo.toLowerCase());
}

export function parseGhCommand(input: unknown, bound: GhRepoTarget[]): GhCommandResult {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ITEMS || input.some((item) => typeof item !== "string")) return fail("args must be a non-empty array of strings");
  const args = input as string[];
  if (args.reduce((sum, item) => sum + item.length, 0) > MAX_TOTAL || args.some((item) => item.length > MAX_VALUE || item.includes("\0"))) return fail("argument too long or contains a NUL");
  const spec = SPECS[`${args[0]} ${args[1]}`];
  if (!spec) return fail(`unsupported gh command: ${args.slice(0, 2).join(" ")}`);

  const positionals: string[] = [];
  const flags: Array<[string, string | true]> = [];
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const token = args[i]!;
    let name: string;
    let inline: string | undefined;
    if (token === "-R") name = "repo";
    else if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      inline = eq < 0 ? undefined : token.slice(eq + 1);
    } else if (token.startsWith("-")) return fail(`unsupported flag: ${token.slice(0, 40)}`);
    else { positionals.push(token); continue; }

    const raw = name === "repo" ? (spec.scope === "repo" ? "str" : undefined) : spec.flags[name];
    if (raw === undefined) return fail(`unsupported flag for gh ${args[0]} ${args[1]}: --${name.slice(0, 40)}`);
    const flag = typeof raw === "object" && "kind" in raw ? raw.kind : raw;
    const repeat = typeof raw === "object" && "kind" in raw;
    if (!repeat && seen.has(name)) return fail(`repeated flag: --${name}`);
    seen.add(name);
    if (flag === "bool") {
      if (inline !== undefined) return fail(`--${name} takes no value`);
      flags.push([name, true]);
      continue;
    }
    const value = inline ?? args[++i];
    if (value === undefined) return fail(`--${name} needs a value`);
    if (flag === "int" && !(/^\d{1,4}$/.test(value) && +value >= 1 && +value <= 1000)) return fail(`--${name} must be 1-1000`);
    if (flag === "json" && !/^[A-Za-z0-9,]+$/.test(value)) return fail("--json takes a comma-separated field list");
    if (typeof flag === "object" && "enum" in flag && !flag.enum.includes(value)) return fail(`--${name} must be one of: ${flag.enum.join(", ")}`);
    flags.push([name, value]);
  }

  for (const name of spec.required ?? []) if (!seen.has(name)) return fail(`--${name} is required`);
  if (spec.positional === "none" && positionals.length > 0) return fail("unexpected argument");
  if (spec.positional !== "none" && positionals.length !== 1) return fail("exactly one target argument is required");
  const target = positionals[0];
  if (spec.positional === "number" && !/^\d{1,9}$/.test(target!)) return fail("the target must be an issue, pull request, project or run number");
  if (spec.positional === "name" && (target!.startsWith("-") || target!.length > 50 || /[\r\n]/.test(target!))) return fail("invalid name");

  const value = (name: string) => flags.find(([key]) => key === name)?.[1] as string | undefined;
  if (spec.scope === "repo") {
    const repo = value("repo");
    if (repo === undefined) return fail("--repo owner/name is required");
    if (!boundRepo(repo, bound)) return fail(`only repositories bound to this workspace may be used: ${repo.slice(0, 100)}`);
  }
  if (spec.scope === "owner") {
    const owner = value("owner");
    if (owner === undefined) return fail("--owner is required");
    if (!NAME.test(owner) || !bound.some((item) => item.owner.toLowerCase() === owner.toLowerCase())) return fail(`only owners of repositories bound to this workspace may be used: ${owner.slice(0, 100)}`);
  }
  const url = value("url");
  if (args[0] === "project" && url !== undefined) {
    const match = ISSUE_URL.exec(url);
    if (!match || !boundRepo(`${match[1]}/${match[2]}`, bound)) return fail("--url must be an issue or pull request of a bound repository");
  }

  const argv = [args[0]!, args[1]!, ...positionals, ...flags.map(([name, v]) => (v === true ? `--${name}` : `--${name}=${v}`))];
  return { ok: true, mode: spec.mode, argv };
}

export const GH_COMMAND_TOOLS = ["gh_read", "gh_write"] as const;
