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
- **ログイン時に起動**は、デスクトップアプリの **アプリ設定 → 一般** にあります。ブラウザーまたは Compose のセッションでもこの項目は表示され、そこでは変更できないと説明します。

**モデルと GitHub**
- モデルはサイドバーの **アプリ設定 → モデル** で選びます。ターミナルは不要です。提供元は 1 段だけです：ChatGPT サブスクリプション、Claude サブスクリプション、API キー。ChatGPT サブスクリプションはブラウザーログインか、既存のローカル Codex ログインです。Claude サブスクリプションはローカルの Claude Code トークンを入力します。API キーはキーと任意の Responses API アドレスです。接続したあと、その提供元が返す一覧からモデルを選びます。モデル ID を手入力する欄はありません。一覧の読み込み中は、メニューにその旨が表示され、開くことはできません。Claude は公式エイリアスを使い、未選択のときはアカウントの既定です。提供元ごとのログインはそれぞれ残ります。同じページで推論の強さを設定できます。Agent ランタイムの別スイッチはありません。
- GitHub プラグインは既定で無効です。ワークスペースの「コードとプラグイン」で有効にすると、Agent はサインイン済みのローカル `gh` を使います（ターミナルで一度 `gh auth login` を実行してください）。Nema は GitHub トークンを要求も保存もしません。読み取りはプラグインを有効にすると使えます。GitHub の変更（Issue の作成とコメント、ラベルの編集、Project の更新）は、同じページの許可スイッチがさらに必要です。Agent がアクセスできるのは、そのワークスペースに紐づく github.com リポジトリだけです。

**コーディング Agent の報告フック**：`nema report install` が書き込むフック（パッケージ版は `nema` を PATH に置きません。インストール先の `resources\payload` フォルダーで `Nema CLI.cmd report install --agent claude` を実行します。macOS は `Nema CLI.command`、Linux は `nema-cli` です。フックは同梱の Node と CLI を絶対パスで指します）は、ユーザー単位の `~/.nema/report-token` を使い、デスクトップアプリが起動時にローカルコアへ登録します。アプリの実行中は、フックが自動的にアプリを見つけて身元を検証します。**フックを新しくインストールしたら、デスクトップアプリを再起動**してください（トークンが登録されます）。アプリが動いていない間の報告はローカルのスプール（最大 5 MB、7 日間保持）に入り、次の報告時に送られます。

**Web / Compose 版からの移行**：現在はライブラリのインターフェースだけで、コマンドも画面もありません。`exportSnapshot`（`apps/hub/src/db/export.ts`）は指定した PostgreSQL 接続からエクスポートし、`importLegacySnapshot`（`apps/local/src/import.ts`）は**空で停止中**のデスクトップのデータディレクトリへインポートします。インポートはまずステージング用ディレクトリで全体を検証し、失敗しても移行先は変更されません。中断した場合は `recoverInterruptedImport` で復旧します。認証情報はエクスポートもインポートもされないため、再度サインインしてください。

**アップグレード**：デスクトップアプリは更新をダウンロードもインストールもしません。起動の約 15 秒後と、おおよそ 1 日に 1 回、GitHub の新しい安定版を確認します。トレイとアプリ内のバナーがそのリリースページを開きます。`Check for Updates` はすぐに 1 回確認します。**アプリ設定 → 情報**の「更新を自動で確認する」（`~/.nema/desktop/update-check.json` の `updateCheck.enabled`）で定期確認を止められます。失敗、ドラフト、プレリリースは表示しません。トレイの `Quit Nema` で終了し、`~/.nema/desktop` をバックアップしてから新しいバージョンをインストールします。起動時にデータベースのマイグレーションが適用されます。2026-10-27 のホストされた Windows と macOS ランナーで、使い捨てデータディレクトリの再オープン、未適用マイグレーション、失敗時のロールバック、バックアップ復元が通りました。同じ日、メンテナーが macOS と Windows で新しいパッケージを既存のインストールに上書きし、workspace のデータはどちらも残っていました。更新前には引き続き `~/.nema/desktop` をバックアップしてください。

現在の安定化の優先順位と受け入れの根拠は[ロードマップ](../ROADMAP.md)を参照してください。以下の過去の検証記録は、記載されたコミットと環境にのみ適用されます。

**検証記録（2026-10-24）**：バックグラウンドのヘルパープロセスの後始末は、現時点で Windows のみ保証されています（POSIX は未証明）。Windows ローカルの全テストは失敗 0 ですが、23 件は条件でスキップされており（Windows の受け入れではありません）、POSIX と CI では再実行していません。詳しくは[検証記録](reviews/2026-10-24-desktop-validation.md)を参照してください。

<a id="requirements"></a>

## Web / Compose の動作条件

