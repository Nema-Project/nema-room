/**
 * Isolated synthetic benchmark for mention-candidate search. Not product code.
 *
 * Creates database nema_mention_bench on a local Postgres, applies this repo's hub
 * migrations, loads generated rows, times the current pool queries against
 * substring and subsequence candidates, then drops that database.
 *
 * Refuses a non-local host and refuses to write the application database `nema`.
 * Does not read NEMA_DATABASE_URL. Does not print the connection string.
 *
 *   NEMA_BENCH_ADMIN_URL=postgres://nema:nema@127.0.0.1:5433/postgres \
 *     node scripts/bench/mention-candidate-search.mjs --out /tmp/mention-bench.json
 *
 * Options: --runs <n>  --scales <500,2000,10000>  --only <all|correctness>  --out <file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

const BENCH_DB = "nema_mention_bench";
const MENU = 8;
const POOL = 500;
const ATTACHMENT_POOL = 50;
const RUNS_DEFAULT = 5;
const SCALES_DEFAULT = [500, 2000, 10000];
const QUERIES = [
  ["empty", ""],
  ["common", "发布"],
  ["rare", "最旧独特标题"],
  ["miss", "没有这个词zz"],
  ["subseq", "发流"],
  ["subseq-old", "甲流乙"],
  ["short", "发"],
];
const RAPID = ["发", "发布", "发布流", "发布流程"];

const root = fileURLToPath(new URL("../..", import.meta.url));
const migrationDir = path.join(root, "apps/hub/src/db/migrations");

function parseArgs(argv) {
  let runs = RUNS_DEFAULT;
  let scales = SCALES_DEFAULT;
  let only = "all";
  let out = "";
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument ${flag}`);
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--runs") runs = Number(value);
    else if (flag === "--scales") scales = value.split(",").map((part) => Number(part));
    else if (flag === "--only") only = value;
    else if (flag === "--out") out = value;
    else throw new Error(`unknown flag ${flag}`);
    i += 1;
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("--runs must be 1..20");
  if (!scales.length || scales.some((scale) => !Number.isInteger(scale) || scale < 1 || scale > 100_000)) {
    throw new Error("--scales must be integers from 1 to 100000");
  }
  if (only !== "all" && only !== "correctness") throw new Error("--only must be all or correctness");
  return { runs, scales, only, out };
}

function adminConfig() {
  const raw = process.env.NEMA_BENCH_ADMIN_URL ?? "postgres://nema:nema@127.0.0.1:5433/postgres";
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("admin URL must be postgres");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("bench refuses a non-local host");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== "postgres") throw new Error("admin URL must use the maintenance database named postgres");
  if (BENCH_DB === "nema") throw new Error("refusing to use the application database");
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function benchConfig(admin) {
  return { ...admin, database: BENCH_DB };
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function summarize(times) {
  return {
    samples: times.map(round),
    min: round(Math.min(...times)),
    median: round(median(times)),
    max: round(Math.max(...times)),
  };
}

function loadFuzzyScore() {
  const source = readFileSync(path.join(root, "packages/shared/src/mentions.ts"), "utf8");
  const start = source.indexOf("const TIER = 100_000;");
  const end = source.indexOf("export function keepMentionsFor");
  if (start < 0 || end < start) throw new Error("fuzzyScore source markers moved; bench oracle was not updated");
  const slice = source
    .slice(start, end)
    .replace(/export function fuzzyScore\([^)]*\)[^{]*/, "function fuzzyScore(query, candidate) ");
  return new Function(`${slice}; return fuzzyScore;`)();
}

function subsequencePattern(query) {
  return Array.from(query.toLowerCase())
    .map((ch) => ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
}

async function applyMigrations(client) {
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationDir, file), "utf8");
    await client.query(sql);
  }
  await client.query(`
    create function bench_subseq(haystack text, needle text) returns boolean
    language plpgsql immutable parallel safe as $$
    declare
      rest text := haystack;
      i int;
      pos int;
    begin
      if needle is null or needle = '' then
        return true;
      end if;
      for i in 1..char_length(needle) loop
        pos := strpos(rest, substr(needle, i, 1));
        if pos = 0 then
          return false;
        end if;
        rest := substr(rest, pos + 1);
      end loop;
      return true;
    end;
    $$
  `);
}

function titleFor(i, n) {
  if (i === n) return "最旧独特标题";
  if (i === n - 1) return "甲发中流乙";
  if (i === n - 2) return "发布";
  if (i % 10 === 0) return `发布流程 ${i}`;
  if (i % 10 === 1) return `版本发布 ${i}`;
  if (i % 10 === 2) return `notes/发布/log-${i}`;
  if (i % 17 === 0) return `罕见标记-${i}`;
  return `记录 ${i} 普通标题`;
}

