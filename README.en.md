# Nema Room

**Turn scattered discussions into traceable requirements, then hand them to a coding agent.**

[简体中文](README.md) · English · [日本語](README.ja.md)

> **Direction update, 2026-10-24:** The first release will be a desktop app that works independently on the user's machine. Multi-device sync, backup features, and team read-only access are deferred until the local core is complete. Desktop migration is not yet implemented; the instructions below describe the existing Web / Compose version. See the [confirmed scope (Chinese)](docs/superpowers/specs/2026-10-24-local-desktop-first.md).

Nema Room is a requirements discussion room that runs locally. Share ideas, meeting notes, and tradeoffs in chat; an agent organizes them into requirements, decisions, questions, and sources. Knowledge changes have Git history. When you are ready to build, generate a spec and plan, then track progress through your coding agent's commit reports.

## Features

- **Discussion to knowledge**: manage requirements, decisions, tradeoffs, questions, sources, code diagrams, and work packages.
- **Traceable evidence**: distinguish user statements, user decisions, and agent inferences; inspect quotes, history, and reasons for changes.
- **Code context**: bind local repositories, read main-branch snapshots, search code, and generate diagrams with staleness indicators.
- **Development handoff**: clarify questions, generate a work package, and approve it for Codex or Claude Code.
- **Implementation tracking**: check commits, main-branch inclusion, and file changes, with manual confirmation available.
- **Three UI languages**: English, Chinese, and Japanese, plus knowledge-language settings, plugin controls, and workspace archiving.

## First release scope and requirements

Install **from source**. The CLI package is private; do not treat `npx nema` as a standalone npm installation command. Windows, macOS, and Linux share a Node.js setup wizard.

| Item | Requirement |
| --- | --- |
| Local tools | Node.js ≥ 22 with npm, Git |
| Containers | Docker and Docker Compose v2 |
| Model access | Configure a runtime below; availability, quotas, and charges depend on the provider |
| Storage | Prefer a local SSD; avoid NAS/SMB shares for the project, knowledge Git repositories, and database |
| Platform | Windows, macOS, Linux; use Docker Desktop with Linux containers on Windows/macOS, or Docker Engine on Linux |

This is a local application without public-facing multi-user authentication. The hub and web UI default to loopback access; do not expose them directly to the internet.

## Quick start

Run in PowerShell, Terminal, or a Linux terminal:

```text
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang en
```

The wizard checks Node/npm, Git, Docker, and Compose, preserves an existing `.env`, installs dependencies, builds the CLI, and starts services. It then guides model selection and connection checks, with an option to start the daemon in the terminal. You can rerun it; it does not install system software, delete application data, or overwrite existing configuration files. Selecting a model mode updates the corresponding local model settings.

Read-only check: `node scripts/setup.mjs --lang en --check`. With npm available, `npm run setup -- --lang en` also works. `--check` checks that Docker is running and does not send model requests.

### Manual installation (Bash)

Compose runs PostgreSQL, the hub, and web. **The daemon runs on your host**, using local credentials and repository paths.

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
docker compose up -d --build
```

Configure model access first. For the default authentication mode:

```bash
node apps/cli/dist/index.js auth login
node apps/cli/dist/index.js auth probe
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js daemon
```

Open [localhost:3000](http://localhost:3000), create a workspace, and send a discussion. Keep the daemon running; new tasks queue while it is offline. `auth probe` sends a minimal model request and consumes the selected service's quota.

```bash
npm run logs   # Hub / web logs
npm run down   # Stop containers; retain the database volume
```

On Linux, set `NEMA_UID` / `NEMA_GID` in `.env` if your UID/GID is not 1000. Create custom data directories yourself and ensure `NEMA_DATA_HOST_DIR` matches the directory read by the daemon.

## Model runtimes

The default adapter, `codex-direct`, runs Nema's own tool loop without launching the Codex CLI. The model receives Room functions and the plugins enabled for that task.

| Mode | Setup and limitations |
| --- | --- |
| Sign in with ChatGPT (default `siwc`) | Run `auth login`, then `auth probe` to verify access; not guaranteed for every subscription or organization account |
| BYOK API key | Requires a Responses API-compatible endpoint and an explicit model; billed under the provider's terms |
| Codex login compatibility | `config set authMode compat`; reads `$CODEX_HOME/auth.json`, default `~/.codex/auth.json`, without refreshing or modifying it. Uses a non-public backend that may stop working or violate service terms |
| Claude Code | `config set adapter claude-code`; requires local `claude`, `claude setup-token`, and `auth claude` |

To switch to BYOK:

```bash
node apps/cli/dist/index.js config set authMode byok
node apps/cli/dist/index.js config set model YOUR_MODEL
# Optional, for another compatible provider:
# node apps/cli/dist/index.js config set byokBaseUrl https://your-provider.example/v1
node apps/cli/dist/index.js auth byok
```

`auth byok` reads one key from standard input: paste it and press Enter. Use a private terminal; input may be echoed. `auth claude` and `auth github` also read standard input. Keep real credentials out of command arguments, repositories, and issues.

Configure Claude Code:

```bash
node apps/cli/dist/index.js config set adapter claude-code
claude setup-token
node apps/cli/dist/index.js auth claude
```

Nema does not silently switch runtimes after authentication or model failures. `config get` and `auth status` show configuration and login status without printing tokens.

## From discussion to delivery

1. **Discuss**: send notes, then review, confirm, or correct the agent's interpretation in the knowledge panel.
2. **Connect code**: install graphify with `uv tool install graphifyy` and bind a local Git repository in settings. The daemon checks the main branch every five minutes and reads committed snapshots, excluding uncommitted changes.
3. **Generate a work package**: select active requirements and enable `superpowers` to generate a spec and plan. The `grill-me` plugin can create a blocking question when information is missing; generation retries after resolution.
4. **Approve and hand off**: review and approve manually, then let your coding agent retrieve it. Editing or regenerating revokes approval.
5. **Report and verify**: track `reported`, `verified`, and `mismatch`. **Verified means Git evidence passed or the user confirmed it, not that tests passed, the feature is correct, or acceptance criteria were met.**

Work packages currently require fixed Chinese format markers even when the knowledge language is English or Japanese, including `## 已定的做法`, `### 任务 1：`, `- 修改：`, and `- 满足：`. See the detailed reference for the full constraints.

