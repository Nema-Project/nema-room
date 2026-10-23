-- Monotonic insertion order. created_at ties (coarse clocks) made FIFO claim and message order nondeterministic.
alter table tasks add column seq bigserial;
alter table messages add column seq bigserial;