async function loadWorkspace(client, workspaceId, n) {
  await client.query(
    `insert into workspaces (id, name) values ($1, $1) on conflict (id) do nothing`,
    [workspaceId],
  );
  const entryIds = [];
  const titles = [];
  for (let i = 1; i <= n; i += 1) {
    entryIds.push(`D-${i}`);
    titles.push(titleFor(i, n));
  }
  await client.query(
    `insert into entry_index (workspace_id, entry_id, kind, title, status, priority, updated_at)
     select $1, row.entry_id, 'note', row.title, 'active', 0, now() - (row.ord || ' seconds')::interval
     from unnest($2::text[], $3::text[]) with ordinality as row(entry_id, title, ord)`,
    [workspaceId, entryIds, titles],
  );
  await client.query(
    `insert into messages (id, workspace_id, role, content, created_at)
     select $1 || '-m-' || row.ord, $1, 'user', 'anchor', now() - (row.ord || ' seconds')::interval
     from generate_series(1, $2) as row(ord)`,
    [workspaceId, n],
  );
  await client.query(
    `insert into threads (id, workspace_id, title, opened_by, created_at)
     select $1 || '-m-' || row.ord, $1, row.title, 'user', now() - (row.ord || ' seconds')::interval
     from unnest($2::text[]) with ordinality as row(title, ord)`,
    [workspaceId, titles],
  );
  await client.query(
    `insert into messages (id, workspace_id, role, content, thread_id, created_at)
     select $1 || '-r-' || row.ord, $1, 'user', 'reply', $1 || '-m-' || row.ord,
            now() - (row.ord || ' seconds')::interval + interval '1 second'
     from generate_series(1, $2) as row(ord)`,
    [workspaceId, n],
  );
  await client.query(
    `insert into message_attachments
       (id, workspace_id, message_id, kind, mime, name, size, sha256, upload_key, status, created_at, attached_at)
     select $1 || '-a-' || row.ord, $1, $1 || '-m-' || row.ord, 'text', 'text/plain', row.title, 16,
            md5($1 || row.ord::text) || md5('x' || $1 || row.ord::text),
            gen_random_uuid(), 'attached', now() - (row.ord || ' seconds')::interval, now()
     from unnest($2::text[]) with ordinality as row(title, ord)`,
    [workspaceId, titles],
  );
}

const STRATEGIES = ["original", "substring", "subseq-regex", "subseq-linear"];

function entrySql(strategy) {
  if (strategy === "original") {
    return `select entry_id as id, title, updated_at
            from entry_index
            where workspace_id = $1
            order by updated_at desc, entry_id desc
            limit ${POOL}`;
  }
  if (strategy === "substring") {
    return `select entry_id as id, title
            from entry_index
            where workspace_id = $1
              and $2 <> ''
              and (strpos(lower(entry_id), lower($2)) > 0 or strpos(lower(title), lower($2)) > 0)
            order by (lower(entry_id) = lower($2)) desc,
                     (strpos(lower(entry_id), lower($2)) = 1 or strpos(lower(title), lower($2)) = 1) desc,
                     updated_at desc, entry_id desc
            limit 9`;
  }
  const predicate = strategy === "subseq-regex"
    ? `lower(entry_id || ' ' || title) ~ $3`
    : `bench_subseq(lower(entry_id || ' ' || title), lower($2))`;
  return `select id, title from (
            select entry_id as id, title, updated_at, lower(entry_id || ' ' || title) as folded
            from entry_index
            where workspace_id = $1 and $2 <> '' and ${predicate}
          ) s
          order by (lower(id) = lower($2)) desc,
                   case
                     when strpos(reverse(split_part(reverse(folded), '/', 1)), lower($2)) = 1 then 3
                     when strpos(folded, lower($2)) = 1 or strpos(folded, '/' || lower($2)) > 0 then 2
                     else 1
                   end desc,
                   char_length(folded) asc,
                   updated_at desc,
                   id desc
          limit 9`;
}

function threadSql(strategy) {
  const activity = `coalesce(max(m.created_at), t.created_at)`;
  if (strategy === "original") {
    return `select t.id, t.title, ${activity} as activity
            from threads t
            left join messages m on m.thread_id = t.id
            where t.workspace_id = $1
            group by t.id
            order by ${activity} desc, t.id desc
            limit ${POOL}`;
  }
  if (strategy === "substring") {
    return `select t.id, t.title
            from threads t
            where t.workspace_id = $1 and $2 <> '' and strpos(lower(t.title), lower($2)) > 0
            order by (strpos(lower(t.title), lower($2)) = 1) desc, t.created_at desc, t.id desc
            limit 9`;
  }
  const predicate = strategy === "subseq-regex"
    ? `lower(t.title) ~ $3`
    : `bench_subseq(lower(t.title), lower($2))`;
  return `select id, title from (
            select t.id, t.title, lower(t.title) as folded, ${activity} as activity
            from threads t
            left join messages m on m.thread_id = t.id
            where t.workspace_id = $1 and $2 <> '' and ${predicate}
            group by t.id
          ) s
          order by case
                     when strpos(reverse(split_part(reverse(folded), '/', 1)), lower($2)) = 1 then 3
                     when strpos(folded, lower($2)) = 1 or strpos(folded, '/' || lower($2)) > 0 then 2
                     else 1
                   end desc,
                   char_length(folded) asc,
                   activity desc,
                   id desc
          limit 9`;
}

