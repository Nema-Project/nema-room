create table message_versions (
  message_id text not null references messages(id) on delete cascade,
  version integer not null,
  content text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, version)
);
alter table messages add column edited_at timestamptz;
alter table tasks drop constraint tasks_kind_check;
alter table tasks add constraint tasks_kind_check check (kind in ('organize', 'workpackage', 'edit'));
