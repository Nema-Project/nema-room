# 安全策略

English: this repository is public and desktop preview releases are available. Report vulnerabilities through [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new). An administrator enabled that setting on 2026-10-27 at about 11:52 Asia/Tokyo. A read at 11:54 returned HTTP 200 `{"enabled":true}`, and the public security page links to the form when signed out. A signed-in non-admin open of the form has not been recorded. Do not post sensitive details in public issues or pull requests. No dedicated security email is published. Fixes land on main and ship in a subsequent desktop release; historical release lines are not separately maintained.

日本語: このリポジトリは公開されており、デスクトップのプレビュー版も配布されています。脆弱性は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送ってください。管理者が 2026-10-27 11:52 ごろ（Asia/Tokyo）にこの設定を有効にしました。11:54 の読み取りは HTTP 200 で `{"enabled":true}` でした。未ログインの公開セキュリティページもそのフォームへリンクします。管理者ではないアカウントでサインインしてフォームを開く確認は、まだ記録されていません。公開 issue や PR に機密情報を書かないでください。専用メールアドレスは公開していません。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。

## 如何报告

**请通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交。** 维护者于 2026-10-27 约 11:52（Asia/Tokyo）启用该设置。同日 11:54 的读取为 HTTP 200 `{"enabled":true}`。未登录打开仓库安全页时，“Report a vulnerability” 指向该表单。普通非管理员登录后打开表单尚未验收，因此这项验收仍未完成。记录见 [P0 语义、升级与报告记录](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md)。

不要在公开 issue、PR 或提交记录里写漏洞细节。本项目没有单独公布安全邮箱。

在私密报告里提供受影响的桌面版本或源码 commit SHA、操作系统、影响及脱敏后的复现步骤。Never include credentials or real user data; use a redacted reproduction only in the private channel. 認証情報や実際の利用者データを含めず、非公開窓口で匿名化した再現手順だけを共有してください。不要附真实用户数据、API key、令牌、`.env`、`auth.json` 或 daemon token；只用可公开的假数据重现。

## 报告范围

这些情况属于安全报告：

- 读取或写入超出预定位置的文件。预定位置包括已绑定仓库的快照、数据目录和凭证文件。
- 凭证文件可被其他用户读取，或在权限过宽、路径为符号链接时仍被接受。
- daemon 或 hub 在文档约定的回环地址之外可被访问，或缺少本地凭证仍可调用。
- GitHub 访问超出已启用插件的范围：对未绑定仓库执行命令、未打开写入开关就修改 GitHub，或在默认路径之外读取、发送 `nema auth github` 保存的令牌。
- 上报 hook 或插件调用转发了文档写明不会发送的对话内容。

下列行为写在 README 中。只有当你能演示越过这些边界的具体步骤时，才作为漏洞报告：

- 聊天、知识和 Agent 读到的代码会发给所选模型服务商。
- 启用 GitHub 插件后，查询会发往 GitHub。
- SIWC 检查 ID token 声明，不做 JWKS 签名校验。
- Claude Code 以本机用户身份运行，工具限制不是操作系统沙箱。
- hub 和 web 默认只监听回环地址。把它们暴露到公网不属于支持的用法。

模型服务商的账号、额度、账单和条款不在本仓库的处理范围内。

## 支持的版本

当前支持桌面预览版本以及 `main` 源码的 Web / Compose 运行方式。修复首先进入 `main`，随后在新的桌面版本中分发；不承诺对历史发布系列回移修复，也没有独立的安全维护分支。CLI 不作为独立 npm 包发布。

Windows 安装包尚未签名；macOS 使用 ad-hoc 签名、未公证。安装、校验和升级限制以 [使用指南](docs/guide.zh.md) 与 [发布检查清单](scripts/desktop/RELEASE.md) 为准；安装包可下载不代表升级或恢复验收已完成。
