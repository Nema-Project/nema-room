import { lstatSync } from "node:fs";

export type EntryView = {
  id: string;
  kind: string;
  title: string;
  status: string;
  basis: string | null;
  related: string[];
  sourceMessages: string[];
  quotes: { messageId: string; text: string }[];
  body: string;
};

export type KnowledgeSnap = { entries: EntryView[]; head: string };

export type SemanticInput = {
  memo: { reply: string; before: KnowledgeSnap; after: KnowledgeSnap };
  design: {
    reply: string;
    beforeCasual: KnowledgeSnap;
    afterCasual: KnowledgeSnap;
    traces: string[];
    threadOpenedBy: string | null;
    finalMessageInAgentThread: boolean;
    decisionsAdded: EntryView[];
    finalUserMessageId: string;
  };
  brainstorm: { reply: string; before: KnowledgeSnap; after: KnowledgeSnap };
  conflict: {
    redisId: string;
    decisions: EntryView[];
    question: EntryView | null;
    userMessageId: string;
    userMessageText: string;
    agentAskedInThreadB: boolean;
  };
  override: {
    redisId: string;
    decisions: EntryView[];
    overrideMessageId: string;
  };
};

export type Check = { name: string; ok: boolean; detail: string };

const stable = (entries: EntryView[]): string => JSON.stringify(entries.map((entry) => ({
  id: entry.id,
  kind: entry.kind,
  title: entry.title,
  status: entry.status,
  basis: entry.basis,
  body: entry.body,
  related: [...entry.related].sort(),
  sourceMessages: [...entry.sourceMessages].sort(),
  quotes: [...entry.quotes].map((quote) => ({ messageId: quote.messageId, text: quote.text }))
    .sort((a, b) => a.messageId.localeCompare(b.messageId) || a.text.localeCompare(b.text)),
})).sort((a, b) => a.id.localeCompare(b.id)));

function sameKnowledge(before: KnowledgeSnap, after: KnowledgeSnap): boolean {
  return stable(before.entries) === stable(after.entries) && before.head === after.head;
}

function activeDecisions(entries: EntryView[]): EntryView[] {
  return entries.filter((entry) => entry.kind === "decision" && entry.status === "active");
}

/** Scores a finished transcript. It does not talk to a model. */
export function evaluateSemantic(input: SemanticInput): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  check("memo-reply", input.memo.reply.trim() !== "", input.memo.reply.trim() ? "replied" : "empty reply");
  check("memo-no-write", sameKnowledge(input.memo.before, input.memo.after), "knowledge stays put");

  check("design-no-early-write", sameKnowledge(input.design.beforeCasual, input.design.afterCasual), "casual turns stay out of knowledge");
  check("design-open-thread", input.design.traces.some((text) => text.includes("open_thread")), input.design.traces.join(" | ") || "no tool trace");
  check("design-agent-opened", input.design.threadOpenedBy === "agent" && input.design.finalMessageInAgentThread, `opened by ${input.design.threadOpenedBy ?? "nobody"}`);
  const added = input.design.decisionsAdded;
  const decision = added.length === 1 ? added[0] : undefined;
  const oneDecided = decision !== undefined && decision.kind === "decision" && decision.basis === "decided" && decision.sourceMessages.includes(input.design.finalUserMessageId);
  check("design-one-decided", oneDecided, added.map((entry) => `${entry.id}:${entry.basis}`).join(",") || "no decision");
  check("design-reply", input.design.reply.trim() !== "", input.design.reply.trim() ? "replied" : "empty reply");

  check("brainstorm-reply", input.brainstorm.reply.trim() !== "", input.brainstorm.reply.trim() ? "replied" : "empty reply");
  check("brainstorm-no-write", sameKnowledge(input.brainstorm.before, input.brainstorm.after), "knowledge stays put");

  const active = activeDecisions(input.conflict.decisions);
  check("conflict-redis-only-active", input.conflict.redisId !== "" && active.length === 1 && active[0]?.id === input.conflict.redisId, active.map((entry) => entry.id).join(",") || "none");
  const question = input.conflict.question;
  const quoted = question?.quotes.some((quote) => quote.messageId === input.conflict.userMessageId && quote.text === input.conflict.userMessageText) ?? false;
  check(
    "conflict-question",
    input.conflict.agentAskedInThreadB && question !== null && question.related.includes(input.conflict.redisId) && quoted && question.sourceMessages.includes(input.conflict.userMessageId),
    question ? `${question.id} related=${question.related.join(",")}` : "no question",
  );

  const redis = input.override.decisions.find((entry) => entry.id === input.override.redisId);
  const stillActive = activeDecisions(input.override.decisions);
  const lru = stillActive.length === 1 ? stillActive[0] : undefined;
  const overridden = redis?.status === "superseded" && lru !== undefined && lru.id !== input.override.redisId && lru.basis === "decided" && /LRU/.test(`${lru.title}\n${lru.body}`) && lru.sourceMessages.includes(input.override.overrideMessageId);
  check("override-redis-superseded", overridden, `redis=${redis?.status ?? "missing"} active=${stillActive.map((entry) => entry.id).join(",") || "none"}`);

  return { ok: checks.every((item) => item.ok), checks };
}

function regularFile(file: string | undefined): boolean {
  if (!file) return false;
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Presence check only. Does not read credential bytes. */
export function credentialPreflight(input: { adapter: string; codexAuthFile?: string; claudeTokenFile?: string }): { ok: true; credentialSource: string } | { ok: false; blocker: string } {
  if (input.adapter === "codex-direct") {
    if (!regularFile(input.codexAuthFile)) return { ok: false, blocker: "Codex auth.json is missing or not a regular file" };
    return { ok: true, credentialSource: "codex-compat-auth-file" };
  }
  if (input.adapter === "claude-code") {
    if (!regularFile(input.claudeTokenFile)) return { ok: false, blocker: "Claude Code token file is missing or not a regular file" };
    return { ok: true, credentialSource: "claude-token-file" };
  }
  return { ok: false, blocker: `unsupported adapter: ${input.adapter}` };
}

/** A connection or login failure cannot be scored. Other task errors are semantic-run failures. */
export function classifyRunError(message: string): "blocked" | "failed" {
  if (/EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|fetch failed|无法连接|未登录|没有 Claude|登录失败|凭证|auth\.json|已过期|模型接口拒绝|timed out|timeout|超时/i.test(message)) return "blocked";
  return "failed";
}
