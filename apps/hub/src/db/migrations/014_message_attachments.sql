-- Chat attachments (#104). Bytes live in <dataDir>/attachments/<workspace_id>/<id>; this table holds
-- the metadata. Deleted rows stay as tombstones (D-4); expired staged uploads are removed.
create table message_attachments (
  id text primary key,
  workspace_id text not null references workspaces(id),
  message_id text references messages(id),
  kind text not null check (kind in ('image', 'pdf', 'text')),
  mime text not null,
  name text not null,
  -- integer, not bigint: pg returns bigint as a string, and no file can exceed 20 MB.
  size integer not null check (size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  upload_key uuid not null,
  status text not null check (status in ('staged', 'attached', 'deleted', 'missing', 'expired')),
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  deleted_at timestamptz,
  -- The same kind/mime/size rules as AttachmentRefSchema in @nema/shared.
  check (
    (kind = 'image' and mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') and size <= 10485760)
    or (kind = 'pdf' and mime = 'application/pdf' and size <= 20971520)
    or (kind = 'text' and mime = 'text/plain' and size <= 524288)
  ),
  -- staged / expired rows belong to no message; every other status does.
  check ((status in ('staged', 'expired')) = (message_id is null))
);
create unique index message_attachments_upload_key_idx on message_attachments (workspace_id, upload_key);
create index message_attachments_message_idx on message_attachments (message_id);
create index message_attachments_staged_idx on message_attachments (status, created_at) where status = 'staged';
