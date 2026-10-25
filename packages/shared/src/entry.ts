import { z } from "zod";
import { Implementation } from "./report.js";

export const ENTRY_KINDS = ["requirement", "decision", "tradeoff", "question", "source", "diagram", "workpackage"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const EntryKindSchema = z.enum(ENTRY_KINDS);

export const BASIS_VALUES = ["stated", "decided", "inferred"] as const;
export type Basis = (typeof BASIS_VALUES)[number];
const BasisSchema = z.enum(BASIS_VALUES);

export const Quote = z.object({ messageId: z.string().min(1), text: z.string().min(1).max(500) });
export type Quote = z.infer<typeof Quote>;

/** Every diagram type the vendored archify renders without extra runtime (`explainer` is not a diagram). */
export const DIAGRAM_TYPES = [
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle",
  "erd",
  "class",
  "tree",
  "timeline",
  "waterfall",
] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export function isDiagramType(value: unknown): value is DiagramType {
  return typeof value === "string" && (DIAGRAM_TYPES as readonly string[]).includes(value);
}

/** What a `diagram` entry records about the code it was drawn from. */
export const DiagramMeta = z.object({
  repoId: z.string().min(1),
  type: z.enum(DIAGRAM_TYPES),
  /** repo id -> main sha the diagram was drawn at. */
  sourceCommits: z.record(z.string(), z.string()),
  /** archify node id -> repo-relative paths that node stands for. */
  nodePaths: z.record(z.string(), z.array(z.string())),
});
export type DiagramMeta = z.infer<typeof DiagramMeta>;

export const MAX_WP_TASKS = 15;

export const WpTask = z.object({
  n: z.number().int().min(1).max(MAX_WP_TASKS),
  title: z.string(),
  satisfies: z.array(z.string()),
  files: z.array(z.object({ op: z.enum(["modify", "create"]), repo: z.string(), path: z.string() })),
  status: z.enum(["pending", "reported", "verified", "mismatch"]),
  inferred: z.boolean(),
  reportMessageId: z.string().nullable(),
  confirmedBy: z.literal("user").nullable(),
});
export type WpTask = z.infer<typeof WpTask>;

/** What a `workpackage` entry records about its plan. `repos` holds repo ids; `blockedOn` a question id. */
export const WorkPackageMeta = z.object({
  requirements: z.array(z.string()),
  repos: z.array(z.string()),
  approvedAt: z.string().nullable(),
  approvedCommit: z.string().nullable(),
  blockedOn: z.string().nullable(),
  tasks: z.array(WpTask),
});
export type WorkPackageMeta = z.infer<typeof WorkPackageMeta>;

const IsoDateTime = z.iso.datetime({ offset: true }).nullable();

export const KIND_DIR = {
  requirement: "requirements",
  decision: "decisions",
  tradeoff: "tradeoffs",
  question: "questions",
  source: "sources",
  diagram: "diagrams",
  workpackage: "workpackages",
} as const satisfies Record<EntryKind, string>;

export const KIND_PREFIX = {
  requirement: "R",
  decision: "D",
  tradeoff: "T",
  question: "Q",
  source: "S",
  diagram: "G",
  workpackage: "W",
} as const satisfies Record<EntryKind, string>;

const PREFIX_KIND: Record<string, EntryKind> = {
  R: "requirement",
  D: "decision",
  T: "tradeoff",
  Q: "question",
  S: "source",
  G: "diagram",
  W: "workpackage",
};

const ID_RE = /^(R|D|T|Q|S|G|W)-[1-9]\d*$/;

export function kindFromId(id: string): EntryKind | null {
  if (!ID_RE.test(id)) return null;
  return PREFIX_KIND[id[0]] ?? null;
}

export function idNumber(id: string): number {
  return Number(id.slice(id.indexOf("-") + 1));
}

export const KIND_STATUSES = {
  requirement: ["active", "superseded", "dropped"],
  decision: ["active", "superseded", "dropped"],
  tradeoff: ["active", "dropped"],
  question: ["open", "resolved", "dropped"],
  source: ["active", "dropped"],
  diagram: ["active", "superseded", "dropped"],
  workpackage: ["draft", "approved", "in_progress", "done", "dropped"],
} as const satisfies Record<EntryKind, readonly string[]>;

export const ALL_STATUSES = ["active", "superseded", "dropped", "open", "resolved", "draft", "approved", "in_progress", "done"] as const;
export type EntryStatus = (typeof ALL_STATUSES)[number];
const StatusSchema = z.enum(ALL_STATUSES);

export const INACTIVE_STATUSES = ["superseded", "dropped", "resolved"] as const;

const BusinessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

const HttpUrl = z.string().refine((s) => {
  try {
    const p = new URL(s).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}, "url must be http or https");

const Priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** Kind-specific rules shared by frontmatter and upsert input. */
function refineKind(
  v: { kind: EntryKind; status?: string | undefined; url?: string | undefined; priority?: number | undefined; diagram?: DiagramMeta | undefined; implementation?: Implementation | undefined; workpackage?: WorkPackageMeta | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.status !== undefined && !(KIND_STATUSES[v.kind] as readonly string[]).includes(v.status)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: `invalid status "${v.status}" for ${v.kind}` });
  }
  if (v.kind === "source") {
    if (v.url === undefined) ctx.addIssue({ code: "custom", path: ["url"], message: "url is required for source" });
  } else if (v.url !== undefined) {
    ctx.addIssue({ code: "custom", path: ["url"], message: "url is only allowed for source" });
  }
  if (v.kind === "diagram") {
    if (v.diagram === undefined) ctx.addIssue({ code: "custom", path: ["diagram"], message: "diagram is required for diagram" });
  } else if (v.diagram !== undefined) {
    ctx.addIssue({ code: "custom", path: ["diagram"], message: "diagram is only allowed for diagram" });
  }
  if (v.kind === "workpackage") {
    if (v.workpackage === undefined) ctx.addIssue({ code: "custom", path: ["workpackage"], message: "workpackage is required for workpackage" });
  } else if (v.workpackage !== undefined) {
    ctx.addIssue({ code: "custom", path: ["workpackage"], message: "workpackage is only allowed for workpackage" });
  }
  if (v.kind !== "requirement" && v.implementation !== undefined) {
    ctx.addIssue({ code: "custom", path: ["implementation"], message: "implementation is only allowed for requirement" });
  }
  if (v.kind === "question") {
    if (v.priority === undefined) ctx.addIssue({ code: "custom", path: ["priority"], message: "priority is required for question" });
  } else if (v.priority !== undefined) {
    ctx.addIssue({ code: "custom", path: ["priority"], message: "priority is only allowed for question" });
  }
}

