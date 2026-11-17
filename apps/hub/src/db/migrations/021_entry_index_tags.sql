alter table entry_index add column if not exists tags text[];
alter table entry_index add column if not exists tags_indexed_at timestamptz;
