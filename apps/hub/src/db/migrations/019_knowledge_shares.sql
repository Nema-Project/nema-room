-- Read-only knowledge share links. The token itself is never stored, only its sha256.
create table knowledge_shares (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  token_hash text not null unique,
  note text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index knowledge_shares_workspace on knowledge_shares (workspace_id);
