#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodeUtil from "node:util";
import { devComposeUpArgs } from "./compose-dev.mjs";
import { readReleaseTrio, assertReleaseTrio } from "./npm/check-tag.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = path.join(ROOT, "apps/cli/dist/index.js");
export const TEXT = {
  en: {
    title: "Nema Room setup",
    node: "Node.js 22 or newer is required.", missing: "Required tool unavailable:", docker: "Docker is not running or this user cannot access it.",
    config: "Existing .env will be preserved. Setup uses these host settings:", data: "Data directory", hub: "Hub URL", uid: "Container UID/GID", checkout: "Version built from this checkout",
    proceed: "Install dependencies, build the CLI, and build/start the Compose services?", stopped: "Cancelled. No installation changes were made.",
    env: "Created .env from .env.example.", install: "Installing dependencies and building the CLI…", services: "Building and starting PostgreSQL, hub, and web…",
    waiting: "Waiting for hub, web, and the shared daemon token…", timeout: "Services did not become ready. Check: docker compose logs --tail=100 hub web postgres",
    mode: "Model setup: 1) ChatGPT login  2) BYOK  3) Codex compatibility  4) Claude Code  5) Keep current / configure later",
    choose: "Choose 1–5", invalid: "Invalid choice.", model: "Model name (required)", base: "API base URL (Enter for https://api.openai.com/v1)",
    secret: "The next command reads a token from stdin. Use a private terminal; input may be visible. Paste one line and press Enter.",
    compat: "Compatibility mode uses a non-public backend and does not refresh Codex credentials. It may stop working or violate service terms.",
    claude: "First obtain a token with claude setup-token in another terminal, then return here.", readyToken: "Have the token ready?",
    later: "Services are running. Configure model access, run doctor, and start the daemon when ready.",
    probe: "Send a minimal model request to verify access? This consumes provider quota.", doctor: "Checking configuration and service access…",
    done: "Setup complete. Open http://localhost:3000. Containers remain running; stop them with npm run down.",
    start: "Start the daemon in this terminal now? Keep it open while using Nema Room.", manual: "Daemon command (run from any directory):",
    failed: "Setup failed. Existing data is not deleted and started containers are left running. Fix the error and rerun the wizard.",
    check: "Environment check passed. No files, credentials, packages, or containers were changed.", tty: "Interactive setup requires a terminal. Use --check for a read-only check.",
  },
  zh: {
    title: "Nema Room 安装向导",
    node: "需要 Node.js 22 或以上版本。", missing: "缺少必需工具：", docker: "Docker 未启动，或当前用户无权访问。",
    config: "已有 .env 会保留。向导将使用以下本机设置：", data: "数据目录", hub: "Hub 地址", uid: "容器 UID/GID", checkout: "本检出构建的版本",
    proceed: "安装依赖、构建 CLI 并构建/启动 Compose 服务？", stopped: "已取消，未执行安装变更。",
    env: "已从 .env.example 创建 .env。", install: "正在安装依赖并构建 CLI……", services: "正在构建并启动 PostgreSQL、hub 和 web……",
    waiting: "等待 hub、web 和共享 daemon token 就绪……", timeout: "服务未能就绪，请检查：docker compose logs --tail=100 hub web postgres",
    mode: "模型设置：1) ChatGPT 登录  2) BYOK  3) Codex 兼容登录  4) Claude Code  5) 保留当前配置 / 稍后配置",
    choose: "请选择 1–5", invalid: "无效选项。", model: "模型名称（必填）", base: "API 地址（回车使用 https://api.openai.com/v1）",
    secret: "接下来的命令从标准输入读取令牌。请在私人终端操作，输入可能回显；粘贴一行后按回车。",
    compat: "兼容模式使用非公开后端，不刷新 Codex 凭证，可能失效或违反服务条款。",
    claude: "请先在另一终端运行 claude setup-token 获取令牌，再回到这里。", readyToken: "已准备好令牌？",
    later: "服务已启动。准备好后配置模型，运行 doctor，再启动 daemon。",
    probe: "发送一次最小模型请求验证访问？这会消耗服务商额度。", doctor: "正在检查配置与服务连接……",
    done: "安装完成。打开 http://localhost:3000。容器会保持运行，使用 npm run down 停止。",
    start: "现在在此终端启动 daemon？使用期间请保持终端开启。", manual: "daemon 启动命令（可在任意目录执行）：",
    failed: "安装失败。已有数据未删除，已启动的容器保持运行。修正错误后可重新运行向导。",
    check: "环境检查通过。未修改文件、凭证、依赖或容器。", tty: "交互安装需要终端；只读检查请使用 --check。",
  },
  ja: {
    title: "Nema Room セットアップ",
    node: "Node.js 22 以上が必要です。", missing: "必要なツールがありません：", docker: "Docker が停止中、または現在のユーザーにアクセス権がありません。",
    config: "既存の .env は保持します。以下のホスト設定を使用します：", data: "データ保存先", hub: "Hub URL", uid: "コンテナ UID/GID", checkout: "このチェックアウトでビルドするバージョン",
    proceed: "依存関係と CLI をビルドし、Compose サービスをビルド・起動しますか？", stopped: "キャンセルしました。インストールによる変更はありません。",
    env: ".env.example から .env を作成しました。", install: "依存関係をインストールし、CLI をビルドしています…", services: "PostgreSQL、hub、web をビルド・起動しています…",
    waiting: "hub、web、共有 daemon token の準備を待っています…", timeout: "サービスが準備できません。確認：docker compose logs --tail=100 hub web postgres",
    mode: "モデル設定：1) ChatGPT ログイン  2) BYOK  3) Codex 互換  4) Claude Code  5) 現在の設定を保持 / 後で設定",
    choose: "1–5 を選択", invalid: "無効な選択です。", model: "モデル名（必須）", base: "API URL（Enter で https://api.openai.com/v1）",
    secret: "次のコマンドは標準入力からトークンを読みます。入力が表示される場合があるため、他人に見られない端末で一行貼り付けて Enter を押してください。",
    compat: "互換モードは非公開バックエンドを使い、Codex の認証情報を更新しません。停止や利用規約違反の可能性があります。",
    claude: "別の端末で claude setup-token を実行してトークンを取得し、ここに戻ってください。", readyToken: "トークンの準備はできましたか？",
    later: "サービスは起動済みです。モデル設定後に doctor と daemon を実行してください。",
    probe: "最小限のモデルリクエストで接続を確認しますか？利用枠を消費します。", doctor: "設定と接続を確認しています…",
    done: "セットアップ完了。http://localhost:3000 を開いてください。コンテナは起動したままです。停止は npm run down。",
    start: "この端末で daemon を起動しますか？利用中は端末を開いたままにしてください。", manual: "daemon 起動コマンド（どのディレクトリからでも実行可能）：",
    failed: "セットアップ失敗。既存データは削除せず、起動済みコンテナは残します。問題を修正して再実行してください。",
    check: "環境チェック完了。ファイル、認証情報、依存関係、コンテナは変更していません。", tty: "対話型セットアップには端末が必要です。読み取り専用の確認には --check を使用してください。",
  },
};