To use `nema` from another repository, first link the CLI from this project's root. You may need to add npm's global bin directory to PATH:

```bash
npm link --workspace @nema/cli
```

Then, inside a bound code repository:

```bash
nema wp list
nema wp get W-1
nema report --entries W-1 --task 1 --summary "Implement task 1" --commits COMMIT_SHA --files src/example.ts
```

Optional reporting hooks: `nema report install --agent codex` or `--agent claude`. This modifies the agent's user-level hook configuration and installs the `nema-report` skill. Remove it with `nema report uninstall --agent <agent>`.

The GitHub plugin is disabled by default. Install `github-mcp-server`, save a token with `auth github`, then enable it in the workspace. It can only read PRs and issues for bound GitHub remotes.

## Data, privacy, and known limitations

| Default location | Contents |
| --- | --- |
| PostgreSQL Compose volume `nema-pg` | Chat, tasks, workspace settings, indexes, and related records |
| `~/.nema/data` | Daemon token and workspace knowledge Git repositories |
| `~/.nema` | Local configuration, model/plugin credentials, code index snapshots, report spool, and related files |

**A GitHub copy of this source repository is not an application-data backup.** Stop writes before backing up, retain a PostgreSQL export and the actual data directories, and validate recovery. To preserve data, do not use `docker compose down -v`: `-v` deletes the database volume.

- Local storage is not offline inference: chat, knowledge, and code returned by tools go to the model provider; the GitHub plugin also sends queries to GitHub. A confidential workspace is not an offline mode or operating-system isolation boundary.
- Ordinary task limits: 24 model calls, 60 tool calls, 10 minutes. Work packages: 48, 120, 20 minutes. Interrupted tasks retry up to three times.
- Startup can recover some uncommitted knowledge files, but Git and database indexes do not have complete automatic reconciliation.
- SIWC refresh failures may require another login. The implementation checks ID token claims but does not verify JWKS signatures.
- Credentials use `0600` on macOS/Linux and private ACLs on Windows, limited to the current user, SYSTEM, and administrators. Reads reject broad permissions and symbolic links.
- Claude Code runs as the local user; tool restrictions are not a separate operating-system sandbox.

## Development and upgrades

Development mode runs only PostgreSQL in Docker:

```bash
npm ci
cp .env.example .env  # Do not overwrite existing configuration
npm run build -w apps/hub
npm run build -w apps/cli
npm run db:up
npm run dev
```

Start `node apps/cli/dist/index.js daemon` in another terminal. Do not also run the Compose hub/web: their ports overlap.

```bash
npm test
npm run typecheck
npm run typecheck -w apps/cli
npm run lint -w apps/web
npm run build -w apps/web
```

The root typecheck excludes web; build it separately. Before upgrading, back up data, then run `git pull`, `npm ci`, rebuild the CLI and Compose images, and restart the daemon. Keep hub and CLI versions aligned.

See [.env.example](.env.example) for ports and directories. The CLI does not automatically load the root `.env`: export `NEMA_DATA_DIR` or pass `--token-file` to `daemon` / `doctor` for a custom data directory; also pass `--hub` for a different hub port. Changing `NEXT_PUBLIC_HUB_URL` requires rebuilding web.

## Documentation and feedback

- [Detailed command and implementation reference (Chinese)](docs/reference.zh-CN.md)
- [Changelog](CHANGELOG.md)
- [Designs and implementation plans](docs/superpowers/)
- [Report an issue](https://github.com/Nema-Project/nema-room/issues): include your OS, Node/Docker versions, runtime configuration, and redacted errors.

This project is licensed under the [MIT License](LICENSE). Third-party components include archify and writing rules adapted from superpowers. License and source records are retained in [archify](vendor/archify/VENDORED.md) and [superpowers-rules](vendor/superpowers-rules/VENDORED.md); retain their licenses and copyright notices as well.
