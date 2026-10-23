import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { protectPrivatePath } from "./secrets/permissions.js";

export const DEFAULT_BYOK_BASE_URL = "https://api.openai.com/v1";
const BYOK_BASE_URL_ERROR = "byokBaseUrl 只允许 https，或 http://127.0.0.1 与 http://localhost（可带端口）";

export function normalizeByokBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(BYOK_BASE_URL_ERROR);
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.username !== ""
    || url.password !== ""
    || raw.includes("?")
    || raw.includes("#")
    || raw !== raw.trim()
  ) {
    throw new Error(BYOK_BASE_URL_ERROR);
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

const ConfigSchema = z
  .object({
    adapter: z.enum(["codex-direct", "claude-code"]),
    model: z.string().min(1).optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]),
    authMode: z.enum(["siwc", "compat", "byok"]),
    byokBaseUrl: z.string().transform(normalizeByokBaseUrl).optional(),
  })
  .strict();

export type NemaConfig = z.infer<typeof ConfigSchema>;

/** The one default config: used by loadConfig and by the Runner when no config getter is given. */
export const DEFAULT_CONFIG: Readonly<NemaConfig> = Object.freeze({ adapter: "codex-direct", reasoningEffort: "medium", authMode: "siwc" });

/** A user-facing Chinese message for an unreadable config.json (bad JSON or schema), without zod/stack noise. */
export function configErrorMessage(e: unknown): string {
  let detail: string;
  if (e instanceof z.ZodError) detail = e.issues.map((i) => `${i.path.join(".") || "(根)"}：${i.message}`).join("；");
  else if (e instanceof SyntaxError) detail = `不是合法的 JSON（${e.message}）`;
  else detail = e instanceof Error ? e.message : String(e);
  return `配置文件 ~/.nema/config.json 无法读取：${detail}`;
}

const configFile = (nemaHome: string) => path.join(nemaHome, "config.json");

/**
 * `codex` / `codex-cli` are the retired CLI adapter. Loading them means "run codex-direct against the
 * existing Codex login file" (spec 6.7 §6, 2026-10-23). A stored authMode is replaced because the CLI
 * never used SIWC; it used ~/.codex/auth.json.
 */
function migrateRetiredCli(stored: Record<string, unknown>): Record<string, unknown> {
  if (stored.adapter !== "codex" && stored.adapter !== "codex-cli") return stored;
  return { ...stored, adapter: "codex-direct", authMode: "compat" };
}

export function loadConfig(nemaHome: string): NemaConfig {
  let raw: string;
  try {
    raw = readFileSync(configFile(nemaHome), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw e;
  }
  const stored = z.object({}).passthrough().parse(JSON.parse(raw)) as Record<string, unknown>;
  return ConfigSchema.parse({ ...DEFAULT_CONFIG, ...migrateRetiredCli(stored) });
}

export function saveConfig(nemaHome: string, patch: Partial<NemaConfig>): NemaConfig {
  const next = ConfigSchema.parse({ ...loadConfig(nemaHome), ...patch });
  mkdirSync(nemaHome, { recursive: true });
  protectPrivatePath(nemaHome, 0o700);
  const file = configFile(nemaHome);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  protectPrivatePath(tmp);
  renameSync(tmp, file);
  return next;
}
