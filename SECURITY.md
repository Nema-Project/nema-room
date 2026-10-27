# 安全策略

English: this repository is public and desktop preview releases are available. Private vulnerability reporting is the intended channel, but its availability has not yet been verified. Do not post sensitive details in public issues or pull requests. Until verification, you may only ask for a private contact route without disclosing the vulnerability. No dedicated security email is published. Fixes land on main and ship in a subsequent desktop release; historical release lines are not separately maintained.

日本語: このリポジトリは公開されており、デスクトップのプレビュー版も配布されています。非公開の脆弱性報告窓口は利用可否を確認中です。公開 issue や PR に機密情報を書かず、確認が済むまでは脆弱性の内容を含めずに非公開の連絡方法だけを問い合わせてください。専用メールアドレスは公開していません。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。

## 如何报告

**私密报告渠道待验证，当前不能声明已可用。** 预定入口是 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new)。需要先确认仓库已启用该功能，并由有权报告的普通非管理员用户验证表单可访问；仅有 URL 或管理员能打开页面不能作为证据。验证状态见 [P0 发布保障记录](docs/reviews/2026-10-26-p0-release-assurance.md)。

验证完成前，不要提交敏感详情；仅可在公开渠道提出不含漏洞细节的“请提供私密联系途径”请求。不要使用公开 issue、PR 或提交记录报告漏洞细节。本项目没有单独公布安全邮箱。

确认私密渠道可用后，在该渠道提供受影响的桌面版本或源码 commit SHA、操作系统、影响及脱敏后的复现步骤。Never include credentials or real user data; use a redacted reproduction only in the verified private channel. 認証情報や実際の利用者データを含めず、確認済みの非公開窓口で匿名化した再現手順だけを共有してください。不要附真实用户数据、API key、令牌、`.env`、`auth.json` 或 daemon token；只用可公开的假数据重现。

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
