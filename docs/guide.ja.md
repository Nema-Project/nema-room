# Nema Room ユーザーガイド

[README に戻る](../README.ja.md) · [English](guide.en.md) · [简体中文](guide.zh.md) · [日本語](guide.ja.md)

デスクトップアプリと Web / Compose の詳しいインストール・設定・操作手順です。概要とダウンロードは README を参照してください。

- [デスクトップアプリ（プレビュー）](#desktop)
- [Web / Compose の動作条件](#requirements)
- [クイックスタート](#source-installation)
- [モデルの実行方式](#models)
- [議論から実装まで](#workflow)
- [データ・プライバシー・既知の制限](#data)
- [開発とアップグレード](#development)

<a id="desktop"></a>

## デスクトップアプリ（プレビュー）

デスクトップアプリは、全体を 1 つのローカルプログラムにまとめます。ディスク上の PGlite データベース、単一オーナーのローカルコア、保護された同一オリジンのゲートウェイ、同梱の Node を使い、Docker もデータベースサーバーも不要です。Git は PC にインストール済みのもの（2.31 以降）を使います。macOS では Finder から開いた場合も Homebrew と MacPorts の Git を見つけます。Git がない、または古い場合は起動時にその旨を表示し、https://git-scm.com/downloads を案内します。**デスクトップ版を公開しています。** Windows x64 と Apple シリコン向けです。[ダウンロード](https://github.com/Nema-Project/nema-room/releases/latest)。Windows ではインストーラーかポータブル ZIP のどちらかを選びます。

| 項目 | 状態 |
| --- | --- |
| Windows x64 | NSIS インストーラー（`.exe`）またはポータブル ZIP（`.zip`）。どちらか一方 |
| macOS | Apple シリコン（arm64）向け DMG。Intel Mac は対象外 |
| Linux | デスクトップ用インストーラーなし |
| 署名と更新 | Windows は**未署名**、macOS は**アドホック署名・未公証**。新しい安定版を見つけてリリースページを開くことはできる。ダウンロードとインストールは自動では行わない |
| 一般公開 | [最新リリース](https://github.com/Nema-Project/nema-room/releases/latest)。Node（MIT）、同梱フォント（OFL）、Electron の ffmpeg（LGPL、差し替えできる別ライブラリ）は同梱の許諾文で公開 |

**ビルド（Windows x64）**：`npm ci` の後に `npm run desktop:make -- --platform win32 --arch x64` を実行します。成果物は `dist/desktop-artifacts/win32-x64/` に出力されます：`Nema-<バージョン>-win32-x64.exe`（NSIS インストーラー）と `Nema-<バージョン>-win32-x64.zip`（ポータブル版。アーカイブ直下に `Nema.exe`）。ビルドは実行中の OS 向けのみで、ネイティブ C コンパイラーが必要です（Windows では Clang。[scripts/desktop/README.md](../scripts/desktop/README.md) を参照）。

**初回起動と OS の警告**：自分でビルドした、または内容を確認したファイルだけを開いてください。Windows の SmartScreen が「Windows によって PC が保護されました」と表示したら、「詳細情報」→「実行」を選びます。macOS 版は未検証です。公証されていないアプリは、通常どおり「システム設定 → プライバシーとセキュリティ」で「このまま開く」を選ぶ必要があります。

**データの場所**：既定は `~/.nema/desktop`（`db/` がデータベース、`data/` が知識の Git リポジトリ、`instance.json` が実行状態）。Compose のデータベースは読まず、従来の `~/.nema/data` も使いません。

**Windows のポータブル ZIP**：`Nema-<バージョン>-win32-x64.zip` を展開して `Nema.exe` を実行します。ショートカットもアンインストーラーもありません。そのフォルダを削除すると、ポータブル版だけを取り除けます。NSIS インストールと同じ `~/.nema/desktop` を使います。両方を同時に動かすとこのディレクトリを共有し、後から起動した側は既に動いているコアへ接続します。ZIP のフォルダを削除しても NSIS はアンインストールされず、NSIS をアンインストールしても展開済みフォルダと `~/.nema/desktop` は残ります。

**ウィンドウ、トレイ、ブラウザーモード**
- ウィンドウを閉じても閉じるのはウィンドウだけで、コアはトレイで動き続けます。トレイのアイコンから開き直せます。トレイメニューの `Quit Nema` で終了し、バックグラウンド処理の後始末を待ちます。
- 同じコアにブラウザーからもアクセスできます。インストール先の `resources\payload` に `Nema Browser.cmd`（macOS は `Nema Browser.command`、Linux は `nema-browser`）があり、コアを起動または再利用して、1 回限りのリンクをブラウザーで開きます。`--no-open` はリンクの表示のみ、`--quit` は終了要求です。ウィンドウのプロセスが異常終了した後も、これで作業を続けられます。

**モデルと GitHub**
- モデルはアプリの「モデル設定」で選びます。ターミナルは不要です。提供元は 1 段だけです：ChatGPT サブスクリプション、Claude サブスクリプション、API キー。ChatGPT サブスクリプションはブラウザーログインか、既存のローカル Codex ログインです。Claude サブスクリプションはローカルの Claude Code トークンを入力します。API キーはキーと任意の Responses API アドレスです。接続したあと、その提供元が返す一覧からモデルを選びます。モデル ID を手入力する欄はありません。一覧の読み込み中は、メニューにその旨が表示され、開くことはできません。Claude は公式エイリアスを使い、未選択のときはアカウントの既定です。提供元ごとのログインはそれぞれ残ります。同じページで推論の強さを設定できます。Agent ランタイムの別スイッチはありません。
- GitHub プラグインは既定で無効です。ワークスペースの「コードとプラグイン」で有効にすると、Agent はサインイン済みのローカル `gh` を使います（ターミナルで一度 `gh auth login` を実行してください）。Nema は GitHub トークンを要求も保存もしません。読み取りはプラグインを有効にすると使えます。GitHub の変更（Issue の作成とコメント、ラベルの編集、Project の更新）は、同じページの許可スイッチがさらに必要です。Agent がアクセスできるのは、そのワークスペースに紐づく github.com リポジトリだけです。

**コーディング Agent の報告フック**：`nema report install` が書き込むフック（パッケージ版は `nema` を PATH に置きません。インストール先の `resources\payload` フォルダーで `Nema CLI.cmd report install --agent claude` を実行します。macOS は `Nema CLI.command`、Linux は `nema-cli` です。フックは同梱の Node と CLI を絶対パスで指します）は、ユーザー単位の `~/.nema/report-token` を使い、デスクトップアプリが起動時にローカルコアへ登録します。アプリの実行中は、フックが自動的にアプリを見つけて身元を検証します。**フックを新しくインストールしたら、デスクトップアプリを再起動**してください（トークンが登録されます）。アプリが動いていない間の報告はローカルのスプール（最大 5 MB、7 日間保持）に入り、次の報告時に送られます。

**Web / Compose 版からの移行**：現在はライブラリのインターフェースだけで、コマンドも画面もありません。`exportSnapshot`（`apps/hub/src/db/export.ts`）は指定した PostgreSQL 接続からエクスポートし、`importLegacySnapshot`（`apps/local/src/import.ts`）は**空で停止中**のデスクトップのデータディレクトリへインポートします。インポートはまずステージング用ディレクトリで全体を検証し、失敗しても移行先は変更されません。中断した場合は `recoverInterruptedImport` で復旧します。認証情報はエクスポートもインポートもされないため、再度サインインしてください。

**アップグレード**：デスクトップアプリは更新をダウンロードもインストールもしません。起動の約 15 秒後と、おおよそ 1 日に 1 回、GitHub の新しい安定版を確認します。トレイとアプリ内のバナーがそのリリースページを開きます。`Check for Updates` はすぐに 1 回確認します。サイドバーの「更新を自動で確認する」（`~/.nema/desktop/update-check.json` の `updateCheck.enabled`）で定期確認を止められます。失敗、ドラフト、プレリリースは表示しません。トレイの `Quit Nema` で終了し、`~/.nema/desktop` をバックアップしてから新しいバージョンをインストールします。起動時にデータベースのマイグレーションが適用されます。2026-10-27 のホストされた Windows と macOS ランナーで、使い捨てデータディレクトリの再オープン、未適用マイグレーション、失敗時のロールバック、バックアップ復元が通りました。同じ日、メンテナーが macOS と Windows で新しいパッケージを既存のインストールに上書きし、workspace のデータはどちらも残っていました。更新前には引き続き `~/.nema/desktop` をバックアップしてください。

現在の安定化の優先順位と受け入れの根拠は[ロードマップ](../ROADMAP.md)を参照してください。以下の過去の検証記録は、記載されたコミットと環境にのみ適用されます。

**検証記録（2026-10-24）**：バックグラウンドのヘルパープロセスの後始末は、現時点で Windows のみ保証されています（POSIX は未証明）。Windows ローカルの全テストは失敗 0 ですが、23 件は条件でスキップされており（Windows の受け入れではありません）、POSIX と CI では再実行していません。詳しくは[検証記録](reviews/2026-10-24-desktop-validation.md)を参照してください。

<a id="requirements"></a>

## Web / Compose の動作条件

ホストの daemon は npm パッケージ `nema` です（Node.js ≥ 22）。このパッケージはリポジトリにあり、[scripts/npm/RELEASE.md](../scripts/npm/RELEASE.md) の最初の公開までは npm 上にありません。それまでは下のウィザードで、このチェックアウトから daemon を入れます。公開のあと、実行中の hub と同じバージョンを入れます。

```sh
npx nema@<hub のバージョン> --version
npm i -g nema@<hub のバージョン>
```

Compose では `curl http://127.0.0.1:4400/api/version` が `{"version":"..."}` を返します。デスクトップ版はサイドバーにバージョンを表示し、アプリのオリジンは `GET /_nema/version` を提供します。バージョンが違うと daemon は hub のエラーと `run: npm i -g nema@<バージョン>` を出して止まり、再接続しません。

`nema daemon` の `--hub` の既定値は `http://127.0.0.1:4400` です。トークンファイルは `$NEMA_DATA_DIR` または `~/.nema/data` の `daemon-token`（`defaultTokenFile()`）です。hub は起動時にファイルがなければ書き込みます。Compose はコンテナの `NEMA_DATA_DIR` を `/data` にし、ホストのデータディレクトリ（既定は `~/.nema/data`、または `NEMA_DATA_HOST_DIR`）をそこにマウントするので、ホストの daemon とコンテナの hub は同じトークンファイルを使います。

このリポジトリから Web / Compose を動かす場合は、下のソース用ウィザードを使います。Windows、macOS、Linux で共通の Node.js セットアップです。バージョンを付けない `nema` を入れて hub と一致するとみなさないでください。

| 項目 | 条件 |
| --- | --- |
| ローカルツール | Node.js ≥ 22（npm を含む）、Git |
| コンテナ | Docker と Docker Compose v2 |
| モデル | 下記の実行方式を一つ設定。利用可否、上限、料金はプロバイダーによる |
| ストレージ | ローカル SSD を推奨。プロジェクト、知識 Git リポジトリ、DB を NAS/SMB 共有に置くことは非推奨 |
| プラットフォーム | Windows、macOS、Linux。Windows/macOS は Docker Desktop の Linux コンテナ、Linux は Docker Engine を使用可能 |

ローカル利用向けで、公開サーバー用の複数ユーザー認証はありません。hub と web は標準でループバック接続のみを受け付けます。インターネットへ直接公開しないでください。

<a id="source-installation"></a>

## クイックスタート

PowerShell、Terminal、Linux の端末で実行：

```text
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang ja
```

Node/npm、Git、Docker、Compose を確認し、既存の `.env` を保持して依存関係と CLI をビルドし、サービスを起動します。続いてモデルの選択・接続確認を案内し、端末で daemon を起動できます。再実行可能で、システムソフトウェアの導入、アプリデータの削除、既存設定ファイルの上書きは行いません。モデル方式を選ぶと、対応するローカルモデル設定を更新します。

読み取り専用チェック：`node scripts/setup.mjs --lang ja --check`。npm があれば `npm run setup -- --lang ja` も利用できます。`--check` は Docker の起動状態を確認しますが、モデルリクエストは送りません。

### 手動インストール（Bash）

Compose で PostgreSQL、hub、web を起動します。**daemon はホストで動かし**、ローカルの認証情報とリポジトリのパスを使います。daemon はイメージに入っていません。イメージを公開するリリースまでは、このチェックアウトからビルドします。

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
# Linux と macOS のみ。Windows の Docker Desktop では不要です。
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
npm run up
```

`npm run up` はこのチェックアウトから hub と web をビルドします。Linux と macOS では、上の `export` は UID/GID が 1000 かどうかに関係なく、コンテナのユーザーをホストのユーザーにします。Windows の Docker Desktop ではこの export は不要です。`NEMA_HUB_PORT` の変更が効くのはこのソースビルドだけです。hub はそのポートで公開され、web は `http://127.0.0.1:<ポート>` で再ビルドされます。

clone せずにピン留めしたイメージを pull できるのは、イメージ公開ワークフローを含む最初の `v*` tag からです。`v0.1.3` はそのリリースではありません。`scripts/images/check-images.mjs` は compose のピンとパッケージ版の一致を要求するので、ピンはイメージを公開するリリースと一緒に動きます。その tag のあと、その `docker-compose.yml` を取得します。Linux と macOS では同じように `NEMA_UID` と `NEMA_GID` を export します。Windows の Docker Desktop ではこの export は不要です。そのあと `docker compose up -d` を実行します。公開 web イメージが hub を呼ぶアドレスは `http://127.0.0.1:4400` で、`NEMA_HUB_PORT` は無視されます。

まずモデルを設定します。標準の認証方式を使う場合：

```bash
node apps/cli/dist/index.js auth login
node apps/cli/dist/index.js auth probe
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js daemon
```

[localhost:3000](http://localhost:3000) を開き、ワークスペースを作成して議論を送信します。daemon は起動したままにしてください。オフライン中の新しいタスクはキューに入ります。`auth probe` は最小限のモデルリクエストを送り、選択したサービスの利用枠を消費します。

```bash
npm run logs   # hub / web のログ
npm run down   # コンテナを停止。DB ボリュームは保持
```

Linux と macOS では、上のコマンドがすべてのホストユーザーについて `id` から `NEMA_UID` と `NEMA_GID` を export します。Windows の Docker Desktop ではこの export は不要です。同じ値を `.env` に書くこともできます。保存先を変更する場合は、先にディレクトリを作成し、`NEMA_DATA_HOST_DIR` と daemon が読む保存先を一致させます。

<a id="models"></a>

## モデルの実行方式

標準の `codex-direct` は Codex CLI を起動せず、Nema 独自のツールループを実行します。モデルに渡すのは Room 関数と、そのタスクで有効なプラグイン関数です。下の 4 行は、画面の 3 つの提供元が保存する設定です。画面にはこれらの内部名は出ません。

| 方式 | 設定と制限 |
| --- | --- |
| Sign in with ChatGPT（標準 `siwc`） | `auth login` 後に `auth probe` で利用可否を確認。すべてのサブスクリプションや組織アカウントでの利用は保証しない |
| BYOK API key | Responses API 互換エンドポイントと model の明示設定が必要。課金はプロバイダーの条件による |
| Codex ログイン互換 | `config set authMode compat`。`$CODEX_HOME/auth.json`（標準は `~/.codex/auth.json`）を読み取るだけで更新しない。非公開バックエンドのため、停止や利用規約違反の可能性がある |
| Claude Code | `config set adapter claude-code`。ローカルの `claude`、`claude setup-token`、`auth claude` が必要 |

BYOK に切り替える例：

```bash
node apps/cli/dist/index.js config set authMode byok
node apps/cli/dist/index.js config set model YOUR_MODEL
# 別の互換プロバイダーを使う場合のみ設定：
# node apps/cli/dist/index.js config set byokBaseUrl https://your-provider.example/v1
node apps/cli/dist/index.js auth byok
```

`auth byok` は標準入力からキーを一行読みます。貼り付けて Enter を押してください。端末に入力が表示される場合があるため、他人に見られない環境で操作してください。`auth claude` と `auth github` も標準入力から読みます。実際のキーをコマンド引数、リポジトリ、issue に記載しないでください。

Claude Code の設定：

```bash
node apps/cli/dist/index.js config set adapter claude-code
claude setup-token
node apps/cli/dist/index.js auth claude
```

認証や呼び出しに失敗しても、別の実行方式に自動で切り替えません。`config get` と `auth status` で設定と認証状態を確認できます。トークンは表示しません。

<a id="workflow"></a>

## 議論から実装まで

1. **議論**：メモを送り、知識パネルで Agent の解釈を確認、確定、修正、取り下げできます。任意のメッセージを引用でき、自分のメッセージは編集できます（以前の文は残り、Agent が新しい文でやり直します）。ヘッダーのアイコンから、キーワードでこのワークスペースを検索できます。`/` でコマンドメニューが開きます。図の種類は `/diagram:sequence` のように並び、入力に合わせて絞られます。長いやり取りには `/thread` で新しい thread を開始できます。比較や利害の検討を求められ、まだ決めていないときは、Agent が先に会話を thread に移して議論します。thread は独立したウィンドウで開き、サイドバーの未読バッジから次に対応が必要な thread を開けます。Agent は copilot として自然に応答し、メモの確認、雑談、疑問形のアイデア、利点と欠点の質問では知識を書き込みません。議論や thread に残すよう頼むことも書き込みではありません。主チャットと thread には同じ記録ルールが適用されます。未決定の比較では question エントリを作りません。ユーザーが既存の決定を明確に覆していないときは、その決定を保持して現在の thread で質問します。明確な上書き指示があれば、古い決定を superseded にして新しい決定を記録します。進捗を尋ねたり、既存の図を更新したりすることもできます。
2. **コード連携**：設定のシステムフォルダ選択でローカル Git リポジトリを登録します。選択後にリモートと検出したメインブランチを表示し、名前はフォルダ名を使います。その名前が既にあるときだけ入力します。ダイアログはホストの daemon が開きます。Windows はエクスプローラー形式の選択です。Graphify はインストール先の `tools/graphify/` から読みます。PATH からは入れず、実行時にダウンロードもしません。`desktop:stage` が固定した CPython 3.11.17 と graphifyy 0.9.95 をこのディレクトリへ入れ、起動ファイルは自分からの相対パスだけを使います。同梱インタプリタは `python/bin/python3.11` です。Tree-sitter の文法は JavaScript、TypeScript、TSX、Python、Go、Rust、Java、C、C++、C#、Ruby、PHP、Swift、Kotlin、Bash、JSON を残します。この固定版に YAML、TOML、HTML、CSS、Markdown の文法 wheel はありません。文法が無いファイルは警告して飛ばし、抽出は完了します。無いときは索引とコード検索が `随包的 Graphify 运行环境缺失` と報告し、プラグインページも同じ文を表示します。修復ボタンはありません。リポジトリの登録時に一度索引を作ります。全量の抽出には数分かかることがあります。索引中はチャットに進捗が出て、終わるとコードについて質問できる旨が表示されます。アーキテクチャ図はその索引の後に描き、その間も進捗を表示します。その後 daemon は時計どおりに `git fetch` しません。タスクがそのリポジトリのコードを初めて読むときだけメインブランチを fetch し、コミット済みのスナップショットを読みます。未コミットの変更は含みません。同じタスクの後続の読み取りは、その結果を再利用します。
3. **開発パッケージ生成**：active な要件を選び、`superpowers` を有効にして spec と plan を生成します。情報不足の場合、`grill-me` が質問を作成して生成を止めます。チャットのその確認の下で回答すると、生成は自動で再試行します。未解決の古い確認も、そのカードから回答できます。
4. **承認と引き継ぎ**：人が確認・承認し、コーディング Agent に取得させます。編集や再生成で承認は取り消されます。
5. **報告と検証**：`reported`、`verified`、`mismatch` を記録します。**verified は Git の証拠が検査を通ったか、ユーザーが確認したことを示します。テスト合格、機能の正しさ、要件の受け入れ完了を保証しません。**

開発パッケージでは、知識の言語が日本語や英語でも、`## 已定的做法`、`### 任务 1：`、`- 修改：`、`- 满足：` など固定の中国語書式を保持する必要があります。詳細はリファレンスを参照してください。

別のリポジトリで `nema` を使うには、まず本プロジェクトのルートで CLI をリンクします。npm のグローバル bin を PATH に追加する必要がある場合があります。

```bash
npm link --workspace @nema/cli
```

登録済みのコードリポジトリで実行：

```bash
nema wp list
nema wp get W-1
nema report --entries W-1 --task 1 --summary "Implement task 1" --commits COMMIT_SHA --files src/example.ts
```

任意の報告 hook は `nema report install --agent codex` または `--agent claude` で導入します。Agent のユーザー単位 hook 設定を変更し、`nema-report` skill をインストールします。削除は `nema report uninstall --agent <agent>` です。

GitHub プラグインは既定で無効です。有効化、`gh` のログイン、書き込みの許可は上のデスクトップアプリの節と同じです。Web / Compose の daemon も同じ経路です。コマンドの許可表と、以前からの 6 つの読み取り関数は技術リファレンスにあります。`nema auth github` は今もトークンを `~/.nema/github-token` に書けますが、既定の経路はそれを読みません。

<a id="data"></a>

## データ・プライバシー・既知の制限

| 標準の保存先 | 内容 |
| --- | --- |
| PostgreSQL の Compose ボリューム `nema-pg` | チャット、タスク、ワークスペース設定、インデックスなど |
| `~/.nema/data` | daemon token と知識 Git リポジトリ |
| `~/.nema` | ローカル設定、モデル・プラグイン認証情報、コード索引スナップショット、報告キャッシュなど |
| `~/.nema/desktop` | デスクトップアプリのデータベース、知識の Git リポジトリ、実行状態。上の Compose のデータとは独立 |

**ソースリポジトリの GitHub コピーは、アプリデータのバックアップではありません。** 書き込みを止め、PostgreSQL のエクスポートと実際のデータディレクトリを保存し、復旧手順を検証してください。データ保持には `docker compose down -v` を使わないでください。`-v` は DB ボリュームを削除します。

- ローカル保存はオフライン推論ではありません。チャット、知識、ツールが返すコードをモデルプロバイダーへ送ります。GitHub プラグインが有効なとき、クエリはローカルの `gh` 経由で GitHub に送られます。書き込みはワークスペースで別に有効化する必要があります。機密ワークスペースはオフライン実行や OS レベルの隔離を意味しません。
- 通常タスクの上限はモデル呼び出し 24 回、ツール呼び出し 60 回、10 分。開発パッケージは 48 回、120 回、20 分です。中断タスクは最大 3 回再試行します。
- 起動時に一部の未コミット知識ファイルを復旧できますが、Git と DB 索引の完全な自動整合性修復はありません。
- SIWC 更新失敗時は再ログインが必要になる場合があります。ID token のクレームは検査しますが、JWKS 署名検証は行いません。
- 認証ファイルは macOS/Linux では `0600`、Windows では現在のユーザー、SYSTEM、管理者のみの非公開 ACL を使用します。読み取り時に広いアクセス権やシンボリックリンクを拒否します。
- Claude Code はローカルユーザー権限で動きます。ツール制限は独立した OS サンドボックスではありません。

<a id="development"></a>

## 開発とアップグレード

開発モードでは PostgreSQL だけを Docker で動かします。

```bash
npm ci
cp .env.example .env  # 既存設定は上書きしない
npm run build -w apps/hub
npm run build -w apps/cli
npm run db:up
npm run dev
```

別の端末で `node apps/cli/dist/index.js daemon` を起動します。Compose の hub/web との同時起動はポートが競合します。

```bash
npm test
npm run typecheck
npm run typecheck -w apps/cli
npm run lint -w apps/web
npm run build -w apps/web
```

ルートの typecheck は web を含みません。web は個別にビルドしてください。ソースのチェックアウトを更新する前にデータをバックアップし、`git pull`、`npm ci`、CLI の再ビルド、`npm run up`、daemon の再起動を行います。daemon は `GET /api/version` が返す hub のバージョンに合わせます。違う場合は `run: npm i -g nema@<バージョン>` を出して再接続しません。最初の npm 公開までは、daemon はこのチェックアウトから入れます。

ポートや保存先は [.env.example](../.env.example) を参照してください。CLI はルートの `.env` を自動で読みません。保存先を変更したら shell で `NEMA_DATA_DIR` を export するか、`daemon` / `doctor` に `--token-file` を指定します。hub のポートを変えたら `--hub` も指定してください。`NEMA_HUB_PORT` の変更が効くのは `npm run up` のソースビルドだけで、web は `http://127.0.0.1:<ポート>` で再ビルドされます。公開イメージは `NEMA_HUB_PORT` と `NEXT_PUBLIC_HUB_URL` を無視し、`http://127.0.0.1:4400` のままです。`npm run dev` は引き続き `NEXT_PUBLIC_HUB_URL` を読みます。

## セキュリティ報告

セキュリティ上の問題は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送り、[セキュリティポリシー](../SECURITY.md) を確認してください。公開 issue や PR に機密情報を書かないでください。管理者ではない read 権限のアカウントが 2026-10-27 にフォームへ到達し、テスト報告は同日、未公開のまま閉じられました。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。
