## 做了什么

<!-- 说明原因。若修复了 issue，写上 Fixes #编号。 -->

## 怎样验证

<!-- 删去与本次改动无关的命令。 -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck -w apps/cli`
- [ ] 改了 `apps/web`：`npm run lint -w apps/web`
- [ ] 改了 `apps/web`：`npm run build -w apps/web`

## 清单

<!-- 删去与本次改动无关的项。 -->

- [ ] 用户能感知的行为已写入 `CHANGELOG.md` 的 `## [Unreleased]`
- [ ] 安装、配置或使用方式有变时，已同步 `README.md`、`README.en.md`、`README.ja.md`
- [ ] 界面文案已同时改 `apps/web/messages/zh.json`、`en.json`、`ja.json`
- [ ] 没有提交 `.env`、令牌、`auth.json` 或 `~/.nema` 中的内容
- [ ] 改了 `vendor/` 时，已按 `VENDORED.md` 更新来源记录并保留原许可证
