// `nema report hook` (called by a coding agent's Stop / SessionEnd hook) and `nema report` (called by the agent itself).
import { HookSignal, ReportInput } from "@nema/shared";
import type { Out } from "../direct/authCommands.js";
import { repoInfo } from "./git.js";
import { discoverDesktopOrigin } from "./desktop.js";
import { appendSpool, flushSpool, HOOK_TIMEOUTS, postToHub, sendToHub, type HubPath, type SendOpts, type SendResult } from "./send.js";
import { ensureReportToken } from "./token.js";

const STDIN_CAP = 1024 * 1024;
export const DEFAULT_HUB_URL = "http://127.0.0.1:4400";

/** `--hub`, else NEMA_HUB_URL, else the same default `nema daemon` uses. */
export function resolveHubUrl(flag?: string): string {
  return flag || process.env.NEMA_HUB_URL || DEFAULT_HUB_URL;
}

/**
 * Like `resolveHubUrl`, but when neither `--hub` nor NEMA_HUB_URL is given it first looks for a running desktop
 * instance whose identity it can verify. An explicit address always wins and is never probed.
 */
export async function resolveHubTarget(flag?: string, discover: () => Promise<string | null> = discoverDesktopOrigin): Promise<string> {
  if (flag || process.env.NEMA_HUB_URL) return resolveHubUrl(flag);
  return (await discover()) ?? DEFAULT_HUB_URL;
}

/** Reads stdin up to 1 MB; anything past the cap makes the input unusable (returns null). */
async function readCapped(stdin: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stdin) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += b.length;
    if (size > STDIN_CAP) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function replay(hubUrl: string, token: string, opts: SendOpts) {
  return (line: { path: HubPath; body: unknown }): Promise<SendResult> => sendToHub(hubUrl, line.path, token, line.body, opts);
}

export type HookRun = {
  agent: string;
  nemaHome: string;
  hubUrl: string;
  stdin: NodeJS.ReadableStream | null;
  sendOpts?: SendOpts;
};

/**
 * Always resolves 0 and never writes to stdout. Only `cwd` and `session_id` are taken from the agent's
 * payload; nothing else is kept or forwarded.
 */
export async function runReportHook(o: HookRun): Promise<number> {
  try {
    let cwd = process.cwd();
    let sessionId: string | null = null;
    const raw = o.stdin ? await readCapped(o.stdin) : null;
    if (raw) {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown> | null;
        if (payload && typeof payload === "object") {
          if (typeof payload.cwd === "string" && payload.cwd !== "") cwd = payload.cwd;
          if (typeof payload.session_id === "string" && payload.session_id.length <= 200) sessionId = payload.session_id;
        }
      } catch {
        /* not JSON: use process.cwd() */
      }
    }
    const info = await repoInfo(cwd);
    if (!info) return 0;
    const parsed = HookSignal.safeParse({ agent: o.agent, cwd, gitCommonDir: info.gitCommonDir, branch: info.branch, head: info.head, at: new Date().toISOString(), sessionId });
    if (!parsed.success) return 0;
    const signal = parsed.data;
    const token = ensureReportToken(o.nemaHome);
    const opts = o.sendOpts ?? HOOK_TIMEOUTS;
    const line = { path: "/report/hook" as const, body: signal, spooledAt: signal.at };
    // A spool still waiting means the hub is down: queue behind it to keep the order.
    if ((await flushSpool(o.nemaHome, replay(o.hubUrl, token, opts))) === "failed") {
      appendSpool(o.nemaHome, line);
      return 0;
    }
    if ((await sendToHub(o.hubUrl, "/report/hook", token, signal, opts)) === "failed") appendSpool(o.nemaHome, line);
  } catch {
    /* a hook never fails the agent */
  }
  return 0;
}

export type ReportFlags = {
  summary?: string;
  commits?: string;
  entries?: string;
  files?: string;
  task?: string;
  agent?: string;
  json?: boolean;
};

export type ReportRun = {
  nemaHome: string;
  hubUrl: string;
  cwd: string;
  out: Out;
  flags: ReportFlags;
  stdin?: NodeJS.ReadableStream;
  sendOpts?: SendOpts;
};

const list = (s: string | undefined): string[] | undefined =>
  s === undefined ? undefined : s.split(",").map((x) => x.trim()).filter((x) => x !== "");

function hubError(text: string, status: number): string {
  try {
    const v = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof v.error === "string") return v.error;
    if (typeof v.message === "string") return v.message;
  } catch {
    /* plain text */
  }
  return text.trim() || `Nema 拒绝了这次上报（HTTP ${status}）`;
}

export async function runReport(o: ReportRun): Promise<number> {
  const info = await repoInfo(o.cwd);
  if (!info) {
    o.out.error("不在 git 仓库里，无法上报");
    return 1;
  }
  let fromJson: Record<string, unknown> = {};
  if (o.flags.json) {
    const raw = o.stdin ? await readCapped(o.stdin) : null;
    try {
      const v: unknown = raw === null ? null : JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      fromJson = v as Record<string, unknown>;
    } catch {
      o.out.error("--json 需要从标准输入读取一个 JSON 对象（不超过 1 MB）");
      return 1;
    }
  }
  const parsed = ReportInput.safeParse({
    ...fromJson,
    agent: o.flags.agent ?? fromJson.agent ?? "coding-agent",
    gitCommonDir: info.gitCommonDir,
    ...(o.flags.summary !== undefined ? { summary: o.flags.summary } : {}),
    ...(o.flags.commits !== undefined ? { commits: list(o.flags.commits) } : {}),
    ...(o.flags.entries !== undefined ? { entries: list(o.flags.entries) } : {}),
    ...(o.flags.files !== undefined ? { files: list(o.flags.files) } : {}),
    ...(o.flags.task !== undefined ? { task: /^\d+$/.test(o.flags.task) ? Number(o.flags.task) : o.flags.task } : {}),
  });
  if (!parsed.success) {
    o.out.error(`上报内容不完整或格式不对：${parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}：${i.message}`).join("；")}`);
    return 1;
  }
  const report = parsed.data;
  let token: string;
  try {
    token = ensureReportToken(o.nemaHome);
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const opts = o.sendOpts ?? HOOK_TIMEOUTS;
  const line = { path: "/report" as const, body: report, spooledAt: new Date().toISOString() };
  const spool = (): number => {
    if (appendSpool(o.nemaHome, line)) {
      o.out.log("Nema 暂时不可达，已暂存，稍后补发");
      return 0;
    }
    o.out.error("Nema 暂时不可达，且本机暂存已满（5 MB），这次上报没有保存");
    return 1;
  };
  if ((await flushSpool(o.nemaHome, replay(o.hubUrl, token, opts))) === "failed") return spool();
  const res = await postToHub(o.hubUrl, "/report", token, report, opts);
  const result: SendResult = res.status === 0 || res.status >= 500 ? "failed" : res.status >= 400 ? "dropped" : "ok";
  if (result === "failed") return spool();
  if (result === "dropped") {
    o.out.error(hubError(res.text, res.status));
    return 1;
  }
  if (res.status === 204) {
    o.out.error("这个仓库没有绑定到 Nema 里任何未归档的 workspace，上报未被接收");
    return 1;
  }
  o.out.log("已上报到 Nema");
  return 0;
}
