import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runWpGet, runWpList } from "../../src/wp/commands.js";
import { runReport } from "../../src/report/commands.js";
import { collectOut, fakeHub, makeRepo, tmp, type FakeHub } from "../report/helpers.js";

let hubs: FakeHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
});
const hub = async (status: number, reply: unknown) => {
  const h = await fakeHub();
  h.status = status;
  h.reply = JSON.stringify(reply);
  hubs.push(h);
  return h;
};
const WP = { id: "W-2", title: "包", spec: "# spec\n", plan: "### 任务 1：做事\n- 满足：R-1\n" };
const PREFIX = '> 做完每个任务后运行：nema report --entries W-2 --task <n> --summary "…" --commits <sha,…> --files <path,…>\n\n';

describe("nema wp", () => {
  test("get writes spec and plan with the report prefix", async () => {
    const h = await hub(200, WP);
    const repo = makeRepo();
    const c = collectOut();
    const code = await runWpGet({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: repo, out: c.out, id: "W-2" });
    expect(code).toBe(0);
    expect(h.received[0]!.path).toMatch(/^\/report\/workpackages\/W-2\?gitCommonDir=/);
    expect(readFileSync(path.join(repo, ".nema/W-2/spec.md"), "utf8")).toBe(WP.spec);
    expect(readFileSync(path.join(repo, ".nema/W-2/plan.md"), "utf8")).toBe(PREFIX + WP.plan);
    // same content again is fine
    expect(await runWpGet({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: repo, out: collectOut().out, id: "W-2" })).toBe(0);
  });

  test("get refuses to overwrite different content without --force", async () => {
    const h = await hub(200, WP);
    const repo = makeRepo();
    mkdirSync(path.join(repo, ".nema/W-2"), { recursive: true });
    const spec = path.join(repo, ".nema/W-2/spec.md");
    writeFileSync(spec, "我改过的\n");
    const c = collectOut();
    const home = tmp("nema-home-");
    expect(await runWpGet({ nemaHome: home, hubUrl: h.url, cwd: repo, out: c.out, id: "W-2" })).toBe(1);
    expect(c.errors).toEqual([`${spec} 已存在且内容不同；加 --force 覆盖`]);
    expect(readFileSync(spec, "utf8")).toBe("我改过的\n");
    expect(await runWpGet({ nemaHome: home, hubUrl: h.url, cwd: repo, out: collectOut().out, id: "W-2", force: true })).toBe(0);
    expect(readFileSync(spec, "utf8")).toBe(WP.spec);
  });

  test("--stdout prints without writing", async () => {
    const h = await hub(200, WP);
    const repo = makeRepo();
    const c = collectOut();
    expect(await runWpGet({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: repo, out: c.out, id: "W-2", stdout: true })).toBe(0);
    expect(c.logs.join("\n")).toContain(PREFIX + WP.plan);
    expect(c.logs.join("\n")).toContain("# spec");
    expect(existsSync(path.join(repo, ".nema"))).toBe(false);
  });

  test("get outside a repo exits 1", async () => {
    const h = await hub(200, WP);
    const c = collectOut();
    expect(await runWpGet({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: tmp("nema-norepo-"), out: c.out, id: "W-2" })).toBe(1);
    expect(c.errors).toEqual(["不在 git 仓库里"]);
  });

  test("a 404 from the hub is reported", async () => {
    const h = await hub(404, { error: "没有可取的开发包 W-9" });
    const c = collectOut();
    expect(await runWpGet({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: makeRepo(), out: c.out, id: "W-9" })).toBe(1);
    expect(c.errors).toEqual(["没有可取的开发包 W-9"]);
  });

  test("list prints the empty message", async () => {
    const h = await hub(200, []);
    const c = collectOut();
    expect(await runWpList({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: makeRepo(), out: c.out })).toBe(0);
    expect(c.logs).toEqual(["当前仓库没有已批准的开发包"]);
  });

  test("list prints one line per package", async () => {
    const h = await hub(200, [{ id: "W-2", title: "包", tasks: 3 }]);
    const c = collectOut();
    await runWpList({ nemaHome: tmp("nema-home-"), hubUrl: h.url, cwd: makeRepo(), out: c.out });
    expect(c.logs).toEqual(["W-2  包  (3 个任务)"]);
  });

  test("report --task is sent as a number", async () => {
    const h = await hub(202, {});
    const code = await runReport({
      nemaHome: tmp("nema-home-"),
      hubUrl: h.url,
      cwd: makeRepo(),
      out: collectOut().out,
      flags: { summary: "done", commits: "abcdef1", entries: "W-2", task: "3" },
    });
    expect(code).toBe(0);
    expect((h.received[0]!.body as { task: number }).task).toBe(3);
  });
});
