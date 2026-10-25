# Packaged Graphify runtime

The release payload carries Graphify. GitHub Actions builds it the same way it builds Node and Git: `desktop:stage` downloads pinned bytes, checks SHA-256, and writes `tools/graphify/`. A developer's uv install is not an input. The app does not download Graphify, uv, or Python on first launch.

## Pin

`scripts/desktop/graphify-lock.json` pins:

- CPython 3.11.17 from the python-build-standalone release `20261021`, `install_only`, for `win32-x64` and `darwin-arm64`.
- graphifyy 0.9.95 and the wheels `pip download` selects for that version with no extras.

Each file has an HTTPS URL and a SHA-256. A checksum mismatch fails the build. `sourceCorrespondence.status` stays `pending-task-7c`. This pin does not close that publication gate.

Linux is not a desktop release target and has no pin. Staging it does not invent a Graphify runtime.

## Layout

The archive extracts to `tools/graphify/python/`. Symlinks inside it are replaced with copies of the target file, so the payload has no links. Wheels unpack into that Python's `site-packages`. A wheel that uses a `.data` layout fails the build.

The launcher is `tools/graphify/graphify.exe` on Windows and `tools/graphify/graphify` on macOS. Windows staging compiles `scripts/desktop/graphify-launcher.c` with the same Clang used for the owned helper. The executable asks Windows for its own path and starts `python\python.exe -m graphify`. macOS uses a shell script that starts `python/bin/python3 -m graphify`. Neither file contains a build-machine path.

Licenses from the graphifyy wheel (`LICENSE`, `LICENSE-MIT`, `NOTICE`) and CPython's `LICENSE.txt` are copied to `tools/graphify/licenses/` and `runtime/licenses/graphify-runtime/`.

After the tree is built, staging rejects a symlink, a `uv/tools/graphifyy` path, or the current machine's home directory anywhere in those bytes.

## Out of scope

No repair button, no first-launch download, and no `PATH` lookup. The missing-runtime sentence stays `随包的 Graphify 运行环境缺失`.
