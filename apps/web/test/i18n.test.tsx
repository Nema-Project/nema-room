import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, detectLocale, useLocale, useT } from "@/lib/i18n";

function Probe() {
  const t = useT();
  const [locale, setLocale] = useLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="a">{t("a")}</span>
      <span data-testid="b">{t("b", { n: 3 })}</span>
      <span data-testid="c">{t("missing.key")}</span>
      <button onClick={() => setLocale("zh")}>zh</button>
    </div>
  );
}

const messages = { en: { a: "A-en", b: "B-en {n}" }, ja: { a: "A-ja" }, zh: { a: "A-zh", b: "B-zh {n}" } };

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("detectLocale", () => {
  it("maps languages", () => {
    expect(detectLocale(["ja-JP", "en"])).toBe("ja");
    expect(detectLocale(["zh-TW"])).toBe("zh");
    expect(detectLocale(["fr"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});

describe("I18nProvider", () => {
  it("falls back to en for keys missing in the active locale, then to the key", async () => {
    localStorage.setItem("nema.locale", "ja");
    render(
      <I18nProvider messages={messages}>
        <Probe />
      </I18nProvider>,
    );
    expect(await screen.findByText("A-ja")).toBeTruthy();
    expect(screen.getByTestId("b").textContent).toBe("B-en 3");
    expect(screen.getByTestId("c").textContent).toBe("missing.key");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("persists the chosen locale and updates <html lang>", async () => {
    render(
      <I18nProvider messages={messages}>
        <Probe />
      </I18nProvider>,
    );
    await act(async () => screen.getByText("zh").click());
    expect(localStorage.getItem("nema.locale")).toBe("zh");
    expect(screen.getByTestId("locale").textContent).toBe("zh");
    expect(document.documentElement.lang).toBe("zh");
  });

  it("ignores an invalid stored locale", async () => {
    localStorage.setItem("nema.locale", "xx");
    render(
      <I18nProvider messages={messages}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("locale").textContent).toBe("en");
  });
});

describe("message files", () => {
  const load = (l: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../messages/${l}.json`), "utf8")) as Record<string, string>;
  const exact: Record<string, { zh: string; ja: string; en: string }> = {
    "basis.stated": { zh: "用户说过", ja: "発言あり", en: "Stated" },
    "basis.decided": { zh: "用户决定", ja: "決定済み", en: "Decided" },
    "basis.inferred": { zh: "推断", ja: "推測", en: "Inferred" },
    "know.stale": { zh: "可能过时", ja: "古い可能性", en: "May be outdated" },
    "detail.basis": { zh: "依据", ja: "根拠", en: "Basis" },
    "detail.ingestedAt": { zh: "进库时间", ja: "登録日時", en: "Added" },
    "detail.confirmedAt": { zh: "最后确认", ja: "最終確認", en: "Last confirmed" },
    "detail.confirm": { zh: "确认仍有效", ja: "有効と確認", en: "Confirm still valid" },
    "detail.quotes": { zh: "原文摘录", ja: "原文の抜粋", en: "Quotes" },
    "author.system": { zh: "系统", ja: "システム", en: "System" },
  };
  it("have identical key sets", () => {
    const en = load("en");
    const ja = load("ja");
    const zh = load("zh");
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(exact)) {
      expect(en[key]).toBe(value.en);
      expect(ja[key]).toBe(value.ja);
      expect(zh[key]).toBe(value.zh);
    }
  });

  it("every new key exists in ja, en and zh", () => {
    const en = load("en");
    const ja = load("ja");
    const zh = load("zh");
    const keys: Record<string, { zh: string; ja: string; en: string }> = {
      "know.workpackages": { zh: "开发包", ja: "開発パッケージ", en: "Work packages" },
      "wp.generate": { zh: "生成开发包", ja: "開発パッケージを作成", en: "Generate work package" },
      "wp.select": { zh: "选择需求", ja: "要件を選択", en: "Select requirements" },
      "wp.generateSelected": { zh: "为所选需求生成开发包", ja: "選択した要件で作成", en: "Generate for selected" },
      "wp.blocked": { zh: "待澄清", ja: "確認待ち", en: "Needs answers" },
      "wp.status.draft": { zh: "草稿", ja: "下書き", en: "Draft" },
      "wp.status.approved": { zh: "已批准", ja: "承認済み", en: "Approved" },
      "wp.status.in_progress": { zh: "进行中", ja: "進行中", en: "In progress" },
      "wp.status.done": { zh: "已完成", ja: "完了", en: "Done" },
      "wp.status.dropped": { zh: "已放弃", ja: "中止", en: "Dropped" },
      "wp.tab.overview": { zh: "概览", ja: "概要", en: "Overview" },
      "wp.tab.spec": { zh: "Spec", ja: "Spec", en: "Spec" },
      "wp.tab.plan": { zh: "Plan", ja: "Plan", en: "Plan" },
      "wp.tab.history": { zh: "历史", ja: "履歴", en: "History" },
      "wp.approve": { zh: "批准", ja: "承認", en: "Approve" },
      "wp.regenerate": { zh: "重新生成", ja: "再生成", en: "Regenerate" },
      "wp.drop": { zh: "放弃", ja: "中止", en: "Drop" },
      "wp.edit": { zh: "编辑", ja: "編集", en: "Edit" },
      "wp.save": { zh: "保存", ja: "保存", en: "Save" },
      "grill.strict": { zh: "严格：影响实现的问题都先问", ja: "厳格：実装に影響する点はすべて先に確認", en: "Strict: ask everything that affects implementation" },
      "grill.lenient": { zh: "宽松：只在决策冲突时停下", ja: "緩め：決定が矛盾するときだけ止まる", en: "Lenient: stop only on conflicting decisions" },
      "grill.extraRules": { zh: "补充追问规则", ja: "追加の確認ルール", en: "Extra questioning rules" },
      "sidebar.appSettings": { zh: "应用设置", ja: "アプリ設定", en: "App settings" },
      "appSettings.title": { zh: "应用设置", ja: "アプリ設定", en: "App settings" },
      "appSettings.back": { zh: "返回对话", ja: "会話に戻る", en: "Back to conversation" },
      "appSettings.tabs": { zh: "设置分类", ja: "設定の項目", en: "Settings sections" },
      "appSettings.tab.model": { zh: "模型", ja: "モデル", en: "Model" },
      "appSettings.tab.plugins": { zh: "插件", ja: "プラグイン", en: "Plugins" },
      "appSettings.tab.general": { zh: "通用", ja: "一般", en: "General" },
      "appSettings.tab.about": { zh: "关于", ja: "情報", en: "About" },
      "appSettings.loginItem": { zh: "开机自启动", ja: "ログイン時に起動", en: "Open at login" },
      "appSettings.loginItemHelp": {
        zh: "登录这台电脑时打开 Nema Room。",
        ja: "このコンピューターへのログイン時に Nema Room を開きます。",
        en: "Open Nema Room when you sign in on this computer.",
      },
      "appSettings.loginItemUnavailable": {
        zh: "开机自启动只在桌面应用里可用。这个浏览器会话不能修改它。",
        ja: "ログイン時の起動はデスクトップアプリだけで使えます。このブラウザーセッションでは変更できません。",
        en: "Open at login is available in the desktop app. This browser session cannot change it.",
      },
      "appSettings.loginItemError": {
        zh: "开机自启动没有保存成功。",
        ja: "ログイン時の起動設定を保存できませんでした。",
        en: "The login setting could not be saved.",
      },
      "appSettings.aboutUnavailable": {
        zh: "这个会话里没有版本信息。",
        ja: "このセッションではバージョンを表示できません。",
        en: "Version details are not available in this session.",
      },
      "plugins.title": { zh: "扩展管理", ja: "拡張管理", en: "Extensions" },
      "extensions.provision.bundled": { zh: "随应用提供", ja: "アプリに同梱", en: "Bundled with the app" },
      "extensions.provision.managed": { zh: "由 Nema 安装", ja: "Nema がインストール", en: "Installed by Nema" },
      "extensions.provision.external": { zh: "在 Nema 外发现", ja: "Nema の外で発見", en: "Found outside Nema" },
      "extensions.install.absent": { zh: "未安装", ja: "未インストール", en: "Not installed" },
      "extensions.install.installing": { zh: "安装中", ja: "インストール中", en: "Installing" },
      "extensions.install.installed": { zh: "已安装", ja: "インストール済み", en: "Installed" },
      "extensions.install.updating": { zh: "更新中", ja: "更新中", en: "Updating" },
      "extensions.install.removing": { zh: "卸载中", ja: "削除中", en: "Removing" },
      "extensions.install.failed": { zh: "失败", ja: "失敗", en: "Failed" },
      "extensions.use.enabled": { zh: "启用", ja: "有効", en: "Enabled" },
      "extensions.use.disabled": { zh: "停用", ja: "停止", en: "Disabled" },
      "extensions.error.bundled-runtime-missing": {
        zh: "随包的 Graphify 运行环境缺失，可在此修复。",
        ja: "同梱の Graphify 実行環境がありません。ここから修復できます。",
        en: "The packaged Graphify runtime is missing. It can be repaired from here.",
      },
      "plugins.local": { zh: "仅本机", ja: "ローカルのみ", en: "Local only" },
      "plugins.external": { zh: "会外发", ja: "外部送信あり", en: "Sends data out" },
      "plugins.installed": { zh: "已安装", ja: "インストール済み", en: "Installed" },
      "plugins.notInstalled": { zh: "未安装", ja: "未インストール", en: "Not installed" },
      "plugins.externalNote": {
        zh: "打开后，调用内容会发送到外部服务",
        ja: "有効にすると呼び出し内容が外部サービスに送信されます",
        en: "When on, call contents are sent to an external service",
      },
      "know.diagrams": { zh: "代码图", ja: "コード図", en: "Code diagrams" },
      "diagram.open": { zh: "在新窗口打开", ja: "新しいウィンドウで開く", en: "Open in new window" },
      "diagram.update": { zh: "更新", ja: "更新", en: "Update" },
      "diagram.updateQueued": { zh: "已排队更新", ja: "更新をキューに追加しました", en: "Update queued" },
      "diagram.sourceCommit": { zh: "画图时的提交", ja: "作図時のコミット", en: "Drawn from commit" },
      "code.title": { zh: "代码与插件", ja: "コードとプラグイン", en: "Code & plugins" },
      "code.repos": { zh: "绑定的仓库", ja: "連携リポジトリ", en: "Linked repositories" },
      "code.addRepo": { zh: "添加仓库", ja: "リポジトリを追加", en: "Add repository" },
      "code.path": { zh: "本地路径", ja: "ローカルパス", en: "Local path" },
      "code.label": { zh: "用途", ja: "用途", en: "Label" },
      "code.mainBranch": { zh: "主分支", ja: "メインブランチ", en: "Main branch" },
      "code.fetchedAt": { zh: "最后同步", ja: "最終同期", en: "Last fetched" },
      "code.fetchFailed": { zh: "同步失败", ja: "同期失敗", en: "Fetch failed" },
      "code.noOrigin": { zh: "没有 origin，使用本地分支", ja: "origin がないためローカルブランチを使用", en: "No origin; using the local branch" },
      "report.label": { zh: "coding agent 上报", ja: "coding agent の報告", en: "Coding agent report" },
      "report.commitsExist": { zh: "提交存在", ja: "コミットあり", en: "Commits exist" },
      "report.onMain": { zh: "已合入主分支", ja: "メインブランチに反映済み", en: "On main" },
      "report.notYet": { zh: "尚未合入主分支", ja: "まだメインブランチに未反映", en: "Not on main yet" },
      "report.filesOk": { zh: "文件相符", ja: "ファイル一致", en: "Files match" },
      "report.untouched": { zh: "未改动的文件", ja: "変更されていないファイル", en: "Files not touched" },
      "impl.reported": { zh: "已上报", ja: "報告済み", en: "Reported" },
      "impl.reportedInferred": { zh: "已上报（代码推断）", ja: "報告済み（コードから推測）", en: "Reported (inferred from code)" },
      "impl.verified": { zh: "已核实", ja: "検証済み", en: "Verified" },
      "impl.mismatch": { zh: "有出入", ja: "不一致", en: "Mismatch" },
      "impl.confirm": { zh: "确认已实现", ja: "実装済みと確認", en: "Confirm implemented" },
      "impl.confirmedByUser": { zh: "由用户确认", ja: "ユーザーが確認", en: "Confirmed by user" },
      "github.connected": { zh: "GitHub 连接可用。", ja: "GitHub 接続を利用できます。", en: "GitHub connection is available." },
      "github.notConnected": { zh: "GitHub 连接不可用。", ja: "GitHub 接続を利用できません。", en: "GitHub connection is not available." },
      "github.localConnectionHelp": {
        zh: "GitHub 访问可使用已登录的本地 gh 命令，或在其他位置配置的 MCP 连接。",
        ja: "GitHub へのアクセスには、認証済みのローカル gh コマンドまたは別途設定した MCP 接続を利用できます。",
        en: "GitHub access can use an already authenticated local gh command or an MCP connection configured elsewhere.",
      },
      "github.noRemote": { zh: "没有 GitHub 远端", ja: "GitHub リモートなし", en: "No GitHub remote" },
      "code.plugins": { zh: "本 workspace 的插件", ja: "この workspace のプラグイン", en: "Plugins for this workspace" },
      "code.modelEgress": {
        zh: "Agent 读到的代码片段会随请求发送给模型服务商（OpenAI / Anthropic）。",
        ja: "Agent が読んだコード片はリクエストとともにモデル提供者（OpenAI / Anthropic）に送信されます。",
        en: "Code the Agent reads is sent to the model provider (OpenAI / Anthropic) with each request.",
      },
    };
    for (const [key, value] of Object.entries(keys)) {
      expect(en[key]).toBe(value.en);
      expect(ja[key]).toBe(value.ja);
      expect(zh[key]).toBe(value.zh);
    }
  });
});
