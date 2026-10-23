-- A label names one repo per workspace (the Agent passes it as `repo`). Older rows that share a label
-- keep the first one bound and get their id appended, so the index can be created.
update workspace_repos r set label = r.label || ' ' || r.id
where exists (
  select 1 from workspace_repos o
  where o.workspace_id = r.workspace_id and o.label = r.label
    and (o.created_at, o.id) < (r.created_at, r.id)
);
create unique index workspace_repos_label_unique on workspace_repos (workspace_id, label);
