<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>From conversation to code, with the context intact.</strong></p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest"><img src="https://img.shields.io/github/v/release/Nema-Project/nema-room?style=flat-square&color=555" alt="Latest release" /></a>
<a href="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml"><img src="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="License: MIT" /></a>
</p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest">Download</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#from-discussion-to-delivery">Workflow</a> ·
<a href="#documentation-and-feedback">Docs</a> ·
<a href="ROADMAP.md">Roadmap</a>
</p>

<p><a href="README.zh.md">简体中文</a> · <strong>English</strong> · <a href="README.ja.md">日本語</a></p>

</div>

Nema Room is a local workspace for shaping requirements with an AI agent. Turn discussions into requirements and decisions with sources and Git history, then hand an approved spec and plan to **Codex or Claude Code**.

<img src="docs/screenshots/room-en.png" width="1100" alt="A discussion about bill exports, with requirements, decisions, and an open question in the knowledge panel." />

<p align="center"><sub>A sample discussion, organized into knowledge you can inspect and correct.</sub></p>

<a id="features"></a>

## Why Nema Room

- **Keep the reasoning.** Requirements, decisions, tradeoffs, and open questions retain their sources. User statements and agent inferences stay distinguishable.
- **Version your knowledge.** Changes have Git history. Correct or retract an entry without erasing where it came from.
- **Ground discussions in code.** Bind local repositories, search committed main-branch snapshots, and generate diagrams with staleness indicators.
- **Hand off with intent.** Generate a work package, resolve blocking questions, and approve the spec and plan before a coding agent picks them up.
- **Follow the implementation.** Connect commit reports to requirements and inspect the Git evidence.

English, Chinese, and Japanese UI · Light and dark themes · Separate discussion threads

<details>
<summary>Look inside a requirement</summary>

See the original statement, why it was recorded, and whether it came from you or an agent inference.

<img src="docs/screenshots/entry-en.png" width="1100" alt="A requirement with its source statement and evidence type." />

</details>

## Quick start

<a id="desktop-app-preview"></a>

### Desktop

Download an installer from the [latest release](https://github.com/Nema-Project/nema-room/releases/latest).

| Platform | Installer |
| --- | --- |
| Windows x64 | `.exe` |
| macOS · Apple Silicon | `.dmg` |
| Linux / Intel Mac | Use Web / Compose below |

1. Install [Git 2.31 or later](https://git-scm.com/downloads), then install and open Nema Room. Node and the local database are bundled; Docker is not required.
2. Open **Model settings** and connect a ChatGPT subscription, Claude subscription, or a Responses API-compatible API key. Access and billing depend on the provider.
3. Create a workspace and start a discussion. Bind a local repository when you want code context.

> **Preview release.** Windows installers are unsigned; macOS builds are ad-hoc signed and not notarized. Verify downloads against the release checksums. The app does not download or install updates. It checks GitHub for a newer stable release and links to that release; turn this off with “Check for updates automatically” in the sidebar. Quit from the tray and back up `~/.nema/desktop` before upgrading. A disposable data-directory migration and backup restore passed on hosted Windows and macOS runners on 2026-10-27. The same day, the maintainer installed a new package over an existing one on macOS and on Windows; workspace data remained. See the [desktop guide](docs/guide.en.md#desktop) for first launch and limitations.

<a id="first-release-scope-and-requirements"></a>

### Web / Compose

Requires **Node.js ≥ 22**, **Git**, **Docker**, and **Docker Compose v2** on Windows, macOS, or Linux.

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang en
```

The wizard checks dependencies, builds the CLI, starts services, and guides model setup. Open [localhost:3000](http://localhost:3000) and keep the host daemon running. Existing `.env` files are preserved.

[Manual setup and configuration](docs/guide.en.md#source-installation) · Read-only check: `node scripts/setup.mjs --lang en --check`

The CLI is private and installed from source; `npx nema` is not a standalone installation method.

## From discussion to delivery

1. **Discuss** — share notes and tradeoffs; review the agent's interpretation. Use `/thread` for a separate discussion.
2. **Connect** — bind a local repository to bring committed code into the conversation.
3. **Prepare** — enable `superpowers`, select active requirements, and generate a work package with a spec and plan. Resolve blocking questions.
4. **Approve** — review the package, then let your coding agent retrieve it. Editing or regenerating a package revokes approval.
5. **Track** — inspect commit reports and their evidence against the requirements.

```text
Discussion → Requirements + decisions → Approved spec + plan → Coding agent
                      ↑                                           │
                      └──────────── Commit reports ────────────────┘
```

For a source installation, link the CLI once from the Nema Room checkout with `npm link --workspace @nema/cli`. Then, in a bound code repository:

```sh
nema wp list
nema wp get W-1
```

[CLI reports and hooks](docs/guide.en.md#workflow) connect the implementation back to the room. Desktop installs use the [bundled CLI launcher](docs/guide.en.md#desktop).

**`verified` means Git evidence passed or a user confirmed it.** It does not mean tests passed or acceptance criteria were met.

<a id="data-privacy-and-known-limitations"></a>

## Your data and its boundaries

- **Stored locally.** Desktop data lives in `~/.nema/desktop`. Web / Compose uses PostgreSQL and local knowledge Git repositories.
- **Models receive context.** Chat, knowledge, and code returned by tools are sent to your selected model provider. Local storage does not mean offline inference.
- **GitHub is opt-in.** The plugin uses your signed-in local `gh` and is limited to bound repositories. Writes need a separate workspace opt-in.
- **Built for local use.** There is no public multi-user authentication. Multi-device sync, managed backups, and team read-only access are not available yet.

See [storage, backups, and known limitations](docs/guide.en.md#data). A copy of this source repository is not an application-data backup.

<a id="model-runtimes"></a>
<a id="development-and-upgrades"></a>

## Documentation and feedback

[Model setup](docs/guide.en.md#models) · [Development and upgrades](docs/guide.en.md#development)

| Resource | Contents |
| --- | --- |
| [User guide](docs/guide.en.md) | Installation, model setup, desktop operation, CLI, backups, and upgrades |
| [Technical reference](docs/reference.zh-CN.md) · 中文 | Commands, work-package formats, plugins, and implementation details |
| [Agent development guide](AGENTS.md) | Shared conventions for local and remote coding agents |
| [Contributing](CONTRIBUTING.md) · 中文 | Development setup, repository layout, and checks |
| [Desktop build guide](scripts/desktop/README.md) | Native builds, bundled tools, and packaging |
| [Roadmap and acceptance tracker](ROADMAP.md) · 中文 | Stabilization priorities, TODOs, and acceptance evidence |
| [Changelog](CHANGELOG.md) | Changes across releases |
| [Security policy](SECURITY.md) · 中文 | Reporting guidance and security boundaries |

Found a bug or have an idea? [Open an issue](https://github.com/Nema-Project/nema-room/issues/new/choose). Include your OS, installation method, and redacted errors. Contributions in English, Chinese, or Japanese are welcome.

For security concerns, report through [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new) and read the [security policy](SECURITY.md). Do not disclose sensitive details in public issues or PRs. A signed-in non-admin reached the form on 2026-10-27; the test report was closed the same day without publication. Fixes land on main and ship in a subsequent desktop release; older release lines are not separately maintained.

---

[MIT](LICENSE) © Nema-Project contributors. Third-party notices: [archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md).
