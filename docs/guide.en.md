# Nema Room user guide

[Back to README](../README.md) · [English](guide.en.md) · [简体中文](guide.zh.md) · [日本語](guide.ja.md)

Detailed setup and operation for the desktop app and Web / Compose. For an overview and downloads, start with the README.

- [Desktop app (preview)](#desktop)
- [Web / Compose requirements](#requirements)
- [Quick start](#source-installation)
- [Model runtimes](#models)
- [From discussion to delivery](#workflow)
- [Data, privacy, and known limitations](#data)
- [Development and upgrades](#development)

<a id="desktop"></a>

## Desktop app (preview)

The desktop app puts the whole stack in one local program: an on-disk PGlite database, a single-owner local core, a protected same-origin gateway, and bundled Node. It uses the Git already on your machine (2.31 or later). On macOS, an app opened from the Finder also finds Homebrew and MacPorts Git. If Git is missing or older, the app says so on launch and links to https://git-scm.com/downloads. It needs neither Docker nor a database server. **Desktop builds are published** for Windows x64 and Apple Silicon: [download a build](https://github.com/Nema-Project/nema-room/releases/latest). On Windows, pick the installer or the portable ZIP.

| Item | Status |
| --- | --- |
| Windows x64 | NSIS installer (`.exe`) or portable ZIP (`.zip`). Pick one |
| macOS | DMG for Apple Silicon (arm64). Intel Macs are not a target |
| Linux | No desktop installer |
| Signing and updates | Windows is **unsigned**; macOS uses **ad-hoc signing, without notarization**. The app can notice a newer stable GitHub release and open its release page. It does not download or install updates |
| Public release | [Latest release](https://github.com/Nema-Project/nema-room/releases/latest). Node (MIT), Inter and JetBrains Mono (OFL), and Electron's ffmpeg (LGPL, its own library) ship with their notices |

**Build (Windows x64):** after `npm ci`, run `npm run desktop:make -- --platform win32 --arch x64`. Output goes to `dist/desktop-artifacts/win32-x64/`: `Nema-<version>-win32-x64.exe` (NSIS installer) and `Nema-<version>-win32-x64.zip` (portable app; `Nema.exe` at the top of the archive). A build only targets the current OS and needs a native C compiler (Clang on Windows; see [scripts/desktop/README.md](../scripts/desktop/README.md)).

**First launch and operating-system warnings:** open only a file you built or checked yourself. Windows SmartScreen shows "Windows protected your PC": choose "More info", then "Run anyway". The macOS package is unverified; as usual for an app that is not notarized, it would need "Open Anyway" in System Settings → Privacy & Security.

**Where data lives:** `~/.nema/desktop` by default (`db/` database, `data/` knowledge Git repositories, `instance.json` run state). It does not read the Compose database and never uses the old `~/.nema/data`.

**Windows portable ZIP:** unzip `Nema-<version>-win32-x64.zip` and run `Nema.exe`. There is no shortcut and no uninstaller; delete that folder to remove the portable copy. It uses the same `~/.nema/desktop` directory as an NSIS install. Running both at once shares that directory: the second launch connects to the core that is already running. Deleting the ZIP folder does not uninstall NSIS, and uninstalling NSIS does not delete the extracted folder or `~/.nema/desktop`.

**Window, tray, and browser mode**
- Closing the window closes only the window; the core keeps running in the tray, and the tray icon reopens it. `Quit Nema` in the tray menu quits and waits for background work to be cleaned up.
- You can also use the same core from a browser: `resources\payload` in the install directory contains `Nema Browser.cmd` (`Nema Browser.command` on macOS, `nema-browser` on Linux). It starts or reuses the core and opens a one-time link in your browser. `--no-open` prints the link instead; `--quit` asks the core to quit. It also lets you keep working after the window process exits unexpectedly.
- **Open at login** is under **App settings → General** in the desktop app. A browser or Compose session shows the control and explains that it cannot change it.

**Models and GitHub**
- Choose the model from the sidebar under **App settings → Model**; no terminal is needed. There is one provider list: ChatGPT subscription, Claude subscription, or API key. A ChatGPT subscription uses browser login or an existing local Codex login. A Claude subscription takes a local Claude Code token. An API key takes the key and an optional Responses API address. After that provider is connected, pick a model from the list it returns. While that list is loading, the menu says so and stays closed. There is no field for a custom model ID. Claude uses the official aliases; leaving it unset keeps the account default. Each provider keeps its own login. Reasoning effort is on the same page. There is no separate Agent-runtime control.
- The GitHub plugin is off by default. After you turn it on under "Code & plugins" in the workspace, the Agent uses the `gh` you are already signed in to (run `gh auth login` once in a terminal). Nema neither asks for nor stores a GitHub token. Reading comes with the plugin. Changing GitHub (creating and commenting on issues, editing labels, updating Projects) needs the allow switch on that same page. The Agent can only reach the github.com repositories bound to that workspace.

**Coding-agent report hooks:** the hooks that `nema report install` writes (the packaged app does not put `nema` on PATH: from the install directory's `resources\payload` folder run `Nema CLI.cmd report install --agent claude`, or `Nema CLI.command` on macOS and `nema-cli` on Linux; the hooks then point at the bundled Node and CLI by absolute path) use the per-user `~/.nema/report-token`, which the desktop app registers with its local core at startup. While the app runs, a hook finds it and verifies its identity automatically. **After installing hooks, restart the desktop app** so the token is registered. While the app is not running, reports go to a local spool (at most 5 MB, kept 7 days) and are sent with the next report.

**Migrating from the Web / Compose version:** there is only a library interface so far, with no command or UI. `exportSnapshot` (`apps/hub/src/db/export.ts`) exports from a PostgreSQL connection you name, and `importLegacySnapshot` (`apps/local/src/import.ts`) imports into an **empty, stopped** desktop data directory. The import validates everything in a staging directory first and leaves the destination untouched on failure; use `recoverInterruptedImport` after an interruption. Credentials are neither exported nor imported, so sign in again.

**Upgrading:** the desktop app does not download or install updates. About 15 seconds after startup, and about once a day, it checks GitHub for a newer stable release. The tray and an in-app banner link to that release page. **Check for updates** runs once immediately. **Check for updates automatically** under **App settings → About** (`updateCheck.enabled` in `~/.nema/desktop/update-check.json`) turns the scheduled check off. A failure, draft, or prerelease stays quiet. Quit with `Quit Nema` in the tray, back up `~/.nema/desktop`, then install the new version; database migrations run on startup. A disposable data-directory reopen, pending migration, failed migration, and backup restore passed on hosted Windows and macOS runners on 2026-10-27. On that date the maintainer installed a new package over an existing one on macOS and on Windows, and workspace data remained. Back up `~/.nema/desktop` before upgrading anyway.

Current stabilization priorities and acceptance evidence are tracked in the [roadmap](../ROADMAP.md). The historical validation snapshot below applies only to the commit and environment recorded in that review.

**Validation snapshot (2026-10-24):** cleanup of background helper processes is guaranteed only on Windows so far (POSIX is unproven), and the full Windows test run has 0 failures locally but 23 tests are skipped by gates (not Windows acceptance), and POSIX and CI have not been re-run. See the [validation record](reviews/2026-10-24-desktop-validation.md).

<a id="requirements"></a>

## Web / Compose requirements

The host daemon is the npm package `@nema-project/nema` (Node.js ≥ 22). The command name is `nema`. `@nema-project/nema@0.1.3` was published on 2026-10-27. That manual first publish is recorded in [scripts/npm/RELEASE.md](../scripts/npm/RELEASE.md). `v0.1.4` is the first trusted-publisher publish. Install the same version as the running hub:

```sh
npx @nema-project/nema@<hub version> --version
npm i -g @nema-project/nema@<hub version>
```

The version in those commands is the one both `image:` pins in your `docker-compose.yml` carry: `grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` prints it, and the `nema-room-web:` pin must print the same value. A source checkout builds the daemon from this tree and does not pick a version this way. A source checkout also carries `scripts/install/public.mjs`, which resolves one released version, verifies that its Compose asset, both images, and the npm package exist, and then writes `NEMA_IMAGE_TAG` into `.env` beside the matching `docker-compose.yml`; run it with `--check` first. It reads the release's own `docker-compose.yml` asset and refuses a release that does not carry one; releases before `v0.1.6` do not.

Compose: `curl http://127.0.0.1:4400/api/version` returns `{"version":"..."}`. Desktop: **App settings → About** shows the app version, and the app origin serves `GET /_nema/version`. If the daemon version does not match, it prints the hub error and `run: npm i -g @nema-project/nema@<version>`, then stops. It does not keep reconnecting.

`nema daemon` defaults to `--hub http://127.0.0.1:4400`. It reads `daemon-token` from `$NEMA_DATA_DIR` or `~/.nema/data` (`defaultTokenFile()`). The hub writes that file when it starts, if the file is missing. Compose sets the container `NEMA_DATA_DIR` to `/data` and bind-mounts the host data directory there (default `~/.nema/data`, or `NEMA_DATA_HOST_DIR`), so the host daemon and the container hub share one token file.

Running the Web / Compose stack from this repository still uses the source wizard below. Windows, macOS, and Linux share that Node.js setup. Do not install an unversioned `@nema-project/nema` and assume it matches the hub.

| Item | Requirement |
| --- | --- |
| Local tools | Node.js ≥ 22 with npm, Git |
| Containers | Docker and Docker Compose v2 |
| Model access | Configure a runtime below; availability, quotas, and charges depend on the provider |
| Storage | Prefer a local SSD; avoid NAS/SMB shares for the project, knowledge Git repositories, and database |
| Platform | Windows, macOS, Linux; use Docker Desktop with Linux containers on Windows/macOS, or Docker Engine on Linux |

This is a local application without public-facing multi-user authentication. The hub and web UI default to loopback access; do not expose them directly to the internet.

<a id="source-installation"></a>

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

Compose runs PostgreSQL, the hub, and web. **The daemon runs on your host**, using local credentials and repository paths. It is not in the images. Developing this repository still builds the images from this checkout. Tag `v0.1.4` is the first release that publishes them.

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
# Linux and macOS only. Docker Desktop on Windows does not need this.
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
npm run up
```

`npm run up` builds hub and web from this checkout. On Linux and macOS, the `export` sets the hub's user to the host user, including when that user is not uid 1000. Docker Desktop on Windows does not need that export. `NEMA_HUB_PORT` (default 4400) is both the published host port and the hub's listen port. `NEMA_WEB_PORT` (default 3000) is only the published host port. The web container reads `NEMA_HUB_URL` at start; compose sets it to `http://127.0.0.1:$NEMA_HUB_PORT`.

Pulling pinned images, without cloning, starts at tag `v0.1.4`, the first tag that contains the image publish workflow and publishes the images (`linux/amd64`; arm64 is [issue #50](https://github.com/Nema-Project/nema-room/issues/50)). The `docker-compose.yml` in this repository tree is a template whose hub and web `image:` entries interpolate `${NEMA_IMAGE_TAG:-latest}`, so the tree carries no usable version. Each release from `v0.1.6` on attaches a rendered `docker-compose.yml` whose hub and web images are pinned to that release's version. It is a fixed-name asset of that release, so the current one is always at [`releases/latest/download/docker-compose.yml`](https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml), and an install locks its version into a local `.env` as `NEMA_IMAGE_TAG`. To install without cloning:

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

**Upgrading to a newer minor version is explicit.** A caret range that points at an older minor never resolves to a newer one, so `npm update`, or an `npx`/`npm i -g` without a version, stays on the older minor. Install the daemon with `npm i -g @nema-project/nema@<version>`. For Compose, change `NEMA_IMAGE_TAG` in `.env` to `<version>` and, in step 1, fetch `releases/download/v<version>/docker-compose.yml` instead of the `latest` asset, then start it as in step 4; the hub, web and host daemon must all be that version. Nothing upgrades on its own, and the previous version keeps working until you switch.

Step 1 reads the last `NEMA_IMAGE_TAG` in `.env`, the one Compose uses. With none, it fetches the current release from `releases/latest/download/`. With one, it keeps that lock and fetches that version's asset from `releases/download/v<locked>/docker-compose.yml` instead; `0.1.4` and `0.1.5` have no release asset, so after that download's 404 it takes the tag's own file from `raw.githubusercontent.com/Nema-Project/nema-room/v<locked>/docker-compose.yml`, which pins both images to that version. `latest` moves with each release, while a versioned address stays the same as long as that release exists. Step 2 prints the version only when hub and web are pinned to the same one, and step 3 prints `locked <version>` only when that version is also the effective lock; if either prints nothing, stop. Each later step runs only if the one before it succeeded, so a failed download, check, startup, or install stops the rest instead of continuing with a stale file or an older `nema`. Step 4 creates the data directory as your user, as the setup wizard does, and checks that it is writable; it passes the locked version to Compose explicitly, so an exported `NEMA_IMAGE_TAG` in your shell cannot override it; and `--wait` returns only after the services are healthy, by which time the hub has written `daemon-token` for step 6. Steps 1 and 3 read only plain `NEMA_IMAGE_TAG=<version>` lines, so an `.env` edited by hand (quotes, comments, CRLF) makes them stop. For that case, or when two installs could run in the same directory, use `scripts/install/public.mjs` from a checkout: it reads the value the way Compose does and writes `.env` and `docker-compose.yml` together under a lock file. The v0.1.6 asset still opens with the repository template's comment calling it a template, not an installable version. That comment is stale: the two pinned `image:` lines are what count, and releases after v0.1.6 carry a header that names their version. Agent tasks need the daemon from step 6 running. Right after a release is published, its images or npm package can still be publishing; if step 4 cannot pull an image or step 5 cannot find the version, wait and run the steps again, or run `node scripts/install/public.mjs --check` from a checkout, which verifies the Compose asset, both images, and the npm package before anything is installed. `-L` is required: the release download address redirects. Docker Desktop on Windows does not need the export in step 4.

Host ports follow `NEMA_HUB_PORT` (default 4400; the container listens on the same port) and `NEMA_WEB_PORT` (default 3000; the container still listens on 3000). The published web image reads `NEMA_HUB_URL` at start. Compose defaults that to `http://127.0.0.1:$NEMA_HUB_PORT`, so the image does not need a rebuild when the port changes.

For public installation, use the Compose asset of the release you install, and install the daemon at that same version, which is the one both images in that file are pinned to. Main can advance ahead of published artifacts; develop from source with `npm run up`. Publication does not replace native-platform or feature acceptance.

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

On Linux and macOS, the commands above export `NEMA_UID` and `NEMA_GID` from `id` for every host user. Docker Desktop on Windows does not need that export. The same values can be set in `.env`. Create custom data directories yourself and ensure `NEMA_DATA_HOST_DIR` matches the directory read by the daemon.

<a id="models"></a>

## Model runtimes

The default adapter, `codex-direct`, runs Nema's own tool loop without launching the Codex CLI. The model receives Room functions and the plugins enabled for that task. The four rows below are what the three providers in the app save; the app does not show these internal names.

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

<a id="attachments"></a>

### Attachments by runtime

Images and PDFs are sent in the provider's own native form (`input_image` / `input_file` on the Responses API, Claude's `image` block). Nema does not convert them or switch to another format; whether and how the provider or model reads them is up to the provider. Text files are always sent as text inside the message.

| Runtime | Images | PDF | Text files | Basis |
| --- | --- | --- | --- | --- |
| Claude Code | native | refused before sending: not confirmed that Claude Code passes PDF blocks to the model | as text | Docs: images follow the official stream-json example. Not run against the real model |
| Sign in with ChatGPT (`siwc`) | native | native | as text | Docs: OpenAI Responses API. Not run against the real model |
| BYOK with the default `https://api.openai.com/v1` | native | native | as text | Docs: as above. Not run against the real model |
| BYOK with another `byokBaseUrl` (OpenRouter, self-hosted servers, …) | native | native | as text | Depends on the provider. Measured (2026-10-30, OpenRouter `:free` models): a vision model read the image; a text-only model got HTTP 404 from OpenRouter and Nema reported it as such. PDF not measured |
| Codex login compatibility (`compat`) | native | native | as text | Non-public backend, no documentation. Not run against the real model |

**When the provider refuses**: if the provider answers with a 4xx about the file, the task fails with "your provider or model rejected this PDF" (or "this image") and the provider's own text. Nema does not retry, fall back, or turn a PDF into text. When the provider points at one block, only that file is named; with several attachments and no such pointer, the message says the provider did not say which one. Any other error is shown as the provider worded it. A request carrying an image or PDF is not retried automatically after a 5xx or a dropped connection either, because the provider may already have processed and billed the file.

**Risk**: some compatible servers silently drop a file block they do not understand instead of rejecting it. The model then answers without having read the file, and Nema cannot tell. When it matters, try a small file first that contains a word found only in that file.

**Cost**: some providers parse PDFs on their side. That is the provider's own behavior and Nema does not interfere. For example, OpenRouter parses a PDF with a paid OCR engine by default when the model cannot read files itself, BYOK included; see [OpenRouter PDF Inputs](https://openrouter.ai/docs/features/multimodal/pdfs) for engines and prices.

**If you need third-party PDF parsing**, you can install an MCP server or Skills for it yourself.

Run-by-run real-model results are in the [acceptance record](reviews/2026-10-30-attachments-model-acceptance.md).

- **Types** are decided from the file's content, and the extension must agree with it: PNG, JPEG, WebP, GIF, PDF, and strict UTF-8 text without NUL bytes. Text files also need one of these extensions, or none: txt, md, markdown, log, csv, tsv, json, jsonl, yaml, yml, toml, ini, xml, html, css, js, mjs, cjs, ts, tsx, jsx, py, rb, go, rs, java, kt, swift, c, h, cc, cpp, hpp, cs, php, sh, bash, zsh, sql, diff, patch. A file whose extension contradicts its content is refused, as are SVG, HEIC, Office documents, archives, audio, and video.
- **Limits:** images 10 MB, PDFs 20 MB, text files 512 KB. One task takes at most 8 files and 32 MB in total, counting the message, the message it quotes, and the thread's first message. All attachments together are capped by `NEMA_ATTACHMENTS_MAX_BYTES` (default 2 GB), and an upload is refused when it would leave less than 1 GB free on the data disk. Files picked but never sent are removed after 24 hours.
- **What the model is told:** attachments are data. What it reads from them is its inference, not something you said or decided, and quotes in its interpretation can only come from message text.
- **Deleting** an attachment (Delete on its card, confirmed) removes the file at once and keeps a tombstone in the message with the name, type, size, sha256, and deletion time. A file that disappeared from disk shows as missing.

<a id="workflow"></a>

## From discussion to delivery

1. **Discuss**: send notes, then review, confirm, or correct the agent's interpretation in the knowledge panel. You can quote any message, edit your own (the previous text is kept and the agent re-runs), and search the workspace by keyword from the icon in the header. Type `@` for a mention menu: knowledge entries, files you have already sent, and topics, in that order. Choosing one writes its readable form into the message (`[D-12]`, `附件：截图 1.png`, `[话题：标题]`) and adds a chip above the box; the chip's × removes the mention and that text together, and deleting the text by hand removes the chip. Typing an entry id exactly (`@D-12`) puts that entry first. `@` only opens at the start of a line, after a space, or after an opening bracket or one of `「『（` and `，。、：`, never in `a@b` or inside a code block; the `/` menu keeps its own rule and the two never show at once. On send, a mentioned entry's body goes to the agent with the message (up to 4 KiB each and 16 KiB in total; anything over that is named by id for the agent to read), a mentioned file travels with the task like the message's own attachments (still at most 8 files and 32 MB per task), and a topic contributes its title and the start of its anchor. A message may mention at most 20 things, and a mention never changes an entry's status. Type `/` for a command menu. Diagram types are listed, such as `/diagram:sequence`, and the list narrows as you type. Progress and updating an existing diagram are there too.
1. **Thread discussions**: use `/thread` to start a new long discussion, or let the agent move the current conversation into a thread when you ask to compare options or weigh tradeoffs and have not decided. Threads open in a separate window, and unread badges in the sidebar take you to the next one that needs attention. The agent acts like a copilot: memo checks, casual chat, question-shaped ideas, and requests for pros and cons do not write knowledge. Asking to keep something in the discussion does not write it either. The main chat and threads follow the same recording rules. An undecided comparison does not create a question entry. When there is no clear decision, it asks first. Unless you clearly overturn an existing decision, it keeps that decision and asks in the current thread. When you clearly overturn one, the old decision is marked as superseded and the new one is recorded.
2. **Connect code**: bind a local Git repository from settings with the system folder picker. After a folder is chosen, the remote and the detected main branch are shown, and the name is the folder name. A name is typed only when that name is already used. The dialog opens in the host daemon. Windows uses the Explorer-style picker. Graphify is read from `tools/graphify/` in the install payload. It is not installed from `PATH` and is not downloaded at runtime. `desktop:stage` places pinned CPython 3.11.18 and graphifyy 0.9.95 there, and the launcher uses only a path relative to itself. The packaged interpreter is `python/bin/python3.11`. Tree-sitter grammars cover JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, Bash, and JSON. YAML, TOML, HTML, CSS, and Markdown have no grammar wheel in this pin. A missing grammar is skipped with a warning; extract still finishes. When it is missing, indexing and code search report `随包的 Graphify 运行环境缺失`, and the plugins page shows the same sentence. Its Repair button only checks again; it cannot put the runtime back. Binding a repository indexes it once. A full extract may take a few minutes. Chat shows progress while the index runs, then says the index is ready and code questions can start. The architecture diagram is drawn after that index finishes, with its own progress line. After that the daemon does not `git fetch` on a clock: the first time a task reads that repository, it fetches the main branch and reads the committed snapshot, excluding uncommitted changes. Later reads in the same task reuse that result.
3. **Generate a work package**: select active requirements and enable `superpowers` to generate a spec and plan. The `grill-me` plugin can create a blocking question when information is missing. Answer it under that question in the chat. An older open question can be answered on its own card, and generation retries.
4. **Approve and hand off**: review and approve manually, then let your coding agent retrieve it. Editing or regenerating revokes approval.
5. **Report and verify**: track `reported`, `verified`, and `mismatch`. **`verified` shows as "Commits checked" when every cited report passed its Git check: not that tests passed, the feature is correct, or acceptance criteria were met. It shows as "Accepted" once you confirm the requirement yourself.** You can accept a commits-checked requirement. If a cited report's check later changes, the requirement asks for review; "Still accept" clears only that mark. A work package task you confirmed reads "Task marked done by you", which is not requirement acceptance. In chat, each report shows the agent's claim apart from the hub's check (Git lines, commit authors, the GitHub read; failed check runs in red).

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

Work in progress can be reported first: `nema report --progress in_progress --summary "…"` (or `"progress":"in_progress"` with `--json`). Such a report may have no commits and does not advance a work package task; send a `completed` report (with at least one commit) when the work is done.

The GitHub plugin is off by default. How to turn it on, sign in with `gh`, and allow writes is in the desktop section above; the Web / Compose daemon uses the same path. The command allowlist and the six older read functions are in the technical reference. `nema auth github` can still write a token to `~/.nema/github-token`; the default path does not read it.

The Plugins page (Settings, bottom left) gives every extension an Enable / Disable switch that takes effect immediately, with no restart. A disabled extension's functions stop being offered to the Agent and calling one directly is refused. The switch covers the whole install; each workspace has its own switches on top, and both have to be on. Disabling a bundled extension stores only an override row, never a change to what shipped. An extension Nema installed also has Uninstall, which deletes its directory with the record; one found outside Nema only offers Remove from list, which drops the record and leaves your files where they are. A bundled extension offers no removal, only the switch. See "Enabling, disabling and removing extensions" in the technical reference.

To install a skill, paste a GitHub repository, a link to a folder or `SKILL.md` in one, or a skills.sh page into "Install a skill" at the top of the Plugins page and press Preview. The preview shows the commit the source is pinned to, the license GitHub reports, and every skill found there with the folder it would install to. A skill that cannot be installed says why. Install copies only that skill's folder at that commit; the line under it shows files done out of the total, with Cancel install while it runs. A failed install shows the reason on its row and offers Retry install, which starts again from the same commit. Only public repositories are supported for now. See "Installing a skill" in the technical reference (安装 Skill).

How Skills are used: the Agent starts with each enabled Skill's name and description and reads the body only when it needs it (the built-in Agent uses the read-only `read_skill` tool; Claude Code uses its own Skill loading, which needs v2.1.309 or newer), and resource files named in the body are read on demand the same way. A Skill used in a thread is loaded, at its current version, into that thread's next tasks without being read again, up to 32 KB in all; Skills switched off or uninstalled since are skipped, and the main chat does not do this.

You can also ask in chat, for example "install the pdf skill from anthropics/skills". The Agent pins the source the same way as the Preview button and puts a card under its reply with the skill's name, description, repository, commit, license, and target folder. The Agent cannot install anything itself: the skill is installed only when you press Install on the card, which goes through the same install service as the Plugins page and shows the same progress and Cancel install. If the source holds several skills, the Agent asks which one you mean. Only a message you sent can lead to an install card; system requests and coding-agent reports cannot.

The page has two sections. Installed lists everything present: bundled items, skills Nema installed (a failed install stays here with its reason and Retry install), and items found outside Nema. Discover & install holds "Install a skill" and any record whose install was cancelled, which can be installed again from there. Above both, the Type choice (All, Skills, MCP, Plugins) and the search box narrow both sections at once. Search matches the name, description, source, or id, ignoring case. They narrow the folders under Found on this computer the same way (by name, description, path, or id; MCP and Plugins hide them, since they are skills). Neither sends anything to the hub; they only change what the page shows.

Skills in a repository: under Code & plugins, each bound repository has a "Trust this repository's Skills" switch, off by default. Before it turns on, a note explains that the instructions committed to `.agents/skills` and `.claude/skills` on the main branch will be given to agents, and that anyone who can commit to the repository can change them. It takes effect from the next task. Before each task the daemon fetches the main branch (at most once every 5 minutes per repository) and reads only committed content; uncommitted changes do not count. When both folders have a Skill with the same name, the one in `.agents/skills` is used. When a repository Skill has the same name as one you installed or one in another repository, the repository's is named `<repository>:<name>`.

Calling a Skill yourself: when a message starts with `/name`, that Skill's instructions go into the task, and the rest of the message is its arguments (`$ARGUMENTS` in the Skill is replaced with them). Type `/` at the start of a message and the menu lists a Skills group under the built-in commands, filtered by name or description. Built-in commands come first: a Skill that has a built-in command's name is shown, and inserted, as `/skill:name`; other Skills use `/name`, and `/skill:name` works for them too. A repository's Skill is shown, and inserted, as `/skill:<repository>:name`; `/<repository>:name` is accepted too. Skills marked as not for the model to pick on its own can still be called this way. A `/name` in the middle of a message is not a call.

Under Discover & install, Found on this computer lists the skill folders directly inside `~/.claude/skills`, `~/.codex/skills`, and `~/.agents/skills`. Nema opens only each folder's `SKILL.md`, up to 256 KiB, and uses only its front matter. Hidden folders are skipped, and a link that points outside its location is listed with a note but not read. A location that exists but cannot be read says so, and a `SKILL.md` that cannot be read marks only its own folder. Attach records the folder's real path as an extension found outside Nema, enabled. Nothing is copied, and Remove from list later drops only the record. A folder somewhere else can be typed in, or picked with Choose…, and attached the same way. A folder is refused when its `SKILL.md` has no name and description, when its name is taken by a built-in or another extension, or when it is already attached; the reason is shown in place.

MCP servers are added under Discover & install with Add an MCP server…. A stdio server needs a command, its arguments one per line, and optionally an absolute working directory and environment lines; an HTTP server needs a URL (https; plain http only on 127.0.0.1, ::1 or localhost) and optional header lines. A line is `NAME=value`, `NAME=env:VAR` to take the value from the daemon's environment, or `NAME=secret:REF` for a stored credential (`NAME=value:…` keeps a literal that starts with one of these prefixes). A variable or header whose name looks like a credential (containing token, key, secret, password, auth, cookie, session or credential) must be a reference; saving a typed value is refused with the field named, never the value. After saving, the server's row shows its connection (Disconnected, Connecting, Connected, Needs login, Connection error), Start or Stop, Edit, the last error, the server's own name and version, and the tools it lists. Each `secret:` reference gets a write-only box: Save stores the value and empties the box, Clear deletes it, and the row only says Set or Not set. A running server restarts with the new value. Changing the command, arguments, working directory or URL deletes the stored credentials, so a credential never follows a server to a new target. Disabling or uninstalling an MCP server stops it first, and the daemon stops every MCP server when it shuts down, including on Ctrl+C, SIGTERM or SIGHUP (press Ctrl+C again to exit at once); none starts again on its own. If a `nema daemon` you started yourself on macOS or Linux was killed or crashed instead, before it starts any MCP server, the next daemon tries to stop each stdio server the previous one recorded as running (a record it cannot check is kept for a later start), and that server's row says a copy left by the previous daemon was stopped; press Start to run it again. Not starting them automatically is deliberate (rationale recorded 2026-11-02): MCP tools are not offered to the Agent in this release, so a running server has no consumer; a stdio server runs a command you configured, as you and with your credentials, so each start should come from you, including when the desktop app opens at login; and restoring servers after a crash could replay whatever caused it. This will be revisited when MCP tools are offered to the Agent, most likely as a per-server automatic start that is off by default. If a save was cut off or `mcp.json` was changed outside Nema, the row says the config is damaged after the next start: Edit opens the form under the same id to enter it again, and Uninstall removes the server and its credentials. MCP tools are not offered to the Agent in this release.

The same is available from a terminal: `nema mcp add <id> --name <name> --command <cmd> [--arg …] [--env NAME=…]` (or `--url` and `--header` for HTTP), `nema mcp edit`, `nema mcp list`, `nema mcp status <id>`, `nema mcp start <id>`, `nema mcp stop <id>`, `nema mcp secret set <id> <name>` (reads the value from standard input) and `nema mcp secret clear <id> <name>`. `nema mcp` with no subcommand is still the Room MCP server that Codex and Claude launch. On the desktop app the hub's API requires the app's sign-in, so use the Plugins page there; `nema mcp secret set|clear --desktop` writes the desktop app's credential files directly. `nema mcp add` refuses an id that already exists, and `secret set` keeps the line exactly as typed.

Each built-in row has Repair, shown as Check again when the item already works. For graphify it runs the packaged Graphify version check. If the check passes, the row shows "Checked: working."; if the runtime is missing or does not run, the row says so and that reinstalling Nema puts it back. For GitHub it asks the GitHub CLI (`gh`) whether it is installed and signed in to github.com, and says which one is missing. The other built-in items are part of the app and are confirmed as working. The result is kept, so the page shows the last check instead of the shipped default. Repair never runs a package manager.

<a id="data"></a>

## Data, privacy, and known limitations

| Default location | Contents |
| --- | --- |
| PostgreSQL Compose volume `nema-pg` | Chat, tasks, workspace settings, indexes, and related records |
| `~/.nema/data` | Daemon token, workspace knowledge Git repositories, and chat attachments (`attachments/`) |
| `~/.nema` | Local configuration, model/plugin credentials, code index snapshots, report spool, and related files |
| `~/.nema/desktop` | The desktop app's database, knowledge Git repositories, chat attachments (`data/attachments/`), and run state; independent of the Compose data above |

**A GitHub copy of this source repository is not an application-data backup.** Stop writes before backing up, retain a PostgreSQL export and the actual data directories, and validate recovery. To preserve data, do not use `docker compose down -v`: `-v` deletes the database volume.

- Local storage is not offline inference: chat, knowledge, and code returned by tools go to the model provider. When the GitHub plugin is on, queries go to GitHub through your local `gh`; writing needs a separate opt-in in the workspace. A confidential workspace is not an offline mode or operating-system isolation boundary.
- Attachments are sent to the model provider with the task that uses them. Deleting one removes its file but cannot take back what a model already received; a quoted message's attachments go along with the quote. Back up `attachments/` together with the database: a row without its file shows as missing.
- Ordinary task limits: 24 model calls, 60 tool calls, 10 minutes. Work packages: 48, 120, 20 minutes. Interrupted tasks retry up to three times.
- Startup can recover some uncommitted knowledge files, but Git and database indexes do not have complete automatic reconciliation.
- SIWC refresh failures may require another login. The implementation checks ID token claims but does not verify JWKS signatures.
- Credentials use `0600` on macOS/Linux and private ACLs on Windows, limited to the current user, SYSTEM, and administrators. Reads reject broad permissions and symbolic links.
- Claude Code runs as the local user; tool restrictions are not a separate operating-system sandbox.

<a id="development"></a>

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

The root typecheck excludes web; build it separately. Before upgrading a source checkout, back up data, then run `git pull`, `npm ci`, rebuild the CLI, run `npm run up`, and restart the daemon. Keep the daemon on the hub version from `GET /api/version`. A mismatch prints `run: npm i -g @nema-project/nema@<version>` and does not reconnect. A source checkout still builds that daemon from this tree, and it does not use `NEMA_IMAGE_TAG` to choose a version. `@nema-project/nema@0.1.3` has been on npm since 2026-10-27.

See [.env.example](../.env.example) for ports and directories. The CLI does not automatically load the root `.env`: export `NEMA_DATA_DIR` or pass `--token-file` to `daemon` / `doctor` for a custom data directory; also pass `--hub` for a different hub port. Compose reads `NEMA_HUB_PORT` (default 4400; the host and the container use the same port) and `NEMA_WEB_PORT` (default 3000; the container stays on 3000). The web container reads `NEMA_HUB_URL` when it starts. Compose defaults that to `http://127.0.0.1:$NEMA_HUB_PORT`. Set `NEMA_HUB_URL` only when the browser reaches the hub at a different address. `NEXT_PUBLIC_HUB_URL` is what `npm run dev` reads, and it is only the baked fallback inside the image.

## Security reporting

For security concerns, report through [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new) and read the [security policy](../SECURITY.md). Do not disclose sensitive details in public issues or PRs. A signed-in non-admin reached the form on 2026-10-27; the test report was closed the same day without publication. Fixes land on main and ship in a subsequent desktop release; older release lines are not separately maintained.
