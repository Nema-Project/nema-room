---
name: nema-report
description: Report finished, committed work to Nema so it can track which requirements are implemented. Use after you finish a unit of work and commit it in a repository that Nema follows.
---

# Report finished work to Nema

When you have finished a unit of work and committed it, tell Nema what you did. Run this from inside the repository:

```sh
nema report --summary "<one line: what you finished>" --commits <sha>[,<sha>...] --entries <id>[,<id>...] --files <path>[,<path>...]
```

- Report once per finished unit of work, after the commits exist. Don't report work that is unfinished or not yet committed.
- `--commits`: the commits that hold this work (`git log` shows them).
- `--entries`: reference requirement ids like R-7 when you know them. Leave the flag out when you don't.
- `--files`: list only files you changed, as paths relative to the repository root.
- Keep the summary short and factual. Never include secrets, tokens, keys or credentials anywhere in a report.
- If `.nema/W-*/plan.md` exists in your working tree, report each finished task with `--entries W-n --task <n>`.

If the command says Nema is unreachable, the report is kept locally and sent later. You don't need to retry. If it says the repository isn't bound to Nema, stop reporting for this repository.
