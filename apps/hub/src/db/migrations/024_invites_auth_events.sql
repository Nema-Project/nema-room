-- #167 remote form: one-time invites and the account audit trail. code_hash is the sha256 hex of the invite
-- code; the code itself is never stored.
create table invites (
  id text primary key,
  code_hash text not null unique,
  created_by text not null references users(id),
  intended_workspace_id text references workspaces(id) on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_user_id text references users(id),
  created_at timestamptz not null default now(),
  check ((used_at is null) = (used_by_user_id is null))
);

-- Append only. Account, invite and login events; member changes stay in member_events (022), whose kind
-- check this table deliberately does not widen.
create table auth_events (
  id text primary key,
  user_id text references users(id),           -- null when the event has no account yet (e.g. a locked unknown login)
  kind text not null check (kind in ('account_created', 'invite_created', 'invite_used', 'login_locked', 'sessions_revoked', 'bootstrap_completed')),
  actor_user_id text references users(id),
  detail jsonb,                                -- never a password, token, invite code or hash
  created_at timestamptz not null default now()
);
create index auth_events_user on auth_events (user_id, created_at);
