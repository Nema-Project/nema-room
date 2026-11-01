# Changelog

Version sections on main may describe release preparation. A version heading and date do not establish that its tag, packages, images or installers are available; published versions and downloads are listed on the [GitHub Releases page](https://github.com/Nema-Project/nema-room/releases). Public installation instructions stay on an available version until the required artifacts are verified.

## [Unreleased]

## [0.2.2] - 2026-11-01

### Added

- One provider can have several accounts on the same machine, each with its own credentials, endpoint and default model. The settings page creates, renames, enables, disables and deletes accounts and stores credentials per account; the composer, a thread and a workspace each have an account picker, and the choice is recorded with the task and its binding. With a single account the interface is the same as in 0.2.0.
- The daemon runs a task with the account you chose, and the reply shows which account and model ran it and why that account was picked (message over thread over workspace over the default account). A named account that does not exist or has no credentials fails the task before any request is sent and says which one. A named account still runs when it is disabled: disabling only removes it from default selection. When the account settings file exists but cannot be read (corrupt, permissions too open, or a symlink) the task fails with the reason instead of falling back to the default account or the old single credential. An older daemon does not understand the account fields, so a task that names an account fails there and asks you to upgrade instead of silently using the default account.
- Account settings have an "automatic routing" switch, off by default. While it is off there is no "Auto" choice, and a task that asks for automatic routing fails saying the switch is off instead of quietly using the default account. When it is on you can choose "Auto" on a workspace, a thread or a single message: when the task starts Nema picks an account by your order, cost tier and declared capabilities, and moves to the next one when the preferred account is rate-limited or out of quota. A switch is written into the task progress (from which account to which) and the reply records the account actually used, along with the accounts tried and why they failed. Authentication failures, content-policy refusals, malformed requests and a run that has already produced output never switch accounts, and after a switch the previous attempt's reasoning is not sent to the model. For a task carrying images or PDFs, an account is an automatic candidate only when its model or account settings declare support for that kind or, when they say nothing, its adapter is known to pass that kind on (Claude Code is not, for PDFs); otherwise the task fails rather than run on an account that may not support it.

### Fixed

- `release-promote` no longer stops on the npm registry's provenance index lagging behind a package it just published. v0.2.1's first promotion failed this way: the version was readable and `npm latest` had already moved, but `/npm/v1/attestations` still answered 404, `release:verify` called that missing, and the run stopped leaving the two GHCR `latest` tags and the GitHub Release behind a rerun. The visibility wait now covers provenance as a third item after the package and its dist-tag, inside the same two-minute budget, so both the candidate preflight and the final verify see a settled answer instead of a timing race. A 404 there is only waited on while something shows the attestation exists — the registry's own version document already declares `dist.attestations`, or the version was published within the last five minutes — so a version that really has no provenance is still reported as having none, at once, instead of spending the budget and then being downgraded to "unknown". When the budget runs out the run record now says which of the two it is: "provenance declared but not served" (waitable, rerun when the index catches up) or "no provenance" (definite, needs a new tag). `npm run release:verify` on its own is unchanged and still treats a missing attestation as missing.

- Dropdowns in a floating thread window no longer close as soon as they open. Clicking an input, a dropdown or a button no longer makes the window take focus away, and the account picker in the thread title bar is no longer covered by the drag layer.

## [0.2.1] - 2026-11-01

### Changed

- Release preparation is safe to interrupt and cannot run twice at once. `npm run release:cut` and `npm run release:stamp` now share one repository-root lock (`.nema-release.lock`): a second run of either exits non-zero and names the process holding it, so one version can no longer produce two changelog sections or delete a shared fragment twice. Before writing `CHANGELOG.md`, `release:cut` records what it will delete in `.nema-release-cut.json`, so a cut interrupted after the write is finished by rerunning the same command: it deletes the remaining fragments and removes the journal instead of refusing with "already has a section", writes nothing twice, and keeps any fragment edited after the interruption for the next release. Every cut is recorded, including one that consumes no fragments, so a cut interrupted after its write is recoverable in that case too. The record is replaced atomically, so an interrupted run cannot leave a half-written journal that blocks recovery or destroy the record of an earlier run.

### Fixed

- Account credential files are now only trusted when they are private *and* owned by the user running Nema: a file another user happens to leave at mode 0600 no longer counts as a credential, and a symlink anywhere from `~/.nema` itself down to an account's directory is refused for reading, writing and deleting rather than followed. A key or token file that is empty, holds more than one line or contains control characters now shows as unusable instead of connected, and a saved Codex (compat) login that Nema cannot read shows as unusable instead of missing.
- Opening an account's settings no longer rewrites `~/.nema/accounts.json`: the default account's projection from `config.json` is computed in memory and only saved when you actually change an account, so a machine that never edits accounts keeps exactly the files it had. Moving the old single key into an account is now a copy-then-delete that finishes on the next attempt if it is interrupted, and two Nema processes editing accounts can no longer drop each other's account.
- A name pasted into the account form that looks like a key is rejected without Nema repeating it back in the error, so a pasted credential cannot end up in a message you copy or a log line.
- In compat mode `~/.codex/auth.json` is refused unless it is mode 0600 and owned by the user running Nema; Nema reports it as "凭证文件不可用（权限/符号链接/损坏）", and `chmod 600 ~/.codex/auth.json` (or running `codex login` again) is what fixes it. This matters because Codex CLI only applies 0600 when it *creates* that file, so one left at 0644 stays world-readable through every rewrite.
- An account's `createdAt` now accepts an ISO 8601 timestamp with a numeric offset such as `2026-10-31T09:00:00+09:00`, not only one ending in `Z`: a hand-edited or tool-written `~/.nema/accounts.json` no longer reads as corrupt, which had made every account disappear from the app while the data was still on disk.

- `release-promote` no longer gives up when the npm registry has not indexed a just-published version yet. After the publish run reports success it re-reads the exact version and the expected `latest` (or prerelease `next`) dist-tag for up to two minutes, then continues the promotion, so a maintainer no longer has to re-run the job because of registry lag (v0.2.0's first promote attempt failed that way and a rerun succeeded). A tarball with another integrity, a 401/403, or an answer that cannot be interpreted still stops immediately. When the budget runs out the run still exits non-zero without moving any later pointer, and its summary says whether the registry confirmed the version is not there, whether the version is there but its channel pointer never moved, or whether that could not be determined.

## [0.2.0] - 2026-10-31

### Added

- Chat messages and thread replies can carry images (PNG, JPEG, WebP, GIF), PDFs and UTF-8 text files: paste them, drop them on the composer, or pick them with the Attach button. Files are previewed and removable before sending, a message may hold only attachments, and the composer says before sending when it is not confirmed that the current adapter passes a type to the model. Sent attachments appear in the message as thumbnails or file cards you can download. Deleting one removes its content from Nema and leaves a tombstone with the name, type, size, sha256 and deletion time; what an agent or model already received cannot be taken back. If removing a deleted attachment's file fails, the deletion still stands: open chats switch to the tombstone at once, the delete reports the failure, and the hourly cleanup removes the file later. Images and PDFs are sent in the provider's own native form, unconverted, with every Codex direct login (ChatGPT, Codex login compatibility, any BYOK endpoint); PDFs are refused before the run on Claude Code, where it is not confirmed that they reach the model. When the provider or model rejects an image or PDF, the task fails saying so, with the provider's own message; nothing is retried, converted or turned into text. Some compatible servers may drop a file block silently instead, and some providers parse PDFs on their side at a cost (OpenRouter's default OCR, for example); the user guide's attachments section describes both and links OpenRouter's pricing. Third-party PDF parsing can be added by installing an MCP server or Skills.

- The `@` mention menu in the chat composer can suggest a workspace's knowledge entries, files already sent with earlier messages, and topics as you type; a new hub route (`GET /api/workspaces/:id/mention-context`) answers those suggestions, naming only ids and names and never file contents.

- Chat messages can `@`-mention workspace context: a knowledge entry (`[D-12]`), a file already sent with an earlier message (`` `附件：截图 1.png` ``), or a topic (`[话题：标题]`). Mentioned entries arrive in the agent's prompt with their body (4 KiB each, 16 KiB in total; anything over that is named by id for the agent to read), a mentioned file is delivered with the task like the message's own attachments (still at most 8 files and 32 MB per task), and a topic contributes its title and a shortened anchor. A mention is the user's pointer, not a decision: it never changes an entry, and nothing is retried or converted. A message may mention at most 20 things, and each mention must be this workspace's; a mention whose text was edited out of the message is dropped on edit. In the composer, typing `@` opens one menu with those three groups (entries, files you already sent, topics), writes the readable text into the message, and shows a chip above the box that removes both when clicked; an entry id typed exactly (`@D-12`) comes first, and the composer refuses a 21st mention instead of failing the send.

- A report's chat message now keeps two more hub observations beside the git check, each replaced on its own: the commits' author and committer as read from git (commit metadata only; it never allows or refuses anything), and, when the report names a `pr`, one read of that pull request's head and one page of its check runs through the workspace's GitHub plugin. The read happens only when the GitHub plugin is on, `gh` is installed and logged in, and the report's repo has a GitHub remote; otherwise the report is still accepted and the observation says why it was not read. A failed read never reuses the previous read's head or check runs, the previous read is kept as history, and check runs never change the git check or any verified state.

- `nema report --progress in_progress` reports unfinished work without `--json`; `--commits` may then be left out. The report skill now says so, and the room's report instructions describe `verified` as a commit check, not a test pass or the user's acceptance.

- A coding agent can report work that is still in progress: `nema report` accepts `progress: "in_progress"` (still through `--json`), with no commits if none exist yet. Such a report stays in chat with its own git check, but it is not applied to a work package task and starts no organizing task, even after its commits reach main; with no commits the check is skipped and the chat says so instead of "Checking…". Reports may also carry the agent's own claims (`branch`, `pr`, `headSha`, `ci`, `verified`, `notVerified`, `blockers`), which are stored as sent. Completed reports still need at least one commit and work as before.

- The Plugins page lists skill folders found in `~/.claude/skills`, `~/.codex/skills`, and `~/.agents/skills` under Found on this computer. Attach records one in place as an external extension. Nema copies nothing, and any other folder can be attached the same way. Built-in rows gain Repair (Check again once working), which re-checks graphify's packaged runtime or whether the GitHub CLI is installed and signed in, and keeps the result instead of the shipped default.

- Ask in chat to install a skill: the Agent calls `offer_skill_install`, which pins the source like the Plugins page preview and puts a card under the reply with the skill's description, repository, commit, license, and target folder. Nothing is installed until you press Install on the card, which uses the same install service as the Plugins page and shows the same progress and cancel button. Only tasks started by your own message can offer an install. The four READMEs, the three guides, and the technical reference describe the flow.

- MCP servers (stdio or HTTP) can be added, edited, started, stopped, and removed. Use the hub's `/api/extensions/…/mcp` routes, or the new `nema mcp add | edit | start | stop | status | list | secret set | secret clear` commands. Bare `nema mcp` is still the Room MCP server that Codex and Claude Code start.
- Credentials live in private files under `~/.nema/secrets/mcp/<id>/`, or come from the daemon's environment. Config files, the extension record, and every hub reply keep only references to them. A secret can be written but never read back. `nema mcp secret set` writes the file on this computer directly from stdin, keeping the line exactly as typed, and checks the config again after reading it.
- Changing a server's command, arguments, working directory, or URL clears its stored credentials. Setting or clearing a credential restarts a running server with the new value. Disabling or removing a server stops it first.
- A stdio server gets exactly its configured environment plus `PATH` and a private `HOME` (also `USERPROFILE` on Windows). Stopping it also ends its process group. On Windows, stdio servers run only under the desktop app's owned-process scope.
- `nema mcp add` and a save with `"create": true` refuse an id that already exists, so two adds racing for one id never replace each other.
- `nema mcp start` exits non-zero when the server does not connect. A stop also cancels a start still waiting its turn, and `status` or `stop` for an id that is not an MCP server is an error.
- A credential-named switch such as `--api-key` counts as taking a value unless the next argument is a long option (`--…`), so `--api-key -value` is refused like `--api-key value`.
- HTTP servers do not follow redirects, and a 401 or 403 shows as "needs login".
- The daemon stops every MCP server when it shuts down and starts none on its own. At start-up it marks a server whose config file is missing or changed as damaged and deletes credentials left behind by a server that no longer exists or that its saved config no longer names.
- On the desktop app, the hub API accepts only the app's own requests, so use the Plugins page there; `nema mcp secret set|clear --desktop` writes the desktop app's credentials directly.
- MCP tools are not offered to the Agent in this release.

- The Plugins page can add an MCP server (Add an MCP server… under Discover & install, stdio or HTTP) and edit it. Each MCP server's row shows its connection, Start or Stop, Edit, the last error, the server's name and version and the tools it lists. Credential slots are written as `NAME=secret:REF` or `NAME=env:VAR`; each `secret:` reference gets a write-only box that shows only Set or Not set, with Save and Clear, and never shows a stored value. MCP tools are still not offered to the Agent.
- While a server is starting its row says Connecting and Stop cancels the attempt; every MCP row checks its status every few seconds and shows the answer of each Start, Stop and credential change at once, so a server that exits, or is started from another tab or the CLI, shows without a reload. Values, header values and arguments are saved exactly as typed.
- Editing a server that another tab or the CLI removed meanwhile fails instead of bringing it back (`create: false` on save, a 404 when it is gone), and a relative working directory is refused when saving rather than at Start.
- A server whose config was cut off mid-save or changed outside Nema shows as damaged after a restart; Edit opens the form under the same id to enter it again, and Uninstall removes it with its credentials.
- New text is in English, Japanese and Chinese.

- The Plugins page now splits Installed from Discover & install, with a type filter (All, Skills, MCP, Plugins) and a search box over name, description, source, and id. A record whose install was cancelled is listed under Discover & install with Retry install. The four READMEs, the three guides, and the technical reference describe the layout, and `docs/superpowers/plans/2026-10-30-extension-page-sections.md` plans the remaining Attach and Repair work.

- Claude Code tasks (Claude Code 2.1.309 or newer) now load the enabled Skills natively. Each task gets its own copy of the Skills and only the Skill and Read tools. Reads outside the task folder are blocked, and Skill shell commands and hooks are turned off.

- codex-direct tasks now see a catalog of the enabled Skills and can load one with the new `read_skill` tool, which reads files only inside the Skill's folder, re-checks each read, and pages long files.

- Start a message with `/name` to put that Skill's instructions into the task, with the rest of the message as its arguments. The `/` menu lists the workspace's Skills under the built-in commands when `/` starts the message. Built-in commands keep their names; a Skill with the same name is called as `/skill:name`, and `/skill:name` works for every Skill.

- A bound repository's committed `.agents/skills` and `.claude/skills` can be given to agents. Turn on "Trust this repository's Skills" for that repository under Code & plugins; it is off by default and asks before turning on. Skills are read from the latest main-branch commit, and a name that clashes with your own Skills or another repository's gets the repository prefix.

- A thread now remembers which Skills its tasks loaded and preloads them, up to 32 KB, into the thread's next task. Skills that have since been turned off or removed are skipped. The hub stores only Skill ids, versions and times.

### Changed

- Public Compose installs now fetch `docker-compose.yml` from `releases/latest/download/`, the fixed-name asset each release from `v0.1.6` on carries, instead of a file on a version tag. The four READMEs, the three guides, and the three site pages give the same no-clone steps: fetch with `curl -fsSL`, check that both image pins print the same version, lock it in `.env` as `NEMA_IMAGE_TAG` (an existing lock, read as its last assignment the way Compose does, is kept and its versioned asset fetched instead), start with that version passed explicitly and `--wait`, install the daemon at that version, and run `nema daemon`.

- A requirement the user accepted (`confirmedBy: "user"`) is no longer replaced by an agent, a report recheck or a finished work package: the room refuses an agent rewrite of it (repeating it unchanged is not a rewrite), and the check runs under the knowledge repo's lock so an acceptance that lands mid-write is kept. When a report the acceptance cites changes its git check, the requirement gets an `acceptanceReview` mark instead; the acceptance stays. A finished work package now marks its requirements as commits-checked only when every task has a passing report of its own (not a user confirmation or an inference), with one `reportEvidence` group per report, and agents may cite such groups to verify a requirement built from several reports.

- The user can now confirm a requirement whose commits were checked (`verified`) but that no user has accepted yet, and accept again after a linked check changed; the confirm button keeps refusing an implementation the user already accepted. The room also refuses `reportEvidence` that cites a report from another workspace or commits that report does not list.

- The requirement tag no longer says "Verified" for a git check. A requirement you accepted shows "Accepted". One whose cited reports all passed their commit check shows "Commits checked", next to the commits that this covers. If any cited report's check did not pass, no tag is shown. You can accept a commits-checked requirement. When the check of a report you relied on changes, the requirement asks for review and the button reads "Still accept". A work package task you confirmed reads "Task marked done by you". Coding agent reports in chat are split into the agent's claim (its own words; the agent name is not an authenticated identity) and the hub's check: the git lines, commit authors and the GitHub read. Failed check runs are marked in red, and no conclusion that tests passed is drawn. A report that names an entry this workspace does not have says so in a quiet note.

- A new release's GitHub Release and the `latest` tags of both GHCR images now move only after the npm package and both images verify for that version, in one maintainer-run promote step. npm is published first in that step, so for the few minutes until it finishes (or, if it stops, until it is re-run) npm `latest` already serves the new version while `releases/latest/download/docker-compose.yml` and GHCR `latest` still serve the previous release. Until promote runs at all, every public install entry keeps the previous release, so a tag push alone never exposes a half-published version. This applies from the next release.

- A Skill from a trusted repository is inserted in the composer as `/skill:<repository>:<name>` (and `/skill:name` for one whose name a built-in command takes), matching the documented form; `/<repository>:<name>` still works.

- **Upgrading to 0.2.0 has to be asked for.** A dependency on `^0.1.x` never resolves to `0.2.0`, so `npm update` and a plain reinstall of an existing setup leave you on 0.1.x. Install the daemon explicitly with `npm i -g @nema-project/nema@0.2.0`. For Compose, set `NEMA_IMAGE_TAG=0.2.0` in `.env` and fetch that release's `docker-compose.yml` (`releases/download/v0.2.0/docker-compose.yml`) instead of the `latest` asset; the hub, web and daemon must all be the same version. Nothing upgrades on its own, and the previous version keeps working until you switch.

### Fixed

- When a provider rejects an attachment, Nema now names only the file the provider pointed at, says so when the provider did not say which of several files it rejected, recognises rejections reported inside the response stream, and no longer mistakes an unknown model whose name contains "vision" or "image" for a rejected file. A request carrying an image or PDF is no longer retried automatically after a server error or a dropped connection, so the provider does not process (and bill) the same file twice.

- `nema auth status` with `authMode=byok` no longer says "尚未登录直连模式" and points to `nema auth login`. It shows the mode, the adapter, the base URL (marked when it is the default), the model, and whether the API key is saved, missing or unusable; the key itself is never printed. It exits 0 only when the adapter is `codex-direct` and a usable key and a model are both set; under `claude-code` it says the BYOK settings are not used.

- BYOK now reads the model list that OpenAI and OpenAI-compatible servers (OpenRouter, vLLM, Ollama and others) actually return, `{ data: [{ id }] }`. Before, `nema auth probe` failed with "模型列表响应缺少 models 数组" and the model picker in the desktop settings stayed empty, so a BYOK model could not be chosen there.

- The `docker-compose.yml` attached to a release no longer starts with the repository template's "not an installable version" header. Its header names the pinned version, the `NEMA_IMAGE_TAG` value to lock, and the matching daemon command. This applies from the next release; the v0.1.6 asset keeps the old header, and its pins are correct.

- Editing a chat message through `PATCH /api/workspaces/:id/messages/:messageId` can now clear its text while the message still has an attachment whose file is available; before, the route refused empty text. An edit that would leave no text and no available attachment (none, only deleted ones, or only ones whose file is missing) is still refused with 400, sending a message is unchanged, and an edit body now accepts only `content`.

- `nema daemon` now stops on Ctrl-C, SIGTERM or SIGHUP by closing first, so its stdio MCP servers (and running tasks) are stopped instead of outliving it. A second signal exits at once; a close that takes longer than 15 seconds is cut off.
- A daemon that was killed without closing no longer leaves stdio MCP servers running for good. Each running server's process is recorded in `<nema home>/run/mcp/<id>/server.json`; the next daemon stops any recorded server whose daemon is gone and that is still the same process (pid and start time match), or whose leader exited but left its group running, with its whole process group, before any MCP server starts, and its row on the Plugins page says "stopped a copy left running by the previous daemon; start it again". A record is only removed once its group is stopped; if the check itself fails, MCP starts are refused until the daemon is restarted. Nothing is restarted on its own.
- A stdio server that exits on its own no longer leaves the rest of its process group behind, even when a descendant still holds its output open.

- Skills now follow the Agent Skills naming rule (lowercase letters, digits and single hyphens, up to 64 characters), so a Skill whose name starts with a digit, such as `3d-print`, can be installed from GitHub or attached from a local folder. A new Skill can no longer use a doubled or trailing hyphen. Records saved under the earlier rule stay listed and can still be switched on or off and removed. MCP server ids keep their earlier rule.

- Work-package markers such as `[W-3]` in work-package specs and plans are now clickable links that open the entry, like `[D-12]` and the other entry kinds already were.

## [0.1.6] - 2026-10-30

### Added

- **App settings** opens from the sidebar and covers the conversation. It has Model, Plugins, General, and About. Model settings and the plugins list move there. Version, **Check for updates**, and **Check for updates automatically** move to About, and a newer release stays a link to its release page. The update banner above the conversation stays. The sidebar keeps the daemon status, night mode, and the language switch. **Settings** in the header still edits the current workspace.
- The desktop app can open at login from **App settings → General**. A browser or Compose session still shows that control and says it cannot change it.

- The Plugins page has an "Install a skill" section: paste a GitHub repository, a folder or `SKILL.md` link, or a skills.sh page, preview the pinned commit, license, and each skill's target folder or the reason it cannot be installed, then install one skill with progress and a cancel button. A failed install shows its reason and a retry button on its row. `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`, and the three guides describe the flow.

- The Plugins page can now remove an extension Nema installed, deleting its own directory and index record, and take an external extension off the list while leaving the files outside Nema untouched; a bundled extension still only has the on/off switch. `README.md` and `README.en.md` describe the same three outcomes on the Plugins page.

- Skills can be installed from a previewed GitHub or skills.sh source through the hub: `POST /api/extensions/install` installs one folder at the pinned commit, checks every file against its Git blob hash and the size, count, and file-name limits, and activates it atomically with its provenance. Installs report progress, can be cancelled and retried, and an install cut off by a daemon restart is marked failed and cleaned up on the next start.

- The hub can preview a skill source before anything is installed: `POST /api/extensions/resolve` accepts a public GitHub repository, a `tree`/`blob` link into one, or a skills.sh page, pins it to a 40-character commit, and lists each `SKILL.md` at that commit with its name, description, Git blob digest, license, and target folder. A managed record from GitHub must now carry that commit as its revision.

- Extensions can be turned on and off from the Plugins page without uninstalling them; a built-in extension keeps its shipped definition and only its on/off choice is stored.
- A disabled extension's functions are no longer offered to the agent, and calling one is refused; the Plugins page keeps the state you chose even while the daemon is offline.

- Public installs resolve one released version, verify the compose file, both images, and the npm package exist, and lock that version into `.env` with `docker-compose.yml` written as a pair.

### Changed

- Markdown under `scripts/desktop/` and `scripts/images/` starts neither the desktop or image pull-request workflows nor the macOS/Windows platform checks. Code and scripts there still do. `AGENTS.md` and `CLAUDE.md` use the documentation CI lane.
- Release preparation stamps the cli, desktop, and local package versions, and their `package-lock.json` records, with `npm run release:stamp -- <version>`. The stamp refuses before writing when those records do not already match. `npm run release:cut -- <version>` merges `changelog.d/<slug>.<category>.md` fragments into `[Unreleased]` (existing entries ahead of a category's fragments, fragments in filename order), moves `[Unreleased]` into a section dated the local cut day, and deletes each consumed fragment only after that write succeeds. Neither command commits, tags, or publishes. That date stays the cut day when the tag is created later.

- Markdown-only changes take the documentation CI lane wherever the file lives, except the handful of Markdown files a package ships or a process reads at runtime; a Markdown-only pull request no longer runs the application suite.

### Fixed

- Control ports moved out of the default ephemeral range, and a descriptor left by the previous port formula is still accepted.

## [0.1.5] - 2026-10-28

### Added

- Source snapshots and `sourceRefs` preserve external evidence without turning excerpts into chat messages. Hub imports validate hashes and reuse source IDs after interrupted indexing; startup reconciles import receipts and confirmation events. This adds the protocol foundation; external service connectors are not included. Final CX-03 acceptance remains pending in `ROADMAP.md`; automated checks do not establish final acceptance.
- UI edits and confirmations record independent evidence events with Git provenance. Knowledge reads report source freshness, references needing review, and unconfirmed snapshots without rewriting decisions.

### Fixed

- Pull-request CI classifies the tested merge commit against its base, so documentation-only branches behind main no longer pick up main-only application changes.
- The knowledge-store concurrency regression test yields between reads and uses bounded Windows-specific repetitions and timeout, preserving its integrity assertions without changing production behavior.
- Hub and web images now build on `node:22-trixie-slim` (Debian 13) instead of `node:22-slim` (Debian 12, whose regular security support has ended). Patch-level dependency updates: Next.js 16.4.3, Hono 4.13.14, and PGlite 0.5.12. Electron moves from 45.0.0 to 45.1.0 — a feature and Chromium step rather than a patch, so it needs a desktop smoke pass before release.
- The web build loads Inter (variable, weights 400–700) and JetBrains Mono (weight 500) from WOFF2 files in the repository. `next build` no longer downloads those faces from Google Fonts, so an unreachable fonts host cannot fail the image build. The web image ships the matching OFL texts at `/app/licenses/fonts/inter/OFL.txt` and `/app/licenses/fonts/jetbrains-mono/OFL.txt`.
- UI confirmation retries recover committed evidence after transient database failures, preserving the original commit and events before a restart.

- Source freshness reads compare the last observed revision with the current imported snapshot, including after interrupted indexing, so reimports update freshness and reference review flags immediately.

### Security

- Desktop staging pins CPython **3.11.18** for the bundled Graphify runtime (was 3.11.17), picking up the October 2026 CPython security fixes, including `ssl` distrust of the compromised eMudhra intermediate CA keys (CVE-2026-115557) and rejection of link-replacement in `tarfile`'s `tar_filter` (CVE-2026-114583).

- Room writes with external references validate those references and require verbatim evidence from the current task's user message for user basis. Agents cannot rewrite imported snapshots, change their basis, or consume UI confirmation events. Main and thread prompts identify source excerpts as untrusted external data. Existing decision and user-message guards remain in force.

### Removed

- The bundled Vue.js brand mark is removed from Archify diagrams. The Vue logo's artwork terms (CC-BY-NC-SA-4.0: non-commercial, share-alike) do not fit this project's distribution, so the mark catalogue now ships 106 marks. Diagrams that referenced the `vue` brand mark need a different mark or none.

## [0.1.4] - 2026-10-28

### Added

- Hub and web images publish to GHCR from tag `v0.1.4` after verification of that commit (`ghcr.io/nema-project/nema-room-hub` and `ghcr.io/nema-project/nema-room-web`, `linux/amd64`). Tag `v0.1.3` does not publish images. arm64 is tracked in issue #50. `npm run up` still builds the images from a source checkout. The compose pin equals the package version (`0.1.4`). The published web image reads `NEMA_HUB_URL` when the container starts (default `http://127.0.0.1:4400`). Compose publishes the hub on `NEMA_HUB_PORT` (default 4400, same port inside the container) and web on `NEMA_WEB_PORT` (default 3000, container port 3000), and sets `NEMA_HUB_URL` to `http://127.0.0.1:$NEMA_HUB_PORT` unless that variable is set. Linux and macOS setup exports `NEMA_UID` and `NEMA_GID` from `id` so any host user can write the data directory. Docker Desktop on Windows does not need that export.
- The CLI and daemon pack as the npm package `@nema-project/nema` (command `nema`, Node.js ≥ 22). `@nema-project/nema@0.1.3` was published on 2026-10-27 from a maintainer account. That was the first publish. Nothing was published under the unscoped name `nema`, so there is no previously published daemon that still prints `npm i -g nema@<version>`. Tag `v0.1.4` is the first publish through the trusted publisher (`npm-publish.yml`); that publisher is configured and this release validates it. Install the running hub's version with `npx @nema-project/nema@<hub version>` or `npm i -g @nema-project/nema@<hub version>`. Source checkouts update with the repository. Compose serves the hub version at `GET /api/version`. The desktop app shows it in the sidebar and at `GET /_nema/version`. A mismatch prints `run: npm i -g @nema-project/nema@<version>` and does not reconnect. `nema daemon` still defaults to `http://127.0.0.1:4400` and the shared `daemon-token` file. See `scripts/npm/RELEASE.md`.
- The desktop app shows its version in the macOS app menu, the tray menu on macOS and Windows, and the sidebar. A 7-character build commit is included when `runtime-manifest.json` or `build-metadata.json` has one.
- After startup, and about once a day, the desktop app checks GitHub for a newer stable release. A tray item and an in-app banner link to that release page. Download and install stay manual. Turn the check off with **Check for updates automatically** in the sidebar (`updateCheck.enabled`). Failures stay silent. Prerelease and draft releases are not offered.
- Windows releases include a portable ZIP next to the NSIS installer. The ZIP is a separate download of the unpacked app, with `Nema.exe` at the top and its own checksum. It does not contain the installer, and the installer does not contain the ZIP. The installer still adds shortcuts, uninstall, and overwrite upgrades. The ZIP is unzip-and-run, with no shortcuts or uninstaller. Both use `~/.nema/desktop`.

### Changed

- The landing page still links desktop downloads to the latest GitHub release. It names the Windows portable ZIP beside the installer, shows the unversioned `npm i -g @nema-project/nema` (command `nema`), and names the linux/amd64 hub and web image pins. `docker-compose.yml` is fetched from tag `v0.1.4`, not from the release assets. English, Chinese, and Japanese pages match. `site/en/` still redirects to the English page.
- The PR `CI gate` still skips heavy checks for documentation changes. Other pull requests run the Ubuntu tests and web build, and run macOS/Windows platform checks and npm pack only for the paths that need them. Dockerfile, Compose, and `scripts/images/` changes run image smoke in the image workflow; that smoke is not a required `CI gate` check. A push to `main` runs full verification. Image, npm, and desktop tag workflows still call full `verify.yml`.
- Workspace settings uses the same grouped panels as model settings. Close, delete, and save are bordered buttons in the standard ink color.
- The English, Chinese, and Japanese READMEs, and the landing page, describe Nema Room as a local project-alignment copilot. Delivery is a feedback loop: commit evidence returns to the discussion.
- The READMEs and the landing-page FAQ say the name Nema comes from nemawashi (根回し): understanding before a decision, with disagreements and evidence left visible.

## [0.1.3] - 2026-10-27

### Added

- A disposable desktop data-directory check covers reopen, a pending migration, a failed migration, and backup restore for chats, threads, work packages, and knowledge Git history. On 2026-10-27 that check passed on hosted Windows and macOS runners ([run 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400), head `ef87a29`). The same day the maintainer reported a manual overwrite install on macOS and on Windows; workspace data remained on both.
- A thread semantic acceptance runner scores the scripted memo, decision, open-thread, conflict, and override checks. Rubric unit tests are not a real-model pass. Missing credentials or a connection failure exit as blocked and do not score the rubric. On 2026-10-27, after the harness amendment, Codex direct and Claude each exited 0 twice on Windows (12/12).

### Security

- Desktop tag publication verifies the exact main-line release commit with the full shared CI suite before packaging; failed or missing verification blocks publication. Manual rehearsals never publish.
- Every PR reports a stable `CI gate`, with lightweight checks for allowed documentation changes. Repository enforcement remains pending post-merge activation.
- Public security issue forms are replaced with private-reporting guidance. The setting was read as disabled earlier on 2026-10-27, then an administrator enabled it at about 11:52 Asia/Tokyo. A read at 11:54 returned `{"enabled":true}`. The report form is [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new). A signed-in non-admin reached that form on 2026-10-27; the test report was closed the same day without publication.

### Fixed

- On macOS, the desktop window uses the system traffic-light controls in the top-left. The custom minimize, maximize, and close buttons stay on Windows and Linux.
- Room API writes of user basis (`stated` or `decided`), and reviving any entry from an inactive status (`superseded`, `dropped`, or `resolved`) to `active`, require the current task's user message. The check runs in the same repository lock as the write. A missing or unrelated citation returns 409 `user_basis_evidence`. Re-entering that lock for the same repository throws instead of deadlocking. An entry deleted between the existence check and the locked write returns 404.
- Knowledge entry updates and rollback replace complete files atomically, preventing concurrent readers from seeing truncated frontmatter.
- The default landing page loads its demo from the site root. English stays at `/`, not `/en/`.

### Changed

- The copilot opens a thread when you ask it to compare options or weigh tradeoffs before a decision. A question-shaped idea, including a request for pros and cons, is not written. Asking to keep something in the discussion does not write knowledge. An undecided comparison does not create a question entry.
- Desktop payloads leave out Node headers, npm, and Corepack, ship one CPython interpreter, drop an unreferenced macOS `libpython3.11.dylib`, keep a single Chromium license notice, strip source maps, and omit cold tree-sitter grammars plus the sharp image toolchain. Packaging prints section sizes and warns when a budget is exceeded. Missing grammars are skipped with a warning.
- The landing page links to the latest GitHub release instead of a fixed version number.
- GitHub release notes lead with that version's changelog. Checksums stay in the attached SHA256SUMS file.

## [0.1.2] - 2026-10-26

### Added

- Binding a repository shows a progress line while its code index runs. When the index finishes, chat says it is ready and code questions can start. Drawing the architecture diagram keeps a progress line and names that work.

### Changed

- The landing page and desktop status now describe the 0.1.1 installers. The app uses Git already installed on the machine.
- Each README shows the room and an opened entry from a sample discussion, in that language.
- The Chinese guide is `README.zh.md` again. `README.md` stays the English default.

## [0.1.1] - 2026-10-26

### Added

- Agent-opened threads, the `/thread` command, independent thread windows, and a sidebar attention badge for unread threads. Users can also withdraw an entry while its provenance remains in history.

### Changed

- Desktop publication accepts Node and the bundled fonts from the license notices shipped with them. Electron's ffmpeg stays LGPL: the Chromium notice must name it, and the library must remain a separate file that can be replaced.
- A Mac app opened from the Finder also finds Git installed by Homebrew or MacPorts.
- Desktop publication treats an MIT package README that contains the license grant as that package's notice. `pg-types` and `pgpass` ship the grant there and no separate license file.

- The agent now acts as a copilot in both main chat and threads. It keeps memo checks and casual chat out of the knowledge base, asks in a thread when a statement conflicts with an active decision, and replaces that decision only after a clear user override. Follow-up answers move into their threads.

### Removed

- The main-chat follow-up answer box. Replies to follow-up questions now happen in their threads.

### Fixed

- A quoted message separates the sender from the excerpt with a colon.
- Binding a repository draws its architecture diagram after the code index finishes. A full extract may run for a few minutes instead of being stopped at one minute.
- Code search reads the index extract writes at `src/graphify-out/graph.json`. It had been looking for that file next to the snapshot root, so a finished index still returned 502.
- The sidebar attention count sits inside the workspace row again, and message search opens from the header icon instead of staying on screen.
- Message actions and the edit controls have space between them. Save and cancel are separate buttons.
- Quote and edit stay hidden until the pointer is on that message.
- The desktop window opens a thread when its row is clicked. The packaged shell had still been refusing every thread window.
- Main-chat messages that do not carry a thread id stay on screen. The search field has space inside its border.
- A desktop thread window loads its page, so the window controls are there and the window can be closed.
- Answering a follow-up closes its answer box. The box stays closed while that reply is in the thread.
- A reply that opens a new question shows that question. An older open question no longer replaces it on the card.
- Clicking a code diagram opens it. The desktop shell had refused every new window, so the title did nothing.
- The model menu says it is loading the provider's list, and stays closed, until that list arrives.
- Creating a workspace lines the confirm and cancel marks up with the name field. They use the same thin stroke icons as the theme control, so the check no longer sits under the underline.
- Claude Code tokens and the report token now get a private ACL on the file itself. Protecting only the parent directory left an elevated Windows process, including GitHub-hosted runners, as the Administrators owner, so the next read rejected the file.
- Desktop staging downloads the Electron binary when it is missing. Electron 45 no longer does that during `npm ci`.
- Desktop tool staging follows a symlink in a parent directory, such as macOS `/var`, and still refuses a symlink at the configured directory itself. Tool copies compare those links against the real directory, so Git's in-tree links stay inside the payload.
- The Windows guardian links `advapi32`. GitHub's Clang needs that library for the private pipe ACL.
- Windows packaged-app smoke extracts the ZIP in an ASCII directory, then copies it into the `東京` proof path. System `tar.exe` cannot enter that path on an English code page.
- Private Windows ACL checks wait 45 seconds. A cold PowerShell on the packaged-app runner exceeded 15 seconds, so the desktop core never started.

### Changed

- Choosing a repository folder previews its remote and detected main branch. The name and branch come from the repository. A name is typed only when that name is already used. Windows opens the Explorer-style folder picker.
- Model settings draws the model, provider, and sign-in groups on the sidebar tint, with the page color between them.
- Model settings choose ChatGPT subscription, Claude subscription, or API key on one level. The Agent runtime control is gone. Stored adapter and auth mode are unchanged.
- Bound repositories are fetched when a task first reads their code, not every five minutes. Graphify is resolved from the packaged `tools/graphify/` path. A missing runtime reports `随包的 Graphify 运行环境缺失` and is not installed from `PATH`.

### Added

- A chat message can quote any earlier message, a user's own message can be edited (the previous text is kept and the agent re-runs), and the workspace can be searched by keyword.
- The latest unanswered follow-up in the chat has an answer box. Sending it is a normal message, which the agent records as the answer.
- Every open follow-up has its own answer box. The message names that question, so an older one is not taken as a reply to the newest.
- Typing `/` in the composer opens a command menu. Every diagram type is its own row, such as `/diagram:sequence`, and the list narrows as you type.
- Desktop staging downloads pinned CPython 3.11.17 and graphifyy 0.9.95 into `tools/graphify/`. The launcher uses a path relative to itself, so a release build does not contain a developer's install path. The app still does not download Graphify on first launch.
- Model settings are separate from the provider. After a provider is saved and connected, its model is chosen from that provider's list. There is no custom model ID field. A saved model that is not in the list stays as it is until a listed model replaces it.

- A CLI launcher in the desktop payload (`Nema CLI.cmd`, `Nema CLI.command`, or `nema-cli`) that runs the bundled CLI, so `report install` works from a packaged app.
- Workspace settings chooses a local Git repository with a folder picker. The dialog opens in the host daemon, which can see the repository path. Cancelling the dialog leaves the path empty.
- Night mode is a borderless sun and moon control at the bottom-left of the sidebar, to the left of the language switch. Switching reveals the theme in a circle from that control, and the choice is remembered in the browser.

- The plugins page reads extension records and shows where an item came from, whether it is installed, and whether it is in use beside the name. A ready install or enabled use is green. A failed install, an external source, or an installed item that is not ready is red. A missing packaged Graphify runtime says it can be repaired from the page.

- GitHub issue templates, a pull request template, and contributing, security, and conduct guides. Issues ask for the OS, Node/Docker versions, how Nema Room is run, and redacted errors. Security reports use a security issue template.

- A Chinese, English, and Japanese terminal setup wizard (`node scripts/setup.mjs`), read-only environment checks, and a portable `npm run up` entry point.
- Windows private credential ACL validation, shell-free npm command-shim handling, native browser launching, process-tree cleanup, and encoded reporting hooks. Platform checks now run on Windows, macOS, and Linux in CI; the full application suite runs on Linux.

- Chinese, English, and Japanese release-facing READMEs with matching setup commands, runtime choices, data handling, and known limitations. Detailed Chinese implementation notes now live in `docs/reference.zh-CN.md`.
- MIT license for Nema Room and matching license metadata for the root and workspace packages. Vendored third-party licenses and notices are retained.

- The sidebar opens a plugins page with each plugin's name, local or external tag, install status, and functions. Workspace settings adds a code section to bind a repository, see whether the last fetch worked, and turn a plugin or its read-only functions on or off. External plugins note that calls leave the machine, and the section states that code the Agent reads is sent to the model provider.
- `nema doctor` reports `graphify 可用：<version>` when `graphify --version` runs, or `随包的 Graphify 运行环境缺失` when the packaged runtime is missing. That line is informational and never fails doctor.
- The daemon checks a bound repo's main branch when a task first reads its code, and when a coding-agent hook asks. The hub sends `repos.sync` (including `lastMainSha`) on welcome and when bindings change. Binding stores the indexed sha as `lastMainSha` without emitting `repo.moved`. A null `lastMainSha` is recorded once and does not emit `repo.moved` or update the index; a later sha updates the graphify index from the changed files (a rename removes the old path; a missing index is rebuilt in full) and emits `repo.moved` even when indexing fails. Each check emits `repo.fetched`. A failed fetch keeps the last sha. A repo without origin follows the local branch. The hub stores `last_main_sha` on `repo.moved`, `last_fetch_at` only on a successful `repo.fetched`, and `last_fetch_error`; settings shows a failure next to the last successful fetch time.
- The daemon executes code plugin calls (`plugin.call`: `code__search`, `code__explain`, `code__path`, `code__read`, `code__changes`). A missing graph snapshot is indexed before a graph query. A graph query value that starts with `-` is refused with `参数不能以 - 开头：<value>`. A missing or ill-typed argument is `<name> 参数无效：<field>`; an unknown name is `未知函数 <name>`. `plugins.status` reports graphify's version, or `随包的 Graphify 运行环境缺失`.
- Room tasks can list and call enabled workspace plugin tools (`GET /room/plugins`, `POST /room/plugins/:name`). A call is checked against the workspace, forwarded to the daemon as `plugin.call`, and recorded in `plugin_calls` once it passes the enabled-function check. Daemon offline or timeout is 503 with `daemon 未连接`, `daemon 已断开`, or `daemon 响应超时`; any other daemon error is 502.
- Workspace plugin settings: `GET /api/plugins` (registry plus daemon install status), `GET /api/workspaces/:id/plugins`, and `PATCH /api/workspaces/:id/plugins/:pluginId`. Local plugins default to enabled, including in a confidential workspace. `task.assign` sends that workspace's enabled plugin tools.

- A workspace can bind a local git repository (`GET/POST /api/workspaces/:id/repos`, `PATCH/DELETE /api/workspaces/:id/repos/:repoId`). Binding asks the daemon to inspect the path and index `origin/<main>` with graphify. The same git common dir returns 409. With no daemon, binding returns 503 `daemon 未连接`. A main branch that is not a single branch name (for example a refspec with `:`) returns 400 `主分支名称无效`. The stored origin URL has any `user:secret@` removed.
- Read-only git helpers can inspect a bound repo, fetch `origin/<main>`, and read that ref. Paths under `~/.nema`, `..` paths, and symlink blobs are refused. Snapshot export does not materialize symlink blobs.
- The web knowledge list marks an inferred basis and a source unconfirmed for more than 90 days; the detail shows basis, times, and quotes, and can confirm the entry. History labels a system author.
- An interrupted task is retried at most 3 times. The fourth interruption fails it and posts a system message.
- The hub can call a connected daemon with `rpc.request` and wait for `rpc.response` while a task is still running. No daemon, a timeout (30s), and a dropped socket reject the call with `daemon 未连接`, `daemon 响应超时`, and `daemon 已断开`.
- The shared plugin registry exposes the local `code` plugin (`graphify`) and its five read-only `code__*` functions. `task.assign` requires `pluginTools`, and the daemon protocol adds `rpc.request`, `rpc.response`, `repo.moved`, and `repo.fetched`.
- `POST /api/workspaces/:id/entries/:eid/confirm` with body `{}` confirms an entry as the user, re-indexes it, and emits `knowledge.changed`. A missing entry returns 404.
- Hub startup commits uncommitted knowledge entry files, including in archived workspaces, as `system` recover commits. Unparseable files, deletions, and non-entry paths are left untouched.
- Knowledge entries persist `basis`, `ingested_at`, `confirmed_at`, and `quotes`. Files written before those keys still load; missing values are null or an empty quote list.
- 支持 Claude Code 适配器：`npx nema config set adapter claude-code`，用 `claude setup-token` 取出 token 后由 `nema auth claude` 从 stdin 写入；不打印 token，失败不退回 Codex。
- 支持 BYOK 按量 API：设置 `authMode=byok`、`model` 和可选的 `byokBaseUrl`（默认 `https://api.openai.com/v1`），再用 `nema auth byok` 从 stdin 写入 key；它不使用订阅额度，遇到 401 也不会刷新 key。
- `authMode=compat` uses the existing Codex login file (`~/.codex/auth.json`) to call the Codex responses endpoint directly. Nema reads that file and does not refresh or rewrite it.
- Workspace names in the sidebar can be archived from a right-click menu, or permanently deleted after a red confirmation.
- A desktop app (Electron) runs Nema Room on one machine without Docker or a database server: an on-disk PGlite database, a single-owner local core, a protected same-origin gateway, bundled Node and Git, a tray that keeps the core running after the window closes, and a custom window title bar. Windows packaging is verified; macOS is not yet, builds are unsigned, and nothing has been published.
- Model settings in the app: choose the Agent runtime, model service and sign-in method, enter an API key or Claude Code token, and start or cancel a login, without a terminal. Credentials are never shown again.
- Creating a workspace shows progress, and a failed or pending draft can be retried or discarded.
- The Agent can run `gh` against GitHub issues, pull requests, labels, workflow runs and Projects through two tools, `github__gh_read` and `github__gh_write`. A fixed command allowlist applies, `--repo` and Project `--owner` must belong to the workspace's bound repositories, and there is no `gh api`, file or editor flag, merge, delete or auth command. Writes are off until the workspace turns on "Let the agent change GitHub" in Code & plugins.
- `exportSnapshot` and `importLegacySnapshot` move an existing workspace database and its knowledge Git history into an empty desktop home. The import validates in a staging directory under the single-owner lease, rebuilds repositories without hooks, remotes or config, drops old run tokens, and can be recovered after an interruption. Credentials are never exported.
- `nema report`, `nema report hook` and `nema wp` find a running desktop app when neither `--hub` nor `NEMA_HUB_URL` is given, and send the report token only after the app proves its identity. The gateway forwards only `POST /report`, `POST /report/hook` and `GET /report/workpackages` with the caller's bearer token.

### Changed

- Claude Code model settings offer the official aliases (`sonnet`, `opus`, `haiku`, `fable`, `best`, `opusplan`). The empty choice is labeled with the account default, Opus 5.5. Saving one starts the next task with `claude --model`.
- Model and reasoning sit at the top of model settings, ahead of the provider and its login.
- Each provider keeps its own login. Choosing a provider switches the one that runs the next task and leaves the other logins in place.

- Codex direct, Claude Code, and `nema mcp` declare the task's plugin functions next to the three Room functions. Claude's `--allowedTools` and the init tool-face check use `mcp__room__<name>` for those functions. There is still one MCP server named `room`, and Claude still launches with `--tools ""`.
- The composer hint no longer announces Markdown support.
- The sidebar connection line shows only whether the nema daemon is online.
- `PUT /api/workspaces/:id/entries/:eid` ignores the client's `basis` and `confirmed`. A decision becomes `decided`; every other kind becomes `stated`; `confirmedAt` refreshes.
- `POST /room/entries` requires `basis` (`stated`, `decided`, or `inferred`). Quote text must be an exact substring of a cited source message. Rewriting an active decision's title, body, or status returns 409 unless `basis` is `stated` or `decided` and a cited message is from the user.
- The Codex CLI adapter is retired. Codex runs only in-process; `authMode=compat` reads the existing Codex login file instead of launching the `codex` command. A saved `adapter` of `codex` or `codex-cli` loads as `codex-direct` with `authMode=compat`.
- Right-click menu labels use a bold weight.
- Delete-workspace confirmation buttons use a bold weight.
- The knowledge panel divider can be dragged. The width is remembered in this browser.
- Dragging the workspace list or the knowledge panel below 160px collapses that column to a rail. Dragging or clicking the rail opens it again.
- While a column divider is dragged, the handle shows a warm gray. The resting lines stay the pale rule.
- Settings shows a small geometric mark beside its label. Each column divider has a square button that collapses and expands that column.
- GitHub access defaults to the signed-in local `gh` command instead of `github-mcp-server` and a saved token. Nema no longer asks for or stores a GitHub token; the old `nema auth github` command and token file still exist but are not read by default.
- The plugins pages no longer show an installed or connected line for GitHub.
- The desktop core registers the user-level `~/.nema/report-token`, so coding-agent hooks installed once keep working with the desktop app.

### Fixed

- Security reports no longer link to GitHub's private advisory form. That page returns 404 while the repository is private; use the security issue template instead.
- The desktop window can load its titlebar mark and favicon. The local gateway now forwards only `/nema-room-mark.svg` and `/icon.png` (including the favicon cache query) to a signed-in session.
- A workspace with enough messages no longer stretches the three-column layout past the window. The message list scrolls, and the composer and sidebar footer stay on screen.
- A main-branch move is recorded only after `repo.moved` is sent. A closed socket, a failed send, or a throw leaves the previous sha so the next tick retries the index update and the message. A tick that is already running is not started again.
- A failure while checking one bound repo no longer skips the other repos in that tick. The failed repo keeps its last sha and is tried again on the next tick.
- `code__changes` with `to` omitted passes the bound main ref as a commit SHA. A bind onto a branch other than origin's HEAD no longer fails with `无效的提交 origin/<branch>`.
- A graphify process that times out, exits on a signal, or reports a null status fails the index instead of returning a sha. Binding surfaces `daemon 未连接`, `daemon 已断开`, and `daemon 响应超时` as 503 with that text, inspect failures as 400 with their Chinese text, and a missing repo as 404 `找不到仓库：…`. Inspect failures typecheck as HTTP 400. Incremental updates can read git blobs again.
- Indexing a bound repo continues when `git fetch` fails, including a repository with no origin. The snapshot is the local branch, or the remote ref already present.
- `readFileAtRef` rejects `.`, `foo/..`, and a pathspec magic string instead of returning a different blob.
- A second click on confirm while the first request is in flight does not write another confirm.
- Claude Code 的错误结果不再当成成功回复。登录失败会提示重新运行 `claude setup-token`，错误信息里不包含 stderr 或令牌。
- Deleting a workspace from the web app is no longer blocked by the hub CORS preflight.
- Clicking a reason in an entry's Why tab opens that history version and scrolls the chat to the source message for that version.
