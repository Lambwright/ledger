// Crew hours vs invoicing (Ben / Leela, 2026-10-27): how many hours Einbau's
// own crew logged on each project, per month, next to what was invoiced that
// month. Hours come from Procore Timesheets — the company-wide
// GET /rest/v1.0/companies/{id}/timecard_entries?start_date=&end_date=
// (verified: start_date/end_date filter; filters[date] is ignored; pages of
// 100). Invoicing by month comes from the owner invoices LEDGER already reads
// on every project refresh (billing date — Ben's choice), so it costs nothing.
//
// The nightly run (runScheduled, quiet hours only) re-reads the last ~6 weeks
// of timesheets in one sweep, and works back through older months one at a
// time to HOURS_FROM, then keeps those months as they are.
import { dbQuery } from './db.js';
import { procoreRequest } from './procore.js';

export const HOURS_FROM = '2024-01-01';
const RECENT_DAYS = 40;

let ready = false;
export async function ensureHoursSchema(env) {
  if (ready) return;
  const existed = await dbQuery(env, `select to_regclass('project_invoiced_monthly') is not null as present`, []);
  await dbQuery(env, `create table if not exists project_hours_monthly (
    tenant_id text not null, project_id text not null, month date not null,
    hours numeric not null, entries integer not null, updated_at timestamptz not null default now(),
    primary key (tenant_id, project_id, month)
  )`, []);
  await dbQuery(env, `create table if not exists project_invoiced_monthly (
    tenant_id text not null, project_id text not null, month date not null,
    invoiced numeric not null, invoices integer not null, updated_at timestamptz not null default now(),
    primary key (tenant_id, project_id, month)
  )`, []);
  await dbQuery(env, `alter table portfolio_sync_state
    add column if not exists hours_synced_at timestamptz,
    add column if not exists hours_backfilled_from date`, []);
  await dbQuery(env, `alter table portfolio_projects add column if not exists hours_to_date numeric`, []);
  // First time only: re-read every project overnight so invoicing-by-month
  // exists for closed projects too (they otherwise refresh monthly). dirty_at
  // 3h back keeps it out of daytime runs.
  if (!existed[0]?.present) {
    await dbQuery(env, `update portfolio_projects set dirty_at = now() - interval '3 hours'
      where dirty_at is null and active is not false`, []);
  }
  ready = true;
}

const monthOf = (date) => `${String(date).slice(0, 7)}-01`;
const iso = (d) => d.toISOString().slice(0, 10);

// Replaces one project's invoicing-by-month from its invoice list (non-draft,
// gross of retainage — the same figure as the dashboard's Invoiced).
export async function saveInvoicedByMonth(env, tenantId, projectId, invoices) {
  if (!Array.isArray(invoices)) return;
  await ensureHoursSchema(env);
  const byMonth = new Map();
  for (const inv of invoices) {
    if (String(inv.status || '').toLowerCase() === 'draft') continue;
    const date = inv.billing_date || inv.period_end || inv.created_at;
    if (!date) continue;
    const m = monthOf(date);
    const cur = byMonth.get(m) || { invoiced: 0, invoices: 0 };
    cur.invoiced += Number(inv.total_amount_accrued_this_period) || 0;
    cur.invoices += 1;
    byMonth.set(m, cur);
  }
  await dbQuery(env, `delete from project_invoiced_monthly where tenant_id = $1 and project_id = $2`, [tenantId, String(projectId)]);
  const rows = [...byMonth.entries()];
  if (rows.length === 0) return;
  const values = [];
  const params = [tenantId, String(projectId)];
  rows.forEach(([month, v], i) => {
    const b = 3 + i * 3;
    values.push(`($1, $2, $${b}::date, $${b + 1}, $${b + 2})`);
    params.push(month, Math.round(v.invoiced * 100) / 100, v.invoices);
  });
  await dbQuery(env, `insert into project_invoiced_monthly (tenant_id, project_id, month, invoiced, invoices) values ${values.join(', ')}`, params);
}

