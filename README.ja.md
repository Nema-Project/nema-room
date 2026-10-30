<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>議論から実装まで、プロジェクトの理解を揃える。</strong></p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest"><img src="https://img.shields.io/github/v/release/Nema-Project/nema-room?style=flat-square&color=555" alt="Latest release" /></a>
<a href="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml"><img src="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="License: MIT" /></a>
</p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest">ダウンロード</a> ·
<a href="#クイックスタート">クイックスタート</a> ·
<a href="#議論から実装まで">ワークフロー</a> ·
<a href="#ドキュメントとフィードバック">ドキュメント</a> ·
<a href="ROADMAP.md">ロードマップ</a>
</p>

<p><a href="README.zh.md">简体中文</a> · <a href="README.md">English</a> · <strong>日本語</strong></p>

</div>

Nema Room は、ソフトウェアプロジェクトの理解を揃えるための、手元で動くコパイロットです。依頼や制約、トレードオフは散らばりやすく、同じ要件でも読み方が分かれることがあります。ここで Agent と議論し、出典と Git の履歴を残し、自分の発言と Agent の推論を分け、食い違いを計画にする前に解消します。承認した spec と plan を **Codex や Claude Code** に渡し、コミット報告は議論へ戻します。

<img src="docs/screenshots/room-ja.png" width="1100" alt="請求書エクスポートの議論と、知識パネルに整理された要件・決定・未回答の質問。" />

<p align="center"><sub>サンプルの議論と、確認・修正・追跡できる知識の項目。</sub></p>

<a id="主な機能"></a>

## Nema Room でできること

- **理解を揃える。** 散らばった記録を一つの記録にまとめます。新しい発言が有効な決定と食い違うときは、コパイロットがスレッドで尋ね、あなたの判断を待ちます。
- **判断の根拠を残す。** 要件、決定、トレードオフ、未解決の質問に出典を保持。ユーザーの発言と Agent の推論を区別します。
- **知識をバージョン管理。** 変更は Git に記録。項目を修正・取り下げても、履歴と出典は残ります。
- **コードを踏まえて議論。** ローカルリポジトリを登録し、メインブランチのコミット済みコードを検索。図の生成や、古くなった図の表示にも対応します。
- **意図を引き継ぐ。** 開発パッケージを生成し、不明点を解消。人が spec と plan を承認してから、コーディング Agent に渡します。
- **証拠を議論に戻す。** コミット報告を要件に結び付け、その Git の証拠を議論の中で確認します。

**なぜ Nema？** 名は根回しに由来します。決定の前に理解を揃えつつ、食い違いも根拠も見える形で残します。

日本語・英語・中国語の UI · ライト／ダークテーマ · 独立した議論スレッド

<details>
<summary>要件の根拠を見る</summary>

元の発言と記録した理由を確認し、ユーザーの発言と Agent の推論を区別できます。

<img src="docs/screenshots/entry-ja.png" width="1100" alt="元の発言、記録した理由、根拠の種類を示す要件。" />

</details>

## クイックスタート

<a id="デスクトップアプリプレビュー"></a>

### デスクトップアプリ

