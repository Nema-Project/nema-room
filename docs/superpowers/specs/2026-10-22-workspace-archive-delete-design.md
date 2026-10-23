# Workspace 归档与删除（v1 补充）

对照 `docs/superpowers/specs/2026-10-21-nema-room-design.md` 的 4.6 左栏与 5.1。第一版补充：左栏 workspace 行的右键菜单。

## 意图

workspace 多了之后，左侧列表需要能收起不再看的项目，以及彻底丢掉一个项目。删除会抹掉聊天和知识，所以这一项是红色，并且必须先弹窗。

## 用户定的

- 右键点在左栏的 workspace 名字上，不要冒出浏览器自己的菜单。
- 菜单两项：归档、删除。
- 删除永久去掉这个 workspace 的聊天和项目知识，不能恢复。
- 删除用红色（现有 `--accent` `#e3241b`），并先弹窗。这是 4.6「红色只用于需要你处理」的唯一例外：破坏性确认本身就是需要你处理。

## 实现者定的

- **归档可恢复。** `archived_at` 非空即已归档。主列表不显示。列表底部有一条默认收起的「已归档 N」。展开后那些行可以右键「取消归档」或「删除」。归档不弹窗。
- **正在排队或运行的任务拦住归档和删除。** 返回 409，数据不动。取消归档不拦。检查和数据库删除放在同一个事务里。检查之后、删文件之前任务被领走的窗口接受：daemon 随后会打到已不存在的 workspace。
- **删掉的范围：** 该 workspace 的 `messages`、`tasks`、`task_changes`、`entry_index`、`workspaces` 行；`dataDir/repos/<id>`；以及 `~/.nema/ws/<id>`（CLI 写死的隔离目录）。`fs.rm` 不跟随符号链接，不得删掉 `~/.codex/auth.json`。
- **路径：** 只有匹配 `^ws_[A-Za-z0-9_-]{1,32}$` 的 id 能拼进路径。
- **当前房间被归档或删除：** 切到按 `created_at, id` 排序的下一个未归档 workspace；没有则空状态。已归档的 id 不能当当前房间打开。
- **弹窗：** `role="dialog"`。打开时焦点在「取消」。只有红色的「删除」会执行。Escape、取消、点遮罩都不删。文案带上 workspace 名称。
- 成功后重新 `GET /workspaces`。不新增 SSE 事件。不提供撤销。

## API

- `GET /workspaces` 每项多 `archived: boolean`（`archived_at` 非空）。
- `PATCH /workspaces/:id` 接受 `{ archived: boolean }`，与现有名称、保密、知识语言补丁并存。不存在 404。忙则 409，正文 `{ "error": "workspace is busy" }`。
- `DELETE /workspaces/:id`。成功 204。不存在 404。忙则 409，同上。id 不匹配上面的模式则 400，且不碰文件系统。

## 文案

| key | en | ja | zh |
|---|---|---|---|
| `sidebar.archive` | Archive | アーカイブ | 归档 |
| `sidebar.unarchive` | Unarchive | アーカイブ解除 | 取消归档 |
| `sidebar.delete` | Delete | 削除 | 删除 |
| `sidebar.archived` | Archived {n} | アーカイブ {n} | 已归档 {n} |
| `sidebar.deleteTitle` | Delete workspace | workspace を削除 | 删除 workspace |
| `sidebar.deleteBody` | This permanently deletes the chat and project knowledge for “{name}”. It cannot be undone. | 「{name}」のチャットとプロジェクト知識を完全に削除します。元に戻せません。 | 将永久删除「{name}」的聊天和项目知识，无法恢复。 |
| `sidebar.deleteConfirm` | Delete | 削除 | 删除 |
| `sidebar.cancel` | （已有 Cancel） | （已有 キャンセル） | （已有 取消） |
| `sidebar.busy` | This workspace has a task in progress. | この workspace には処理中のタスクがあります。 | 这个 workspace 还有正在处理的任务。 |

菜单里的删除与弹窗里的确认按钮用 `--accent`。其余保持现有纸白、无圆角、无阴影。

## 不做

批量、回收站、撤销、归档确认、在已归档房间里继续聊天、改 daemon 协议。
