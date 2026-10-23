import { MAX_WP_TASKS, type WpTask } from "@nema/shared";

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const SPEC_HEADING = "## 已定的做法";
const MARKER = /\[(?:[RDTQSG]-[1-9]\d*|推断)\]/;
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+/;

export function checkSpec(md: string): { ok: true } | { ok: false; error: string } {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === SPEC_HEADING);
  if (start < 0) return { ok: false, error: "spec 缺少「## 已定的做法」一节" };
  const bad: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^## /.test(line)) break;
    if (LIST_ITEM.test(line) && !MARKER.test(line)) bad.push(line);
  }
  if (bad.length > 0) {
    return { ok: false, error: `以下做法缺少来源标记（[R-3] 等）或 [推断]：\n${bad.join("\n")}` };
  }
  return { ok: true };
}

type ParsedTask = Omit<WpTask, "status" | "inferred" | "reportMessageId" | "confirmedBy">;

export function parsePlan(md: string, repoLabels: string[]): Result<{ tasks: ParsedTask[] }> {
  const lines = md.split(/\r?\n/);
  const heads: { idx: number; n: number; title: string }[] = [];
  lines.forEach((line, idx) => {
    const m = /^###\s+任务\s*(\d+)\s*[：:]\s*(.+?)\s*$/.exec(line);
    if (m) heads.push({ idx, n: Number(m[1]), title: m[2]! });
  });
  if (heads.length > MAX_WP_TASKS) return { ok: false, error: "任务超过 15 个，请拆成多个开发包" };
  if (heads.length === 0) return { ok: false, error: "plan 中没有「### 任务 <n>：<标题>」" };
  const tasks: ParsedTask[] = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k]!;
    if (h.n !== k + 1) return { ok: false, error: `任务编号应为 ${k + 1}，实际为 ${h.n}（编号需从 1 连续递增）` };
    let end = lines.length;
    for (let i = h.idx + 1; i < lines.length; i++) {
      if (/^#{1,3} /.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const files: ParsedTask["files"] = [];
    let satisfies: string[] | null = null;
    for (const line of lines.slice(h.idx + 1, end)) {
      const f = /^\s*[-*]\s*(修改|新建)\s*[：:]\s*([^\s:：]+?)\s*:\s*(\S+)\s*$/.exec(line);
      if (f) {
        const repo = f[2]!;
        const path = f[3]!;
        if (!repoLabels.includes(repo)) return { ok: false, error: `任务 ${h.n}：未知仓库 ${repo}` };
        if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) {
          return { ok: false, error: `任务 ${h.n}：路径必须是相对路径且不含 ..：${path}` };
        }
        files.push({ op: f[1] === "修改" ? "modify" : "create", repo, path });
        continue;
      }
      const s = /^\s*[-*]\s*满足\s*[：:]\s*(.*)$/.exec(line);
      if (s) {
        const items = s[1]!.split(/[,，、\s]+/).filter(Boolean);
        const badItem = items.find((x) => !/^R-[1-9]\d*$/.test(x));
        if (items.length === 0 || badItem) {
          return { ok: false, error: `任务 ${h.n}：「满足」应为 R-n 列表${badItem ? `，无法识别 ${badItem}` : ""}` };
        }
        satisfies = items;
      }
    }
    if (!satisfies) return { ok: false, error: `任务 ${h.n}：缺少「- 满足：R-n」一行` };
    if (files.length === 0) return { ok: false, error: `任务 ${h.n}：缺少「- 修改：」或「- 新建：」文件行` };
    tasks.push({ n: h.n, title: h.title, satisfies, files });
  }
  return { ok: true, tasks };
}
