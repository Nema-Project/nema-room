# Repository binding and settings groups

Approved 2026-10-25. Two settings surfaces, shipped together. Packaging the Graphify runtime is specified separately in `docs/superpowers/specs/2026-10-25-graphify-package-design.md`.

## Repository binding

The add-repository form stops asking the user to type a purpose and a main branch before anything is known about the folder.

Windows opens the system folder picker (`IFileOpenDialog` with `FOS_PICKFOLDERS`), not `FolderBrowserDialog`. macOS keeps `choose folder`. Linux keeps `zenity --file-selection --directory`. Cancel still returns no path. A picker that fails to start still reports `无法打开文件夹选择器`.

After a path is chosen, the hub asks the daemon `repo.inspect` and returns a preview:

- `root`, `defaultBranch`, `hasOrigin`, `remoteUrl` from that inspect
- `label`, the last path segment of `root`, cut to 40 code points
- `labelTaken`, whether this workspace already has that label

The form then shows the local path, the remote URL, and the detected main branch as text. There is no empty branch field and no empty label field. The remote line shows `remoteUrl`, or the existing no-origin sentence when `hasOrigin` is false. The only action is the existing add-repository button, directly under that summary, enabled only after a preview succeeds.

If `labelTaken` is true, the label field appears, filled with the suggested label, and the add button stays disabled until the text is a different non-empty name. A duplicate discovered only at bind still shows the hub's 409 and keeps the preview. Inspect failures (not a git root, under `~/.nema`, daemon down) show the error and do not enable add. Cancelling the dialog leaves the previous preview in place.

Bind sends `{ path: preview.root, label, mainBranch: preview.defaultBranch }`. `mainBranch` is the preview's branch, which is `main` when inspect did not return a branch name. Already-bound rows still edit label and branch as they do now.

Copy, same keys in en / ja / zh:

- `code.remote`: Remote / リモート / 远程仓库
- `code.previewing`: Reading the repository… / リポジトリを読み込んでいます… / 正在读取仓库…
- `code.labelTaken`: This name is already used here. Choose another. / この名前は既に使われています。別の名前にしてください。 / 这个名字已经用过了。换一个。

## Model settings groups

The model block, the provider block, and the sign-in block are three groups. Each group uses the sidebar surface (`--side`). The drawer stays `--paper`, and the inputs and selects stay `--paper`, so the group is a tint and the controls stay the page color. The page color shows between groups. No new color is introduced. Dark mode uses the same tokens.