function attachmentSql(strategy) {
  if (strategy === "original") {
    return `select id, name, created_at
            from message_attachments
            where workspace_id = $1 and status = 'attached' and message_id is not null
            order by created_at desc, id desc
            limit ${ATTACHMENT_POOL + 1}`;
  }
  if (strategy === "substring") {
    return `select id, name
            from message_attachments
            where workspace_id = $1 and status = 'attached' and message_id is not null
              and $2 <> '' and strpos(lower(name), lower($2)) > 0
            order by (strpos(lower(name), lower($2)) = 1) desc, created_at desc, id desc
            limit 17`;
  }
  const predicate = strategy === "subseq-regex"
    ? `lower(name) ~ $3`
    : `bench_subseq(lower(name), lower($2))`;
  return `select id, name from (
            select id, name, created_at, lower(name) as folded
            from message_attachments
            where workspace_id = $1 and status = 'attached' and message_id is not null
              and $2 <> '' and ${predicate}
          ) s
          order by case
                     when strpos(reverse(split_part(reverse(folded), '/', 1)), lower($2)) = 1 then 3
                     when strpos(folded, lower($2)) = 1 or strpos(folded, '/' || lower($2)) > 0 then 2
                     else 1
                   end desc,
                   char_length(folded) asc,
                   created_at desc,
                   id desc
          limit 17`;
}

function emptySql(group) {
  if (group === "entries") {
    return `select entry_id as id, title from entry_index
            where workspace_id = $1
            order by updated_at desc, entry_id desc
            limit 9`;
  }
  if (group === "threads") {
    return `select t.id, t.title
            from threads t
            left join messages m on m.thread_id = t.id
            where t.workspace_id = $1
            group by t.id
            order by coalesce(max(m.created_at), t.created_at) desc, t.id desc
            limit 9`;
  }
  return `select id, name from message_attachments
          where workspace_id = $1 and status = 'attached' and message_id is not null
          order by created_at desc, id desc
          limit 17`;
}

function sqlFor(group, strategy, query) {
  if (query === "" && strategy !== "original") return emptySql(group);
  if (group === "entries") return entrySql(strategy);
  if (group === "threads") return threadSql(strategy);
  return attachmentSql(strategy);
}

function paramsFor(strategy, workspaceId, query) {
  if (strategy === "original" || query === "") return [workspaceId];
  if (strategy === "substring" || strategy === "subseq-linear") return [workspaceId, query];
  return [workspaceId, query, subsequencePattern(query)];
}

function menuFromRows(strategy, group, query, rows, fuzzyScore) {
  const limit = group === "attachments" && strategy === "original" ? ATTACHMENT_POOL : rows.length;
  const pool = strategy === "original" && group === "attachments" ? rows.slice(0, ATTACHMENT_POOL) : rows;
  if (strategy !== "original") {
    const menu = pool.slice(0, MENU).map((row) => row.id);
    return { menu, returned: pool.length, scannedPool: pool.length };
  }
  if (query === "") return { menu: pool.slice(0, MENU).map((row) => row.id), returned: pool.length, scannedPool: pool.length };
  const textOf = group === "entries"
    ? (row) => `${row.id} ${row.title}`
    : group === "threads"
      ? (row) => row.title
      : (row) => row.name;
  const exactOf = group === "entries" ? (row) => row.id.toLowerCase() === query.toLowerCase() : () => false;
  const needle = query.toLowerCase();
  const scored = pool
    .map((row) => ({ row, score: fuzzyScore(needle, textOf(row)) ?? -1, exact: exactOf(row) }))
    .filter((row) => row.score >= 0 || row.exact);
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  return {
    menu: scored.slice(0, MENU).map((row) => row.row.id),
    returned: scored.length,
    scannedPool: pool.length,
    unusedLimit: limit,
  };
}

async function timed(client, group, strategy, workspaceId, query, fuzzyScore) {
  const sql = sqlFor(group, strategy, query);
  const params = paramsFor(strategy, workspaceId, query);
  const started = performance.now();
  const result = await client.query(sql, params);
  const sqlMs = performance.now() - started;
  const ranked = menuFromRows(strategy, group, query, result.rows, fuzzyScore);
  return { sqlMs, totalMs: performance.now() - started, ...ranked };
}

