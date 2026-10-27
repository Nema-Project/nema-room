import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { acceptanceWorkspacePlan, activeRedisDecisionId, BRAINSTORM_CLOSING, classifyRunError, credentialPreflight, evaluateSemantic, type EntryView, type SemanticInput } from "../src/semanticAcceptance.js";

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
      anchorMessageId: "m-casual",
      threads: [{ id: "m-casual", openedBy: "agent" }],
      firstTurnChanges: [{ entry: "R-1", kind: "requirement", op: "add" }],
      secondTurnChanges: [],
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
      ["design-no-early-write", (input) => { input.design.firstTurnChanges = [{ entry: "D-9", kind: "decision", op: "add" }]; }],
      ["design-open-thread", (input) => { input.design.threads = [{ id: "m-casual", openedBy: "grill" }]; }],
      ["design-agent-opened", (input) => { input.design.finalMessageInAgentThread = false; }],
      ["design-one-decided", (input) => { input.design.decisionsAdded[0]!.basis = "inferred"; }],
      ["brainstorm-no-write", (input) => { input.brainstorm.after.head = "ccc"; }],
      ["conflict-redis-only-active", (input) => { input.conflict.decisions.push(decision({ id: "D-8", title: "LRU" })); }],
      ["conflict-question", (input) => { input.conflict.question!.quotes[0]!.text = "差不多"; }],
      ["override-redis-superseded", (input) => { input.override.decisions[1]!.related = []; }],
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
  test("connection and login failures stay blocked before a turn starts", () => {
    expect(classifyRunError("模型接口错误：无法连接模型接口（EAI_AGAIN）", "startup")).toBe("blocked");
    expect(classifyRunError("未登录直连 Codex，请在终端运行 nema auth login", "startup")).toBe("blocked");
    expect(classifyRunError("acceptance turn timed out", "startup")).toBe("blocked");
    expect(classifyRunError("daemon did not connect", "startup")).toBe("blocked");
    expect(classifyRunError("Agent 没有返回回复", "turn")).toBe("failed");
  });

  test("timeout and credential text after a turn starts are failures, and a missing room tool surface stays blocked", () => {
    expect(classifyRunError("acceptance turn timed out", "turn")).toBe("failed");
    expect(classifyRunError("凭证 auth.json", "turn")).toBe("failed");
    expect(classifyRunError("Claude 的工具面无法确认为只有 Room：{}", "turn")).toBe("blocked");
  });
});

describe("acceptance workspace plan", () => {
  test("memo, design, brainstorm, and conflict are separate, and override reuses conflict", () => {
    const plan = acceptanceWorkspacePlan();
    expect(plan).toEqual({ memo: "memo", design: "design", brainstorm: "brainstorm", conflict: "conflict", override: "conflict" });
    expect(new Set([plan.memo, plan.design, plan.brainstorm, plan.conflict]).size).toBe(4);
  });

  test("the Redis id is the single active decision that matches Redis", () => {
    expect(activeRedisDecisionId([decision({ id: "D-1", title: "缓存用 Redis", body: "缓存用 Redis" })])).toBe("D-1");
    expect(activeRedisDecisionId([
      decision({ id: "D-1", title: "缓存用 Redis" }),
      decision({ id: "D-2", title: "also Redis" }),
    ])).toBe("");
    expect(activeRedisDecisionId([decision({ id: "D-1", title: "缓存用 Redis", status: "superseded" })])).toBe("");
  });
});

describe("amended rubric clauses", () => {
  test("the brainstorm closing line does not ask to record the ideas", () => {
    expect(BRAINSTORM_CLOSING).toBe("这些先留在讨论里，暂不记录，之后再决定。");
    expect(BRAINSTORM_CLOSING).not.toContain("记在");
  });

  test("a grill thread is recorded and does not count as agent-opened", () => {
    const input = golden();
    input.design.threads = [{ id: "m-other", openedBy: "grill" }];
    input.design.finalMessageInAgentThread = false;
    const result = evaluateSemantic(input);
    const open = result.checks.find((check) => check.name === "design-open-thread");
    const agent = result.checks.find((check) => check.name === "design-agent-opened");
    expect(open?.ok).toBe(false);
    expect(open?.detail).toContain("grill");
    expect(agent?.ok).toBe(false);
    expect(agent?.detail).toContain("grill");
  });

  test("the first design turn may add a requirement and must not add a decision or question", () => {
    const added = evaluateSemantic(golden());
    expect(added.checks.find((check) => check.name === "design-no-early-write")?.detail).toContain("add R-1 requirement");
    const question = golden();
    question.design.firstTurnChanges = [{ entry: "Q-1", kind: "question", op: "add" }];
    expect(evaluateSemantic(question).checks.find((check) => check.name === "design-no-early-write")?.ok).toBe(false);
    const second = golden();
    second.design.secondTurnChanges = [{ entry: "R-2", kind: "requirement", op: "add" }];
    const secondCheck = evaluateSemantic(second).checks.find((check) => check.name === "design-no-early-write");
    expect(secondCheck?.ok).toBe(false);
    expect(secondCheck?.detail).toContain("add R-2 requirement");
  });

  test("a decided entry must stay active, and the override must link Redis", () => {
    const inactive = golden();
    inactive.design.decisionsAdded[0]!.status = "superseded";
    expect(evaluateSemantic(inactive).checks.find((check) => check.name === "design-one-decided")?.ok).toBe(false);
    const unlinked = golden();
    unlinked.override.decisions[1]!.related = [];
    const override = evaluateSemantic(unlinked).checks.find((check) => check.name === "override-redis-superseded");
    expect(override?.ok).toBe(false);
    expect(override?.detail).toContain("D-2");
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
