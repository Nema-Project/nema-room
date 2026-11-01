<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>Keep your project aligned, from discussion to delivery.</strong></p>

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

Nema Room is a local copilot for keeping a software project aligned. Requests, constraints, and tradeoffs scatter easily, and the same requirement can be read in more than one way. Discuss them here with an agent: keep sources and Git history, separate what you said from what the agent inferred, and clarify a conflict before it becomes the plan. Hand an approved spec and plan to **Codex or Claude Code**, then bring commit reports back into the discussion.

<img src="docs/screenshots/room-en.png" width="1100" alt="A discussion about bill exports, with requirements, decisions, and an open question in the knowledge panel." />

<p align="center"><sub>A sample discussion, organized into knowledge you can inspect and correct.</sub></p>

<a id="features"></a>

## Why Nema Room

- **Align understanding.** Bring scattered notes into one record. When a statement conflicts with an active decision, the copilot asks in a thread and waits for you.
- **Keep the reasoning.** Requirements, decisions, tradeoffs, and open questions retain their sources. User statements and agent inferences stay distinguishable.
- **Version your knowledge.** Changes have Git history. Correct or retract an entry without erasing where it came from.
- **Ground discussions in code.** Bind local repositories, search committed main-branch snapshots, and generate diagrams with staleness indicators.
- **Hand off with intent.** Generate a work package, resolve blocking questions, and approve the spec and plan before a coding agent picks them up.
- **Bring the evidence back.** Connect commit reports to the requirements and read that Git evidence in the discussion.

**Why Nema?** The name comes from *nemawashi* (根回し), the practice of building understanding before a decision. Nema Room keeps that coordination in the open: disagreements stay visible, and decisions keep their evidence.

<sub>English, Chinese, and Japanese UI · Light and dark themes · Separate discussion threads</sub>

<details>
<summary>Look inside a requirement</summary>

See the original statement, why it was recorded, and whether it came from you or an agent inference.

<img src="docs/screenshots/entry-en.png" width="1100" alt="A requirement with its source statement and evidence type." />

</details>

## Quick start

<a id="desktop-app-preview"></a>

### Desktop

