# 安全策略

English: this repository is private, so GitHub's advisory form does not exist and returns 404. Open a [security issue](https://github.com/Nema-Project/nema-room/issues/new?template=security.yml). Describe the impact. Do not include tokens, `.env`, `auth.json`, daemon tokens, or exploit steps. This page continues in Chinese.

日本語: このリポジトリは非公開のため、GitHub の脆弱性報告フォームは 404 になります。[セキュリティ issue](https://github.com/Nema-Project/nema-room/issues/new?template=security.yml) を開いてください。影響だけを書き、トークン、`.env`、悪用手順は貼らないでください。本文は中国語です。

## 如何报告

本仓库是私有的。GitHub 的私密漏洞报告只对公开仓库提供，`/security/advisories/new` 会返回 404。私有仓库从 2024 年 5 月起也不能创建安全通告。

请使用 [安全 issue 模板](https://github.com/Nema-Project/nema-room/issues/new?template=security.yml)。写上 commit SHA、操作系统和影响。不要写利用步骤，不要粘贴令牌、`.env`、`auth.json` 或 daemon token。维护者需要样本时会再问。

本项目没有单独的安全邮箱。密钥也不要写入 pull request 或提交记录。

## 报告范围

这些情况属于安全报告：

- 读取或写入超出预定位置的文件。预定位置包括已绑定仓库的快照、数据目录和凭证文件。
- 凭证文件可被其他用户读取，或在权限过宽、路径为符号链接时仍被接受。
- daemon 或 hub 在文档约定的回环地址之外可被访问，或缺少本地凭证仍可调用。
- GitHub 令牌的保存或发送超出 `auth github` 和已启用插件的范围。
- 上报 hook 或插件调用转发了文档写明不会发送的对话内容。

下列行为写在 README 中。只有当你能演示越过这些边界的具体步骤时，才作为漏洞报告：

- 聊天、知识和 Agent 读到的代码会发给所选模型服务商。
- 启用 GitHub 插件后，查询会发往 GitHub。
- SIWC 检查 ID token 声明，不做 JWKS 签名校验。
- Claude Code 以本机用户身份运行，工具限制不是操作系统沙箱。
- hub 和 web 默认只监听回环地址。把它们暴露到公网不属于支持的用法。

模型服务商的账号、额度、账单和条款不在本仓库的处理范围内。

## 支持的版本

安装方式是默认分支的源码。CLI 不作为独立 npm 包发布，也没有单独的安全维护分支。修复进入 `main`。

桌面打包仍在迁移中。源码安装的 Web / Compose 路径是当前支持的运行方式。
