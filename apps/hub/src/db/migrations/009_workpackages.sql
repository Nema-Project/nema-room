-- Work packages: system-started tasks of kind 'workpackage', and per-workspace plugin settings.
alter table tasks add column kind text not null default 'organize' check (kind in ('organize','workpackage'));
alter table workspace_plugins add column settings jsonb not null default '{}'::jsonb;
