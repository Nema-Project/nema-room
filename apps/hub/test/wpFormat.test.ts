import { describe, expect, test } from "vitest";
import { checkSpec, parsePlan } from "../src/wpFormat.js";

const goodSpec = `# 规格

## 背景
- 随便写

## 已定的做法
- 用 Hono 提供接口 [D-1]
* 失败时返回 409 [R-3][T-2]
1. 超时 30 秒 [推断]

## 其他
- 无标记也可以
`;

describe("checkSpec", () => {
  test("passes a marked spec", () => {
    expect(checkSpec(goodSpec)).toEqual({ ok: true });
  });
  test("missing section", () => {
    const r = checkSpec("# x\n- a [R-1]\n");
    expect(r).toEqual({ ok: false, error: "spec 缺少「## 已定的做法」一节" });
  });
  test("lists unmarked lines only", () => {
    const r = checkSpec("## 已定的做法\n- 有 [R-1]\n- 没有来源\n- 也没有\n\n## 后面\n- 不检查\n");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("以下做法缺少来源标记（[R-3] 等）或 [推断]：\n- 没有来源\n- 也没有");
    }
  });
  test("accepts 推断", () => {
    expect(checkSpec("## 已定的做法\n- 猜的 [推断]\n")).toEqual({ ok: true });
  });
});

const task = (n: number, extra = "") =>
  `### 任务 ${n}：做第 ${n} 件事\n- 修改：api:src/a${n}.ts\n- 新建：web:src/b${n}.ts\n- 满足：R-3、R-5\n${extra}\n`;

describe("parsePlan", () => {
  const labels = ["api", "web"];
  test("parses two tasks", () => {
    const r = parsePlan(`# 计划\n\n${task(1)}${task(2)}`, labels);
    expect(r).toEqual({
      ok: true,
      tasks: [
        {
          n: 1,
          title: "做第 1 件事",
          satisfies: ["R-3", "R-5"],
          files: [
            { op: "modify", repo: "api", path: "src/a1.ts" },
            { op: "create", repo: "web", path: "src/b1.ts" },
          ],
        },
        {
          n: 2,
          title: "做第 2 件事",
          satisfies: ["R-3", "R-5"],
          files: [
            { op: "modify", repo: "api", path: "src/a2.ts" },
            { op: "create", repo: "web", path: "src/b2.ts" },
          ],
        },
      ],
    });
  });
  test("numbering gap", () => {
    const r = parsePlan(task(1) + task(3), labels);
    expect(r.ok).toBe(false);
  });
  test("numbering repeat", () => {
    expect(parsePlan(task(1) + task(1), labels).ok).toBe(false);
  });
  test("16 tasks", () => {
    const md = Array.from({ length: 16 }, (_, i) => task(i + 1)).join("");
    expect(parsePlan(md, labels)).toEqual({ ok: false, error: "任务超过 15 个，请拆成多个开发包" });
  });
  test("15 tasks ok", () => {
    const md = Array.from({ length: 15 }, (_, i) => task(i + 1)).join("");
    expect(parsePlan(md, labels).ok).toBe(true);
  });
  test("unknown repo label", () => {
    const r = parsePlan("### 任务 1：x\n- 修改：nope:src/a.ts\n- 满足：R-1\n", labels);
    expect(r).toEqual({ ok: false, error: "任务 1：未知仓库 nope" });
  });
  test("rejects .. and absolute paths", () => {
    expect(parsePlan("### 任务 1：x\n- 修改：api:../a.ts\n- 满足：R-1\n", labels).ok).toBe(false);
    expect(parsePlan("### 任务 1：x\n- 修改：api:/etc/a\n- 满足：R-1\n", labels).ok).toBe(false);
  });
  test("missing 满足 line", () => {
    const r = parsePlan("### 任务 1：x\n- 修改：api:src/a.ts\n", labels);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("任务 1");
  });
  test("missing file lines", () => {
    const r = parsePlan("### 任务 1：x\n- 满足：R-1\n", labels);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("任务 1");
  });
});
