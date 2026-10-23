-- Derived state about each diagram's code: whether main moved under one of its node paths since it
-- was drawn. It is recomputed from git, so it never goes into the knowledge repo.
create table diagram_status (
  workspace_id text not null,
  entry_id text not null,
  stale boolean not null default false,
  checked_sha text,
  primary key (workspace_id, entry_id)
);