ホストの daemon は npm パッケージ `@nema-project/nema` です（Node.js ≥ 22）。コマンド名は `nema` です。`@nema-project/nema@0.1.3` は 2026-10-27 に npm へ公開されました。この手動の初回公開は [scripts/npm/RELEASE.md](../scripts/npm/RELEASE.md) に記録しています。`v0.1.4` は trusted publisher による最初の公開です。実行中の hub と同じバージョンを入れます。

```sh
npx @nema-project/nema@<hub のバージョン> --version
npm i -g @nema-project/nema@<hub のバージョン>
```

上のコマンドのバージョンは、取得した `docker-compose.yml` の 2 つの `image:` が固定している版です。`grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` で表示され、`nema-room-web:` の側も同じ値を表示しなければなりません。ソースのチェックアウトでは daemon をこのツリーからビルドし、この方法ではバージョンを選びません。ソースのチェックアウトには `scripts/install/public.mjs` も入っています。公開済みの 1 つの版を解決し、その版の Compose 資産・2 つのイメージ・npm パッケージがそろっていることを確かめてから、`NEMA_IMAGE_TAG` と対応する `docker-compose.yml` をまとめて対象ディレクトリに書き込みます。まず `--check` を付けると検証だけで何も書きません。読むのはその Release 自身の `docker-compose.yml` 資産で、資産がない版は拒否します。`v0.1.6` より前の Release にはこの資産がありません。

Compose では `curl http://127.0.0.1:4400/api/version` が `{"version":"..."}` を返します。デスクトップ版は **アプリ設定 → 情報** にバージョンを表示し、アプリのオリジンは `GET /_nema/version` を提供します。バージョンが違うと daemon は hub のエラーと `run: npm i -g @nema-project/nema@<バージョン>` を出して止まり、再接続しません。

`nema daemon` の `--hub` の既定値は `http://127.0.0.1:4400` です。トークンファイルは `$NEMA_DATA_DIR` または `~/.nema/data` の `daemon-token`（`defaultTokenFile()`）です。hub は起動時にファイルがなければ書き込みます。Compose はコンテナの `NEMA_DATA_DIR` を `/data` にし、ホストのデータディレクトリ（既定は `~/.nema/data`、または `NEMA_DATA_HOST_DIR`）をそこにマウントするので、ホストの daemon とコンテナの hub は同じトークンファイルを使います。

このリポジトリから Web / Compose を動かす場合は、下のソース用ウィザードを使います。Windows、macOS、Linux で共通の Node.js セットアップです。バージョンを付けない `@nema-project/nema` を入れて hub と一致するとみなさないでください。

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

Compose で PostgreSQL、hub、web を起動します。**daemon はホストで動かし**、ローカルの認証情報とリポジトリのパスを使います。daemon はイメージに入っていません。このリポジトリの開発は、このチェックアウトからビルドします。tag `v0.1.4` がイメージを初めて公開するリリースです。

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

`npm run up` はこのチェックアウトから hub と web をビルドします。Linux と macOS では、上の `export` は UID/GID が 1000 かどうかに関係なく、コンテナのユーザーをホストのユーザーにします。Windows の Docker Desktop ではこの export は不要です。`NEMA_HUB_PORT`（既定 4400）は公開されるホストのポートと hub の待受ポートの両方です。`NEMA_WEB_PORT`（既定 3000）はホストのポートだけを変えます。web コンテナは起動時に `NEMA_HUB_URL` を読み、compose はそれを `http://127.0.0.1:$NEMA_HUB_PORT` にします。