export const EntryFrontmatter = z
  .object({
    id: z.string().regex(ID_RE),
    kind: EntryKindSchema,
    title: z.string().min(1).max(200),
    status: StatusSchema,
    businessDate: BusinessDate,
    related: z.array(z.string()),
    sourceMessages: z.array(z.string()),
    url: HttpUrl.optional(),
    priority: Priority.optional(),
    diagram: DiagramMeta.optional(),
    implementation: Implementation.optional(),
    workpackage: WorkPackageMeta.optional(),
    basis: BasisSchema.nullable(),
    ingestedAt: IsoDateTime,
    confirmedAt: IsoDateTime,
    quotes: z.array(Quote),
  })
  .superRefine((v, ctx) => {
    refineKind(v, ctx);
    if (kindFromId(v.id) !== v.kind) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id prefix does not match kind" });
    }
  });
export type EntryFrontmatter = z.infer<typeof EntryFrontmatter>;

export type Entry = EntryFrontmatter & { body: string };
export type EntrySummary = Pick<Entry, "id" | "kind" | "title" | "status" | "businessDate" | "priority" | "url" | "related" | "basis" | "confirmedAt"> & {
  /** Diagrams only: which repo it draws and what kind of diagram it is. */
  diagram?: Pick<DiagramMeta, "repoId" | "type">;
  /** Diagrams only, filled in by the hub: main moved under one of its node paths since it was drawn. */
  stale?: boolean;
  /** Requirements only: the implementation status and its evidence. */
  implementation?: Implementation;
  /** Work packages only: the question it waits on, and how many tasks its plan has. */
  workpackage?: { blockedOn: string | null; taskCount: number };
};

export const STALE_SOURCE_DAYS = 90;

export function isStale(e: Pick<EntrySummary, "kind" | "confirmedAt">, now: Date): boolean {
  return e.kind === "source" && e.confirmedAt !== null && now.getTime() - Date.parse(e.confirmedAt) > STALE_SOURCE_DAYS * 86_400_000;
}

export const UpsertEntryInput = z
  .object({
    id: z.string().regex(ID_RE).optional(),
    kind: EntryKindSchema,
    title: z.string().min(1).max(200),
    body: z.string(),
    status: StatusSchema.optional(),
    businessDate: BusinessDate.optional(),
    related: z.array(z.string()).optional(),
    sourceMessages: z.array(z.string()).default([]),
    url: HttpUrl.optional(),
    priority: Priority.optional(),
    /** Requirements only. The Room API checks it against reports; omitted keeps the stored one. */
    implementation: Implementation.optional(),
    basis: BasisSchema.optional(),
    quotes: z.array(Quote).max(10).optional(),
    confirmed: z.boolean().optional(),
    reason: z.string().min(1).max(500),
  })
  .superRefine((v, ctx) => {
    refineKind(v, ctx);
    if (v.id !== undefined && kindFromId(v.id) !== v.kind) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id prefix does not match kind" });
    }
  });
export type UpsertEntryInput = z.infer<typeof UpsertEntryInput>;