async function combined(client, strategy, workspaceId, query, fuzzyScore) {
  const started = performance.now();
  const groups = await Promise.all(["entries", "threads", "attachments"].map((group) => timed(client, group, strategy, workspaceId, query, fuzzyScore)));
  return { wallMs: performance.now() - started, groups };
}

async function sampleCombined(client, strategy, workspaceId, query, fuzzyScore, runs) {
  await combined(client, strategy, workspaceId, query, fuzzyScore);
  const walls = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    last = await combined(client, strategy, workspaceId, query, fuzzyScore);
    walls.push(last.wallMs);
  }
  return { wall: summarize(walls), groups: last.groups.map(({ menu, returned, scannedPool }) => ({ menu, returned, scannedPool })) };
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function oracleMenu(query, rows, textOf, exactOf, fuzzyScore) {
  if (query === "") return rows.slice(0, MENU).map((row) => row.id);
  const needle = query.toLowerCase();
  const scored = rows
    .map((row) => ({ row, score: fuzzyScore(needle, textOf(row)) ?? -1, exact: exactOf(row) }))
    .filter((row) => row.score >= 0 || row.exact);
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  return scored.slice(0, MENU).map((row) => row.row.id);
}

async function fetchOracle(client, workspaceId) {
  const entries = await client.query(
    `select entry_id as id, title from entry_index where workspace_id = $1 order by updated_at desc, entry_id desc`,
    [workspaceId],
  );
  const threads = await client.query(
    `select t.id, t.title
     from threads t left join messages m on m.thread_id = t.id
     where t.workspace_id = $1
     group by t.id
     order by coalesce(max(m.created_at), t.created_at) desc, t.id desc`,
    [workspaceId],
  );
  const attachments = await client.query(
    `select id, name from message_attachments
     where workspace_id = $1 and status = 'attached' and message_id is not null
     order by created_at desc, id desc`,
    [workspaceId],
  );
  return { entries: entries.rows, threads: threads.rows, attachments: attachments.rows };
}

function flattenPlan(plan, out = []) {
  out.push({
    node: plan["Node Type"],
    actualMs: plan["Actual Total Time"],
    rows: plan["Actual Rows"],
    removed: plan["Rows Removed by Filter"] ?? null,
    sharedHit: plan["Shared Hit Blocks"] ?? null,
    sharedRead: plan["Shared Read Blocks"] ?? null,
  });
  for (const child of plan.Plans ?? []) flattenPlan(child, out);
  return out;
}

async function explain(client, group, strategy, workspaceId, query) {
  const sql = sqlFor(group, strategy, query);
  const params = paramsFor(strategy, workspaceId, query);
  const result = await client.query(`explain (analyze, buffers, format json) ${sql}`, params);
  const rootPlan = result.rows[0]["QUERY PLAN"][0];
  return {
    planningMs: rootPlan["Planning Time"],
    executionMs: rootPlan["Execution Time"],
    nodes: flattenPlan(rootPlan.Plan),
  };
}

async function resetData(client) {
  await client.query(`truncate message_attachments, threads, messages, entry_index, workspaces cascade`);
}