clone せずにピン留めしたイメージを pull できるのは tag `v0.1.4` からです。この tag はイメージ公開ワークフローを含み、これらのイメージの最初の公開です（`linux/amd64`。arm64 は [issue #50](https://github.com/Nema-Project/nema-room/issues/50)）。このリポジトリのツリーにある `docker-compose.yml` はテンプレートで、hub と web の `image:` は `${NEMA_IMAGE_TAG:-latest}` の展開なので、ツリーには使えるバージョンがありません。`v0.1.6` 以降の各 Release には、hub と web のイメージをその Release の版に固定したレンダリング済み `docker-compose.yml` が添付されます。これはその Release の固定名の資産なので、現在の版は常に [`releases/latest/download/docker-compose.yml`](https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml) にあります。インストール時はその版をローカルの `.env` の `NEMA_IMAGE_TAG` に固定します。clone しないインストール手順：

```sh
# 1. fetch the compose asset. With no NEMA_IMAGE_TAG in .env this is the
#    current supported release; an existing lock keeps its own version
#    (0.1.4 and 0.1.5 have no release asset, so their tag file is used).
NEMA_FETCHED= NEMA_LOCKED= NEMA_UP= NEMA_INSTALLED=
NEMA_PIN=$(sed -n 's/^NEMA_IMAGE_TAG=//p' .env 2>/dev/null | tail -1)
NEMA_URL=https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml
test -n "$NEMA_PIN" \
  && NEMA_URL=https://github.com/Nema-Project/nema-room/releases/download/v$NEMA_PIN/docker-compose.yml
{ curl -fsSL -o docker-compose.yml.download "$NEMA_URL" \
  || { test -n "$NEMA_PIN" && curl -fsSL -o docker-compose.yml.download \
    "https://raw.githubusercontent.com/Nema-Project/nema-room/v$NEMA_PIN/docker-compose.yml"; }; } \
  && mv docker-compose.yml.download docker-compose.yml && NEMA_FETCHED=1

# 2. read the one version both images are pinned to; hub and web must agree
NEMA_VERSION=$(grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)
WEB_VERSION=$(grep -o 'nema-room-web:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)
test -n "$NEMA_FETCHED" && test -n "$NEMA_VERSION" && test "$NEMA_VERSION" = "$WEB_VERSION" \
  && echo "$NEMA_VERSION"

# 3. lock it in a local .env; an existing NEMA_IMAGE_TAG stays as it is,
#    and the last assignment, the one Compose uses, must equal that version
test -n "$NEMA_FETCHED" && test -n "$NEMA_VERSION" && test "$NEMA_VERSION" = "$WEB_VERSION" \
  && { test -n "$NEMA_PIN" || printf '\nNEMA_IMAGE_TAG=%s\n' "$NEMA_VERSION" >> .env; } \
  && test "$(sed -n 's/^NEMA_IMAGE_TAG=//p' .env | tail -1)" = "$NEMA_VERSION" \
  && NEMA_LOCKED=$NEMA_VERSION && echo "locked $NEMA_LOCKED"

# 4. start the stack; each later step runs only if the one before succeeded.
#    If .env sets NEMA_HUB_PORT or NEMA_DATA_HOST_DIR, export the same values first.
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"   # Linux and macOS only
NEMA_DIR=${NEMA_DATA_HOST_DIR:-$HOME/.nema/data}
test -n "$NEMA_LOCKED" && mkdir -p -m 700 "$NEMA_DIR" && test -w "$NEMA_DIR" \
  && NEMA_IMAGE_TAG=$NEMA_LOCKED docker compose up -d --wait && NEMA_UP=1

# 5. install the host daemon at the locked version
test -n "$NEMA_UP" && npm i -g "@nema-project/nema@$NEMA_LOCKED" && NEMA_INSTALLED=1

# 6. start the host daemon and keep it running; Compose does not run it.
#    It reads the daemon-token the hub wrote in the data directory.
test -n "$NEMA_INSTALLED" \
  && NEMA_DATA_DIR=$NEMA_DIR nema daemon --hub "http://127.0.0.1:${NEMA_HUB_PORT:-4400}"
```

手順 1 は `.env` の最後の `NEMA_IMAGE_TAG`、つまり Compose が実際に使う値を読みます。値がなければ `releases/latest/download/` から現在の版を取得します。値があればその固定を使い続け、代わりに `releases/download/v<locked>/docker-compose.yml` からその版の資産を取得します。`0.1.4` と `0.1.5` にはリリース資産がないため、そのダウンロードが 404 になったあと、その tag 自身のファイル `raw.githubusercontent.com/Nema-Project/nema-room/v<locked>/docker-compose.yml` を取得します。このファイルは両イメージをその版に固定しています。latest はリリースのたびに変わりますが、版付きのアドレスはその Release がある限り変わりません。手順 2 は hub と web が同じ版に固定されているときだけその版を表示し、手順 3 はその版が実際に有効な固定でもあるときだけ `locked <版>` を表示します。どちらかが何も表示しなければ止めます。以降の各手順は前の手順が成功したときだけ実行されます。ダウンロード・確認・起動・インストールのどれかが失敗すると残りは止まり、古いファイルや古い `nema` のまま進むことはありません。手順 4 では、セットアップウィザードと同じく自分のユーザーでデータディレクトリを作って書き込めることを確かめ、固定した版を Compose に明示的に渡すので、シェルで export した `NEMA_IMAGE_TAG` に上書きされません。`--wait` はサービスが healthy になってから戻るので、その時点で hub は手順 6 のための `daemon-token` を書き終えています。手順 1 と 3 が読むのは `NEMA_IMAGE_TAG=<版>` という素の行だけで、手で編集した `.env`（引用符・コメント・CRLF）では止まります。その場合や、同じディレクトリで 2 つのインストールが同時に走りうる場合は、チェックアウトから `scripts/install/public.mjs` を使ってください。Compose と同じ方法で値を読み、ロックファイルの下で `.env` と `docker-compose.yml` をまとめて書き込みます。v0.1.6 の資産の先頭には、テンプレートでありインストール可能な版ではないというリポジトリのテンプレートのコメントが残っています。このコメントは古く、固定された 2 行の `image:` が正しい情報です。v0.1.6 より後の Release では、先頭のコメントに自分の版が書かれます。エージェントのタスクには、手順 6 の daemon が動き続けている必要があります。Release の公開直後は、イメージや npm パッケージがまだ公開中のことがあります。手順 4 がイメージを pull できない、または手順 5 がその版を見つけられないときは、少し待ってから手順をやり直すか、チェックアウトから `node scripts/install/public.mjs --check` を実行してください。インストール前に Compose 資産・2 つのイメージ・npm パッケージがそろっていることを確かめます。リリースのダウンロード先はリダイレクトするので `-L` は省けません。Windows の Docker Desktop では手順 4 の export は不要です。

ホストのポートは `NEMA_HUB_PORT`（既定 4400。コンテナも同じポートで待ち受けます）と `NEMA_WEB_PORT`（既定 3000。コンテナ内は 3000 のまま）に従います。公開 web イメージは起動時に `NEMA_HUB_URL` を読みます。compose の既定値は `http://127.0.0.1:$NEMA_HUB_PORT` なので、ポートを変えてもイメージの再ビルドは不要です。

公開版のインストールには、入れる Release の Compose 資産を使い、同じ版の daemon を入れます。版はそのファイルで両イメージが固定されているバージョンです。main は公開済みの成果物より先に進むことがあるため、開発には `npm run up` でソースからビルドします。成果物の公開は実機・機能の受け入れ確認の代わりにはなりません。

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

<a id="attachments"></a>

### 実行方式ごとの添付対応

画像と PDF はプロバイダー自身のネイティブ形式（Responses API の `input_image` / `input_file`、Claude の `image` ブロック）で送ります。Nema は変換も別形式への切り替えもしません。プロバイダーやモデルが読むかどうか、どう読むかはプロバイダー次第です。テキストファイルは常に文字としてメッセージに入れます。

| 実行方式 | 画像 | PDF | テキストファイル | 根拠 |
| --- | --- | --- | --- | --- |
| Claude Code | ネイティブ | 送信前に拒否：Claude Code が PDF ブロックをモデルに渡すか未確認 | 文字として | 文書：画像は公式の stream-json の例に従う。実測なし |
| ChatGPT でサインイン（`siwc`） | ネイティブ | ネイティブ | 文字として | 文書：OpenAI Responses API。実測なし |
| BYOK、既定の `https://api.openai.com/v1` | ネイティブ | ネイティブ | 文字として | 文書：同上。実測なし |
| BYOK、ほかの `byokBaseUrl`（OpenRouter、自前のサーバーなど） | ネイティブ | ネイティブ | 文字として | プロバイダー次第。実測（2026-10-30、OpenRouter の `:free` モデル）：画像対応モデルは画像を読めた。テキスト専用モデルに画像を送ると OpenRouter が 404 を返し、Nema はそのとおりに伝えた。PDF は実測なし |
| Codex ログイン互換（`compat`） | ネイティブ | ネイティブ | 文字として | 非公開のバックエンドで文書なし。実測なし |

**プロバイダーが拒否したとき**：プロバイダーがそのファイルについて 4xx を返すと、タスクは「プロバイダーまたはモデルがこの PDF（またはこの画像）を拒否しました」という内容で失敗し、プロバイダーの原文を添えます。Nema は再試行も代替手段への切り替えもせず、PDF を文字に変換することもしません。プロバイダーがどのブロックかを示したときはそのファイルだけを挙げ、添付が複数あって示されないときは「プロバイダーはどれかを示していません」と伝えます。それ以外のエラーはプロバイダーの言葉のまま表示します。画像や PDF を含むリクエストは、5xx や接続の切断のあとも自動では再試行しません。プロバイダーがすでにファイルを処理して課金している可能性があるためです。

**リスク**：互換サーバーの中には、理解できないファイルブロックを拒否せず黙って捨てるものがあります。その場合モデルはファイルを読まないまま答え、Nema はそれに気づけません。結果が重要なときは、そのファイルにしか出てこない語を含む小さなファイルで先に試してください。

**費用**：PDF をサーバー側で解析するプロバイダーもあります。これはプロバイダー自身の動作で、Nema は介入しません。たとえば OpenRouter は、モデルがファイルを直接読めない場合、既定で有料の OCR エンジンで解析し、BYOK でも課金されます。エンジンと料金は [OpenRouter PDF Inputs](https://openrouter.ai/docs/features/multimodal/pdfs) を参照してください。

**第三者の PDF 解析が必要なら**、関連する MCP サーバーや Skills を各自でインストールできます。

実モデルでの記録は[検証記録](reviews/2026-10-30-attachments-model-acceptance.md)にあります。

- **種類**は中身で判定し、拡張子は中身と一致している必要があります：PNG、JPEG、WebP、GIF、PDF、NUL を含まない厳密な UTF-8 テキスト。テキストファイルは拡張子なし、または次のいずれかの拡張子に限ります：txt, md, markdown, log, csv, tsv, json, jsonl, yaml, yml, toml, ini, xml, html, css, js, mjs, cjs, ts, tsx, jsx, py, rb, go, rs, java, kt, swift, c, h, cc, cpp, hpp, cs, php, sh, bash, zsh, sql, diff, patch。拡張子と中身が食い違うファイルは拒否し、SVG、HEIC、Office 文書、圧縮ファイル、音声、動画も拒否します。
- **上限**：画像 10 MB、PDF 20 MB、テキストファイル 512 KB。1 つのタスクで最大 8 個・合計 32 MB で、そのメッセージ、引用元のメッセージ、スレッドの最初のメッセージを合わせて数えます。すべての添付の合計は `NEMA_ATTACHMENTS_MAX_BYTES`（既定 2 GB）が上限で、アップロード後にデータディスクの空きが 1 GB を下回る場合は拒否します。選んだまま送らなかったファイルは 24 時間後に消えます。
- **モデルへの説明**：添付はデータです。そこから読み取った内容はモデルの推測で、あなたが言ったことや決めたことではありません。解釈の引用はメッセージの文章からだけ取れます。
- **削除**（カードの「削除」を押して確認）するとファイルはすぐ消え、メッセージには名前、種類、サイズ、sha256、削除時刻の記録が残ります。ディスクから消えたファイルは「添付ファイルが見つかりません」と表示されます。

<a id="workflow"></a>

## 議論から実装まで

1. **議論**：メモを送り、知識パネルで Agent の解釈を確認、確定、修正、取り下げできます。任意のメッセージを引用でき、自分のメッセージは編集できます（以前の文は残り、Agent が新しい文でやり直します）。ヘッダーのアイコンから、キーワードでこのワークスペースを検索できます。`/` でコマンドメニューが開きます。図の種類は `/diagram:sequence` のように並び、入力に合わせて絞られます。長いやり取りには `/thread` で新しい thread を開始できます。比較や利害の検討を求められ、まだ決めていないときは、Agent が先に会話を thread に移して議論します。thread は独立したウィンドウで開き、サイドバーの未読バッジから次に対応が必要な thread を開けます。Agent は copilot として自然に応答し、メモの確認、雑談、疑問形のアイデア、利点と欠点の質問では知識を書き込みません。議論や thread に残すよう頼むことも書き込みではありません。主チャットと thread には同じ記録ルールが適用されます。未決定の比較では question エントリを作りません。ユーザーが既存の決定を明確に覆していないときは、その決定を保持して現在の thread で質問します。明確な上書き指示があれば、古い決定を superseded にして新しい決定を記録します。進捗を尋ねたり、既存の図を更新したりすることもできます。
2. **コード連携**：設定のシステムフォルダ選択でローカル Git リポジトリを登録します。選択後にリモートと検出したメインブランチを表示し、名前はフォルダ名を使います。その名前が既にあるときだけ入力します。ダイアログはホストの daemon が開きます。Windows はエクスプローラー形式の選択です。Graphify はインストール先の `tools/graphify/` から読みます。PATH からは入れず、実行時にダウンロードもしません。`desktop:stage` が固定した CPython 3.11.18 と graphifyy 0.9.95 をこのディレクトリへ入れ、起動ファイルは自分からの相対パスだけを使います。同梱インタプリタは `python/bin/python3.11` です。Tree-sitter の文法は JavaScript、TypeScript、TSX、Python、Go、Rust、Java、C、C++、C#、Ruby、PHP、Swift、Kotlin、Bash、JSON を残します。この固定版に YAML、TOML、HTML、CSS、Markdown の文法 wheel はありません。文法が無いファイルは警告して飛ばし、抽出は完了します。無いときは索引とコード検索が `随包的 Graphify 运行环境缺失` と報告し、プラグインページも同じ文を表示します。そこの「修復」は再チェックするだけで、ランタイムを戻すことはできません。リポジトリの登録時に一度索引を作ります。全量の抽出には数分かかることがあります。索引中はチャットに進捗が出て、終わるとコードについて質問できる旨が表示されます。アーキテクチャ図はその索引の後に描き、その間も進捗を表示します。その後 daemon は時計どおりに `git fetch` しません。タスクがそのリポジトリのコードを初めて読むときだけメインブランチを fetch し、コミット済みのスナップショットを読みます。未コミットの変更は含みません。同じタスクの後続の読み取りは、その結果を再利用します。
3. **開発パッケージ生成**：active な要件を選び、`superpowers` を有効にして spec と plan を生成します。情報不足の場合、`grill-me` が質問を作成して生成を止めます。チャットのその確認の下で回答すると、生成は自動で再試行します。未解決の古い確認も、そのカードから回答できます。
4. **承認と引き継ぎ**：人が確認・承認し、コーディング Agent に取得させます。編集や再生成で承認は取り消されます。
5. **報告と検証**：`reported`、`verified`、`mismatch` を記録します。**引用したすべての報告が Git 照合を通ると、`verified` は「コミットは照合済み」と表示されます。テスト合格、機能の正しさ、要件の受け入れ完了は保証しません。あなたが要件を確認すると「受け入れ確認済み」と表示されます。** 「コミットは照合済み」の要件はあなたが受け入れられます。後で引用した報告の照合が変わると再確認が必要と表示され、「引き続き受け入れる」はその表示だけを消します。あなたが確認した開発パッケージのタスクは「タスク完了を確認済み」と表示され、要件の受け入れではありません。チャットの各報告では、エージェントの主張と hub の照合（Git の 3 項目、コミットの作成者、GitHub の読み取り。失敗した check run は赤）を分けて表示します。

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

作業中の内容は先に進行中の報告として送れます：`nema report --progress in_progress --summary "…"`（`--json` なら `"progress":"in_progress"`）。コミットがなくても送れますが、開発パッケージのタスクは進みません。作業が終わったら `completed` の報告（コミット 1 つ以上）を送ってください。

GitHub プラグインは既定で無効です。有効化、`gh` のログイン、書き込みの許可は上のデスクトップアプリの節と同じです。Web / Compose の daemon も同じ経路です。コマンドの許可表と、以前からの 6 つの読み取り関数は技術リファレンスにあります。`nema auth github` は今もトークンを `~/.nema/github-token` に書けますが、既定の経路はそれを読みません。

プラグインページ（左下の設定内）では、各拡張に「無効化」/「有効化」ボタンがあります。押すとすぐ反映され、再起動は要りません。無効化した拡張の関数は Agent のツール一覧に出なくなり、直接呼ぶと拒否されます。このスイッチはインストール全体に効き、ワークスペース側のスイッチも別に必要です（両方が有効なときだけ使えます）。同梱の拡張を無効化しても、出荷時の定義は変えず上書きの 1 行だけを保存します。Nema がインストールした拡張には「アンインストール」があり、ディレクトリごと削除します。Nema の外で見つけた拡張は「一覧から外す」だけで、記録を消すだけでファイルはそのまま残ります。同梱の拡張には削除の操作がなく、有効化と無効化だけです。詳細は技術リファレンスの「拡張の有効化・無効化とアンインストール」にあります。

Skill をインストールするには、プラグインページ上部の「Skill をインストール」に GitHub リポジトリ、その中のフォルダか `SKILL.md` へのリンク、または skills.sh のページを貼って「プレビュー」を押します。プレビューには、ソースが固定されたコミット、GitHub が報告するライセンス、見つかった各 Skill とインストール先のフォルダが表示されます。インストールできない Skill には理由が出ます。「インストール」はその Skill のフォルダだけをそのコミットのまま取り込み、下の行に完了したファイル数と総数を表示します。実行中は「インストールを取り消す」が使えます。失敗すると行に理由が出て「インストールを再試行」で同じコミットからやり直せます。今は公開リポジトリだけに対応しています。詳細は技術リファレンスの「安装 Skill」（中国語）にあります。

チャットで頼むこともできます（例：「anthropics/skills から pdf の skill をインストールして」）。Agent は「プレビュー」ボタンと同じようにソースを 1 つのコミットに固定し、返信の下に Skill の名前、説明、リポジトリ、コミット、ライセンス、インストール先フォルダを載せたカードを置きます。Agent 自身は何もインストールできません。カードの「インストール」を押したときだけインストールされ、プラグインページと同じインストール処理を通り、同じ進捗表示と「インストールを取り消す」が出ます。ソースに複数の Skill があるときは、Agent がどれにするか尋ねます。インストールカードが出るのは自分が送ったメッセージへの返信だけで、システムリクエストや coding agent の報告では出ません。

ページは 2 つに分かれています。「インストール済み」には、同梱の項目、Nema がインストールした Skill（失敗したものも理由と「インストールを再試行」付きでここに残ります）、Nema の外で見つけた項目など、今あるものがすべて並びます。「見つけてインストール」には「Skill をインストール」と、インストールを取り消した記録があり、そこから再びインストールできます。上の「種類」（すべて、Skills、MCP、プラグイン）と検索欄は両方をまとめて絞り込みます。検索は名前、説明、ソース、id を大文字小文字を区別せずに照合します。「このコンピューターで見つかったもの」のフォルダーも同じように絞り込みます（名前、説明、パス、id で照合し、どれも Skill なので MCP やプラグインを選ぶと表示しません）。どちらも表示を変えるだけで、hub には何も送りません。

リポジトリの Skill：「コードとプラグイン」で、紐付けた各リポジトリに「このリポジトリの Skills を信頼する」スイッチがあり、既定ではオフです。オンにする前に、メインブランチにコミットされた `.agents/skills` と `.claude/skills` の指示が agent に渡されること、リポジトリにコミットできる人は誰でもその内容を変えられることが表示されます。次のタスクから有効になります。daemon は各タスクの前にメインブランチを取得し（同じリポジトリでは 5 分に 1 回まで）、コミット済みの内容だけを読みます。コミットしていない変更は含まれません。両方のフォルダーに同じ名前の Skill があるときは `.agents/skills` のものを使います。自分でインストールした Skill や別のリポジトリの Skill と名前が重なるときは、リポジトリのものが `<リポジトリ名>:<名前>` になります。

Skill を自分で呼び出す：メッセージを `/名前` で始めると、その Skill の指示がタスクに入り、残りの文がその引数になります（Skill の `$ARGUMENTS` がこの文に置き換わります）。メッセージの先頭で `/` を入力すると、メニューの組み込みコマンドの下に「Skills」グループが並び、名前や説明で絞り込めます。組み込みコマンドが優先です。組み込みコマンドと同じ名前の Skill は `/skill:名前` と表示され、選ぶとその形で入ります。その他の Skill は `/名前` で、`/skill:名前` でも呼べます。リポジトリの Skill は `/<リポジトリ名>:名前` です。モデルが自分では選ばない設定の Skill もこの方法で呼べます。メッセージの途中の `/名前` は呼び出しになりません。

「見つけてインストール」の「このコンピューターで見つかったもの」には、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` の直下にある Skill フォルダーが並びます。Nema が開くのは各フォルダーの `SKILL.md`（最大 256 KiB）だけで、使うのはその front matter だけです。隠しフォルダーは飛ばし、置き場所の外を指すリンクは説明付きで表示するだけで読み込みません。置き場所はあるのに読めない場合はそう表示し、読めない `SKILL.md` はそのフォルダーだけに印を付けます。「接続」はフォルダーの実際のパスを Nema の外で見つけた拡張として記録し、有効にします。何もコピーせず、あとで「一覧から外す」を押しても記録が消えるだけです。ほかの場所のフォルダーも、パスを入力するか「選択…」で選んで同じように接続できます。`SKILL.md` に name と description がない、名前が組み込みや別の拡張と重なる、すでに接続済み、といった場合は接続を断り、その場で理由を表示します。

MCP サーバーは「見つけてインストール」の「MCP サーバーを追加…」から追加します。stdio のサーバーにはコマンド、1 行に 1 つの引数、任意で絶対パスの作業ディレクトリと環境変数の行を指定します。HTTP のサーバーには URL（https。平文の http は 127.0.0.1、::1、localhost のみ）と任意のヘッダー行を指定します。各行は `NAME=value`、daemon の環境変数から取る `NAME=env:VAR`、保存した認証情報を使う `NAME=secret:REF` のいずれかです（これらの接頭辞で始まる値をそのまま使うには `NAME=value:…`）。名前が認証情報らしい変数やヘッダー（token、key、secret、password、auth、cookie、session、credential を含むもの）は参照でなければならず、値を直接書くと保存が拒否されます。エラーには欄の名前だけが出て、値は出ません。保存すると、サーバーの行に接続状態（未接続、接続中、接続済み、ログインが必要、接続エラー）、「起動」または「停止」、「編集」、最後のエラー、サーバー自身の名前とバージョン、提供するツールが表示されます。`secret:` の参照ごとに書き込み専用の欄があり、「保存」で値を保存して欄を空にし、「消去」で削除します。行には「設定済み」か「未設定」だけが表示されます。実行中のサーバーは新しい値で再起動します。コマンド、引数、作業ディレクトリ、URL を変えると保存した認証情報は削除されるので、認証情報が別の接続先へ渡ることはありません。MCP サーバーを無効化またはアンインストールすると、先に停止します。daemon は終了時（Ctrl+C、SIGTERM、SIGHUP を受けたときも含みます。もう一度 Ctrl+C を押すとすぐに終了します）にすべての MCP サーバーを停止し、自動では起動し直しません。daemon が強制終了やクラッシュで止まった場合、macOS / Linux では次に起動した daemon が他の操作より先に、残っていた stdio サーバーを停止し、その行に前の daemon が残したコピーを停止したと表示します。必要なら「起動」で起動し直してください。保存が途中で中断された場合や `mcp.json` が Nema の外で変更された場合、次の起動後に行が「設定が壊れている」と表示します。「編集」で同じ ID のまま入力し直すか、「アンインストール」でサーバーと認証情報を削除できます。このリリースでは MCP のツールを Agent に渡しません。

ターミナルからも同じことができます：`nema mcp add <id> --name <name> --command <cmd> [--arg …] [--env NAME=…]`（HTTP は `--url` と `--header`）、`nema mcp edit`、`nema mcp list`、`nema mcp status <id>`、`nema mcp start <id>`、`nema mcp stop <id>`、`nema mcp secret set <id> <name>`（値は標準入力から読みます）、`nema mcp secret clear <id> <name>`。サブコマンドなしの `nema mcp` は、これまでどおり Codex と Claude が起動する Room MCP サーバーです。デスクトップアプリでは hub の API にアプリのサインインが必要なので、プラグインページを使ってください。`nema mcp secret set|clear --desktop` はデスクトップアプリの認証情報ファイルを直接書きます。`nema mcp add` は既にある ID を拒否し、`secret set` は入力した行をそのまま保存します。

組み込みの各行には「修復」があり、すでに正常なら「再チェック」と表示されます。graphify では同梱の Graphify のバージョンチェックを実行します。通れば「チェック済み：使用できます。」と表示し、ランタイムがない、または実行できない場合はそう伝え、Nema を再インストールすると元に戻ると案内します。GitHub では GitHub CLI（`gh`）がインストール済みで github.com にサインインしているかを確認し、足りないほうを伝えます。ほかの組み込み項目はアプリの一部なので、使用できることを確認します。結果は保存され、ページは出荷時の既定値ではなく最後のチェック結果を表示します。「修復」がパッケージマネージャーを実行することはありません。

<a id="data"></a>

## データ・プライバシー・既知の制限

| 標準の保存先 | 内容 |
| --- | --- |
| PostgreSQL の Compose ボリューム `nema-pg` | チャット、タスク、ワークスペース設定、インデックスなど |
| `~/.nema/data` | daemon token、知識 Git リポジトリ、チャットの添付ファイル（`attachments/`） |
| `~/.nema` | ローカル設定、モデル・プラグイン認証情報、コード索引スナップショット、報告キャッシュなど |
| `~/.nema/desktop` | デスクトップアプリのデータベース、知識の Git リポジトリ、チャットの添付ファイル（`data/attachments/`）、実行状態。上の Compose のデータとは独立 |

**ソースリポジトリの GitHub コピーは、アプリデータのバックアップではありません。** 書き込みを止め、PostgreSQL のエクスポートと実際のデータディレクトリを保存し、復旧手順を検証してください。データ保持には `docker compose down -v` を使わないでください。`-v` は DB ボリュームを削除します。

- ローカル保存はオフライン推論ではありません。チャット、知識、ツールが返すコードをモデルプロバイダーへ送ります。GitHub プラグインが有効なとき、クエリはローカルの `gh` 経由で GitHub に送られます。書き込みはワークスペースで別に有効化する必要があります。機密ワークスペースはオフライン実行や OS レベルの隔離を意味しません。
- 添付は、それを使うタスクとともにモデルプロバイダーへ送られます。削除で消えるのはファイルだけで、モデルがすでに受け取った内容は取り消せません。メッセージを引用すると、その添付も一緒に送られます。バックアップでは `attachments/` をデータベースと一緒に保存してください。記録だけ残ってファイルがない添付は「見つかりません」と表示されます。
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

ルートの typecheck は web を含みません。web は個別にビルドしてください。ソースのチェックアウトを更新する前にデータをバックアップし、`git pull`、`npm ci`、CLI の再ビルド、`npm run up`、daemon の再起動を行います。daemon は `GET /api/version` が返す hub のバージョンに合わせます。違う場合は `run: npm i -g @nema-project/nema@<バージョン>` を出して再接続しません。ソースのチェックアウトでは、daemon をこのツリーからビルドし、バージョンの選択に `NEMA_IMAGE_TAG` は使いません。`@nema-project/nema@0.1.3` は 2026-10-27 から npm にあります。

ポートや保存先は [.env.example](../.env.example) を参照してください。CLI はルートの `.env` を自動で読みません。保存先を変更したら shell で `NEMA_DATA_DIR` を export するか、`daemon` / `doctor` に `--token-file` を指定します。hub のポートを変えたら `--hub` も指定してください。Compose は `NEMA_HUB_PORT`（既定 4400。ホストとコンテナは同じポート）と `NEMA_WEB_PORT`（既定 3000。コンテナ内は 3000 のまま）を読みます。web コンテナは起動時に `NEMA_HUB_URL` を読みます。Compose の既定値は `http://127.0.0.1:$NEMA_HUB_PORT` です。ブラウザが別のアドレスで hub に届くときだけ `NEMA_HUB_URL` を設定してください。`NEXT_PUBLIC_HUB_URL` は `npm run dev` が読む値で、イメージの中では焼き込まれた代替値にすぎません。

## セキュリティ報告

セキュリティ上の問題は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送り、[セキュリティポリシー](../SECURITY.md) を確認してください。公開 issue や PR に機密情報を書かないでください。管理者ではない read 権限のアカウントが 2026-10-27 にフォームへ到達し、テスト報告は同日、未公開のまま閉じられました。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。
