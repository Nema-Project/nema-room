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

English, Chinese, and Japanese UI · Light and dark themes · Separate discussion threads

<details>
<summary>Look inside a requirement</summary>

See the original statement, why it was recorded, and whether it came from you or an agent inference.

<img src="docs/screenshots/entry-en.png" width="1100" alt="A requirement with its source statement and evidence type." />

</details>

## Quick start

<a id="desktop-app-preview"></a>

### Desktop

Download one desktop build from the [latest release](https://github.com/Nema-Project/nema-room/releases/latest). On Windows, pick one of the two downloads.

| Platform | Download |
| --- | --- |
| Windows x64 | `.exe` installer or `.zip` portable app |
| macOS · Apple Silicon | `.dmg` |
| Linux / Intel Mac | Use Web / Compose below |

The Windows `.exe` is the NSIS installer: shortcuts, uninstall, and overwrite upgrade. The Windows `.zip` is the unpacked app: unzip it and run `Nema.exe`. It has no shortcuts or uninstaller, and it skips the installer's repeated file copy. Both use `~/.nema/desktop`. Pick one.

1. Install [Git 2.31 or later](https://git-scm.com/downloads), then install and open Nema Room, or unzip the portable ZIP and run `Nema.exe`. Node and the local database are bundled; Docker is not required.
2. Open **App settings → Model** and connect a ChatGPT subscription, Claude subscription, or a Responses API-compatible API key. Access and billing depend on the provider.
3. Create a workspace and start a discussion. Bind a local repository when you want code context.

> **Preview release.** The Windows installer and portable ZIP are unsigned; macOS builds are ad-hoc signed and not notarized. Verify downloads against the release checksums. The app does not download or install updates. It checks GitHub for a newer stable release and links to that release; turn this off with **Check for updates automatically** under **App settings → About**. Quit from the tray and back up `~/.nema/desktop` before upgrading. A disposable data-directory migration and backup restore passed on hosted Windows and macOS runners on 2026-10-27. The same day, the maintainer installed a new package over an existing one on macOS and on Windows; workspace data remained. See the [desktop guide](docs/guide.en.md#desktop) for first launch and limitations.

<a id="first-release-scope-and-requirements"></a>

### Web / Compose

Build PostgreSQL, the hub, and web from a checkout when developing this repository. Tag `v0.1.4` is the first release that publishes images. The daemon is not in those images. It still runs on the host. The daemon package is `@nema-project/nema`. `@nema-project/nema@0.1.3` was published to npm on 2026-10-27; that manual publish is recorded in [scripts/npm/RELEASE.md](scripts/npm/RELEASE.md). You need **Node.js ≥ 22**, **Git**, **Docker**, and **Docker Compose v2** on Windows, macOS, or Linux.

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
# Linux and macOS only. Docker Desktop on Windows does not need this.
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
node scripts/setup.mjs --lang en
```

The wizard checks dependencies, builds the CLI, starts services from source, and guides model setup. Keep the host daemon running. Existing `.env` files are preserved. `npm run up` is the same source build. On Linux and macOS, export `NEMA_UID` and `NEMA_GID` the same way before `npm run up` so the hub can write its data directory for any host user, including users whose ids are not 1000. Docker Desktop on Windows does not need that export. Open [localhost:3000](http://localhost:3000). The published compose file has no build step.

Pulling pinned images, without cloning, starts at tag `v0.1.4`. That tag contains the image publish workflow and is the first publish of these images (`linux/amd64`; arm64 is [issue #50](https://github.com/Nema-Project/nema-room/issues/50)). The `docker-compose.yml` in this repository tree is a template: its hub and web `image:` entries interpolate `${NEMA_IMAGE_TAG:-latest}`, so the tree carries no usable version. A release published by the current release workflow also attaches a rendered `docker-compose.yml` whose hub and web images are pinned to that version, and an install locks that version into its local `.env` as `NEMA_IMAGE_TAG`. No published release carries that asset yet, so fetch [`docker-compose.yml`](https://github.com/Nema-Project/nema-room/blob/v0.1.5/docker-compose.yml) from tag `v0.1.5` (`curl -fsSLO https://raw.githubusercontent.com/Nema-Project/nema-room/v0.1.5/docker-compose.yml`), which pins both images to `0.1.5`. That tag file is not a release asset. On Linux and macOS, export `NEMA_UID` and `NEMA_GID` as above. Docker Desktop on Windows does not need that export. Then run `docker compose up -d`. Host ports follow `NEMA_HUB_PORT` (default 4400; the container listens on the same port) and `NEMA_WEB_PORT` (default 3000; the container still listens on 3000). `NEMA_HUB_URL` defaults to `http://127.0.0.1:$NEMA_HUB_PORT` and is read when the web container starts, so one published image works without a rebuild.

For public installation, use the versioned Compose file linked above for the release you install, and install the daemon at that same version, which is the one both images in that file are pinned to. Main can advance ahead of published artifacts; develop from source with `npm run up`. Publication does not replace native-platform or feature acceptance.

[Manual setup and configuration](docs/guide.en.md#source-installation) · Read-only check: `node scripts/setup.mjs --lang en --check`

The host daemon is the npm package `@nema-project/nema` (Node.js ≥ 22). The command name is `nema`. `@nema-project/nema@0.1.3` was published on 2026-10-27 from a maintainer account. `v0.1.4` is the first publish through the trusted publisher described in `scripts/npm/RELEASE.md`. Install the same version as the running hub:

```sh
npx @nema-project/nema@<hub version> --version
npm i -g @nema-project/nema@<hub version>
```

The version in those commands is the one both `image:` pins in your `docker-compose.yml` carry: `grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` prints it, and the `nema-room-web:` pin must print the same value. A source checkout builds the daemon from this tree and does not pick a version this way. Nothing writes `NEMA_IMAGE_TAG` into `.env` for you yet: the installer that records the locked version arrives with the fixed-name Compose asset, so until then read the version from the file you fetched.

Compose reports that version at `http://127.0.0.1:4400/api/version`. The desktop app shows it under **App settings → About**; its loopback origin also serves `GET /_nema/version`. A mismatch prints `run: npm i -g @nema-project/nema@<version>` and does not reconnect. `nema daemon` defaults to `--hub http://127.0.0.1:4400` and reads `daemon-token` from `$NEMA_DATA_DIR` or `~/.nema/data`. The hub writes that file on startup. Compose bind-mounts the host data directory at `/data`.

Developing this repository still uses the source checkout above. Do not install an unversioned `@nema-project/nema` and assume it matches the hub.

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
- **Extras can be switched off.** Every extension and plugin has an Enable / Disable switch on the Plugins page. A disabled extension's functions stop being offered to the agent and calls to them are refused; workspace switches still apply on top.
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