async function correctness(client, fuzzyScore) {
  await loadWorkspace(client, "bench-tiny", 30);
  await client.query(
    `insert into entry_index (workspace_id, entry_id, kind, title, status, priority, updated_at) values
      ('bench-tiny', 'D-meta', 'note', '100%_done', 'active', 0, now()),
      ('bench-tiny', 'D-dot', 'note', 'a.b*c', 'active', 0, now()),
      ('bench-tiny', 'D-plain', 'note', 'abc', 'active', 0, now()),
      ('bench-tiny', 'D-nl', 'note', E'发\\n流', 'active', 0, now()),
      ('bench-tiny', 'D-tr', 'note', 'İstanbul', 'active', 0, now()),
      ('bench-tiny', 'D-sz', 'note', 'straße', 'active', 0, now()),
      ('bench-tiny', 'D-em', 'note', 'a😀b', 'active', 0, now()),
      ('bench-tiny', 'D-case', 'note', 'AbCdef', 'active', 0, now())`,
  );
  await client.query(
    `insert into workspaces (id, name) values ('bench-other', 'bench-other') on conflict do nothing`,
  );
  await client.query(
    `insert into entry_index (workspace_id, entry_id, kind, title, status, priority, updated_at)
     values ('bench-other', 'D-1', 'note', '最旧独特标题', 'active', 0, now())`,
  );
  const probes = ["发布", "发流", "甲流乙", "最旧独特标题", "没有这个词zz", "%", "_", ".*", ".", "*", "abc"];
  const audits = [];
  for (const query of probes) {
    const jsRows = await client.query(
      `select entry_id as id, title from entry_index where workspace_id = 'bench-tiny'`,
    );
    const js = new Set(
      jsRows.rows.filter((row) => fuzzyScore(query, `${row.id} ${row.title}`) !== null).map((row) => row.id),
    );
    const regex = new Set((await client.query(
      `select entry_id as id from entry_index
       where workspace_id = 'bench-tiny' and lower(entry_id || ' ' || title) ~ $1`,
      [subsequencePattern(query)],
    )).rows.map((row) => row.id));
    const linear = new Set((await client.query(
      `select entry_id as id from entry_index
       where workspace_id = 'bench-tiny' and bench_subseq(lower(entry_id || ' ' || title), lower($1))`,
      [query],
    )).rows.map((row) => row.id));
    const substring = new Set((await client.query(
      `select entry_id as id from entry_index
       where workspace_id = 'bench-tiny'
         and (strpos(lower(entry_id), lower($1)) > 0 or strpos(lower(title), lower($1)) > 0)`,
      [query],
    )).rows.map((row) => row.id));
    const missingFromRegex = [...js].filter((id) => !regex.has(id));
    const extraRegex = [...regex].filter((id) => !js.has(id));
    const missingFromLinear = [...js].filter((id) => !linear.has(id));
    const extraLinear = [...linear].filter((id) => !js.has(id));
    audits.push({
      query,
      js: js.size,
      substring: substring.size,
      regex: regex.size,
      linear: linear.size,
      missingFromRegex,
      extraRegex,
      missingFromLinear,
      extraLinear,
      substringMisses: [...js].filter((id) => !substring.has(id)),
    });
  }
  const leaked = await client.query(
    `select entry_id from entry_index
     where workspace_id = 'bench-tiny' and title = '最旧独特标题' and entry_id in (
       select entry_id from entry_index where workspace_id = 'bench-other'
     )`,
  );
  const otherVisible = await client.query(
    `select count(*)::int as n from entry_index
     where workspace_id = 'bench-tiny' and entry_id = 'D-1' and title = '最旧独特标题'`,
  );
  const caseFold = [];
  for (const [title, query] of [["İstanbul", "i"], ["İstanbul", "İ"], ["i", "İ"], ["straße", "ss"], ["straße", "ß"], ["a😀b", "😀"], ["发\n流", "发流"]]) {
    const js = fuzzyScore(query, title);
    const sql = await client.query(
      `select lower($1) as folded, lower($1) ~ $3 as regex, bench_subseq(lower($1), lower($2)) as linear`,
      [title, query, subsequencePattern(query)],
    );
    caseFold.push({
      title,
      query,
      jsMatch: js !== null,
      sqlFolded: sql.rows[0].folded,
      jsFolded: title.toLowerCase(),
      regex: sql.rows[0].regex,
      linear: sql.rows[0].linear,
    });
  }
  await resetData(client);
  return { audits, otherWorkspaceRowsWithSameId: otherVisible.rows[0].n, leakedRows: leaked.rows.length, caseFold };
}

async function environment(client) {
  const version = await client.query(`select version()`);
  const settings = await client.query(
    `select name, setting, unit from pg_settings
     where name in ('server_version', 'shared_buffers', 'work_mem', 'effective_cache_size', 'max_parallel_workers_per_gather', 'lc_collate', 'lc_ctype')`,
  );
  const db = await client.query(`select datcollate, datctype from pg_database where datname = current_database()`);
  return {
    postgres: version.rows[0].version,
    settings: Object.fromEntries(settings.rows.map((row) => [row.name, `${row.setting}${row.unit ?? ""}`])),
    databaseCollation: db.rows[0],
    host: { cpus: os.cpus().length, model: os.cpus()[0]?.model ?? "unknown", totalMemBytes: os.totalmem() },
    node: process.version,
  };
}

async function counts(client, workspaceId) {
  const out = {};
  for (const [name, query] of QUERIES) {
    if (query === "") continue;
    const result = await client.query(
      `select
         count(*) filter (where strpos(lower(title), lower($2)) > 0 or strpos(lower(entry_id), lower($2)) > 0)::int as substring,
         count(*) filter (where lower(entry_id || ' ' || title) ~ $3)::int as regex,
         count(*) filter (where bench_subseq(lower(entry_id || ' ' || title), lower($2)))::int as linear
       from entry_index where workspace_id = $1`,
      [workspaceId, query, subsequencePattern(query)],
    );
    out[name] = result.rows[0];
  }
  return out;
}

