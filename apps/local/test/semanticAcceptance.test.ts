import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { classifyRunError, credentialPreflight, evaluateSemantic, type EntryView, type SemanticInput } from "../src/semanticAcceptance.js";

const snap = (head = "aaa"): SemanticInput["memo"]["before"] => ({ entries: [], head });

function decision(partial: Partial<EntryView> & Pick<EntryView, "id">): EntryView {
  return {
    kind: "decision",
    title: "Redis",
    status: "active",
    basis: "decided",
    related: [],
    sourceMessages: ["m-final"],
    quotes: [],
    body: "redis",
    ...partial,
  };
}

function golden(): SemanticInput {
  const redis = decision({ id: "D-1", sourceMessages: ["m-a"] });
  return {
    memo: { reply: "三点总结", before: snap(), after: snap() },
    design: {
      reply: "好，用 Redis",
      beforeCasual: snap(),
      afterCasual: snap(),
      traces: ["调用 open_thread"],
      threadOpenedBy: "agent",
      finalMessageInAgentThread: true,
      decisionsAdded: [decision({ id: "D-1" })],
      finalUserMessageId: "m-final",
    },
    brainstorm: { reply: "先记在讨论里", before: snap(), after: snap() },
    conflict: {
      redisId: "D-1",
      decisions: [redis],
      question: {
        id: "Q-1",
        kind: "question",
        title: "和 Redis 冲突",
        status: "open",
        basis: null,
        related: ["D-1"],
        sourceMessages: ["m-b"],
        quotes: [{ messageId: "m-b", text: "缓存用本地 LRU" }],
        body: "要改掉 Redis 吗？",
      },
      userMessageId: "m-b",
      userMessageText: "缓存用本地 LRU",
      agentAskedInThreadB: true,
    },
    override: {
      redisId: "D-1",
      overrideMessageId: "m-over",
      decisions: [
        decision({ id: "D-1", status: "superseded", sourceMessages: ["m-a"] }),
        decision({ id: "D-2", title: "本地 LRU", body: "use LRU", sourceMessages: ["m-over"], related: ["D-1"] }),
      ],
    },
  };
}

describe("thread semantic rubric", () => {
  test("a complete transcript passes", () => {
    const result = evaluateSemantic(golden());
    expect(result.ok, result.checks.filter((check) => !check.ok).map((check) => check.name).join(",")).toBe(true);
  });

  test("each acceptance miss fails its own check", () => {
    const cases: Array<[string, (input: SemanticInput) => void]> = [
      ["memo-reply", (input) => { input.memo.reply = "  "; }],
      ["memo-no-write", (input) => { input.memo.after.head = "bbb"; }],
      ["design-no-early-write", (input) => { input.design.afterCasual.entries = [decision({ id: "D-9" })]; }],
      ["design-open-thread", (input) => { input.design.traces = ["调用 list_entries"]; }],
      ["design-agent-opened", (input) => { input.design.threadOpenedBy = "user"; }],
      ["design-one-decided", (input) => { input.design.decisionsAdded[0]!.basis = "inferred"; }],
      ["brainstorm-no-write", (input) => { input.brainstorm.after.head = "ccc"; }],
      ["conflict-redis-only-active", (input) => { input.conflict.decisions.push(decision({ id: "D-8", title: "LRU" })); }],
      ["conflict-question", (input) => { input.conflict.question!.quotes[0]!.text = "差不多"; }],
      ["override-redis-superseded", (input) => { input.override.decisions[0]!.status = "active"; }],
    ];
    for (const [name, mutate] of cases) {
      const input = golden();
      mutate(input);
      const result = evaluateSemantic(input);
      expect(result.ok, name).toBe(false);
      expect(result.checks.find((check) => check.name === name)?.ok, name).toBe(false);
    }
  });
});

describe("credential preflight", () => {
  test("requires a regular credential file and rejects other adapters", () => {
    const dir = mkdtempSync(join(tmpdir(), "nema-preflight-"));
    try {
      expect(credentialPreflight({ adapter: "codex-direct", codexAuthFile: join(dir, "auth.json") }).ok).toBe(false);
      mkdirSync(join(dir, "auth.json"));
      expect(credentialPreflight({ adapter: "codex-direct", codexAuthFile: join(dir, "auth.json") }).ok).toBe(false);
      rmSync(join(dir, "auth.json"), { recursive: true });
      writeFileSync(join(dir, "auth.json"), "{}\n");
      expect(credentialPreflight({ adapter: "codex-direct", codexAuthFile: join(dir, "auth.json") })).toEqual({ ok: true, credentialSource: "codex-compat-auth-file" });
      writeFileSync(join(dir, "token"), "not-a-real-token\n");
      expect(credentialPreflight({ adapter: "claude-code", claudeTokenFile: join(dir, "token") })).toEqual({ ok: true, credentialSource: "claude-token-file" });
      expect(credentialPreflight({ adapter: "other" }).ok).toBe(false);
      try {
        symlinkSync(join(dir, "auth.json"), join(dir, "linked-auth.json"));
        expect(credentialPreflight({ adapter: "codex-direct", codexAuthFile: join(dir, "linked-auth.json") }).ok).toBe(false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run error class", () => {
  test("connection and login failures stay blocked", () => {
    expect(classifyRunError("模型接口错误：无法连接模型接口（EAI_AGAIN）")).toBe("blocked");
    expect(classifyRunError("未登录直连 Codex，请在终端运行 nema auth login")).toBe("blocked");
    expect(classifyRunError("acceptance turn timed out")).toBe("blocked");
    expect(classifyRunError("Agent 没有返回回复")).toBe("failed");
  });
});

describe("acceptance command without credentials", () => {
  test("exits blocked and does not score the rubric", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "nema-accept-"));
    const out = join(dir, "out.json");
    const run = spawnSync(process.execPath, [join(root, "scripts/acceptance/run-thread-semantic.mjs"), "--adapter", "codex-direct", "--out", out], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: join(dir, "codex") },
    });
    expect({ status: run.status, stderr: run.stderr, stdout: run.stdout }).toMatchObject({ status: 2 });
    const report = JSON.parse(readFileSync(out, "utf8")) as { status: string; semantic: string; blocker: string };
    expect(report.status).toBe("blocked");
    expect(report.semantic).toBe("not-run");
    expect(report.blocker).toMatch(/auth\.json/);
    rmSync(dir, { recursive: true, force: true });
  });
});
