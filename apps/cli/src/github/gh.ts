import { parseGhCommand, type GhRepoTarget } from "@nema/shared";
import { runHelperFile } from "@nema/shared/ownedHelper";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { commandSpec, windowsRuntimeEnv } from "../platform.js";

const OUTPUT_LIMIT = 65_536;
const CALL_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 2048;
const OWNER_OR_REPO = /^[A-Za-z0-9._-]+$/;
const QUERY = "query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:$first,after:$after){pageInfo{endCursor hasNextPage} nodes{id isResolved isOutdated path line startLine originalLine originalStartLine comments(first:100){nodes{databaseId body author{login} createdAt url}}}}}}}";
const PARENT_QUERY = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number title url}}}}";
const ISSUE_QUERY = "query($owner:String!,$name:String!,$first:Int!,$after:String,$states:[IssueState!],$labels:[String!],$orderBy:IssueOrder,$filterBy:IssueFilters){repository(owner:$owner,name:$name){issues(first:$first,after:$after,states:$states,labels:$labels,orderBy:$orderBy,filterBy:$filterBy){pageInfo{endCursor hasNextPage} nodes{number title state url createdAt updatedAt labels(first:100){nodes{name}}}}}}";

/** `inconclusive` is set when the check itself failed, so `installed` / `loggedIn` are not an answer. */
export type GithubStatus = { installed: boolean; loggedIn: boolean; detail: string; inconclusive?: true };
export type PullRequestObservation =
  | { outcome: "out_of_scope" }
  | { outcome: "read"; observedHeadSha: string; checkRuns: { name: string; status: string; conclusion: string | null; url: string | null }[]; truncated: boolean };
export interface GithubReader {
  call(tool: string, args: object): Promise<unknown>;
  status(): Promise<GithubStatus>;
  close(): Promise<void>;
  /** One read of a pull request's head and one page of its check runs, for a report's evidence. */
  observePullRequest?(args: { owner: string; repo: string; pr: number; perPage: number }): Promise<PullRequestObservation>;
}
export type GithubRequest =
  | { kind: "rest"; endpoint: string; fields: Record<string, string>; accept?: string }
  | { kind: "graphql"; query: string; variables: Record<string, unknown> }
  | { kind: "pr_status"; owner: string; repo: string; number: number; fields: Record<string, string> }
  | { kind: "check_runs"; owner: string; repo: string; number: number; fields: Record<string, string> };

function invalid(field: string): never { throw new Error(`GitHub: invalid ${field}`); }
function requiredString(args: Record<string, unknown>, field: string, max = 2000): string {
  const value = args[field];
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value)) return invalid(field);
  return value;
}
function optionalString(args: Record<string, unknown>, field: string, max = 2000): string | undefined {
  return args[field] === undefined ? undefined : requiredString(args, field, max);
}
function optionalNumber(args: Record<string, unknown>, field: string, max = 2_147_483_647): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return invalid(field);
  return value;
}
function ownerRepo(args: Record<string, unknown>): [string, string] {
  const owner = requiredString(args, "owner", 100);
  const repo = requiredString(args, "repo", 100);
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo) || repo === "." || repo === "..") return invalid("repository");
  return [owner, repo];
}
function pagination(args: Record<string, unknown>): Record<string, string> {
  const page = optionalNumber(args, "page");
  const perPage = optionalNumber(args, "perPage", 100);
  return { ...(page === undefined ? {} : { page: String(page) }), ...(perPage === undefined ? {} : { per_page: String(perPage) }) };
}
function rejectPagination(args: Record<string, unknown>): void {
  if (args.page !== undefined || args.perPage !== undefined) invalid("pagination is unsupported for this method");
}
function fields(args: Record<string, unknown>, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) {
    const value = optionalString(args, from);
    if (value !== undefined) out[to] = value;
  }
  return out;
}
function graph(query: string, variables: Record<string, unknown>): GithubRequest {
  return { kind: "graphql", query, variables };
}
function allowKeys(args: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(args)) if (!allowed.has(key)) invalid(key);
}