export function parseOptions(args, locale = process.env.LANG ?? "en") {
  const options = { lang: locale.startsWith("zh") ? "zh" : locale.startsWith("ja") ? "ja" : "en", check: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lang") {
      if (!Object.hasOwn(TEXT, args[++i])) throw new Error("--lang: en | zh | ja");
      options.lang = args[i];
    } else if (args[i] === "--check") options.check = true;
    else if (args[i] === "--help" || args[i] === "-h") options.help = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}

export function setupSettings(fileEnv, env = process.env, home = os.homedir()) {
  const value = key => env[key] ?? fileEnv[key];
  const raw = value("NEMA_DATA_HOST_DIR") || value("NEMA_DATA_DIR") || path.join(home, ".nema/data");
  if (/[\r\n$]/.test(raw)) throw new Error("NEMA_DATA_HOST_DIR: use a literal absolute path, without variables.");
  const dataDir = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(dataDir)) throw new Error("NEMA_DATA_HOST_DIR must be an absolute path.");
  const port = value("NEMA_HUB_PORT") || "4400";
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535 || [3000, 5433].includes(+port)) throw new Error("NEMA_HUB_PORT: invalid or conflicts with web/PostgreSQL.");
  const uid = value("NEMA_UID") || String(process.getuid?.() ?? 1000);
  const gid = value("NEMA_GID") || String(process.getgid?.() ?? 1000);
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) throw new Error("NEMA_UID / NEMA_GID must be numeric.");
  return { dataDir, port, uid, gid, hubUrl: `http://127.0.0.1:${port}`, tokenFile: path.join(dataDir, "daemon-token") };
}

