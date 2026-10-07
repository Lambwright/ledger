// Small, idempotent schema additions the worker applies to itself the first
// time an instance needs them (LEDGER has no migration runner; the service key
// that the old manual path needed stays server-side). Each is guarded by a
// module flag, so it runs once per worker instance, not per request.
import { dbQuery } from './db.js';

let bulkSchemaReady = false;

// Bulk project reconciliation (Ben's ask 2026-09-30) — see bulk.js.
export async function ensureBulkSchema(env) {
  if (bulkSchemaReady) return;
  await dbQuery(env, `create table if not exists bulk_reconciliations (
    id uuid primary key default gen_random_uuid(),
    tenant_id text not null,
    project_id text not null,
    disposition text not null check (disposition in ('billed', 'reconciled_to_period', 'written_off')),
    notes text,
    invoice_number text,
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'reopened', 'cancelled')),
    requested_by text not null,
    requested_by_name text,
    requested_at timestamptz not null default now(),
    started_at timestamptz,
    completed_at timestamptz,
    record_count integer,
    amount numeric,
    error text,
    reopened_by text,
    reopened_at timestamptz
  )`, []);
  await dbQuery(env, `create index if not exists bulk_reconciliations_project on bulk_reconciliations (tenant_id, project_id, requested_at desc)`, []);
  await dbQuery(env, `alter table billing_records add column if not exists bulk_reconciliation_id uuid`, []);
  // The write-off reason list gains 'bulk_reconciliation'. Replace the check
  // constraint only if it doesn't already allow it.
  const constraints = await dbQuery(env, `
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'write_offs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%reason_category%'`, []);
  if (!constraints.some(c => c.def.includes('bulk_reconciliation'))) {
    for (const c of constraints) {
      await dbQuery(env, `alter table write_offs drop constraint "${c.conname.replace(/"/g, '')}"`, []);
    }
    await dbQuery(env, `alter table write_offs add constraint write_offs_reason_category_check check (reason_category in
      ('warranty', 'service_call', 'goodwill', 'pm_decision', 'other', 'already_billed', 'bulk_reconciliation')) not valid`, []);
    // NOT VALID: applies to new rows only, so an odd reason on some old row
    // can't make this migration fail halfway (constraint dropped, not re-added).
  }
  bulkSchemaReady = true;
}

let prefsSchemaReady = false;

// Per-person view preferences (Ben, 2026-10-06: dashboard column setup), keyed
// by Einbau ID username. Only ever the person's own view — never billing data.
export async function ensurePrefsSchema(env) {
  if (prefsSchemaReady) return;
  await dbQuery(env, `create table if not exists user_preferences (
    tenant_id text not null,
    username text not null,
    pref_key text not null,
    value jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, username, pref_key)
  )`, []);
  prefsSchemaReady = true;
}

let portfolioActualsReady = false;

// The budget view's own cost and invoicing totals, kept beside the actuals so
// the dashboard can flag a project whose budget doesn't cover everything
// (2026-10-07). See refreshProjectSnapshot.
export async function ensurePortfolioActualsColumns(env) {
  if (portfolioActualsReady) return;
  await dbQuery(env, `alter table portfolio_projects
    add column if not exists budget_view_cost numeric,
    add column if not exists budget_view_invoiced numeric`, []);
  portfolioActualsReady = true;
}