// Every timesheet entry from start to end (inclusive). Throws on a refusal so
// the caller's rate-limit handling stops the run without writing anything.
async function fetchTimecardEntries(env, start, end) {
  const all = [];
  for (let page = 1; page <= 200; page++) {
    const res = await procoreRequest(env, 'GET',
      `/rest/v1.0/companies/${env.PROCORE_COMPANY_ID}/timecard_entries?start_date=${start}&end_date=${end}&page=${page}&per_page=100`);
    if (res.status !== 200 || !Array.isArray(res.data)) {
      const err = new Error(`Timesheets read failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    all.push(...res.data);
    if (res.data.length < 100) break;
  }
  return all;
}

// Re-reads whole months [fromMonth .. through end] and replaces their rows.
async function syncMonths(env, tenantId, fromMonth, end) {
  const entries = await fetchTimecardEntries(env, fromMonth, end);
  const byKey = new Map();
  for (const e of entries) {
    if (e.deleted_at || !e.project_id || !e.date) continue;
    const key = `${e.project_id}|${monthOf(e.date)}`;
    const cur = byKey.get(key) || { hours: 0, entries: 0 };
    cur.hours += Number(e.hours) || 0;
    cur.entries += 1;
    byKey.set(key, cur);
  }
  await dbQuery(env, `delete from project_hours_monthly where tenant_id = $1 and month >= $2::date and month <= $3::date`,
    [tenantId, fromMonth, monthOf(end)]);
  const rows = [...byKey.entries()];
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const values = [];
    const params = [tenantId];
    chunk.forEach(([key, v], j) => {
      const [projectId, month] = key.split('|');
      const b = 2 + j * 4;
      values.push(`($1, $${b}, $${b + 1}::date, $${b + 2}, $${b + 3})`);
      params.push(String(projectId), month, Math.round(v.hours * 100) / 100, v.entries);
    });
    await dbQuery(env, `insert into project_hours_monthly (tenant_id, project_id, month, hours, entries) values ${values.join(', ')}
      on conflict (tenant_id, project_id, month) do update set hours = excluded.hours, entries = excluded.entries, updated_at = now()`, params);
  }
  return entries.length;
}

async function refreshHoursToDate(env, tenantId) {
  await dbQuery(env, `update portfolio_projects pp set hours_to_date = coalesce(h.total, 0)
    from (select project_id, sum(hours) as total from project_hours_monthly where tenant_id = $1 group by project_id) h
    where pp.tenant_id = $1 and pp.project_id = h.project_id`, [tenantId]);
}

// One step per scheduled run, overnight only: the recent window once a night,
// otherwise one older month of the backfill. Returns a log line or null.
export async function runHoursSync(env, tenantId) {
  await ensureHoursSchema(env);
  const state = (await dbQuery(env, `select hours_synced_at, hours_backfilled_from from portfolio_sync_state where tenant_id = $1`, [tenantId]))[0] || {};
  const now = new Date();
  const recentFrom = monthOf(iso(new Date(now.getTime() - RECENT_DAYS * 86400000)));
  const synced = state.hours_synced_at ? new Date(state.hours_synced_at).getTime() : 0;
  if (now.getTime() - synced > 20 * 3600 * 1000) {
    const n = await syncMonths(env, tenantId, recentFrom, iso(now));
    await dbQuery(env, `update portfolio_sync_state set hours_synced_at = now(),
      hours_backfilled_from = coalesce(hours_backfilled_from, $2::date) where tenant_id = $1`, [tenantId, recentFrom]);
    await refreshHoursToDate(env, tenantId);
    return `hours: ${n} timesheet entries since ${recentFrom}`;
  }
  const doneFrom = state.hours_backfilled_from ? String(state.hours_backfilled_from instanceof Date ? iso(state.hours_backfilled_from) : state.hours_backfilled_from).slice(0, 10) : recentFrom;
  if (doneFrom <= HOURS_FROM) return null;
  const d = new Date(`${doneFrom}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const month = iso(d);
  const last = new Date(`${doneFrom}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  const n = await syncMonths(env, tenantId, month, iso(last));
  await dbQuery(env, `update portfolio_sync_state set hours_backfilled_from = $2::date where tenant_id = $1`, [tenantId, month]);
  await refreshHoursToDate(env, tenantId);
  return `hours backfill: ${month.slice(0, 7)} (${n} entries)`;
}

// The dashboard's month view: hours and invoicing per project for one month.
export async function monthFigures(env, tenantId, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error('month must be YYYY-MM');
  await ensureHoursSchema(env);
  const m = `${month}-01`;
  const [hours, invoiced] = await Promise.all([
    dbQuery(env, `select project_id, hours from project_hours_monthly where tenant_id = $1 and month = $2::date`, [tenantId, m]),
    dbQuery(env, `select project_id, invoiced from project_invoiced_monthly where tenant_id = $1 and month = $2::date`, [tenantId, m])
  ]);
  const out = {};
  for (const r of hours) (out[r.project_id] ||= {}).hours = Number(r.hours);
  for (const r of invoiced) (out[r.project_id] ||= {}).invoiced = Number(r.invoiced);
  const state = (await dbQuery(env, `select hours_backfilled_from from portfolio_sync_state where tenant_id = $1`, [tenantId]))[0];
  return { month, projects: out, hoursFrom: state?.hours_backfilled_from || null };
}
