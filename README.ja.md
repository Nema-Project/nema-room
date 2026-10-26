# Nema Room

<img src="docs/design/brand/nema-room-preview.png" width="88" height="88" alt="Nema Room アイコン" />

**断片的な議論を、根拠をたどれる要件に整理し、コーディング Agent に引き継ぐ。**

[简体中文](README.zh.md) · [English](README.en.md) · 日本語

> **0.1.1：** Windows x64 と Apple シリコン向けのデスクトップインストーラーを公開しています。アプリは手元のパソコンで動き、インストール済みの Git 2.31 以降を使います。複数端末の同期、バックアップ、チームの閲覧専用アクセスはこれからです。「クイックスタート」は引き続き Web / Compose 版の手順です。[デスクトップアプリ](#デスクトップアプリプレビュー)を参照してください。

Nema Room はローカルで動く要件ディスカッションルームです。アイデア、会議メモ、トレードオフをチャットに送ると、Agent が要件、決定事項、質問、情報源に整理します。知識の変更は Git に記録されます。開発時には spec と plan を生成し、コーディング Agent のコミット報告で進捗を追跡できます。

下はアプリの画面です。サンプルの議論を使っています。チャットは中央、整理された項目は右です。未回答の確認事項は印が付いたままです。

<img src="docs/screenshots/room-ja.png" width="1100" alt="ルーム：請求書エクスポートの議論が、要件、決定 2 件、未回答の確認事項になっている。">

項目を開くと、なぜ記録されたかと、元の発言が並びます。

<img src="docs/screenshots/entry-ja.png" width="1100" alt="要件 R-1。ユーザーが言ったこととして記録され、元の文が横に残っている。">

## 主な機能

- **議論を知識に整理**：要件、決定、トレードオフ、質問、情報源、コード図、開発パッケージを管理。
- **根拠を追跡**：ユーザーの発言・決定と Agent の推論を区別し、引用、履歴、変更理由を確認。
- **コード連携**：ローカルリポジトリを登録し、メインブランチのスナップショットを読み取り、コード検索や図の生成、古くなった図の表示に対応。
- **開発の引き継ぎ**：不明点を確認して開発パッケージを生成し、人が承認して Codex や Claude Code に渡す。
- **スレッドで議論**：長いやり取りでは Agent が会話を thread に移せます。`/thread` で新しい thread を開始できます。thread は独立したウィンドウで開き、サイドバーの未読バッジから次に対応が必要な thread を開けます。
- **知識の管理**：誤って記録した項目を取り下げても、履歴と出典は残ります。
- **実装の追跡**：コミット、メインブランチへの取り込み、ファイル変更を検査。手動確認も可能。
- **3 言語の UI**：日本語・英語・中国語。知識の言語、拡張機能、ワークスペースのアーカイブを設定でき、サイドバー下部で夜間モードを切り替えられます。

## 初回リリースの範囲と動作条件

現在は**ソースからインストール**します。CLI パッケージは private です。`npx nema` を単独の npm インストール手段として使わないでください。Windows、macOS、Linux で共通の Node.js セットアップを使用します。

| 項目 | 条件 |
| --- | --- |
| ローカルツール | Node.js ≥ 22（npm を含む）、Git |
| コンテナ | Docker と Docker Compose v2 |
| モデル | 下記の実行方式を一つ設定。利用可否、上限、料金はプロバイダーによる |
| ストレージ | ローカル SSD を推奨。プロジェクト、知識 Git リポジトリ、DB を NAS/SMB 共有に置くことは非推奨 |
| プラットフォーム | Windows、macOS、Linux。Windows/macOS は Docker Desktop の Linux コンテナ、Linux は Docker Engine を使用可能 |

ローカル利用向けで、公開サーバー用の複数ユーザー認証はありません。hub と web は標準でループバック接続のみを受け付けます。インターネットへ直接公開しないでください。

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

Compose で PostgreSQL、hub、web を起動します。**daemon はホストで動かし**、ローカルの認証情報とリポジトリのパスを使います。

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
docker compose up -d --build
```

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

Linux で UID/GID が 1000 以外の場合は `.env` に `NEMA_UID` / `NEMA_GID` を設定してください。保存先を変更する場合は、先にディレクトリを作成し、`NEMA_DATA_HOST_DIR` と daemon が読む保存先を一致させます。

## デスクトップアプリ（プレビュー）

デスクトップアプリは、全体を 1 つのローカルプログラムにまとめます。ディスク上の PGlite データベース、単一オーナーのローカルコア、保護された同一オリジンのゲートウェイ、同梱の Node を使い、Docker もデータベースサーバーも不要です。Git は PC にインストール済みのもの（2.31 以降）を使います。macOS では Finder から開いた場合も Homebrew と MacPorts の Git を見つけます。Git がない、または古い場合は起動時にその旨を表示し、https://git-scm.com/downloads を案内します。**デスクトップ 0.1.1 を公開しています。** Windows x64 と Apple シリコン向けです。[インストーラーをダウンロード](https://github.com/Nema-Project/nema-room/releases/tag/v0.1.1)。

| 項目 | 状態 |
| --- | --- |
| Windows x64 | 0.1.1 の NSIS インストーラーを公開 |
| macOS | Apple シリコン（arm64）向け 0.1.1 DMG。Intel Mac は対象外 |
| Linux | デスクトップ用インストーラーなし |
| 署名と更新 | インストーラーは**未署名**。自動更新なし |
| 一般公開 | [0.1.1](https://github.com/Nema-Project/nema-room/releases/tag/v0.1.1)。Node（MIT）、同梱フォント（OFL）、Electron の ffmpeg（LGPL、差し替えできる別ライブラリ）は同梱の許諾文で公開 |

**ビルド（Windows x64）**：`npm ci` の後に `npm run desktop:make -- --platform win32 --arch x64` を実行します。成果物は `dist/desktop-artifacts/win32-x64/` に出力されます：`Nema-<バージョン>-win32-x64.exe`（NSIS インストーラー）。ビルドは実行中の OS 向けのみで、ネイティブ C コンパイラーが必要です（Windows では Clang。[scripts/desktop/README.md](scripts/desktop/README.md) を参照）。

**未署名インストーラーを初めて開くとき**：自分でビルドした、または内容を確認したファイルだけを開いてください。Windows の SmartScreen が「Windows によって PC が保護されました」と表示したら、「詳細情報」→「実行」を選びます。macOS 版は未検証です。公証されていないアプリは、通常どおり「システム設定 → プライバシーとセキュリティ」で「このまま開く」を選ぶ必要があります。

**データの場所**：既定は `~/.nema/desktop`（`db/` がデータベース、`data/` が知識の Git リポジトリ、`instance.json` が実行状態）。Compose のデータベースは読まず、従来の `~/.nema/data` も使いません。

**ウィンドウ、トレイ、ブラウザーモード**
- ウィンドウを閉じても閉じるのはウィンドウだけで、コアはトレイで動き続けます。トレイのアイコンから開き直せます。トレイメニューの `Quit Nema` で終了し、バックグラウンド処理の後始末を待ちます。
- 同じコアにブラウザーからもアクセスできます。インストール先の `resources\payload` に `Nema Browser.cmd`（macOS は `Nema Browser.command`、Linux は `nema-browser`）があり、コアを起動または再利用して、1 回限りのリンクをブラウザーで開きます。`--no-open` はリンクの表示のみ、`--quit` は終了要求です。ウィンドウのプロセスが異常終了した後も、これで作業を続けられます。

**モデルと GitHub**
- モデルはアプリの「モデル設定」で選びます。ターミナルは不要です。提供元は 1 段だけです：ChatGPT サブスクリプション、Claude サブスクリプション、API キー。ChatGPT サブスクリプションはブラウザーログインか、既存のローカル Codex ログインです。Claude サブスクリプションはローカルの Claude Code トークンを入力します。API キーはキーと任意の Responses API アドレスです。接続したあと、その提供元が返す一覧からモデルを選びます。モデル ID を手入力する欄はありません。一覧の読み込み中は、メニューにその旨が表示され、開くことはできません。Claude は公式エイリアスを使い、未選択のときはアカウントの既定です。提供元ごとのログインはそれぞれ残ります。同じページで推論の強さを設定できます。Agent ランタイムの別スイッチはありません。
- GitHub プラグインは既定で無効です。ワークスペースの「コードとプラグイン」で有効にすると、Agent はサインイン済みのローカル `gh` を使います（ターミナルで一度 `gh auth login` を実行してください）。Nema は GitHub トークンを要求も保存もしません。読み取りはプラグインを有効にすると使えます。GitHub の変更（Issue の作成とコメント、ラベルの編集、Project の更新）は、同じページの許可スイッチがさらに必要です。Agent がアクセスできるのは、そのワークスペースに紐づく github.com リポジトリだけです。

**コーディング Agent の報告フック**：`nema report install` が書き込むフック（パッケージ版は `nema` を PATH に置きません。インストール先の `resources\payload` フォルダーで `Nema CLI.cmd report install --agent claude` を実行します。macOS は `Nema CLI.command`、Linux は `nema-cli` です。フックは同梱の Node と CLI を絶対パスで指します）は、ユーザー単位の `~/.nema/report-token` を使い、デスクトップアプリが起動時にローカルコアへ登録します。アプリの実行中は、フックが自動的にアプリを見つけて身元を検証します。**フックを新しくインストールしたら、デスクトップアプリを再起動**してください（トークンが登録されます）。アプリが動いていない間の報告はローカルのスプール（最大 5 MB、7 日間保持）に入り、次の報告時に送られます。

**Web / Compose 版からの移行**：現在はライブラリのインターフェースだけで、コマンドも画面もありません。`exportSnapshot`（`apps/hub/src/db/export.ts`）は指定した PostgreSQL 接続からエクスポートし、`importLegacySnapshot`（`apps/local/src/import.ts`）は**空で停止中**のデスクトップのデータディレクトリへインポートします。インポートはまずステージング用ディレクトリで全体を検証し、失敗しても移行先は変更されません。中断した場合は `recoverInterruptedImport` で復旧します。認証情報はエクスポートもインポートもされないため、再度サインインしてください。

**アップグレード**：デスクトップアプリに自動更新はありません。トレイの `Quit Nema` で終了し、`~/.nema/desktop` をバックアップしてから新しいバージョンをインストールします。起動時にデータベースのマイグレーションが適用されます。**古いインストーラーへの上書きアップグレードは未検証**なので、必ずバックアップしてください。

**既知の制限**：バックグラウンドのヘルパープロセスの後始末は、現時点で Windows のみ保証されています（POSIX は未証明）。Windows ローカルの全テストは失敗 0 ですが、23 件は条件でスキップされており（Windows の受け入れではありません）、POSIX と CI では再実行していません。詳しくは[検証記録](docs/reviews/2026-10-24-desktop-validation.md)を参照してください。

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

## 議論から実装まで

1. **議論**：メモを送り、知識パネルで Agent の解釈を確認、確定、修正、取り下げできます。任意のメッセージを引用でき、自分のメッセージは編集できます（以前の文は残り、Agent が新しい文でやり直します）。ヘッダーのアイコンから、キーワードでこのワークスペースを検索できます。`/` でコマンドメニューが開きます。図の種類は `/diagram:sequence` のように並び、入力に合わせて絞られます。長いやり取りには `/thread` で新しい thread を開始できます。Agent も往復の議論が必要なときに会話を thread に移します。thread は独立したウィンドウで開き、サイドバーの未読バッジから次に対応が必要な thread を開けます。Agent は copilot として自然に応答し、メモの確認や雑談では知識を書き込みません。主チャットと thread には同じ記録ルールが適用されます。ユーザーが既存の決定を明確に覆していないときは、その決定を保持して現在の thread で質問します。明確な上書き指示があれば、古い決定を superseded にして新しい決定を記録します。進捗を尋ねたり、既存の図を更新したりすることもできます。
2. **コード連携**：設定のシステムフォルダ選択でローカル Git リポジトリを登録します。選択後にリモートと検出したメインブランチを表示し、名前はフォルダ名を使います。その名前が既にあるときだけ入力します。ダイアログはホストの daemon が開きます。Windows はエクスプローラー形式の選択です。Graphify はインストール先の `tools/graphify/` から読みます。PATH からは入れず、実行時にダウンロードもしません。`desktop:stage` が固定した CPython 3.11.17 と graphifyy 0.9.95 をこのディレクトリへ入れ、起動ファイルは自分からの相対パスだけを使います。無いときは索引とコード検索が `随包的 Graphify 运行环境缺失` と報告し、プラグインページも同じ文を表示します。修復ボタンはありません。リポジトリの登録時に一度索引を作ります。全量の抽出には数分かかることがあります。索引中はチャットに進捗が出て、終わるとコードについて質問できる旨が表示されます。アーキテクチャ図はその索引の後に描き、その間も進捗を表示します。その後 daemon は時計どおりに `git fetch` しません。タスクがそのリポジトリのコードを初めて読むときだけメインブランチを fetch し、コミット済みのスナップショットを読みます。未コミットの変更は含みません。同じタスクの後続の読み取りは、その結果を再利用します。
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

ルートの typecheck は web を含みません。web は個別にビルドしてください。更新前にデータをバックアップし、`git pull`、`npm ci`、CLI と Compose イメージの再ビルド、daemon の再起動を行います。hub と CLI は同じバージョンを使ってください。

ポートや保存先は [.env.example](.env.example) を参照してください。CLI はルートの `.env` を自動で読みません。保存先を変更したら shell で `NEMA_DATA_DIR` を export するか、`daemon` / `doctor` に `--token-file` を指定します。hub のポートを変えたら `--hub` も指定してください。`NEXT_PUBLIC_HUB_URL` 変更後は web の再ビルドが必要です。

## ドキュメントとフィードバック

- [詳細コマンド・実装リファレンス（中国語）](docs/reference.zh-CN.md)
- [変更履歴](CHANGELOG.md)
- [設計・実装計画](docs/superpowers/)
- [貢献ガイド（中国語）](CONTRIBUTING.md)
- [セキュリティ（中国語）](SECURITY.md)：リポジトリは非公開です。記載のセキュリティ issue テンプレートを使い、認証情報は貼らないでください。
- [不具合報告](https://github.com/Nema-Project/nema-room/issues/new/choose)：テンプレートを使ってください。OS、Node/Docker のバージョン、実行方式、機密情報を除いたエラーを記載してください。

第三者コンポーネントには archify と superpowers を基にした執筆ルールが含まれます。ライセンスと出典は [archify](vendor/archify/VENDORED.md) と [superpowers-rules](vendor/superpowers-rules/VENDORED.md) に保持しています。本プロジェクトは [MIT License](LICENSE) で公開します。第三者コンポーネントのライセンスと著作権表示も保持してください。
