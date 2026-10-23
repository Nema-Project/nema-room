create table workspace_repos (
  id text primary key,                -- repo_<nanoid>
  workspace_id text not null references workspaces(id) on delete cascade,
  path text not null,                 -- realpath on the daemon machine
  git_common_dir text not null unique,
  label text not null,
  main_branch text not null,
  has_origin boolean not null,
  remote_url text,
  last_main_sha text,
  last_fetch_at timestamptz,
  last_fetch_error text,
  created_at timestamptz not null default now()
);
create table workspace_plugins (
  workspace_id text not null references workspaces(id) on delete cascade,
  plugin_id text not null,
  enabled boolean not null,
  disabled_functions text[] not null default '{}',
  primary key (workspace_id, plugin_id)
);
create table plugin_calls (
  id bigserial primary key,
  task_id text not null,
  name text not null,
  args_summary text not null,          -- first 200 chars of the JSON args
  ok boolean not null,
  result_bytes int not null,
  ms int not null,
  created_at timestamptz not null default now()
);
