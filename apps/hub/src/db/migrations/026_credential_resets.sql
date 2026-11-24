-- #167 remote form: administrator-issued, one-time credential reset codes (plan task 5, minimal reset).
-- Like invites (024), only the sha256 hex of the code is stored, and the table never enters a snapshot:
-- an unredeemed reset after an import is simply issued again. Unlike an invite, a reset names the account
-- it resets, which invites has no column for; hence its own table rather than reusing invites.
create table credential_resets (
  id text primary key,
  user_id text not null references users(id),
  code_hash text not null unique,
  created_by text not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index credential_resets_user on credential_resets (user_id);
