# 安全策略

English: this repository is public and desktop preview releases are available. Report vulnerabilities through [private vulnerability reporting](https://github.com/Nema-Project/nema-room/security/advisories/new). An administrator enabled that setting on 2026-10-27 at about 11:52 Asia/Tokyo. A read at 11:54 returned HTTP 200 `{"enabled":true}`, and the public security page links to the form when signed out. A signed-in collaborator with read permission, not an administrator, reached the form at 12:18 Asia/Tokyo. The test report was closed at 12:27 the same day without publication and without a CVE. Recorded in the [2026-10-27 review](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md). Do not post sensitive details in public issues or pull requests. No dedicated security email is published. Fixes land on main and ship in a subsequent desktop release; historical release lines are not separately maintained.

日本語: このリポジトリは公開されており、デスクトップのプレビュー版も配布されています。脆弱性は [非公開の脆弱性報告](https://github.com/Nema-Project/nema-room/security/advisories/new) から送ってください。管理者が 2026-10-27 11:52 ごろ（Asia/Tokyo）にこの設定を有効にしました。11:54 の読み取りは HTTP 200 で `{"enabled":true}` でした。未ログインの公開セキュリティページもそのフォームへリンクします。管理者ではない read 権限のコラボレーターが 12:18（Asia/Tokyo）にフォームへ到達しました。テスト報告は同日 12:27 に、公開も CVE もないまま閉じられました。公開 issue や PR に機密情報を書かないでください。専用メールアドレスは公開していません。修正は main に入り、以降のデスクトップ版で配布されます。旧リリース系列の個別保守は約束していません。

## 如何报告

**请通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交。** 维护者于 2026-10-27 约 11:52（Asia/Tokyo）启用该设置。同日 11:54 的读取为 HTTP 200 `{"enabled":true}`。未登录打开仓库安全页时，“Report a vulnerability” 指向该表单。read 权限、非管理员的协作者于 12:18（Asia/Tokyo）提交的测试报告已于同日 12:27 关闭，未发布，也没有 CVE。记录见 [P0 语义、升级与报告记录](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md)。

不要在公开 issue、PR 或提交记录里写漏洞细节。本项目没有单独公布安全邮箱。

在私密报告里提供受影响的桌面版本或源码 commit SHA、操作系统、影响及脱敏后的复现步骤。Never include credentials or real user data; use a redacted reproduction only in the private channel. 認証情報や実際の利用者データを含めず、非公開窓口で匿名化した再現手順だけを共有してください。不要附真实用户数据、API key、令牌、`.env`、`auth.json` 或 daemon token；只用可公开的假数据重现。

## 报告范围

这些情况属于安全报告：

- 读取或写入超出预定位置的文件。预定位置包括已绑定仓库的快照、数据目录和凭证文件。
- 凭证文件可被其他用户读取，或在权限过宽、路径为符号链接时仍被接受。
- daemon 或 hub 在文档约定的回环地址之外可被访问，或缺少本地凭证仍可调用。远程形态下同样属于报告：未开启远程形态时 hub 在回环之外可达，或已开启远程形态但真实认证（账号登录）或 Host 允许清单未启用时可达。已开启远程形态、且认证与 Host 清单齐备的部署不在此列。
- GitHub 访问超出已启用插件的范围：对未绑定仓库执行命令、未打开写入开关就修改 GitHub，或在默认路径之外读取、发送 `nema auth github` 保存的令牌。
- 上报 hook 或插件调用转发了文档写明不会发送的对话内容。

下列行为写在 README 中。只有当你能演示越过这些边界的具体步骤时，才作为漏洞报告：

- 聊天、知识和 Agent 读到的代码会发给所选模型服务商。
- 启用 GitHub 插件后，查询会发往 GitHub。
- SIWC 检查 ID token 声明，不做 JWKS 签名校验。
- Claude Code 以本机用户身份运行，工具限制不是操作系统沙箱。
- hub 和 web 默认只监听回环地址。默认形态下，把它们暴露到局域网或公网不属于支持的用法。远程形态仅在受信网络（局域网或自备 VPN 组网）内、且已完成账号引导与认证时受支持；hub 直面公网在任何形态下都不属于支持的用法。

模型服务商的账号、额度、账单和条款不在本仓库的处理范围内。

### 已知边界：聊天附件不做恶意内容扫描

附件只检查类型和大小，**不扫描病毒或恶意内容**。上传一个带恶意内容的 PDF 或图片本身不算漏洞。现有的缓解措施如下：

- 类型按文件开头的字节判断，扩展名必须与内容一致。只接受 PNG、JPEG、WebP、GIF、PDF 和严格 UTF-8 文本；SVG、Office 文档、压缩包等一律拒收（`apps/hub/src/attachments.ts`）。单个文件和每个任务都有大小上限，见[使用指南](docs/guide.zh.md#attachments)。
- 下载时带 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`；文本文件一律以 `text/plain` 返回，HTML 或类似 SVG 的内容不会在页面里渲染（`apps/hub/src/attachmentRoutes.ts`）。
- Nema 不执行附件，只把它原样交给所选的模型服务商。服务商如何解析文件由服务商决定。

如果能演示附件绕过这些检查（例如被当作网页渲染、写到预定位置之外，或在本机被执行），请按漏洞报告。

### 已知边界：只读知识库分享链接

分享链接是 capability URL。持有链接即可读取该知识库的公开投影；撤销后的下一次请求必须失败。分享页只接受内网和局域网来源，不信任转发头。默认形态下 hub 不对局域网或公网发布；远程形态下 hub 的发布是受控的（账号认证加 Host 允许清单），分享页自身的来源口径不因此改变。局域网分享走明文 HTTP、未加密，同一局域网内的设备可以窃听分享内容，这是已知边界。能绕过撤销、用分享页读到聊天或附件、借公开页把 `/api` 暴露到非回环 Host、或从公网来源读到分享页，才是漏洞。

### 已知边界：远程形态（多人）

远程形态（`NEMA_HUB_REMOTE=1`）把 hub 从单机工具变成小团队共享服务，威胁模型随之改变，部署者须知：

- **受信网络前提**：远程形态只支持部署在局域网或自备 VPN 组网内。hub 自身不做 TLS 终止，链路默认明文；链路加密由部署通道负责（VPN 加密层，或部署者自备的反向代理提供 https）。把 hub 直接暴露到公网不属于支持的用法。
- **登录面**：密码登录是新增的爆破面，hub 以登录限速与连续失败锁定缓解；口令强度由使用者负责，hub 只存 argon2id 哈希、不存明文。
- **凭据只存哈希**：会话 token、daemon 凭据、邀请码与注册码在 hub 侧一律只存哈希。daemon 凭据按「用户 × 机器」单独签发，共享的单机 token 在远程形态下不被接受。
- **泄露处置靠吊销**：会话可按用户整体吊销，daemon 凭据可按台吊销；凭据疑似泄露时先吊销再重发，不存在轮换中的灰色状态。
- **权限边界**：工作区成员资格是内容访问的边界，非成员账号即使能登录 hub 也读不到工作区内容；成员资格校验由 hub 在每个内容接口上执行。

能演示绕过登录、绕过成员校验、用已吊销的会话或 daemon 凭据继续访问、或让未列入 Host 允许清单的 Host 通过校验的，属于漏洞报告。远程形态的部署步骤与配置见[使用指南](docs/guide.zh.md)。

## 支持的版本

当前支持桌面预览版本、npm 包 `@nema-project/nema`（命令名 `nema`，与同一 tag 的桌面版版本号一致），以及 `main` 源码的 Web / Compose 运行方式。修复首先进入 `main`，随后在新的桌面版本和对应的 `@nema-project/nema` 版本中分发；不承诺对历史发布系列回移修复，也没有独立的安全维护分支。

Windows 安装包尚未签名；macOS 使用 ad-hoc 签名、未公证。安装、校验和升级限制以 [使用指南](docs/guide.zh.md) 与 [发布检查清单](scripts/desktop/RELEASE.md) 为准；安装包可下载不代表升级或恢复验收已完成。
