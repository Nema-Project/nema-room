-- The account a message named for its task (spec 2026-10-31 §5.4). It is an opaque id that names an account
-- on the daemon's machine; the hub never reads accounts and never resolves this value. Null means "no
-- account named", which is the behaviour every 0.2.0 message has. Not in snapshots: an id copied to another
-- machine names an account that is not there, and the daemon treats an unknown id as unavailable.
alter table tasks add column account_id text;
