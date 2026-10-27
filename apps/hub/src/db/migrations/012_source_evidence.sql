create table evidence_events (
  id text primary key,
  workspace_id text not null references workspaces(id),
  kind text not null check (kind in ('promote_basis', 'confirm_revision', 'confirm_entry')),
  entry_id text not null,
  target_basis text check (target_basis in ('stated', 'decided')),
  revision text,
  content_hash text not null,
  refs_hash text not null,
  snapshot_hash text,
  payload_hash text not null,
  actor text not null check (actor = 'user'),
  created_at timestamptz not null default now(),
  consumed_commit text,
  consumed_at timestamptz,
  consumable boolean not null default true,
  check (
    (kind = 'promote_basis' and target_basis is not null)
    or (kind = 'confirm_revision')
    or (kind = 'confirm_entry' and target_basis is null)
  ),
  check (
    (consumed_commit is null and consumed_at is null)
    or (consumed_commit is not null and consumed_at is not null)
  ),
  check (kind <> 'confirm_revision' or snapshot_hash is not null)
);
create index evidence_events_entry_idx on evidence_events (workspace_id, entry_id, created_at);
create unique index evidence_events_unconsumed_payload_idx
  on evidence_events (workspace_id, payload_hash)
  where consumed_commit is null and consumable;

create table source_import_receipts (
  workspace_id text not null references workspaces(id),
  provider text not null,
  resource_id text not null,
  revision_key text not null,
  content_hash text not null,
  entry_id text,
  phase text not null check (phase in ('reserved', 'committed', 'indexed')),
  knowledge_commit text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, provider, resource_id, revision_key, content_hash)
);

create table source_freshness (
  workspace_id text not null references workspaces(id),
  entry_id text not null,
  freshness text not null check (freshness in ('current', 'changed', 'unavailable', 'unknown')),
  checked_revision text,
  reason text not null check (reason in ('match', 'mismatch', 'not_found', 'forbidden', 'offline', 'timeout', 'incomparable')),
  checked_at timestamptz not null,
  primary key (workspace_id, entry_id),
  check (
    (freshness = 'current' and reason = 'match' and checked_revision is not null)
    or (freshness = 'changed' and reason = 'mismatch' and checked_revision is not null)
    or (freshness = 'unavailable' and reason in ('not_found', 'forbidden'))
    or (freshness = 'unknown' and reason in ('offline', 'timeout', 'incomparable'))
  )
);
