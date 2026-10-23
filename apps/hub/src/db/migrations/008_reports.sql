-- Coding agents report finished work to Nema as `report` messages.
alter table messages drop constraint if exists messages_role_check;
alter table messages add constraint messages_role_check check (role in ('user','agent','system','report'));

-- sha256 hex of each daemon's ~/.nema/report-token; the token itself is never stored.
create table report_tokens (
  hash text primary key,
  created_at timestamptz default now()
);

-- What coding-agent hooks sent: only agent, branch, head, session id and time.
create table repo_hooks (
  id bigserial primary key,
  repo_id text not null references workspace_repos(id) on delete cascade,
  agent text not null,
  branch text,
  head text not null,
  session_id text,
  at timestamptz not null
);

-- Every move of a repo's main branch, so the fallback can find moves no report covers.
create table main_moves (
  id bigserial primary key,
  repo_id text not null references workspace_repos(id) on delete cascade,
  from_sha text,
  to_sha text not null,
  at timestamptz not null default now(),
  handled boolean not null default false
);
