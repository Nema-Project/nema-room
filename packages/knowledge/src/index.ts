export { KnowledgeStore, UpsertRejected, type CommitMeta, type UpsertGuard, type UpsertGuardContext } from "./store.js";
export { formatCommitMessage, parseCommitMessage, type CommitInfo, type CommitOp } from "./commitMessage.js";
export { RepoLockReentryError, git, withRepoLock } from "./git.js";
export { history, versionAt, blameParagraphs, type HistoryItem, type ParagraphBlame } from "./history.js";
