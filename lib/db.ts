import "server-only";
import pg from "pg";
import path from "node:path";

// One query interface over node-postgres (Supabase in production) and PGlite (local development).
export type Row = Record<string, unknown>;
export interface Q {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
interface Db extends Q {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
}

export const SCHEMA = "nexgen";

pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

function pgDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("pg pool error", e.message));
  const withClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query(`set search_path to ${SCHEMA}, public`);
      return await fn(c);
    } finally {
      c.release();
    }
  };
  return {
    query: (sql, params) => withClient((c) => c.query(sql, params as unknown[]) as never),
    exec: (sql) => withClient(async (c) => void (await c.query(sql))),
    tx: (fn) =>
      withClient(async (c) => {
        await c.query("begin");
        try {
          const out = await fn({ query: (s, p) => c.query(s, p as unknown[]) as never });
          await c.query("commit");
          return out;
        } catch (e) {
          await c.query("rollback").catch(() => {});
          throw e;
        }
      }),
  };
}

async function pgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  await lite.exec(`create schema if not exists ${SCHEMA}; set search_path to ${SCHEMA}, public;`);
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    query: (sql, params) => serial(() => lite.query(sql, params as unknown[]) as never),
    exec: (sql) => serial(async () => void (await lite.exec(sql))),
    tx: (fn) => serial(() => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p as unknown[]) as never }))),
  };
}

// Every uniqueness rule that prevents a duplicate lead or a duplicate email lives here, in the database.
const MIGRATION = `
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  external_case_id text not null unique,
  category text not null,
  case_name text not null,
  case_number text,
  court_id text,
  court_name text,
  company_name text not null,
  distress_type text,
  debt_amount_text text,
  debt_amount numeric,
  creditor_summary text,
  filing_date date,
  insolvency_stage text,
  founder_full_name text,
  founder_first_name text,
  founder_last_name text,
  founder_title text,
  founder_source text,
  company_domain text,
  bc_job_id text,
  direct_email text unique,
  email_status text,
  direct_mobile text,
  linkedin_url text,
  status text not null default 'discovered',
  auto_email_sent boolean not null default false,
  contacted_at timestamptz,
  last_email_at timestamptz,
  followups_sent int not null default 0,
  replied_at timestamptz,
  unread_replies int not null default 0,
  seen_at timestamptz,
  cl_url text,
  raw jsonb,
  enrich_attempts int not null default 0,
  enrich_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_created_idx on leads (created_at desc);
create index if not exists leads_status_idx on leads (status);
create index if not exists leads_bc_job_idx on leads (bc_job_id);

create table if not exists email_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  kind text not null,
  recipient_email text not null,
  subject text,
  body text,
  status text not null default 'queued',
  origin text,
  message_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
-- The first (new lead) email can exist only once per address, ever.
create unique index if not exists email_log_initial_once on email_log (recipient_email) where kind = 'initial';
-- At most one follow-up waiting per lead at a time.
create unique index if not exists email_log_followup_queued on email_log (lead_id) where kind = 'followup' and status = 'queued';
create index if not exists email_log_queue_idx on email_log (status, created_at);

create table if not exists replies (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  from_email text not null,
  from_name text,
  subject text,
  body text,
  message_id text unique,
  received_at timestamptz not null default now(),
  is_read boolean not null default false
);
create index if not exists replies_received_idx on replies (received_at desc);

create table if not exists templates (
  id text primary key,
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists runs (
  id bigserial primary key,
  kind text not null,
  ok boolean not null default true,
  summary text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists runs_created_idx on runs (created_at desc);

create table if not exists push_subs (
  endpoint text primary key,
  keys jsonb not null,
  label text,
  created_at timestamptz not null default now()
);

create table if not exists leases (
  name text primary key,
  until timestamptz not null
);

-- Update A: incoming vs historical backfill.
alter table leads add column if not exists is_historical_backfill boolean not null default false;
-- Update C: exact figures and full case details.
alter table leads add column if not exists tax_debt numeric;
alter table leads add column if not exists secured_debt numeric;
alter table leads add column if not exists unsecured_debt numeric;
alter table leads add column if not exists priority_debt numeric;
alter table leads add column if not exists liabilities_range text;
alter table leads add column if not exists figures_source text;
alter table leads add column if not exists judge text;
alter table leads add column if not exists trustee text;
alter table leads add column if not exists dba text;
alter table leads add column if not exists case_summary text;
alter table leads add column if not exists case_notes jsonb;
alter table leads add column if not exists details_checked_at timestamptz;
alter table leads add column if not exists owner_lookup_at timestamptz;
alter table leads add column if not exists is_individual boolean not null default false;
alter table leads add column if not exists contact_source text;
alter table leads add column if not exists source text not null default 'courtlistener';
alter table leads add column if not exists biz_state text;
alter table leads add column if not exists biz_city text;
alter table leads add column if not exists biz_address text;
alter table leads add column if not exists owner_lookup_note text;
create index if not exists leads_category_idx on leads (category, created_at desc);
-- Update D: a lead can receive the new-lead email once, and an address can receive it once.
create unique index if not exists email_log_initial_lead_once on email_log (lead_id) where kind = 'initial';

create table if not exists cl_budget (bucket text primary key, minute timestamptz not null, used int not null default 0);
alter table cl_budget enable row level security;

-- Token the database scheduler (pg_cron) uses to call /api/cron/tick; never leaves the database.
insert into settings (key, value) values ('cron_token', to_jsonb(md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text)))
on conflict (key) do nothing;

alter table leads enable row level security;
alter table email_log enable row level security;
alter table replies enable row level security;
alter table templates enable row level security;
alter table settings enable row level security;
alter table runs enable row level security;
alter table push_subs enable row level security;
alter table leases enable row level security;
`;

let ready: Promise<Db> | null = null;

async function open(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  const db = url ? pgDb(url) : await pgliteDb(path.join(process.cwd(), ".local", "pglite"));
  await db.exec(MIGRATION);
  if (!url && process.env.NEXGEN_DEMO === "1") await (await import("./demo")).seedDemo(db);
  return db;
}

export function db(): Promise<Db> {
  if (!ready) {
    ready = open();
    ready.catch(() => (ready = null));
  }
  return ready;
}

export async function q<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]> {
  return (await (await db()).query<T>(sql, params)).rows;
}

export async function one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null> {
  return (await q<T>(sql, params))[0] ?? null;
}

export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return (await db()).tx(fn);
}

/** A short exclusive lease so two overlapping cron calls never run the same job together. */
export async function lease(name: string, seconds: number): Promise<boolean> {
  const r = await q(
    `insert into leases (name, until) values ($1, now() + make_interval(secs => $2))
     on conflict (name) do update set until = excluded.until where leases.until < now()
     returning name`,
    [name, seconds],
  );
  return r.length > 0;
}

export async function release(name: string) {
  await q(`update leases set until = now() - interval '1 second' where name = $1`, [name]);
}