/** Translate the six declared GitHub tools into reviewed, fixed read-only API requests. */
export function githubApiRequest(tool: string, input: object): GithubRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("GitHub: invalid arguments");
  const args = input as Record<string, unknown>;
  if (tool === "pull_request_read") {
    allowKeys(args, ["owner", "repo", "pullNumber", "method", "page", "perPage", "after"]);
    const [owner, repo] = ownerRepo(args);
    const number = optionalNumber(args, "pullNumber");
    if (!number) return invalid("pullNumber");
    const method = requiredString(args, "method", 40);
    const endpoint = `repos/${owner}/${repo}/pulls/${number}`;
    if (method !== "get_review_comments" && args.after !== undefined) return invalid("after is supported only for get_review_comments");
    switch (method) {
      case "get": rejectPagination(args); return { kind: "rest", endpoint, fields: {} };
      case "get_diff": rejectPagination(args); return { kind: "rest", endpoint, fields: {}, accept: "application/vnd.github.v3.diff" };
      case "get_status": rejectPagination(args); return { kind: "pr_status", owner, repo, number, fields: {} };
      case "get_check_runs": return { kind: "check_runs", owner, repo, number, fields: pagination(args) };
      case "get_files": return { kind: "rest", endpoint: `${endpoint}/files`, fields: pagination(args) };
      case "get_commits": return { kind: "rest", endpoint: `${endpoint}/commits`, fields: pagination(args) };
      case "get_reviews": return { kind: "rest", endpoint: `${endpoint}/reviews`, fields: pagination(args) };
      case "get_comments": return { kind: "rest", endpoint: `repos/${owner}/${repo}/issues/${number}/comments`, fields: pagination(args) };
      case "get_review_comments": {
        const after = optionalString(args, "after", 1000);
        const first = optionalNumber(args, "perPage", 100) ?? 30;
        // This API uses cursors; accepting REST page without silently ignoring it is not possible.
        if (args.page !== undefined) return invalid("page (get_review_comments uses after cursor)");
        return graph(QUERY, { owner, name: repo, number, first, after: after || null });
      }
      default: throw new Error("GitHub: unsupported pull_request_read method");
    }
  }
  if (tool === "list_pull_requests") {
    allowKeys(args, ["owner", "repo", "state", "base", "head", "sort", "direction", "page", "perPage"]);
    const [owner, repo] = ownerRepo(args);
    const requestFields = { ...fields(args, { state: "state", base: "base", head: "head", sort: "sort", direction: "direction" }), ...pagination(args) };
    if (requestFields.state && !["open", "closed", "all"].includes(requestFields.state)) return invalid("state");
    if (requestFields.direction && !["asc", "desc"].includes(requestFields.direction)) return invalid("direction");
    if (requestFields.sort && !["created", "updated", "popularity", "long-running"].includes(requestFields.sort)) return invalid("sort");
    if (requestFields.base && !/^[A-Za-z0-9._/-]+$/.test(requestFields.base)) return invalid("base ref");
    if (requestFields.head && !/^[A-Za-z0-9._:/-]+$/.test(requestFields.head)) return invalid("head ref");
    return { kind: "rest", endpoint: `repos/${owner}/${repo}/pulls`, fields: requestFields };
  }
  if (tool === "search_pull_requests" || tool === "search_issues") {
    allowKeys(args, ["query", "sort", "order", "page", "perPage"]);
    const query = requiredString(args, "query");
    const repoQualifiers = [...query.matchAll(/(^|\s)repo:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?=\s|$)/gi)];
    if (repoQualifiers.length !== 1 || /\b(?:OR|NOT)\b|\b(?:org|user|owner):/i.test(query)) return invalid("query scope");
    const requestFields: Record<string, string> = { q: tool === "search_pull_requests" ? `is:pr ${query}` : query, ...fields(args, { sort: "sort", order: "order" }), ...pagination(args) };
    if (requestFields.order && !["asc", "desc"].includes(requestFields.order)) return invalid("order");
    if (requestFields.sort && !["created", "updated", "comments"].includes(requestFields.sort)) return invalid("sort");
    return { kind: "rest", endpoint: "search/issues", fields: requestFields };
  }
  if (tool === "issue_read") {
    allowKeys(args, ["owner", "repo", "issue_number", "method", "page", "perPage"]);
    const [owner, repo] = ownerRepo(args);
    const number = optionalNumber(args, "issue_number");
    if (!number) return invalid("issue_number");
    const method = requiredString(args, "method", 40);
    const endpoint = `repos/${owner}/${repo}/issues/${number}`;
    switch (method) {
      case "get": rejectPagination(args); return { kind: "rest", endpoint, fields: {} };
      case "get_comments": return { kind: "rest", endpoint: `${endpoint}/comments`, fields: pagination(args) };
      case "get_sub_issues": return { kind: "rest", endpoint: `${endpoint}/sub_issues`, fields: pagination(args) };
      case "get_parent": rejectPagination(args); return graph(PARENT_QUERY, { owner, name: repo, number });
      case "get_labels": return { kind: "rest", endpoint: `${endpoint}/labels`, fields: pagination(args) };
      default: throw new Error("GitHub: unsupported issue_read method");
    }
  }
  if (tool === "list_issues") {
    allowKeys(args, ["owner", "repo", "state", "labels", "orderBy", "direction", "since", "after", "perPage"]);
    const [owner, repo] = ownerRepo(args);
    const state = optionalString(args, "state", 20);
    if (state && !["open", "closed", "all"].includes(state)) return invalid("state");
    const labels = args.labels;
    if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || label.length > 200))) return invalid("labels");
    const after = optionalString(args, "after", 1000);
    const perPage = optionalNumber(args, "perPage", 100) ?? 30;
    const orderBy = optionalString(args, "orderBy", 30);
    const direction = optionalString(args, "direction", 10)?.toUpperCase();
    if (direction && direction !== "ASC" && direction !== "DESC") return invalid("direction");
    const since = optionalString(args, "since", 64);
    if (since && Number.isNaN(Date.parse(since))) return invalid("since");
    const order = orderBy ? { field: orderBy.toUpperCase(), direction: direction ?? "DESC" } : undefined;
    if (order && !["CREATED_AT", "UPDATED_AT", "COMMENTS"].includes(order.field)) return invalid("orderBy");
    return graph(ISSUE_QUERY, {
      owner, name: repo, first: perPage, after: after || null,
      states: state === "all" ? undefined : state ? [state.toUpperCase()] : undefined,
      labels, orderBy: order, filterBy: since ? { since } : undefined,
    });
  }
  throw new Error("GitHub: unsupported tool");
}

