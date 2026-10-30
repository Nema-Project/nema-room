-- Which Skills a thread has activated, so the next task in the thread starts with them (D-6).
-- Only ids, versions and times: never a Skill's text. Per install, so snapshots do not export it.
create table thread_skill_activations (
  thread_id text not null references threads(id) on delete cascade,
  skill_id text not null,
  last_activated_at timestamptz not null,
  last_task_id text not null,
  revision text not null,
  primary key (thread_id, skill_id)
);
create index thread_skill_activations_recent_idx on thread_skill_activations(thread_id, last_activated_at desc);