| Platform | From the [latest release](https://github.com/Nema-Project/nema-room/releases/latest) |
| --- | --- |
| Windows x64 | `.exe` installer, or `.zip` portable app (unzip, run `Nema.exe`). Pick one |
| macOS · Apple Silicon | `.dmg` |
| Linux / Intel Mac | Use [Web / Compose](#web--compose) |

1. Install [Git 2.31 or later](https://git-scm.com/downloads), then install and open Nema Room. Node and the database are bundled; Docker is not required.
2. Open **App settings → Model** and connect a ChatGPT subscription, a Claude subscription, or a Responses API-compatible API key.
3. Create a workspace and start a discussion. Bind a local repository when you want code context.

> **Preview release.** Windows builds are unsigned; macOS builds are ad-hoc signed and not notarized. Verify downloads against the release checksums. The app links to newer releases but never installs them. Back up `~/.nema/desktop` before upgrading. See the [desktop guide](docs/guide.en.md#desktop) for first launch, the portable ZIP, and limitations.

<a id="first-release-scope-and-requirements"></a>

### Web / Compose

PostgreSQL, the hub, and web run in containers; the daemon runs on your host. You need **Node.js ≥ 22**, **Git**, **Docker**, and **Docker Compose v2** on Windows, macOS, or Linux.

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
# Linux and macOS only. Docker Desktop on Windows does not need this.
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
node scripts/setup.mjs --lang en
```

The wizard checks dependencies, builds from source, starts the services, and guides model setup. It preserves an existing `.env`. Keep the host daemon running, then open [localhost:3000](http://localhost:3000). Read-only check: `node scripts/setup.mjs --lang en --check`.

**Without cloning.** Each release from `v0.1.6` attaches a `docker-compose.yml` whose hub and web images (`linux/amd64`) are pinned to that release. Install the host daemon at the same version with `npm i -g @nema-project/nema@<version>`: hub, web, and daemon must match, and nothing upgrades on its own. The step-by-step script, upgrades, and ports are in the [installation guide](docs/guide.en.md#source-installation) and [Web / Compose requirements](docs/guide.en.md#requirements).

## From discussion to delivery

Delivery is a loop: commit reports come back into the discussion.

1. **Discuss** — share notes and tradeoffs; review the agent's interpretation. Use `/thread` for a separate discussion.
2. **Connect** — bind a local repository to bring committed code into the conversation.
3. **Prepare** — enable `superpowers`, select active requirements, and generate a work package with a spec and plan. Resolve blocking questions.
4. **Approve** — review the package, then let your coding agent retrieve it. Editing or regenerating a package revokes approval.
5. **Track** — bring commit reports and their Git evidence back into the discussion.

```text
Discussion → Requirements + decisions → Approved spec + plan → Coding agent
                      ↑                                           │
                      └──────────── Commit reports ────────────────┘
```

In a bound code repository, a coding agent retrieves the package with `nema wp list` and `nema wp get W-1`. See [CLI reports and hooks](docs/guide.en.md#workflow); desktop installs use the [bundled CLI launcher](docs/guide.en.md#desktop).

> **`verified` comes in two kinds.** *Commits checked*: the cited commits exist, are on main, and touch the claimed files. It does not mean tests passed. *Accepted*: you confirmed the requirement yourself.

<a id="data-privacy-and-known-limitations"></a>

## Your data and its boundaries

- **Stored locally.** Desktop data lives in `~/.nema/desktop`. Web / Compose uses PostgreSQL and local knowledge Git repositories.
- **Models receive context.** Chat, knowledge, attachments, and code returned by tools go to your selected model provider. Local storage does not mean offline inference.
- **Extensions are yours to switch.** Enable, disable, install, or remove extensions, skills, and MCP servers on the Plugins page. The Installed section counts rows that cannot be used. A skill says when a runtime is missing something, or when its name does not match its folder. MCP tools are not offered to the agent in this release.
- **GitHub is opt-in.** The plugin uses your signed-in local `gh` and is limited to bound repositories. Writes need a separate workspace opt-in.
- **Built for local use.** There is no public multi-user authentication. Multi-device sync, managed backups, and team access are not available yet.

More: [storage, backups, and limitations](docs/guide.en.md#data) · [plugins, skills, and MCP](docs/guide.en.md#models) · [attachments](docs/guide.en.md#attachments). A copy of this source repository is not an application-data backup.

<a id="model-runtimes"></a>
<a id="development-and-upgrades"></a>

## Documentation and feedback

| Resource | Contents |
| --- | --- |
| [User guide](docs/guide.en.md) | Installation, model setup, desktop operation, CLI, backups, and upgrades |
| [Technical reference](docs/reference.zh-CN.md) · 中文 | Commands, work-package formats, plugins, and implementation details |
| [Contributing](CONTRIBUTING.md) · 中文 | Development setup, repository layout, and checks |
| [Agent development guide](AGENTS.md) | Shared conventions for local and remote coding agents |
| [Desktop build guide](scripts/desktop/README.md) | Native builds, bundled tools, and packaging |
| [Roadmap](ROADMAP.md) · 中文 | Stabilization priorities and acceptance evidence |
| [Changelog](CHANGELOG.md) | Changes across releases |

Found a bug or have an idea? [Open an issue](https://github.com/Nema-Project/nema-room/issues/new/choose) with your OS, installation method, and redacted errors. Contributions in English, Chinese, or Japanese are welcome.

For security concerns, use [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new) and read the [security policy](SECURITY.md). Do not disclose sensitive details in public issues or PRs.

---

[MIT](LICENSE) © Nema-Project contributors. Third-party notices: [archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md).
