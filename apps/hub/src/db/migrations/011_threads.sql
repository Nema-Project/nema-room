alter table messages add column thread_id text null references messages(id);
create index messages_thread_idx on messages(thread_id, seq);
create table threads (
  id text primary key references messages(id),
  workspace_id text not null references workspaces(id),
  title text not null,
  opened_by text not null check (opened_by in ('agent','user','grill')),
  last_read_seq bigint not null default 0,
  created_at timestamptz not null default now()
);
create table question_threads (
  workspace_id text not null references workspaces(id),
  question_id text not null,
  thread_id text not null references threads(id),
  primary key (workspace_id, question_id)
);
