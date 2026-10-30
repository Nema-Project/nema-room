-- Whether this workspace trusts the bound repository's Skills (.agents/skills, .claude/skills). Off by
-- default; only the user can change it through the UI API. Not in snapshots: a restore starts untrusted.
alter table workspace_repos add column trust_skills boolean not null default false;
