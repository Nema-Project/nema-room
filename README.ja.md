<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>議論からコードへ。文脈を引き継ぐ。</strong></p>

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

Nema Room は、AI Agent と要件を整理するローカルのワークスペースです。議論を出典と Git 履歴のある要件・決定にまとめ、spec と plan を確認・承認してから **Codex や Claude Code** に引き継ぎます。

<img src="docs/screenshots/room-ja.png" width="1100" alt="請求書エクスポートの議論と、知識パネルに整理された要件・決定・未回答の質問。" />

<p align="center"><sub>サンプルの議論と、確認・修正・追跡できる知識の項目。</sub></p>

<a id="主な機能"></a>

## Nema Room でできること

- **判断の根拠を残す。** 要件、決定、トレードオフ、未解決の質問に出典を保持。ユーザーの発言と Agent の推論を区別します。
- **知識をバージョン管理。** 変更は Git に記録。項目を修正・取り下げても、履歴と出典は残ります。
- **コードを踏まえて議論。** ローカルリポジトリを登録し、メインブランチのコミット済みコードを検索。図の生成や、古くなった図の表示にも対応します。
- **意図を引き継ぐ。** 開発パッケージを生成し、不明点を解消。人が spec と plan を承認してから、コーディング Agent に渡します。
- **実装の根拠を確認。** コミット報告を要件に結び付け、変更ファイルやメインブランチへの取り込みを確認できます。

日本語・英語・中国語の UI · ライト／ダークテーマ · 独立した議論スレッド

<details>
<summary>要件の根拠を見る</summary>

元の発言と記録した理由を確認し、ユーザーの発言と Agent の推論を区別できます。

<img src="docs/screenshots/entry-ja.png" width="1100" alt="元の発言、記録した理由、根拠の種類を示す要件。" />

</details>

## クイックスタート

<a id="デスクトップアプリプレビュー"></a>

### デスクトップアプリ

[最新リリース](https://github.com/Nema-Project/nema-room/releases/latest)からインストーラーをダウンロードします。

| プラットフォーム | インストール方法 |
| --- | --- |
| Windows x64 | `.exe` |
| macOS · Apple シリコン | `.dmg` |
| Linux / Intel Mac | 下記の Web / Compose を使用 |

1. [Git 2.31 以降](https://git-scm.com/downloads)をインストールしてから、Nema Room をインストールして開きます。Node とローカル DB は同梱されており、Docker は不要です。
2. **モデル設定**で ChatGPT サブスクリプション、Claude サブスクリプション、または Responses API 互換の API キーを接続します。利用可否や料金はプロバイダーによります。
3. ワークスペースを作成して議論を始めます。コードの文脈が必要になったら、ローカルリポジトリを登録します。

> **プレビュー版。** Windows は未署名、macOS はアドホック署名で未公証です。リリースのチェックサムでダウンロードを確認してください。自動更新はありません。更新前にトレイから終了し、`~/.nema/desktop` をバックアップしてください。2026-10-27 のホストされた Windows と macOS ランナーで、使い捨てデータディレクトリの移行とバックアップ復元は通りました。新しいパッケージで古いインストールを上書きする更新は未検証です。初回起動と制限は[デスクトップガイド](docs/guide.ja.md#desktop)を参照してください。

<a id="初回リリースの範囲と動作条件"></a>

### Web / Compose

Windows、macOS、Linux に対応。**Node.js ≥ 22**、**Git**、**Docker**、**Docker Compose v2** が必要です。

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang ja
```

ウィザードが依存関係を確認し、CLI をビルドしてサービスを起動し、モデル設定を案内します。[localhost:3000](http://localhost:3000) を開き、ホストの daemon は起動したままにしてください。既存の `.env` は保持されます。

[手動インストールと設定](docs/guide.ja.md#source-installation) · 環境の確認のみ：`node scripts/setup.mjs --lang ja --check`

CLI は private パッケージで、ソースからインストールします。`npx nema` は単独のインストール方法ではありません。

## 議論から実装まで

1. **議論** — アイデアやトレードオフを送り、Agent の解釈を確認。`/thread` で独立した議論を始めます。
2. **接続** — ローカルリポジトリを登録し、コミット済みのコードを議論に取り込みます。
3. **整理** — `superpowers` を有効にし、active な要件から spec と plan を含む開発パッケージを生成。不明点に回答します。
4. **承認** — 人が確認・承認した後、コーディング Agent が取得。編集や再生成で承認は取り消されます。
5. **追跡** — コミット報告を確認し、要件と実装を結ぶ根拠をたどります。

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

**`verified` は Git の証拠が検査を通ったか、ユーザーが確認したことを示します。** テスト合格や要件の受け入れ完了を意味しません。

<a id="データプライバシー既知の制限"></a>

## データと利用範囲

- **ローカルに保存。** デスクトップのデータは `~/.nema/desktop`。Web / Compose は PostgreSQL とローカルの知識 Git リポジトリを使用します。
- **モデルに文脈を送信。** チャット、知識、ツールが返すコードは選択したモデルプロバイダーに送られます。ローカル保存はオフライン推論ではありません。
- **GitHub は任意。** プラグインはログイン済みのローカル `gh` を使い、登録済みリポジトリだけにアクセス。書き込みには別途許可が必要です。
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

セキュリティ上の問題は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送り、[セキュリティポリシー](SECURITY.md) を確認してください。公開 issue や PR に機密情報を書かないでください。管理者ではないアカウントでサインインしてフォームを開く確認は、まだ済んでいません。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。

---

[MIT](LICENSE) © Nema-Project contributors。第三者のライセンスと出典：[archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md)。
