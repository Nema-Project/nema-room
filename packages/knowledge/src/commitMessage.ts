export type CommitOp = "add" | "update" | "recover";

export type CommitInfo = {
  op: CommitOp;
  id: string;
  title: string;
  reason: string;
  sourceMessages: string[];
  author: "agent" | "user" | "system";
  taskId?: string;
  evidenceEventIds?: string[];
  uiAction?: "confirm" | "edit";
};

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

export function formatCommitMessage(m: CommitInfo): string {
  const lines = [
    `${m.op} ${m.id}: ${oneLine(m.title)}`,
    "",
    `Reason: ${oneLine(m.reason)}`,
    `Source-Messages: ${m.sourceMessages.join(",")}`,
    `Author: ${m.author}`,
  ];
  if (m.taskId !== undefined) lines.push(`Task: ${m.taskId}`);
  if (m.evidenceEventIds !== undefined) lines.push(`Evidence-Event: ${m.evidenceEventIds.join(",")}`);
  if (m.uiAction !== undefined) lines.push(`UI-Action: ${m.uiAction}`);
  return lines.join("\n");
}

export function parseCommitMessage(msg: string): CommitInfo {
  const lines = msg.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const head = /^(add|update|recover) ([A-Z]-[1-9]\d*): (.*)$/.exec(lines[0] ?? "");
  if (!head) throw new Error(`not a knowledge commit message: ${JSON.stringify(lines[0] ?? "")}`);
  const field = (name: string): string | undefined => {
    const prefix = `${name}: `;
    const line = lines.slice(2).find((l) => l.startsWith(prefix) || l === prefix.trimEnd());
    return line === undefined ? undefined : line.slice(prefix.length);
  };
  const reason = field("Reason");
  const sources = field("Source-Messages");
  const author = field("Author");
  if (reason === undefined || sources === undefined || (author !== "agent" && author !== "user" && author !== "system")) {
    throw new Error("malformed knowledge commit message");
  }
  const out: CommitInfo = {
    op: head[1] as CommitOp,
    id: head[2],
    title: head[3],
    reason,
    sourceMessages: sources === "" ? [] : sources.split(","),
    author,
  };
  const taskId = field("Task");
  if (taskId !== undefined) out.taskId = taskId;
  const evidenceEventIds = field("Evidence-Event");
  if (evidenceEventIds !== undefined) out.evidenceEventIds = evidenceEventIds === "" ? [] : evidenceEventIds.split(",");
  // Only the final server-appended trailer is provenance; embedded user text is not.
  const uiAction = /^UI-Action: (confirm|edit)$/.exec(lines.at(-1) ?? "");
  if (uiAction) out.uiAction = uiAction[1] as "confirm" | "edit";
  return out;
}
