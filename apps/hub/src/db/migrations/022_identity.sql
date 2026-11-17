create table users (
  id text primary key,                       -- 'usr_local' 或 'usr_' || nanoid(16)
  display_name text,                         -- null = 界面用本地化的「我」；去首尾空白后 1–64 个字符
  created_at timestamptz not null default now(),
  check (id ~ '^usr_[A-Za-z0-9_-]{1,32}$'),
  check (display_name is null or char_length(display_name) between 1 and 64)
);

create table workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id),
  role text not null check (role in ('owner', 'member')),
  added_at timestamptz not null default now(),
  added_by text references users(id),        -- 迁移种入的本地用户为 null
  removed_at timestamptz,
  removed_by text references users(id),
  primary key (workspace_id, user_id),
  check ((removed_at is null) = (removed_by is null))
);
create index workspace_members_user on workspace_members (user_id);

-- 只追加。成员加入、移除、改角色、改名都写一行。
create table member_events (
  id text primary key,                       -- 'mev_' || nanoid(16)
  workspace_id text references workspaces(id) on delete cascade, -- 改名这类全局事件为 null
  user_id text not null references users(id),
  kind text not null check (kind in ('added', 'removed', 'role_changed', 'renamed')),
  actor_user_id text references users(id),   -- 迁移种入时为 null
  detail jsonb,                              -- 如 {"from":"member","to":"owner"}；不存 token、不存凭据
  created_at timestamptz not null default now()
);
create index member_events_workspace on member_events (workspace_id, created_at);

alter table messages add column author_user_id text references users(id);
alter table messages add constraint messages_author_role_check
  check (author_user_id is null or role = 'user');

insert into users (id) values ('usr_local') on conflict do nothing;
insert into workspace_members (workspace_id, user_id, role)
  select id, 'usr_local', 'owner' from workspaces
  on conflict do nothing;
insert into member_events (id, workspace_id, user_id, kind, actor_user_id)
  select 'mev_seed_' || id, id, 'usr_local', 'added', null from workspaces
  on conflict do nothing;
