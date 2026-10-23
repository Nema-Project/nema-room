# Vendored: superpowers rules

- Upstream: superpowers 7.0.0 (Claude plugin, local plugin cache `claude-plugins-official/superpowers/7.0.0`)
- Source skills: `brainstorming` ("The Written Design") and `writing-plans`
- Vendored on: 2026-10-23
- License: MIT, "Copyright (c) 2025 Jesse Vincent" (see `LICENSE`)

`spec-rules.md` and `plan-rules.md` are rewritten essentials, not copies. They are adapted to Nema's work
packages: the Chinese section headings and the markers (`[R-n]`, `### 任务 <n>：`, `- 修改：`, `- 满足：`) are what
the hub parses. The hub serves them to the Agent through `workpackage__read`.