const ENV_ALLOW = new Set([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "PATH", "PATHEXT",
  "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "GH_TOKEN", "GITHUB_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
]);
function ghEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...windowsRuntimeEnv(parent) };
  for (const [key, value] of Object.entries(parent)) if (value !== undefined && ENV_ALLOW.has(key.toUpperCase()) || value !== undefined && ENV_ALLOW.has(key)) env[key] = value;
  Object.assign(env, { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", PAGER: "cat" });
  return env;
}
function argsFor(request: GithubRequest): { args: string[]; input?: Buffer } {
  if (request.kind === "pr_status" || request.kind === "check_runs") throw new Error("GitHub: derived request requires PR metadata");
  if (request.kind === "graphql") {
    return { args: ["api", "--hostname", "github.com", "graphql", "--input", "-"], input: Buffer.from(JSON.stringify({ query: request.query, variables: request.variables })) };
  }
  const args = ["api", "--hostname", "github.com", "--method", "GET", request.endpoint];
  if (request.accept) args.push("--header", `Accept: ${request.accept}`);
  for (const [key, value] of Object.entries(request.fields)) args.push("-f", `${key}=${value}`);
  return { args };
}
function redactSecrets(text: string): string {
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]");
}
function cap(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let out = "";
  for (const char of text) { if (Buffer.byteLength(out + char) > bytes) break; out += char; }
  return out;
}

/** A report's GitHub read parses whole responses (a PR and one page of 100 check runs), so it gets its own bound. */
const OBSERVE_LIMIT_BYTES = 8 * 1024 * 1024;

