-- Skills the agent offered to install during a task. A row lives only until the task's reply is
-- saved: the reply's meta then carries the offers, so snapshots do not export this table.
create table task_skill_offers (
  task_id text not null references tasks(id) on delete cascade,
  skill_id text not null,
  offer jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (task_id, skill_id)
);
