-- #167 remote form: a person's password and their browser sessions. Only hashes are stored:
-- password_hash is an argon2id PHC string (apps/hub/src/passwords.ts); token_hash is the sha256 hex of a
-- high-entropy session token, as knowledge_shares does (019). No plaintext secret ever lands in a column.
create table user_credentials (
  user_id text primary key references users(id),
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id text primary key,
  user_id text not null references users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user on sessions (user_id);