export type GithubGhOptions = { bin?: string; env?: NodeJS.ProcessEnv; ownedHelpers?: OwnedHelperScope; timeoutMs?: number; observeLimitBytes?: number };
export class GithubGh implements GithubReader {
  private readonly abort = new AbortController();
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: GithubGhOptions = {}) {}
  private get bin(): string { return this.options.bin ?? "gh"; }
  private get env(): NodeJS.ProcessEnv { return ghEnvironment(this.options.env ?? process.env); }
  private async execute(args: string[], options: { timeout: number; input?: Buffer; maxBuffer?: number; whole?: boolean } ): Promise<{ error: Error | null; stdout: string; stderr: string; code: number | null }> {
    if (this.closed) throw new Error("GitHub provider stopped");
    const command = commandSpec(this.bin, args, this.env);
    const operation = runHelperFile(command.bin, command.args, {
      env: this.env, timeout: options.timeout, maxBuffer: options.maxBuffer ?? 1024 * 1024, encoding: "utf8", signal: this.abort.signal, input: options.input,
    }, this.options.ownedHelpers);
    this.pending.add(operation);
    let result;
    try { result = await operation; }
    finally { this.pending.delete(operation); }
    // `whole` callers parse the JSON themselves; cutting it at the display cap would only make it unparseable.
    const stdout = result.stdout.toString("utf8");
    return { error: result.error, stdout: options.whole ? stdout : cap(stdout, OUTPUT_LIMIT), stderr: cap(result.stderr.toString("utf8"), STDERR_LIMIT), code: result.code };
  }
  /** `github__gh_read` / `github__gh_write`: the hub already scoped the call; the table is applied again here. */
  private async command(tool: string, input: object): Promise<string> {
    const { args, bound } = input as { args?: unknown; bound?: unknown };
    const targets: GhRepoTarget[] = Array.isArray(bound)
      ? bound.filter((item): item is GhRepoTarget => !!item && typeof (item as GhRepoTarget).owner === "string" && typeof (item as GhRepoTarget).repo === "string")
      : [];
    const parsed = parseGhCommand(args, targets);
    if (!parsed.ok) throw new Error(`GitHub: ${parsed.error}`);
    if (parsed.mode !== (tool === "gh_write" ? "write" : "read")) throw new Error("GitHub: command does not match the tool");
    const result = await this.execute(parsed.argv, { timeout: this.options.timeoutMs ?? CALL_TIMEOUT_MS });
    if (result.error) {
      if (result.error.message.includes("timed out")) throw new Error("GitHub call timed out");
      const detail = redactSecrets(result.stderr || result.stdout).trim();
      throw new Error(`gh failed${result.code === null ? "" : ` (exit ${result.code})`}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout;
  }
  async call(tool: string, args: object): Promise<unknown> {
    if (tool === "gh_read" || tool === "gh_write") return this.command(tool, args);
    const request = githubApiRequest(tool, args);
    if (request.kind === "pr_status" || request.kind === "check_runs") {
      const metadata = await this.execute(["api", "--hostname", "github.com", "--method", "GET", `repos/${request.owner}/${request.repo}/pulls/${request.number}`], { timeout: this.options.timeoutMs ?? CALL_TIMEOUT_MS });
      if (metadata.error) throw new Error("GitHub call failed");
      let sha: unknown;
      try { sha = (JSON.parse(metadata.stdout) as { head?: { sha?: unknown } }).head?.sha; } catch { /* sanitized below */ }
      if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("GitHub returned invalid pull request head SHA");
      const endpoint = request.kind === "pr_status"
        ? `repos/${request.owner}/${request.repo}/commits/${sha}/status`
        : `repos/${request.owner}/${request.repo}/commits/${sha}/check-runs`;
      const derived = await this.execute(["api", "--hostname", "github.com", "--method", "GET", endpoint, ...Object.entries(request.fields).flatMap(([key, value]) => ["-f", `${key}=${value}`])], { timeout: this.options.timeoutMs ?? CALL_TIMEOUT_MS });
      if (derived.error) throw new Error("GitHub call failed");
      return derived.stdout;
    }
    const operation = argsFor(request);
    const result = await this.execute(operation.args, { timeout: this.options.timeoutMs ?? CALL_TIMEOUT_MS, input: operation.input });
    if (result.error) throw new Error(result.error.message.includes("timed out") ? "GitHub call timed out" : "GitHub call failed");
    return result.stdout;
  }
  /**
   * The same two GETs as `pull_request_read` `get` then `get_check_runs`, one page only. A 404 on the pull
   * request is `out_of_scope` (nothing else is tried). The head must be exactly 40 hex characters.
   */
  async observePullRequest(input: { owner: string; repo: string; pr: number; perPage: number }): Promise<PullRequestObservation> {
    const [owner, repo] = ownerRepo(input as unknown as Record<string, unknown>);
    const pr = optionalNumber(input as unknown as Record<string, unknown>, "pr");
    if (!pr) return invalid("pr");
    const perPage = optionalNumber(input as unknown as Record<string, unknown>, "perPage", 100) ?? 100;
    const read = { timeout: this.options.timeoutMs ?? CALL_TIMEOUT_MS, maxBuffer: this.options.observeLimitBytes ?? OBSERVE_LIMIT_BYTES, whole: true };
    const failed = (result: { error: Error | null }): never => {
      const message = result.error?.message ?? "";
      if (message.includes("timed out")) throw new Error("GitHub call timed out");
      if (message.includes("maxBuffer")) throw new Error("GitHub returned invalid response: larger than the read limit");
      throw new Error("GitHub call failed");
    };
    const metadata = await this.execute(["api", "--hostname", "github.com", "--method", "GET", `repos/${owner}/${repo}/pulls/${pr}`], read);
    if (metadata.error) {
      if (!metadata.error.message.includes("timed out") && !metadata.error.message.includes("maxBuffer") && /Not Found|HTTP 404/.test(`${metadata.stdout}\n${metadata.stderr}`)) return { outcome: "out_of_scope" };
      return failed(metadata);
    }
    let sha: unknown;
    try { sha = (JSON.parse(metadata.stdout) as { head?: { sha?: unknown } }).head?.sha; } catch { /* rejected below */ }
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error("GitHub returned invalid pull request head SHA");
    const head = sha.toLowerCase();
    const runs = await this.execute(["api", "--hostname", "github.com", "--method", "GET", `repos/${owner}/${repo}/commits/${head}/check-runs`, "-f", `per_page=${perPage}`], read);
    if (runs.error) return failed(runs);
    let body: { total_count?: unknown; check_runs?: unknown };
    try { body = JSON.parse(runs.stdout) as typeof body; } catch { throw new Error("GitHub returned invalid check runs"); }
    if (!body || !Array.isArray(body.check_runs)) throw new Error("GitHub returned invalid check runs");
    const checkRuns = body.check_runs.map((run: Record<string, unknown>) => ({
      name: typeof run?.name === "string" ? run.name : "",
      status: typeof run?.status === "string" ? run.status : "",
      conclusion: typeof run?.conclusion === "string" ? run.conclusion : null,
      url: typeof run?.html_url === "string" ? run.html_url : null,
    }));
    const truncated = typeof body.total_count !== "number" || body.total_count > checkRuns.length;
    return { outcome: "read", observedHeadSha: head, checkRuns, truncated };
  }
  async status(): Promise<GithubStatus> {
    let version;
    try { version = await this.execute(["--version"], { timeout: STATUS_TIMEOUT_MS }); }
    catch { return { installed: false, loggedIn: false, detail: "GitHub CLI unavailable", inconclusive: true }; }
    if (version.error) {
      // Only "no such program" means gh is not installed; a gh that starts but fails is a failed check.
      const missing = (version.error as NodeJS.ErrnoException).code === "ENOENT";
      return missing
        ? { installed: false, loggedIn: false, detail: "GitHub CLI unavailable" }
        : { installed: false, loggedIn: false, detail: "GitHub CLI unavailable", inconclusive: true };
    }
    let auth;
    try {
      auth = await this.execute(["auth", "status", "--hostname", "github.com", "--json", "hostname,login,state,active", "--no-refresh"], { timeout: STATUS_TIMEOUT_MS });
    } catch { return { installed: true, loggedIn: false, detail: "GitHub CLI installed; login status unavailable", inconclusive: true }; }
    // gh exits non-zero both when nobody is signed in and when the query itself failed (an older gh
    // without --json, a timeout). Only JSON it printed or its own "not logged in" message is an answer.
    type AuthPayload = { hosts?: Record<string, Array<{ active?: boolean; state?: string }>> };
    let payload: AuthPayload | null = null;
    try {
      const parsed = JSON.parse(auth.stdout) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "hosts" in parsed) payload = parsed as AuthPayload;
    } catch { /* not JSON: decided below */ }
    if (payload) {
      const accounts = payload.hosts?.["github.com"] ?? [];
      const loggedIn = accounts.some((account) => account.active === true && (!account.state || account.state === "success"));
      return { installed: true, loggedIn, detail: loggedIn ? "GitHub CLI logged in to github.com" : "GitHub CLI installed; no active github.com login" };
    }
    if (auth.error && !auth.error.message.includes("timed out") && /not logged in/i.test(`${auth.stderr}\n${auth.stdout}`)) {
      return { installed: true, loggedIn: false, detail: "GitHub CLI installed; no active github.com login" };
    }
    return { installed: true, loggedIn: false, detail: "GitHub CLI installed; login status unavailable (upgrade gh)", inconclusive: true };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await Promise.allSettled([...this.pending]);
  }
}
