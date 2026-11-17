-- Additive indexes only: existing rows and older application versions remain compatible.
create index entry_index_mention_browse_idx on entry_index (workspace_id, updated_at desc, entry_id desc);
create index message_attachments_mention_browse_idx on message_attachments (workspace_id, created_at desc, id desc)
  where status = 'attached' and message_id is not null;
create index threads_workspace_idx on threads (workspace_id);
