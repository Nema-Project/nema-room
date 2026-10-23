create table workspaces (
  id text primary key,
  name text not null,
  confidential boolean not null default true,
  knowledge_language text not null default 'follow' check (knowledge_language in ('ja','en','zh','follow')),
  created_at timestamptz default now()
);

create table messages (
  id text primary key,
  workspace_id text references workspaces,
  role text check (role in ('user','agent','system')),
  content text not null,
  meta jsonb,
  task_id text,
  created_at timestamptz default now()
);

create table tasks (
  id text primary key,
  workspace_id text references workspaces,
  message_id text references messages,
  status text check (status in ('queued','running','done','failed')),
  run_token text unique,
  daemon_id text,
  error text,
  created_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table task_changes (
  task_id text references tasks,
  entry_id text,
  kind text,
  title text,
  op text check (op in ('add','update')),
  created_at timestamptz default now()
);

create table entry_index (
  workspace_id text,
  entry_id text,
  kind text,
  title text,
  status text,
  priority int,
  business_date date,
  updated_at timestamptz,
  primary key (workspace_id, entry_id)
);