async function attachmentWindow(client) {
  const n = 40;
  const titles = Array.from({ length: n }, (_, index) => `报告-${index + 1}.txt`);
  await loadWorkspace(client, "bench-missing", n);
  await client.query(`update message_attachments set name = row.title from unnest($1::text[]) with ordinality as row(title, ord) where id = 'bench-missing-a-' || row.ord and workspace_id = 'bench-missing'`, [titles]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "nema-mention-bench-"));
  try {
    for (let i = 17; i <= n; i += 1) await writeFile(path.join(dir, `bench-missing-a-${i}`), "x");
    for (let i = 1; i <= 50; i += 1) await writeFile(path.join(dir, `present-${i}`), "x");
    async function statIds(ids) {
      const times = [];
      let present = 0;
      let absent = 0;
      for (let run = 0; run < 21; run += 1) {
        const started = performance.now();
        present = 0;
        absent = 0;
        for (const id of ids) {
          try {
            const info = await stat(path.join(dir, id));
            if (info.isFile()) present += 1;
            else absent += 1;
          } catch {
            absent += 1;
          }
        }
        if (run > 0) times.push(performance.now() - started);
      }
      return { ...summarize(times), present, absent };
    }
    const newest16 = Array.from({ length: 16 }, (_, index) => `bench-missing-a-${index + 1}`);
    const firstAvailableIs = 17;
    const missingStats = await statIds(newest16);
    const presentStats = await statIds(Array.from({ length: 50 }, (_, index) => `present-${index + 1}`));
    const updateTimes = [];
    for (let run = 0; run < 6; run += 1) {
      await client.query("begin");
      const updateStarted = performance.now();
      for (const id of newest16) {
        await client.query(`update message_attachments set status = 'missing' where id = $1 and workspace_id = 'bench-missing' and status = 'attached'`, [id]);
      }
      if (run > 0) updateTimes.push(performance.now() - updateStarted);
      await client.query("rollback");
    }
    const updateSummary = summarize(updateTimes);
    await client.query("begin");
    for (const id of newest16) {
      await client.query(`update message_attachments set status = 'missing' where id = $1 and workspace_id = 'bench-missing' and status = 'attached'`, [id]);
    }
    const stillThere = await client.query(
      `select count(*)::int as n from message_attachments
       where workspace_id = 'bench-missing' and status = 'attached' and name like '报告-%'`,
    );
    await client.query("rollback");
    return {
      orderedMatches: n,
      statBudget: 16,
      newestMissing: 16,
      firstPresentOrdinal: firstAvailableIs,
      menuWouldReturn: missingStats.present,
      attachedRowsRemainingAfterMarkingBudget: stillThere.rows[0].n,
      filesPresentOnDisk: n - 16,
      stat16Missing: missingStats,
      stat50Present: presentStats,
      serialUpdatesFor16Missing: updateSummary,
      note: "Ordinal 17 is the first file that exists. A budget that stats only the newest 16 never opens it. The 17th row is also the old spec's probe row, which is not returned and is not stat'd.",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await resetData(client);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fuzzyScore = loadFuzzyScore();
  if (fuzzyScore("发流", "发布流程") === null) throw new Error("oracle does not match the documented subsequence example");
  if (fuzzyScore("发流", "版本发布") !== null) throw new Error("oracle matched 发流 against 版本发布");
  const admin = adminConfig();
  const adminClient = new pg.Client(admin);
  await adminClient.connect();
  await adminClient.query(`
    select pg_terminate_backend(pid) from pg_stat_activity
    where datname = $1 and pid <> pg_backend_pid()`, [BENCH_DB]);
  await adminClient.query(`drop database if exists ${BENCH_DB}`);
  await adminClient.query(`create database ${BENCH_DB}`);
  const client = new pg.Client(benchConfig(admin));
  await client.connect();
  let pool;
  const started = new Date().toISOString();
  try {
    await client.query(`set statement_timeout = '20s'`);
    await applyMigrations(client);
    const env = await environment(client);
    log("correctness");
    const checks = await correctness(client, fuzzyScore);
    const generator = (id) => /^D-\d+$/.test(id);
    const generatorMiss = checks.audits.filter((row) =>
      [...row.missingFromRegex, ...row.extraRegex, ...row.missingFromLinear, ...row.extraLinear].some(generator));
    const star = checks.audits.find((row) => row.query === ".*");
    const percent = checks.audits.find((row) => row.query === "%");
    if (generatorMiss.length) throw new Error(`predicate disagrees with fuzzyScore on generated rows: ${JSON.stringify(generatorMiss)}`);
    if (!star || star.extraRegex.includes("D-plain") || star.missingFromRegex.includes("D-dot")) {
      throw new Error(`regex escape failed: ${JSON.stringify(star)}`);
    }
    if (!percent || percent.extraRegex.includes("D-plain") || percent.missingFromRegex.includes("D-meta")) {
      throw new Error(`percent literal failed: ${JSON.stringify(percent)}`);
    }
    const abc = checks.audits.find((row) => row.query === "abc");
    if (!abc || abc.missingFromRegex.includes("D-case") || abc.missingFromLinear.includes("D-case") || abc.extraRegex.includes("D-plain")) {
      throw new Error(`ASCII case fold failed: ${JSON.stringify(abc)}`);
    }
    pool = new pg.Pool({ ...benchConfig(admin), max: 16 });
    const held = [];
    for (let i = 0; i < 16; i += 1) held.push(await pool.connect());
    for (const heldClient of held) await heldClient.query(`set statement_timeout = '20s'`);
    for (const heldClient of held) heldClient.release();
    const report = {
      started,
      command: "node scripts/bench/mention-candidate-search.mjs",
      database: BENCH_DB,
      host: admin.host,
      port: admin.port,
      runs: options.runs,
      scales: options.scales,
      distribution: "Per scale N: D-1 newest through D-N oldest. Titles: N=最旧独特标题, N-1=甲发中流乙, N-2=发布, i%10=0 发布流程, i%10=1 版本发布, i%10=2 notes/发布/log, i%17=0 罕见标记, else 记录. One reply message per thread. Attachment names copy titles. Second workspace bench-b is loaded only after the largest scale's timings.",
      environment: env,
      correctness: checks,
      scalesMeasured: [],
    };
    if (options.only === "correctness") {
      report.finished = new Date().toISOString();
      const json = JSON.stringify(report, null, 2);
      if (options.out) writeFileSync(options.out, json);
      process.stdout.write(json);
      return;
    }
    for (const scale of options.scales) {
      log(`scale ${scale}`);
      await loadWorkspace(client, "bench-a", scale);
      await client.query(`analyze`);
      const oracle = await fetchOracle(client, "bench-a");
      const matchCounts = await counts(client, "bench-a");
      const queries = {};
      for (const [name, query] of QUERIES) {
        queries[name] = {};
        for (const strategy of STRATEGIES) {
          log(`  ${name} ${strategy}`);
          let combinedResult;
          try {
            combinedResult = await sampleCombined(pool, strategy, "bench-a", query, fuzzyScore, options.runs);
          } catch (error) {
            queries[name][strategy] = { error: error.code ?? "error", message: String(error.message).slice(0, 300) };
            log(`  ${name} ${strategy} failed ${error.code ?? error.message}`);
            continue;
          }
          const entryOracle = oracleMenu(query, oracle.entries, (row) => `${row.id} ${row.title}`, (row) => row.id.toLowerCase() === query.toLowerCase(), fuzzyScore);
          const threadOracle = oracleMenu(query, oracle.threads, (row) => row.title, () => false, fuzzyScore);
          const attachmentOracle = oracleMenu(query, oracle.attachments, (row) => row.name, () => false, fuzzyScore);
          const [entries, threads, attachments] = combinedResult.groups;
          queries[name][strategy] = {
            wall: combinedResult.wall,
            entries: { ...entries, agreesWithFullFuzzy: sameIds(entries.menu, entryOracle) },
            threads: { ...threads, agreesWithFullFuzzy: sameIds(threads.menu, threadOracle) },
            attachments: { ...attachments, agreesWithFullFuzzy: sameIds(attachments.menu, attachmentOracle) },
            findsOutsideEntry: entries.menu.includes(`D-${scale - 1}`),
            findsOldestEntry: entries.menu.includes(`D-${scale}`),
          };
        }
      }
      const plans = {};
      for (const [name, query] of [["empty", ""], ["common", "发布"], ["subseq-old", "甲流乙"], ["miss", "没有这个词zz"]]) {
        plans[name] = {};
        for (const strategy of ["original", "substring", "subseq-regex", "subseq-linear"]) {
          try {
            plans[name][strategy] = {
              entries: await explain(client, "entries", strategy, "bench-a", query),
              threads: await explain(client, "threads", strategy, "bench-a", query),
            };
          } catch (error) {
            plans[name][strategy] = { error: error.code ?? "error", message: String(error.message).slice(0, 300) };
          }
        }
      }
      let twin = null;
      if (scale === options.scales[options.scales.length - 1]) {
        log("  twin workspace");
        await loadWorkspace(client, "bench-b", scale);
        await client.query(`analyze`);
        const before = plans.common["subseq-regex"].entries;
        const after = await explain(client, "entries", "subseq-regex", "bench-a", "发布");
        const ranked = entrySql("subseq-regex")
          .replace(
            "select entry_id as id, title, updated_at, lower(entry_id || ' ' || title) as folded",
            "select entry_id as id, workspace_id, title, updated_at, lower(entry_id || ' ' || title) as folded",
          )
          .replace("select id, title from", "select id, workspace_id from");
        const found = await client.query(ranked, paramsFor("subseq-regex", "bench-a", "发布"));
        const foreign = found.rows.filter((row) => row.workspace_id !== "bench-a").length;
        twin = {
          rowsPerWorkspace: scale,
          planBeforeTwin: before,
          planAfterTwin: after,
          menuRows: found.rows.length,
          foreignWorkspaceRows: foreign,
        };
      }
      report.scalesMeasured.push({ scale, matchCounts, queries, plans, twin });
      if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2));
      await resetData(client);
    }
    log("rapid and concurrent");
    const large = options.scales[options.scales.length - 1];
    await loadWorkspace(client, "bench-a", large);
    await client.query(`analyze`);
    const rapid = {};
    for (const strategy of ["original", "subseq-regex", "substring"]) {
      await combined(pool, strategy, "bench-a", RAPID[0], fuzzyScore);
      const serial = [];
      const parallel = [];
      for (let i = 0; i < options.runs; i += 1) {
        const serialStarted = performance.now();
        for (const query of RAPID) await combined(pool, strategy, "bench-a", query, fuzzyScore);
        serial.push(performance.now() - serialStarted);
        const parallelStarted = performance.now();
        await Promise.all(RAPID.map((query) => combined(pool, strategy, "bench-a", query, fuzzyScore)));
        parallel.push(performance.now() - parallelStarted);
      }
      rapid[strategy] = { serial: summarize(serial), parallelInFlight: summarize(parallel), steps: RAPID };
    }
    const concurrent = {};
    for (const strategy of ["original", "subseq-regex"]) {
      const walls = [];
      for (let i = 0; i < options.runs; i += 1) {
        const startedAt = performance.now();
        await Promise.all(Array.from({ length: 8 }, () => combined(pool, strategy, "bench-a", "发布", fuzzyScore)));
        walls.push(performance.now() - startedAt);
      }
      concurrent[strategy] = { clients: 8, query: "发布", eachClientRunsEntriesThreadsAttachments: true, wall: summarize(walls) };
    }
    log("adversarial regex");
    await client.query(`set statement_timeout = '3s'`);
    await client.query(
      `insert into entry_index (workspace_id, entry_id, kind, title, status, priority, updated_at)
       select 'bench-a', 'A-' || i, 'note', repeat('a', 500), 'active', 0, now()
       from generate_series(1, 1000) as i`,
    );
    const adversarial = {};
    for (const length of [8, 20, 30, 100, 200]) {
      const query = "a".repeat(length);
      const startedAt = performance.now();
      try {
        const result = await client.query(
          `select count(*)::int as n from entry_index
           where workspace_id = 'bench-a' and entry_id like 'A-%' and lower(title) ~ $1`,
          [subsequencePattern(query)],
        );
        adversarial[`regex-${length}`] = { ms: round(performance.now() - startedAt), matches: result.rows[0].n, timedOut: false };
      } catch (error) {
        adversarial[`regex-${length}`] = { ms: round(performance.now() - startedAt), timedOut: error.code === "57014", error: error.code ?? error.message };
      }
      const linearStarted = performance.now();
      try {
        const result = await client.query(
          `select count(*)::int as n from entry_index
           where workspace_id = 'bench-a' and entry_id like 'A-%' and bench_subseq(lower(title), lower($1))`,
          [query],
        );
        adversarial[`linear-${length}`] = { ms: round(performance.now() - linearStarted), matches: result.rows[0].n, timedOut: false };
      } catch (error) {
        adversarial[`linear-${length}`] = { ms: round(performance.now() - linearStarted), timedOut: error.code === "57014", error: error.code ?? error.message };
      }
    }
    await client.query(`set statement_timeout = '20s'`);
    await resetData(client);
    log("attachment window");
    const attachments = await attachmentWindow(client);
    report.rapid = rapid;
    report.concurrent = concurrent;
    report.adversarial = {
      rows: 1000,
      titleLength: 500,
      statementTimeout: "3s",
      results: adversarial,
    };
    report.attachmentWindow = attachments;
    report.finished = new Date().toISOString();
    report.limits = "Times are warm-cache observations on this process after one untimed warmup and ANALYZE. They are not a latency SLO and they do not finish roadmap item P2-02.";
    const json = JSON.stringify(report, null, 2);
    if (options.out) writeFileSync(options.out, json);
    process.stdout.write(json);
  } finally {
    await pool?.end().catch(() => {});
    await client.end().catch(() => {});
    await adminClient.query(`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()`, [BENCH_DB]).catch(() => {});
    await adminClient.query(`drop database if exists ${BENCH_DB}`).catch((error) => {
      log(`drop database failed: ${error.message}`);
    });
    await adminClient.end().catch(() => {});
  }
}

main().catch((error) => {
  log(error.stack || error.message);
  process.exitCode = 1;
});
