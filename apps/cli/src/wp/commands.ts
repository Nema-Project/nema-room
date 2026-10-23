// `nema wp list` and `nema wp get`: a coding agent pulls an approved work package from the hub.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Out } from "../direct/authCommands.js";
import { repoInfo } from "../report/git.js";
import { getFromHub } from "../report/send.js";
import { ensureReportToken } from "../report/token.js";

export type WpRun = { nemaHome: string; hubUrl: string; cwd: string; out: Out };
export type WpGetRun = WpRun & { id: string; dir?: string; stdout?: boolean; force?: boolean };

type Fetched = { ok: true; json: unknown } | { ok: false; code: number };

async function fetchJson(o: WpRun, route: string): Promise<Fetched> {
  const info = await repoInfo(o.cwd);
  if (!info) {
    o.out.error("不在 git 仓库里");
    return { ok: false, code: 1 };
  }
  let token: string;
  try {
    token = ensureReportToken(o.nemaHome);
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return { ok: false, code: 1 };
  }
  const sep = route.includes("?") ? "&" : "?";
  const res = await getFromHub(o.hubUrl, `${route}${sep}gitCommonDir=${encodeURIComponent(info.gitCommonDir)}`, token);
  if (res.status === 0 || res.status >= 500) {
    o.out.error("Nema 暂时不可达");
    return { ok: false, code: 1 };
  }
  if (res.status === 204) {
    o.out.error("这个仓库没有绑定到 Nema 里任何未归档的 workspace");
    return { ok: false, code: 1 };
  }
  if (res.status >= 400) {
    let message = `Nema 拒绝了请求（HTTP ${res.status}）`;
    try {
      const v = JSON.parse(res.text) as { error?: unknown };
      if (typeof v.error === "string") message = v.error;
    } catch {
      /* plain text */
    }
    o.out.error(message);
    return { ok: false, code: 1 };
  }
  try {
    return { ok: true, json: JSON.parse(res.text) };
  } catch {
    o.out.error("Nema 返回了无法解析的内容");
    return { ok: false, code: 1 };
  }
}

export async function runWpList(o: WpRun): Promise<number> {
  const r = await fetchJson(o, "/report/workpackages");
  if (!r.ok) return r.code;
  const items = Array.isArray(r.json) ? (r.json as { id: string; title: string; tasks: number }[]) : [];
  if (items.length === 0) {
    o.out.log("当前仓库没有已批准的开发包");
    return 0;
  }
  for (const w of items) o.out.log(`${w.id}  ${w.title}  (${w.tasks} 个任务)`);
  return 0;
}

const reportBlock = (id: string): string =>
  `> 做完每个任务后运行：nema report --entries ${id} --task <n> --summary "…" --commits <sha,…> --files <path,…>\n\n`;

export async function runWpGet(o: WpGetRun): Promise<number> {
  if (!/^W-[1-9]\d*$/.test(o.id)) {
    o.out.error(`开发包编号应形如 W-2，实际为 ${o.id}`);
    return 1;
  }
  const r = await fetchJson(o, `/report/workpackages/${o.id}`);
  if (!r.ok) return r.code;
  const wp = r.json as { id: string; spec: string; plan: string };
  const plan = reportBlock(wp.id) + wp.plan;
  if (o.stdout) {
    o.out.log(`${wp.spec}\n\n${plan}`);
    return 0;
  }
  const base = path.join(path.resolve(o.cwd, o.dir ?? "."), ".nema", wp.id);
  const files = [
    { file: path.join(base, "spec.md"), content: wp.spec },
    { file: path.join(base, "plan.md"), content: plan },
  ];
  if (!o.force) {
    for (const f of files) {
      if (existsSync(f.file) && readFileSync(f.file, "utf8") !== f.content) {
        o.out.error(`${f.file} 已存在且内容不同；加 --force 覆盖`);
        return 1;
      }
    }
  }
  mkdirSync(base, { recursive: true });
  for (const f of files) writeFileSync(f.file, f.content);
  for (const f of files) o.out.log(`已写入 ${f.file}`);
  return 0;
}
