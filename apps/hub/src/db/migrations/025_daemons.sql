-- #167 remote form: registered daemons with per-machine credentials. daemons.id is the stable id that
-- replaces the daemonId minted per connection today. credential_hash and code_hash are sha256 hex; the
-- credential and the registration code themselves are never stored.
create table daemons (
  id text primary key,
  owner_user_id text not null references users(id),
  label text not null,
  credential_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index daemons_owner on daemons (owner_user_id);

create table daemon_registration_codes (
  id text primary key,
  code_hash text not null unique,
  owner_user_id text not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_daemon_id text references daemons(id),
  created_at timestamptz not null default now(),
  check ((used_at is null) = (used_by_daemon_id is null))
);

-- Append only. daemon_id is nullable for events that name no registered daemon row, and owner_user_id is
-- nullable because a hello rejected for an unknown credential has no known owner to record.
create table daemon_events (
  id text primary key,
  daemon_id text references daemons(id),
  owner_user_id text references users(id),
  kind text not null check (kind in ('registered', 'revoked', 'rejected')),
  actor_user_id text references users(id),
  detail jsonb,                                -- never a credential, registration code or hash
  created_at timestamptz not null default now()
);
create index daemon_events_daemon on daemon_events (daemon_id, created_at);