[最新リリース](https://github.com/Nema-Project/nema-room/releases/latest)からデスクトップ版を 1 つダウンロードします。Windows では 2 つのダウンロードから 1 つを選びます。

| プラットフォーム | ダウンロード |
| --- | --- |
| Windows x64 | `.exe` インストーラー、または `.zip` ポータブル版 |
| macOS · Apple シリコン | `.dmg` |
| Linux / Intel Mac | 下記の Web / Compose を使用 |

Windows の `.exe` は NSIS インストーラーです。ショートカット、アンインストール、上書き更新が使えます。`.zip` は展開してそのまま実行するアプリです。展開して `Nema.exe` を実行します。ショートカットもアンインストーラーもなく、インストーラーの繰り返しコピーを避けられます。どちらも `~/.nema/desktop` を使います。どちらか一方を選んでください。

1. [Git 2.31 以降](https://git-scm.com/downloads)をインストールしてから、Nema Room をインストールして開くか、ポータブル ZIP を展開して `Nema.exe` を実行します。Node とローカル DB は同梱されており、Docker は不要です。
2. **アプリ設定 → モデル**で ChatGPT サブスクリプション、Claude サブスクリプション、または Responses API 互換の API キーを接続します。利用可否や料金はプロバイダーによります。
3. ワークスペースを作成して議論を始めます。コードの文脈が必要になったら、ローカルリポジトリを登録します。

> **プレビュー版。** Windows のインストーラーとポータブル ZIP は未署名、macOS はアドホック署名で未公証です。リリースのチェックサムでダウンロードを確認してください。アプリは更新をダウンロードもインストールもしません。GitHub の新しい安定版を確認し、そのリリースページへリンクします。**アプリ設定 → 情報**の「更新を自動で確認する」で止められます。更新前にトレイから終了し、`~/.nema/desktop` をバックアップしてください。2026-10-27 のホストされた Windows と macOS ランナーで、使い捨てデータディレクトリの移行とバックアップ復元は通りました。同じ日、メンテナーが macOS と Windows で新しいパッケージを既存のインストールに上書きし、workspace のデータはどちらも残っていました。初回起動と制限は[デスクトップガイド](docs/guide.ja.md#desktop)を参照してください。

<a id="初回リリースの範囲と動作条件"></a>

### Web / Compose

このリポジトリを開発するときは、チェックアウトから PostgreSQL、hub、web をビルドします。tag `v0.1.4` がイメージを初めて公開するリリースです。daemon はイメージに入っていません。ホストで動かします。daemon のパッケージは `@nema-project/nema` です。`@nema-project/nema@0.1.3` は 2026-10-27 に npm へ公開され、その手動公開は [scripts/npm/RELEASE.md](scripts/npm/RELEASE.md) に記録しています。Windows、macOS、Linux 上の **Node.js ≥ 22**、**Git**、**Docker**、**Docker Compose v2** が必要です。

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
# Linux と macOS のみ。Windows の Docker Desktop では不要です。
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
node scripts/setup.mjs --lang ja
```

ウィザードが依存関係を確認し、CLI をビルドしてソースからサービスを起動し、モデル設定を案内します。ホストの daemon は起動したままにしてください。既存の `.env` は保持されます。`npm run up` は同じソースビルドです。Linux と macOS では、UID/GID が 1000 でもそれ以外でも、上と同じように `NEMA_UID` と `NEMA_GID` を export してから `npm run up` してください。hub がデータディレクトリへ書き込めます。Windows の Docker Desktop ではこの export は不要です。その後 [localhost:3000](http://localhost:3000) を開きます。公開用 compose ファイルにビルド手順はありません。

clone せずにピン留めしたイメージを pull できるのは tag `v0.1.4` からです。この tag はイメージ公開ワークフローを含み、これらのイメージの最初の公開です（`linux/amd64`。arm64 は [issue #50](https://github.com/Nema-Project/nema-room/issues/50)）。このリポジトリのツリーにある `docker-compose.yml` はテンプレートです。hub と web の `image:` は `${NEMA_IMAGE_TAG:-latest}` の展開で、ツリーには使えるバージョンがありません。`v0.1.6` 以降の各 Release には、hub と web のイメージをその Release の版に固定したレンダリング済み `docker-compose.yml` が添付されます。これはその Release の固定名の資産なので、現在の版は常に [`releases/latest/download/docker-compose.yml`](https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml) にあります。インストール時はその版をローカルの `.env` の `NEMA_IMAGE_TAG` に固定します。clone しないインストール手順：

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

ホストのポートは `NEMA_HUB_PORT`（既定 4400。コンテナも同じポートで待ち受けます）と `NEMA_WEB_PORT`（既定 3000。コンテナ内は 3000 のまま）に従います。`NEMA_HUB_URL` の既定値は `http://127.0.0.1:$NEMA_HUB_PORT` で、web コンテナの起動時に読まれるので、公開イメージを再ビルドせずにアドレスを変えられます。

公開版のインストールには、入れる Release の Compose 資産を使い、同じ版の daemon を入れます。版はそのファイルで両イメージが固定されているバージョンです。main は公開済みの成果物より先に進むことがあるため、開発には `npm run up` でソースからビルドします。成果物の公開は実機・機能の受け入れ確認の代わりにはなりません。

[手動インストールと設定](docs/guide.ja.md#source-installation) · 環境の確認のみ：`node scripts/setup.mjs --lang ja --check`

ホストの daemon は npm パッケージ `@nema-project/nema` です（Node.js ≥ 22）。コマンド名は `nema` です。`@nema-project/nema@0.1.3` は 2026-10-27 にメンテナーのアカウントから公開されました。`v0.1.4` は `scripts/npm/RELEASE.md` の trusted publisher による最初の公開です。実行中の hub と同じバージョンを入れます。

```sh
npx @nema-project/nema@<hub のバージョン> --version
npm i -g @nema-project/nema@<hub のバージョン>
```

上のコマンドのバージョンは、取得した `docker-compose.yml` の 2 つの `image:` が固定している版です。`grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` で表示され、`nema-room-web:` の側も同じ値を表示しなければなりません。ソースのチェックアウトでは daemon をこのツリーからビルドし、この方法ではバージョンを選びません。ソースのチェックアウトには `scripts/install/public.mjs` も入っています。公開済みの 1 つの版を解決し、その版の Compose 資産・2 つのイメージ・npm パッケージがそろっていることを確かめてから、`NEMA_IMAGE_TAG` と対応する `docker-compose.yml` をまとめて対象ディレクトリに書き込みます。まず `--check` を付けると検証だけで何も書きません。読むのはその Release 自身の `docker-compose.yml` 資産で、資産がない版は拒否します。`v0.1.6` より前の Release にはこの資産がありません。

Compose はそのバージョンを `http://127.0.0.1:4400/api/version` で返します。デスクトップ版は **アプリ設定 → 情報** に表示し、ループバックの `GET /_nema/version` でも読めます。バージョンが違うと daemon は `run: npm i -g @nema-project/nema@<バージョン>` を出して再接続しません。`nema daemon` の `--hub` の既定値は `http://127.0.0.1:4400` で、トークンは `$NEMA_DATA_DIR` または `~/.nema/data` の `daemon-token` です。hub が起動時にそのファイルを書きます。Compose はホストのデータディレクトリを `/data` にマウントします。

このリポジトリの開発は上のソースインストールのままです。バージョンを付けない `@nema-project/nema` を入れて hub と一致するとみなさないでください。

## 議論から実装まで

実装はループです。コミット報告は議論に戻ります。

1. **議論** — アイデアやトレードオフを送り、Agent の解釈を確認。`/thread` で独立した議論を始めます。
2. **接続** — ローカルリポジトリを登録し、コミット済みのコードを議論に取り込みます。
3. **整理** — `superpowers` を有効にし、active な要件から spec と plan を含む開発パッケージを生成。不明点に回答します。
4. **承認** — 人が確認・承認した後、コーディング Agent が取得。編集や再生成で承認は取り消されます。
5. **追跡** — コミット報告と、それに紐づく Git の証拠を議論へ戻します。

```text
Discussion → Requirements + decisions → Approved spec + plan → Coding agent
                      ↑                                           │
                      └──────────── Commit reports ────────────────┘
```

ソースからのインストールでは、Nema Room のルートで一度 `npm link --workspace @nema/cli` を実行し、登録済みのコードリポジトリで次を実行します。

```sh
nema wp list
nema wp get W-1
```

[CLI の報告と hooks](docs/guide.ja.md#workflow)で実装の進捗をルームに戻せます。デスクトップ版では[同梱の CLI ランチャー](docs/guide.ja.md#desktop)を使います。

**`verified` には 2 種類あります。** 「コミットは照合済み」は、引用したコミットが存在し、main 上にあり、報告が主張したファイルを変更したことを示します。テスト合格や要件の受け入れ完了を意味しません。「受け入れ確認済み」は、あなた自身が要件を確認したことを示します。後で根拠にした報告の照合が変わると再確認が必要と表示され、「引き続き受け入れる」で受け入れを保てます。

<a id="データプライバシー既知の制限"></a>

## データと利用範囲

- **ローカルに保存。** デスクトップのデータは `~/.nema/desktop`。Web / Compose は PostgreSQL とローカルの知識 Git リポジトリを使用します。
- **モデルに文脈を送信。** チャット、知識、ツールが返すコードは選択したモデルプロバイダーに送られます。ローカル保存はオフライン推論ではありません。
- **GitHub は任意。** プラグインはログイン済みのローカル `gh` を使い、登録済みリポジトリだけにアクセス。書き込みには別途許可が必要です。
- **MCP サーバーは設定できますが、まだ Agent には渡しません。** プラグインページ（または `nema mcp add`）で stdio / HTTP の MCP サーバーを追加し、その場で起動・停止して、接続状態、サーバーが名乗る名前、ツールを確認できます。認証情報は所有者だけが読める `~/.nema/secrets/mcp/`（デスクトップアプリでは `~/.nema/desktop/secrets/mcp/`）に保存され、ページには設定済みかどうかだけが表示されます。置き換えと消去はできますが、読み出すことはできません。daemon は終了時（Ctrl+C、SIGTERM、SIGHUP を含む）に MCP サーバーを停止し、クラッシュ後は次に起動した daemon が残った stdio サーバーを停止して（macOS と Linux）その行に表示します。自動では起動し直しません。このリリースでは MCP のツールを Agent に渡しません。
- **プラグインページから Skill をインストール。** GitHub リポジトリか skills.sh のリンクを貼り、固定されたコミット、ライセンス、インストール先をプレビューで確かめてから Skill を 1 つ選んでインストールします。進捗、取り消し、再試行はその場に表示されます。チャットで頼むこともできます。Agent は返信の下に同じ内容のプレビューカードを置き、カードの「インストール」を押すまで何もインストールされません。ページは「インストール済み」と「見つけてインストール」に分かれ、種類で絞り込んだり検索したりできます。ほかの Agent が `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` に置いた Skill フォルダーは「このコンピューターで見つかったもの」に並び、その場所のまま接続できます。ほかのフォルダーも接続できます。Nema はファイルをコピーしません。組み込みの項目には「修復」（正常になると「再チェック」）があり、もう一度チェックして結果を表示します。
- **添付ファイルもモデルに送信。** チャットのメッセージとスレッドの返信には、画像（PNG、JPEG、WebP、GIF）、PDF、UTF-8 のテキストファイルを添付できます。貼り付け、ドロップ、添付ボタンのどれでも追加できます。ファイルは所有者だけが読める権限でデータディレクトリ（`~/.nema/data/attachments`、デスクトップアプリでは `~/.nema/desktop/data/attachments`）に保存され、タスクとともにモデルプロバイダーへ送られます。テキストファイルは文字として送り、画像と PDF は読めることが確認できている実行方式にだけ送ります。それ以外は送信前に入力欄で知らせ、タスクも理由付きで拒否するので、黙って捨てられることはありません。送信済みの添付を削除するとファイルが消え、削除記録（名前、種類、サイズ、sha256、時刻）が残ります。すでにモデルに送った内容は取り消せません。送信前に外した添付はそのまま破棄されます。詳しくは[実行方式ごとの添付対応](docs/guide.ja.md#attachments)を参照してください。
- **ローカル利用向け。** 公開サーバー用の複数ユーザー認証はありません。複数端末の同期、自動バックアップ、チームの閲覧専用アクセスは未対応です。

[保存先・バックアップ・既知の制限](docs/guide.ja.md#data)を参照してください。ソースリポジトリのコピーは、アプリデータのバックアップではありません。

<a id="モデルの実行方式"></a>
<a id="開発とアップグレード"></a>

## ドキュメントとフィードバック

[モデル設定](docs/guide.ja.md#models) · [開発とアップグレード](docs/guide.ja.md#development)

| ドキュメント | 内容 |
| --- | --- |
| [ユーザーガイド](docs/guide.ja.md) | インストール、モデル設定、デスクトップ操作、CLI、バックアップ、更新 |
| [技術リファレンス](docs/reference.zh-CN.md) · 中文 | コマンド、開発パッケージの書式、プラグイン、実装の詳細 |
| [Agent 開発ガイド](AGENTS.md) | ローカル・リモートのコーディング Agent 共通の開発規約 |
| [貢献ガイド](CONTRIBUTING.md) · 中文 | 開発環境、ディレクトリ構成、チェック |
| [デスクトップビルドガイド](scripts/desktop/README.md) | ネイティブビルド、同梱ツール、パッケージング |
| [ロードマップと受け入れ台帳](ROADMAP.md) · 中文 | 安定化の優先順位、TODO、受け入れの根拠 |
| [変更履歴](CHANGELOG.md) | 各リリースの変更 |
| [セキュリティポリシー](SECURITY.md) · 中文 | 報告方法とセキュリティの範囲 |

不具合やアイデアは [issue](https://github.com/Nema-Project/nema-room/issues/new/choose) へ。OS、インストール方法、機密情報を除いたエラーを記載してください。日本語・英語・中国語での貢献を歓迎します。

セキュリティ上の問題は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送り、[セキュリティポリシー](SECURITY.md) を確認してください。公開 issue や PR に機密情報を書かないでください。管理者ではない read 権限のアカウントが 2026-10-27 にフォームへ到達し、テスト報告は同日、未公開のまま閉じられました。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。

---

[MIT](LICENSE) © Nema-Project contributors。第三者のライセンスと出典：[archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md)。
