## What changed

<!-- Explain why. If this fixes an issue, add Fixes #number. -->

## How to verify

<!-- Remove commands that do not apply to this change. -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck -w apps/cli`
- [ ] For `apps/web` changes: `npm run lint -w apps/web`
- [ ] For `apps/web` changes: `npm run build -w apps/web`

## Checklist

<!-- Remove items that do not apply to this change. -->

- [ ] User-visible behavior is recorded in a `changelog.d/<slug>.<category>.md` fragment
- [ ] Changes to installation, configuration, or usage are reflected in `README.md`, `README.ja.md`, and `README.en.md`
- [ ] UI copy changes are reflected in `apps/web/messages/zh.json`, `en.json`, and `ja.json`
- [ ] No `.env` files, tokens, `auth.json`, or contents of `~/.nema` are included
- [ ] Changes to `vendor/` follow its `VENDORED.md` source record and preserve upstream licenses
