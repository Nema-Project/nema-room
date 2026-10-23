import { configErrorMessage, loadConfig, saveConfig, type NemaConfig } from "./config.js";
import type { Out } from "./direct/authCommands.js";

// `nema config get|set` over ~/.nema/config.json. Only these keys exist; values are validated before anything is written.

export const CONFIG_KEYS = ["adapter", "model", "reasoningEffort", "authMode", "byokBaseUrl"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

const ENUMS: Partial<Record<ConfigKey, readonly string[]>> = {
  adapter: ["codex-direct", "claude-code"],
  reasoningEffort: ["low", "medium", "high"],
  authMode: ["siwc", "compat", "byok"],
};

const isKey = (k: string): k is ConfigKey => (CONFIG_KEYS as readonly string[]).includes(k);
const unknownKey = (k: string) => `未知配置项 ${JSON.stringify(k)}；可用：${CONFIG_KEYS.join("、")}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function configGet(o: { nemaHome: string; out: Out; key?: string }): number {
  if (o.key !== undefined && !isKey(o.key)) {
    o.out.error(unknownKey(o.key));
    return 1;
  }
  let config: NemaConfig;
  try {
    config = loadConfig(o.nemaHome);
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  if (o.key !== undefined) {
    o.out.log(String(config[o.key as ConfigKey] ?? ""));
    return 0;
  }
  for (const k of CONFIG_KEYS) o.out.log(`${k}=${config[k] ?? ""}`);
  return 0;
}

export function configSet(o: { nemaHome: string; out: Out; key: string; value: string }): number {
  if (!isKey(o.key)) {
    o.out.error(unknownKey(o.key));
    return 1;
  }
  if (o.key === "adapter" && (o.value === "codex-cli" || o.value === "codex")) {
    o.out.error("codex-cli 适配器已取消，本项目不再启动 Codex CLI。请保持 adapter=codex-direct，并用 nema config set authMode compat 读取已有的 Codex 登录。");
    return 1;
  }
  const allowed = ENUMS[o.key];
  if (allowed && !allowed.includes(o.value)) {
    o.out.error(`${o.key} 的值必须是 ${allowed.join(" | ")}（收到 ${JSON.stringify(o.value)}）`);
    return 1;
  }
  if (o.key === "model" && o.value.trim() === "") {
    o.out.error("model 不能为空");
    return 1;
  }
  try {
    loadConfig(o.nemaHome);
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  try {
    saveConfig(o.nemaHome, { [o.key]: o.value } as Partial<NemaConfig>);
  } catch (e) {
    o.out.error(`无法保存配置：${msg(e)}`);
    return 1;
  }
  o.out.log(`已设置 ${o.key}=${o.value}`);
  return 0;
}
