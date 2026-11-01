-- The account this task asked for (spec 2026-10-31 §5.4), and whether the task allowed automatic routing.
--
-- Both are nullable and nothing reads them as a requirement: an old hub's rows, and a task nobody gave an
-- account to, are the same "not chosen". The id is opaque here — the hub cannot know whether that account
-- exists on the daemon's machine — so the only check is the allowance's value, which this version can only
-- ever set to "auto".
alter table tasks add column account_id text null;
alter table tasks add column routing text null check (routing in ('auto'));