async function ask(label, fallback = "") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback; }
  finally { rl.close(); }
}

const yes = async label => /^(y|yes)$/i.test(await ask(`${label} (y/N)`, "n"));
const quote = value => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;

// Current Node Windows shims assign `%~dp0\node_modules\npm\bin\npm-cli.js` without a quote before `%`.
const NPM_SHIM_ENTRY = /%(?:~dp0|dp0%)[\\/]([^"'%\r\n]+\.(?:[cm]?js))/i;

export function npmEntryFromShim(source) {
  return NPM_SHIM_ENTRY.exec(source)?.[1] ?? null;
}

export function npmCliBeside(dir) {
  const entry = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(entry) ? entry : null;
}

// npm.cmd cannot be execFile'd on Windows. Invoke its JS entry without a shell.
export function setupCommand(bin, args, env = process.env) {
  if (bin !== "npm" || process.platform !== "win32") return { bin, args };
  if (env.npm_execpath && /npm-cli\.js$/i.test(env.npm_execpath) && existsSync(env.npm_execpath)) return { bin: process.execPath, args: [env.npm_execpath, ...args] };
  const search = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const dir of [path.dirname(process.execPath), ...search.split(";")]) {
    const bundled = npmCliBeside(dir);
    if (bundled) return { bin: process.execPath, args: [bundled, ...args] };
    const shim = path.join(dir, "npm.cmd");
    if (!existsSync(shim)) continue;
    const rel = npmEntryFromShim(readFileSync(shim, "utf8"));
    if (!rel) continue;
    const entry = path.resolve(dir, rel);
    if (existsSync(entry)) return { bin: process.execPath, args: [entry, ...args] };
  }
  throw new Error("npm is missing. Install Node.js with npm, then reopen the terminal.");
}

function run(bin, args, env) {
  const command = setupCommand(bin, args, env);
  const result = spawnSync(command.bin, command.args, { cwd: ROOT, env, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(bin)} ${args.slice(0, 2).join(" ")} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
}

async function waitReady(settings, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(settings.tokenFile, constants.R_OK);
      const statuses = await Promise.all([`${settings.hubUrl}/api/daemon/status`, "http://127.0.0.1:3000"].map(async url => {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel();
        return res.ok;
      }));
      if (statuses.every(Boolean)) return true;
    } catch { /* Containers may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log("node scripts/setup.mjs [--lang en|zh|ja] [--check]\n--check: read-only prerequisites and configuration check; no installation.\nWindows / macOS / Linux: Node.js >= 22, npm, Git, Docker + Compose v2.");
    return;
  }
  const t = TEXT[options.lang];
  console.log(`\n${t.title}\n`);
  try {
    if (+process.versions.node.split(".")[0] < 22) throw new Error(t.node);
    for (const [bin, argv] of [["npm", ["--version"]], ["git", ["--version"]], ["docker", ["compose", "version"]]]) {
      const command = setupCommand(bin, argv);
      const result = spawnSync(command.bin, command.args, { stdio: "ignore", windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(`${t.missing} ${bin} ${argv.join(" ")}`);
      console.log(`✓ ${bin} ${argv.join(" ")}`);
    }
    if (spawnSync("docker", ["info"], { stdio: "ignore", windowsHide: true }).status !== 0) throw new Error(t.docker);
    let fileEnv = {};
    try { fileEnv = nodeUtil.parseEnv(await readFile(path.join(ROOT, ".env"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const settings = setupSettings(fileEnv);
    // A source checkout builds its own images; the trio must still agree. This key is reported,
    // never used to pick a version: NEMA_IMAGE_TAG in .env neither selects nor overrides it.
    const trio = await readReleaseTrio(ROOT);
    const { version: checkoutVersion } = assertReleaseTrio(`v${trio.cli}`, trio);
    console.log(`${t.config}\n${t.data}: ${settings.dataDir}\n${t.hub}: ${settings.hubUrl}\n${t.uid}: ${settings.uid}/${settings.gid}\n${t.checkout}: ${checkoutVersion}\n`);
    if (options.check) { console.log(t.check); return; }
    if (!process.stdin.isTTY) throw new Error(t.tty);
    if (!await yes(t.proceed)) { console.log(t.stopped); return; }
    try {
      await copyFile(path.join(ROOT, ".env.example"), path.join(ROOT, ".env"), constants.COPYFILE_EXCL);
      console.log(t.env);
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    const env = { ...process.env, NEMA_DATA_HOST_DIR: settings.dataDir, NEMA_DATA_DIR: settings.dataDir, NEMA_HUB_PORT: settings.port, NEMA_UID: settings.uid, NEMA_GID: settings.gid };
    const cli = args => run(process.execPath, [CLI, ...args], env);
    console.log(t.install);
    run("npm", ["ci"], env);
    run("npm", ["run", "build", "-w", "apps/cli"], env);
    await mkdir(settings.dataDir, { recursive: true, mode: 0o700 });
    console.log(t.services);
    run("docker", devComposeUpArgs(), env);
    console.log(t.waiting);
    if (!await waitReady(settings)) throw new Error(t.timeout);
    const connection = ["--hub", settings.hubUrl, "--token-file", settings.tokenFile];
    console.log(`${t.manual}\n${process.platform === "win32" ? "& " : ""}${[process.execPath, CLI, "daemon", ...connection].map(quote).join(" ")}`);
    console.log(t.mode);
    let mode;
    do { mode = await ask(t.choose, "5"); if (!/^[1-5]$/.test(mode)) console.log(t.invalid); } while (!/^[1-5]$/.test(mode));
    if (mode === "1") {
      cli(["config", "set", "adapter", "codex-direct"]);
      cli(["config", "set", "authMode", "siwc"]);
      cli(["auth", "login"]);
    } else if (mode === "2") {
      let model;
      do { model = await ask(t.model); } while (!model);
      const base = await ask(t.base, "https://api.openai.com/v1");
      cli(["config", "set", "adapter", "codex-direct"]);
      cli(["config", "set", "authMode", "byok"]);
      cli(["config", "set", "model", model]);
      cli(["config", "set", "byokBaseUrl", base]);
      console.log(t.secret);
      cli(["auth", "byok"]);
    } else if (mode === "3") {
      console.log(t.compat);
      if (!await yes(t.proceed)) return;
      cli(["config", "set", "adapter", "codex-direct"]);
      cli(["config", "set", "authMode", "compat"]);
      cli(["auth", "login"]);
    } else if (mode === "4") {
      console.log(t.claude);
      if (!await yes(t.readyToken)) { console.log(t.later); return; }
      cli(["config", "set", "adapter", "claude-code"]);
      console.log(t.secret);
      cli(["auth", "claude"]);
    }
    if (mode === "5") { console.log(t.later); return; }
    if (mode !== "4" && await yes(t.probe)) cli(["auth", "probe"]);
    console.log(t.doctor);
    cli(["doctor", ...connection]);
    console.log(t.done);
    if (await yes(t.start)) cli(["daemon", ...connection]);
  } catch (error) {
    console.error(error.message);
    if (!options.check) console.error(t.failed);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
