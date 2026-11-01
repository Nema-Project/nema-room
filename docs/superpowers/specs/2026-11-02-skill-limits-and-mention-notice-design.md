# Skill limits and dropped-mention notice

Issues [#192](https://github.com/Nema-Project/nema-room/issues/192) and [#193](https://github.com/Nema-Project/nema-room/issues/193). Serves [issue #45](https://github.com/Nema-Project/nema-room/issues/45): a person can see, from the page itself, when an installed skill is only partly usable and when an edit dropped the context they named.

## Skill limits (#192)

`skills.catalog` rows gain `diagnostics`: the codes already on `SkillUsage` (`name-folder-mismatch` and the other front-matter codes). No paths and no file contents. `runtimes` stays as it is. The hub already forwards the daemon payload.

The web client keeps `runtimes` and `diagnostics` on the skill row. An older daemon that omits them shows the skill with no extra lines.

The plugin page (installed skill rows that carry `skill`) and the `/` menu show:

- one line per runtime whose `missing` list is not empty, naming the runtime and the gaps
- one line when `diagnostics` contains `name-folder-mismatch`

Other diagnostic codes stay on the payload and off the page. Notes such as `model-override` stay off the page.

The Installed section counts rows that cannot be used: install failed, availability other than `ready`, or an error. A row that is merely switched off is not in that count. The count is a toggle; pressed, the Installed list shows only those rows. Type and search still apply. Discover is unchanged.

## Dropped mentions (#193)

On save, the editor compares the message's mentions with `syncMentions(draft, mentions)` (`keepMentionsFor`). After a successful save, if the count fell, a status line says how many were removed. The save is not blocked and there is no confirm dialog. A failed save shows no such line. The hub rule is unchanged.

## Copy

New strings live in `apps/web/messages/{en,zh,ja}.json`.
