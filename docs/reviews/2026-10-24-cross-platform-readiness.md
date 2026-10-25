# First-release cross-platform validation

Date: 2026-10-24 (Asia/Tokyo)

> Superseded release scope: the user subsequently chose a standalone local desktop first release, with sync, backup features, and team read-only access deferred. This document records the previous Web / Compose implementation. Its Docker installation gate is not the desktop release gate. See the [confirmed scope](../superpowers/specs/2026-10-24-local-desktop-first.md) and [migration plan](../superpowers/plans/2026-10-24-local-desktop-migration.md). Local Windows test revisions after the NAS migration remain incomplete; the broad rerun was interrupted when the product direction changed.

Windows, macOS, and Linux are product targets. Known portability defects must be fixed and tested rather than turning Windows into an unsupported platform in the README.

## Implemented

- Dependency-free Node.js setup wizard with Chinese, English, and Japanese prompts. Checks prerequisites before installation; preserves an existing `.env`; aligns Compose mounts, daemon token paths, custom ports, and UID/GID; starts services; guides model configuration and optional daemon startup.
- Read-only `--check` and `--help`; `npm run up` no longer relies on POSIX shell expansion or `mkdir -p`.
- Credentials retain strict POSIX file modes on macOS/Linux. Windows checks a private DACL for the current account, SYSTEM, and administrators, rejecting broad permissions. It does not accept synthetic Windows mode bits as proof of privacy.
- Windows browser launching, native/standard npm command-shim execution without a shell, required OS environment variables, and Claude process-tree termination.
- Windows reporting hooks encode literal PowerShell arguments; install/uninstall recognizes the encoded hooks and preserves unrelated hooks.
- Knowledge recovery normalizes Windows filesystem paths before comparing them with Git paths.
- Three-language READMEs, an MIT license, and CI covering native platform checks on all three OSes. Linux CI additionally runs the full test suite, web build/lint, and Compose startup checks.

## Local validation completed

Validation ran from a local SSD scratch copy to avoid NAS filesystem interference, using Windows and Node.js 24.22.1. The working project was not moved. Dependencies were installed only into that scratch copy.

- Root TypeScript project build and CLI test typecheck passed.
- Four installer configuration tests passed.
- Eighty-three tests across platform execution, credential ACLs, config, auth commands, knowledge storage, and history passed with two workers.
- Fourteen Claude adapter tests passed separately, including normal execution and failure/termination paths.
- Native hook execution was tested with spaces, quotes, ampersands, percent signs, and non-ASCII arguments.
- Private credentials were actually written/read/replaced on Windows; granting Everyone read access caused the reader to reject the file without leaking its contents.

## Release gates still open

The first broad Windows run in this session had **806 passing and 123 failing tests out of 929**. This was before the final recovery-path and extensionless Node-launcher fixes. It is a diagnostic baseline, not a claim about the final tree's full-suite count. The targeted checks above were rerun after the relevant fixes.

Remaining failures need triage rather than a blanket classification as harmless:

- POSIX-only `0600`/`0700` assertions and deliberately insecure `chmod` fixtures need native ACL equivalents.
- Tests using `/bin/sh`, `mkfifo`, `/dev/null`, or privileged file symlink creation need portable fixtures or explicit capability-specific coverage.
- Exact environment/hook string assertions need to account for required Windows OS variables and native hook encoding.
- Line-ending expectations and concurrent-test timeouts need review; assertions must continue checking the intended behavior.

The complete Windows suite has not been shown green. The final macOS/Linux CI matrix has not run remotely yet. The local machine has no Docker, so a real clean-machine container installation, browser/daemon connection, and model-backed first discussion were not validated here. Those checks must pass before declaring cross-platform release readiness.

No release tag was created, no GitHub Release was published, and these working changes were not pushed as part of this validation.
