// Company-level portfolio view (Ben's ask 2026-09-24) — one summary row per
// Procore project in `portfolio_projects`, so the company page never calls
// Procore itself (LEDGER's whole Procore allowance is 25 requests/minute,
// shared by every LEDGER user). Rows are refreshed by:
//   - opening a project in the LEDGER sidebar (refreshIfStale),
//   - Procore webhooks marking a project dirty (markDirty), picked up by
//   - the scheduled run (runScheduled), which also sweeps stale projects.
// Headline numbers come from the Budget tool's "Custom Reporting View" —
// the same view Ben reports from, custom calculated columns included — so
// the dashboard matches Procore exactly.

import { procoreRequest, procoreCallCount } from './procore.js';
import { dbQuery } from './db.js';
import { ledgerLevel } from './roles.js';
import { ensureBulkSchema, ensurePortfolioActualsColumns } from './schema.js';
import { hasQueuedBulkReconciliation, processNextBulkReconciliation } from './bulk.js';
import { listPendingTickets, listPendingDirectCosts, listCommitments } from './app.js';

// Company-level budget view; resolved by name if a project doesn't have it.
const REPORTING_VIEW_ID = '562949953553505';
const REPORTING_VIEW_NAME = 'Procore Standard Budget (Custom Reporting View)';

// Budget view columns are keyed by their display names in Procore.
const COLUMN_MAP = {
  revised_contract: 'Revised Contract Amount',
  invoiced: 'Invoicing to Date',
  pct_invoiced: '% Invoiced',
  invoicing_remaining: 'Invoicing Remaining',
  jtd_cost: 'Job to date costs',
  direct_costs: 'Direct Costs',
  sub_invoices: 'Subcontractor invoices',
  committed_costs: 'Committed costs',
  revised_budget: 'Revised Budget',
  original_budget: 'original_budget_amount',
  approved_budget_changes: 'Approved budget changes',
  margin_to_date: 'Margin to Date ($)',
  margin_to_date_pct: 'Margin to Date (%)',
  budgeted_margin: 'Budgeted Margin ($)',
  budgeted_margin_pct: 'Budgeted Margin (%)',
  retainage: 'Retainage'
};
// Percent columns are recomputed from the summed totals — never summed.
const PERCENT_COLUMNS = new Set(['pct_invoiced', 'margin_to_date_pct', 'budgeted_margin_pct']);

// The "Fiscal Year" project custom field (a dropdown; Ben, 2026-10-07). The
// project show call already returns it as { id, label } — no extra request.
const FISCAL_YEAR_FIELD = 'custom_field_562949954054370';

// Einbau's convention for a Prime Contract that bills costs straight through
// (LEDGER's standalone invoices use it too). Their revenue isn't part of the
// quote the original budget was built for.
const isPassThroughContract = (title) => /pass[\s-]*thr(u|ough)/i.test(String(title || ''));

// Budgeted margin basis (Ben, 2026-09-24/29). The live "Revised Contract −
// Revised Budget" inflates as soon as Change Orders or pass-through contracts
// add revenue to a budget nobody has updated — KPS showed 58% against a 39%
// quote. So until the budget itself has changed (no approved budget changes,
// revised budget still = original), hold it at the original quote: approved
// Prime Contracts' original values (grand_total, before COs; pass-through
// contracts excluded) against the original budget. Once the budget has been
// changed, use Procore's live figures. (The approved estimate itself would be
// better still, but Estimating's API rejects app logins — asked Procore.)
function budgetedMarginBasis(values, contracts) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const originalContract = Array.isArray(contracts)
    ? round2(contracts
        .filter(c => ['Approved', 'Complete'].includes(c.status) && !isPassThroughContract(c.title))
        .reduce((s, c) => s + (num(c.grand_total) || 0), 0))
    : null;
  const budgetChanged = Math.abs(values.approved_budget_changes || 0) >= 0.01
    || Math.abs((values.revised_budget ?? 0) - (values.original_budget ?? 0)) >= 0.01;
  if (!budgetChanged && originalContract > 0 && (values.original_budget ?? 0) > 0) {
    const margin = round2(originalContract - values.original_budget);
    return { basis: 'original', originalContract, margin, pct: Math.round((margin / originalContract) * 10000) / 100 };
  }
  return { basis: 'live', originalContract };
}

// Stages that are finished — refreshed rarely, not on every sweep.
const CLOSED_STAGES = ['Completed and Invoiced', 'Cancelled', 'Closed', 'Warranty Complete'];

// Keep this many requests of the 25/minute allowance free for PMs using the
// sidebar. Background work stops as soon as Procore reports fewer left.
const RESERVED_REQUESTS = 12;

class RateBudgetExhausted extends Error {}

// Procore refused a call (429). Besides the 25-request short window there's a
// larger one — seen live 2026-10-07: "x-rate-limit-limit: 600", remaining 0,
// which blocked every LEDGER call for ~15 minutes overnight. A refresh that
// hits either one must not write anything: a refused budget-view call used to
// save the row as "no budget view" with blank figures (hiding the project).
function rateLimited(res) {
  const limit = res?.headers?.['x-rate-limit-limit'];
  const reset = Number(res?.headers?.['x-rate-limit-reset']);
  const secs = Number.isFinite(reset) ? Math.max(0, Math.round(reset - Date.now() / 1000)) : null;
  return new RateBudgetExhausted(
    `Procore's rate limit was reached${limit ? ` (${limit}-request window)` : ''}${secs != null ? `; it resets in about ${secs}s` : ''}. Nothing was changed — try again then.`
  );
}

// Routine background refreshing happens overnight (Ben, 2026-10-07: the
// daytime sweep competed with PMs for Procore's 25/minute). Quiet hours are
// 9 pm – 6 am Eastern on weekdays, and all weekend. During the day only
// projects that changed recently (webhook-marked) are refreshed, one per run.
const QUIET_TZ = 'America/Toronto';

// Procore's second, larger limit (600 requests per window, probably an hour —
// seen 2026-10-07). Background work stops after this many calls in a clock
// hour, leaving the rest for people even at night. ~7 calls per refresh, so
// about 50 refreshes an hour.
const BACKGROUND_CALLS_PER_HOUR = 360;
const RECENT_CHANGE_HOURS = 2; // daytime: only changes newer than this

export function isQuietHours(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: QUIET_TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour);
  return parts.weekday === 'Sat' || parts.weekday === 'Sun' || hour >= 21 || hour < 6;
}

async function procoreGet(env, path) {
  const res = await procoreRequest(env, 'GET', path);
  const remaining = Number(res.headers?.['x-rate-limit-remaining']);
  return { ...res, remaining: Number.isFinite(remaining) ? remaining : null };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchReportingSummary(env, projectId) {
  let res = await procoreGet(env, `/rest/v1.0/budget_views/${REPORTING_VIEW_ID}/summary_rows?project_id=${projectId}`);
  if (res.status === 200 || res.status === 429) return res;
  const views = await procoreGet(env, `/rest/v1.0/budget_views?project_id=${projectId}`);
  if (views.status === 429) return views;
  const view = Array.isArray(views.data) ? views.data.find(v => v.name === REPORTING_VIEW_NAME) : null;
  if (!view) return { status: 404, data: null, remaining: views.remaining };
  return procoreGet(env, `/rest/v1.0/budget_views/${view.id}/summary_rows?project_id=${projectId}`);
}

// Every page of a v1.0 list (per_page 300). { ok, items, remaining }.
async function fetchAllV1(env, path) {
  const items = [];
  let remaining = null;
  for (let page = 1; page <= 10; page++) {
    const res = await procoreGet(env, `${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=300`);
    if (res.remaining != null) remaining = remaining == null ? res.remaining : Math.min(remaining, res.remaining);
    if (res.status !== 200 || !Array.isArray(res.data)) return { ok: false, items: null, remaining, refused: res.status === 429 ? res : null };
    items.push(...res.data);
    if (res.data.length < 300) break;
  }
  return { ok: true, items, remaining };
}

// What the project has really been sold, invoiced and spent (Ben, 2026-10-07).
// The budget view only counts money on cost codes that have been ADDED to the
// budget, so a project with an incomplete budget showed $0 contract and
// invoicing (Walmart 1095 Vaughan: really $640 / $640) and KPS was $4,959
// under-invoiced. These come straight from the records instead:
//   contract  = approved/complete Prime Contracts' revised amounts
//   invoiced  = every non-draft owner invoice, gross of retainage — the same
//               figure as the budget view's "Invoicing to Date" (one call:
//               /payment_applications?project_id= lists all contracts' invoices)
//   cost      = non-draft direct costs + each commitment's latest sub invoice
//               to date (verified = budget view job-to-date cost on KPS, 2026-09-26)
// A null part means that call failed; the caller keeps the budget view's figure.
async function fetchProjectActuals(env, projectId) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const pcs = await fetchAllV1(env, `/rest/v1.0/prime_contracts?project_id=${projectId}`);
  const invoices = await fetchAllV1(env, `/rest/v1.0/payment_applications?project_id=${projectId}`);
  const dcs = await fetchAllV1(env, `/rest/v1.0/projects/${projectId}/direct_costs`);
  const reqs = await fetchAllV1(env, `/rest/v1.0/requisitions?project_id=${projectId}`);
  const live = (x) => String(x.status || '').toLowerCase() !== 'draft';

  const contracts = pcs.ok ? pcs.items : null;
  const contractValue = contracts
    ? round2(contracts.filter(c => ['Approved', 'Complete'].includes(c.status)).reduce((s, c) => s + (num(c.revised_contract_amount) || 0), 0))
    : null;
  const invoiced = invoices.ok
    ? round2(invoices.items.filter(live).reduce((s, p) => s + (num(p.total_amount_accrued_this_period) || 0), 0))
    : null;
  const directCosts = dcs.ok
    ? round2(dcs.items.filter(live).reduce((s, d) => s + (num(d.grand_total ?? d.amount) || 0), 0))
    : null;
  let subInvoices = null;
  if (reqs.ok) {
    const toDate = new Map(); // latest cumulative total per commitment
    for (const r of reqs.items.filter(live)) {
      const v = num(r.summary?.total_completed_and_stored_to_date) || 0;
      toDate.set(r.commitment_id, Math.max(toDate.get(r.commitment_id) ?? 0, v));
    }
    subInvoices = round2([...toDate.values()].reduce((s, v) => s + v, 0));
  }
  const remaining = [pcs, invoices, dcs, reqs].map(x => x.remaining).filter(r => r != null);
  const refused = [pcs, invoices, dcs, reqs].find(x => x.refused)?.refused || null;
  return { contracts, contractValue, invoiced, directCosts, subInvoices, refused, remaining: remaining.length ? Math.min(...remaining) : null };
}

// Refreshes one project's row. Returns Procore's reported remaining requests
// (lowest seen) so background callers can stop before starving the sidebar.
export async function refreshProjectSnapshot(env, tenantId, projectId) {
  await ensurePortfolioActualsColumns(env);
  const startedAt = new Date().toISOString();
  const show = await procoreGet(env, `/rest/v1.0/projects/${projectId}?company_id=${env.PROCORE_COMPANY_ID}`);
  if (show.status === 429) throw rateLimited(show);
  if (show.status !== 200) {
    await dbQuery(
      env,
      `insert into portfolio_projects (tenant_id, project_id, refresh_error, refreshed_at)
       values ($1, $2, $3, now())
       on conflict (tenant_id, project_id) do update set refresh_error = excluded.refresh_error, refreshed_at = now()`,
      [tenantId, String(projectId), `Project fetch failed: ${show.status}`]
    );
    return show.remaining;
  }
  const p = show.data;
  const summary = await fetchReportingSummary(env, projectId);
  if (summary.status === 429) throw rateLimited(summary);
  // summary_rows returns one row for the project itself plus one per sub job
  // (KPS Lloydminster has 16) — the project's real totals are their sum, which
  // matches the budget view's Grand Totals row exactly (verified 2026-09-25).
  const rows = summary.status === 200 && Array.isArray(summary.data) && summary.data.length > 0 ? summary.data : null;

  const values = {};
  for (const [col, label] of Object.entries(COLUMN_MAP)) {
    if (PERCENT_COLUMNS.has(col)) continue;
    values[col] = rows ? Math.round(rows.reduce((sum, r) => sum + (num(r[label]) || 0), 0) * 100) / 100 : null;
  }
  const pctOf = (part, whole) => (rows && whole ? Math.round((part / whole) * 10000) / 100 : null);
  values.pct_invoiced = pctOf(values.invoiced, values.revised_contract);
  values.margin_to_date_pct = pctOf(values.margin_to_date, values.invoiced);
  values.budgeted_margin_pct = pctOf(values.budgeted_margin, values.revised_contract);
  const budgetStatus = !rows ? 'no_view' : (values.revised_budget ?? 0) === 0 ? 'no_budget' : 'ok';

  // Keep the budget view's own totals (to flag money outside the budget)…
  values.budget_view_cost = rows ? values.jtd_cost : null;
  values.budget_view_invoiced = rows ? values.invoiced : null;

  // …then use the real records for contract, invoicing and cost.
  const actuals = await fetchProjectActuals(env, projectId);
  if (actuals.refused) throw rateLimited(actuals.refused);
  const round2 = (n) => Math.round(n * 100) / 100;
  const share = (part, whole) => (part != null && whole ? Math.round((part / whole) * 10000) / 100 : null);
  if (actuals.contractValue != null) values.revised_contract = actuals.contractValue;
  if (actuals.invoiced != null) values.invoiced = actuals.invoiced;
  if (actuals.directCosts != null && actuals.subInvoices != null) {
    values.direct_costs = actuals.directCosts;
    values.sub_invoices = actuals.subInvoices;
    values.jtd_cost = round2(actuals.directCosts + actuals.subInvoices);
  }
  if (values.revised_contract != null && values.invoiced != null) {
    values.invoicing_remaining = round2(values.revised_contract - values.invoiced);
    values.pct_invoiced = share(values.invoiced, values.revised_contract);
  }
  if (values.invoiced != null && values.jtd_cost != null) {
    values.margin_to_date = round2(values.invoiced - values.jtd_cost);
    values.margin_to_date_pct = share(values.margin_to_date, values.invoiced);
  }

  // Budgeted margin: the original quote until the budget changes, then the
  // live budget — both against the real contract (see budgetedMarginBasis).
  const basis = budgetedMarginBasis(values, actuals.contracts);
  values.original_contract = basis.originalContract;
  values.budget_basis = rows ? basis.basis : null;
  if (rows && basis.basis === 'original') {
    values.budgeted_margin = basis.margin;
    values.budgeted_margin_pct = basis.pct;
  } else if (rows && (values.revised_budget ?? 0) > 0 && values.revised_contract != null) {
    values.budgeted_margin = round2(values.revised_contract - values.revised_budget);
    values.budgeted_margin_pct = share(values.budgeted_margin, values.revised_contract);
  }

  values.fiscal_year = p.custom_fields?.[FISCAL_YEAR_FIELD]?.value?.label ?? null;

  const cols = [...Object.keys(COLUMN_MAP), 'original_contract', 'budget_basis', 'budget_view_cost', 'budget_view_invoiced', 'fiscal_year'];
  const params = [
    tenantId, String(projectId),
    p.name || null, p.project_number || null, p.project_stage?.name || p.stage || null,
    p.project_region?.name || null, (p.departments || []).map(d => d.name).join(', ') || null,
    p.office?.name || null, p.city || null, p.state_code || null, p.active !== false, p.created_at || null,
    ...cols.map(c => values[c]),
    budgetStatus, rows ? null : `Budget view unavailable (${summary.status})`, startedAt
  ];
  const baseCols = ['name', 'project_number', 'stage', 'region', 'departments', 'office', 'city', 'state_code', 'active', 'procore_created_at'];
  const allCols = [...baseCols, ...cols, 'budget_status', 'refresh_error'];
  const placeholders = allCols.map((_, i) => `$${i + 3}`);
  await dbQuery(
    env,
    `insert into portfolio_projects (tenant_id, project_id, ${allCols.join(', ')}, refreshed_at)
     values ($1, $2, ${placeholders.join(', ')}, now())
     on conflict (tenant_id, project_id) do update set
       ${allCols.map(c => `${c} = excluded.${c}`).join(', ')},
       refreshed_at = now(),
       dirty_at = case when portfolio_projects.dirty_at <= $${allCols.length + 3}::timestamptz then null else portfolio_projects.dirty_at end`,
    params
  );
  return Math.min(...[show.remaining, summary.remaining, actuals.remaining].filter(r => r != null), 999);
}

// Record counts (Ben's ask 2026-09-25): how many T&M tickets, direct costs and
// commitments are unbilled / billed / budgeted / written off. A record partly
// dispositioned counts in each bucket it has lines in — same as the sidebar's
// Review Project tab counts.
function countRecords(tickets, directCosts, commitments) {
  const bucket = (data, countKey, full) =>
    (data?.[full] || []).length + (data?.unbilled || []).filter(x => x.partialBilled && x[countKey] > 0).length;
  const t = tickets || [];
  return {
    unbilled: t.filter(x => x.unbilledCount > 0).length + (directCosts?.unbilled || []).length + (commitments?.unbilled || []).length,
    billed: t.filter(x => x.billedCount > 0).length + bucket(directCosts, 'billedLineCount', 'billed') + bucket(commitments, 'billedLineCount', 'billed'),
    budgeted: t.filter(x => x.budgetedCount > 0).length + bucket(directCosts, 'budgetedLineCount', 'budgeted') + bucket(commitments, 'budgetedLineCount', 'budgeted'),
    writtenOff: t.filter(x => x.writtenOffCount > 0).length + bucket(directCosts, 'writtenOffLineCount', 'writtenOff') + bucket(commitments, 'writtenOffLineCount', 'writtenOff')
  };
}

export async function saveProjectCounts(env, tenantId, projectId, counts) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  await dbQuery(
    env,
    `insert into portfolio_projects (tenant_id, project_id, unbilled_count, billed_count, budgeted_count, written_off_count, counts_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (tenant_id, project_id) do update set
       unbilled_count = excluded.unbilled_count, billed_count = excluded.billed_count,
       budgeted_count = excluded.budgeted_count, written_off_count = excluded.written_off_count, counts_at = now()`,
    [tenantId, String(projectId), n(counts.unbilled), n(counts.billed), n(counts.budgeted), n(counts.writtenOff)]
  );
}

// Recount from the same lists the sidebar uses. ~8-10 Procore requests — run
// on a dashboard project open, and one project at a time by the scheduled
// count sweep (runScheduled step 4) when enough requests are spare.
export async function refreshProjectCounts(env, tenantId, projectId) {
  const [tm, dc, cm] = await Promise.all([
    listPendingTickets(env, { tenantId, projectId, selfHeal: false }),
    listPendingDirectCosts(env, { tenantId, projectId }).catch(() => null),
    listCommitments(env, { tenantId, projectId }).catch(() => null)
  ]);
  await saveProjectCounts(env, tenantId, projectId, countRecords(tm.tickets, dc, cm));
}

// Dashboard drill-down (Ben's ask 2026-09-26): the source records behind a
// project's numbers — direct costs, subcontractor invoices (Requisitions) and
// owner invoices — each with LEDGER's own billing status. Only loaded when a
// PM asks (≈3 + one per Prime Contract requests). Verified on KPS Lloydminster:
// all direct costs + all sub invoices = the budget view's Job-to-date cost to
// the cent, so any difference is cost sitting outside the budget.
export async function projectSourceRecords(env, tenantId, projectId) {
  const [dcRes, reqRes, pcRes, ledgerRows, snapshot] = await Promise.all([
    procoreGet(env, `/rest/v1.0/projects/${projectId}/direct_costs?per_page=300`),
    procoreGet(env, `/rest/v1.0/requisitions?project_id=${projectId}&per_page=300`),
    procoreGet(env, `/rest/v1.0/prime_contracts?project_id=${projectId}`),
    dbQuery(
      env,
      `select record_type, procore_record_id, status from billing_records
       where tenant_id = $1 and project_id = $2 and record_type in ('direct_cost', 'direct_cost_line', 'commitment_line')`,
      [tenantId, String(projectId)]
    ),
    dbQuery(env, `select direct_costs, sub_invoices, invoiced, budget_view_cost from portfolio_projects where tenant_id = $1 and project_id = $2`, [tenantId, String(projectId)])
  ]);
  for (const [label, res] of [['direct costs', dcRes], ['sub invoices', reqRes], ['prime contracts', pcRes]]) {
    if (res.status !== 200) throw new Error(`Couldn't load ${label} from Procore (${res.status})`);
  }

  // LEDGER status per direct cost / commitment, from its billing records.
  const statusesBy = { dc: new Map(), cm: new Map() };
  for (const r of ledgerRows) {
    const parent = r.record_type === 'direct_cost' ? r.procore_record_id : r.procore_record_id.split(':')[0];
    const map = r.record_type === 'commitment_line' ? statusesBy.cm : statusesBy.dc;
    if (!map.has(parent)) map.set(parent, { statuses: new Set() });
    map.get(parent).statuses.add(r.status);
  }
  const LABEL = { billed: 'Billed', draft_co: 'In draft CO', written_off: 'Written off', reconciled_to_period: 'Budgeted' };
  const ledgerStatus = (map, id) => {
    const s = map.get(String(id));
    if (!s) return 'Not in LEDGER yet';
    return [...s.statuses].map(x => LABEL[x] || x).join(' + ');
  };

  const round2 = (x) => Math.round(x * 100) / 100;
  const directCosts = (dcRes.data || []).map(d => ({
    id: d.id,
    date: d.direct_cost_date || null,
    vendor: d.vendor_name || d.vendor || null,
    description: d.description || '',
    type: d.direct_cost_type || null,
    status: d.status || null,
    amount: num(d.grand_total ?? d.amount) || 0,
    ledgerStatus: ledgerStatus(statusesBy.dc, d.id)
  }));

  // A sub invoice's own amount = its completed-to-date minus the previous
  // invoice's on the same commitment (Procore only stores cumulative totals).
  const reqs = [...(reqRes.data || [])].sort((a, b) => (a.commitment_id - b.commitment_id) || ((a.number || 0) - (b.number || 0)));
  const lastToDate = new Map();
  const subInvoices = reqs.map(r => {
    const toDate = num(r.summary?.total_completed_and_stored_to_date) || 0;
    const previous = lastToDate.get(r.commitment_id) || 0;
    lastToDate.set(r.commitment_id, toDate);
    return {
      id: r.id,
      commitmentId: r.commitment_id,
      commitmentType: r.commitment_type || null,
      vendor: r.vendor_name || null,
      invoiceNumber: r.invoice_number || null,
      number: r.number ?? null,
      billingDate: r.billing_date || null,
      status: r.status || null,
      amount: round2(toDate - previous),
      ledgerStatus: ledgerStatus(statusesBy.cm, r.commitment_id)
    };
  });

  const contracts = Array.isArray(pcRes.data) ? pcRes.data : [];
  const ownerInvoices = [];
  for (const c of contracts) {
    const paRes = await procoreGet(env, `/rest/v1.0/prime_contracts/${c.id}/payment_applications?project_id=${projectId}&per_page=300`);
    if (paRes.status !== 200) continue;
    for (const pa of paRes.data || []) {
      ownerInvoices.push({
        id: pa.id,
        contractId: c.id,
        contractTitle: c.title || `#${c.number}`,
        invoiceNumber: pa.invoice_number || null,
        billingDate: pa.billing_date || null,
        periodStart: pa.period_start || null,
        periodEnd: pa.period_end || null,
        status: pa.status || null,
        amount: num(pa.total_amount_accrued_this_period) || 0
      });
    }
  }

  const total = (list) => round2(list.reduce((s, x) => s + x.amount, 0));
  const dcTotal = total(directCosts);
  const subTotal = total(subInvoices);
  const snap = snapshot[0] || {};
  // Since 2026-10-07 the row's own cost comes from these same records, so the
  // comparison is against the budget view's cost (budget_view_cost).
  const budgetCost = snap.budget_view_cost != null
    ? num(snap.budget_view_cost) || 0
    : (num(snap.direct_costs) || 0) + (num(snap.sub_invoices) || 0);
  return {
    directCosts: directCosts.sort((a, b) => String(b.date).localeCompare(String(a.date))),
    subInvoices: subInvoices.sort((a, b) => String(b.billingDate).localeCompare(String(a.billingDate))),
    ownerInvoices: ownerInvoices.sort((a, b) => String(b.billingDate).localeCompare(String(a.billingDate))),
    totals: { directCosts: dcTotal, subInvoices: subTotal, ownerInvoices: total(ownerInvoices) },
    // Cost recorded in Procore that the budget view doesn't count (a cost
    // code not added to the budget). Null until the project's been refreshed.
    costOutsideBudget: snapshot[0] ? round2(dcTotal + subTotal - budgetCost) : null
  };
}

// Sidebar use keeps busy projects current: refresh at most every 10 minutes.
export async function refreshIfStale(env, tenantId, projectId) {
  const rows = await dbQuery(
    env,
    `select refreshed_at from portfolio_projects where tenant_id = $1 and project_id = $2`,
    [tenantId, String(projectId)]
  );
  const last = rows[0]?.refreshed_at ? new Date(rows[0].refreshed_at).getTime() : 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  await refreshProjectSnapshot(env, tenantId, projectId);
}

// Every project in the company, with stage/region/active — one paged call,
// plus region names. Departments/office/budget come from the per-project
// refresh (the list endpoint doesn't carry them).
export async function syncProjectList(env, tenantId) {
  const co = env.PROCORE_COMPANY_ID;
  const syncStartedAt = new Date().toISOString();
  const regions = await procoreGet(env, `/rest/v1.0/companies/${co}/project_regions`);
  const regionName = new Map((Array.isArray(regions.data) ? regions.data : []).map(r => [String(r.id), r.name]));
  let remaining = regions.remaining;
  for (let page = 1; page <= 20; page++) {
    const res = await procoreGet(env, `/rest/v1.0/projects?company_id=${co}&page=${page}&per_page=300`);
    remaining = res.remaining ?? remaining;
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`Project list failed: ${res.status}`);
    // One multi-row upsert per page — a query per project would blow through
    // Cloudflare's per-invocation subrequest cap on a 500+ project company.
    if (res.data.length > 0) {
      const perRow = 10;
      const values = [];
      const params = [];
      res.data.forEach((p, i) => {
        const b = i * perRow;
        values.push(`(${Array.from({ length: perRow }, (_, j) => `$${b + j + 1}`).join(', ')}, now())`);
        params.push(
          tenantId, String(p.id), p.name || null, p.project_number || null, p.project_stage?.name || p.stage || null,
          regionName.get(String(p.project_region_id)) || null, p.city || null, p.state_code || null,
          p.active !== false, p.created_at || null
        );
      });
      await dbQuery(
        env,
        `insert into portfolio_projects (tenant_id, project_id, name, project_number, stage, region, city, state_code, active, procore_created_at, listed_at)
         values ${values.join(', ')}
         on conflict (tenant_id, project_id) do update set
           name = excluded.name, project_number = excluded.project_number, stage = excluded.stage,
           region = coalesce(excluded.region, portfolio_projects.region), city = excluded.city,
           state_code = excluded.state_code, active = excluded.active,
           procore_created_at = excluded.procore_created_at, listed_at = now()`,
        params
      );
    }
    if (res.data.length < 300) break;
  }
  // Procore's project list only returns ACTIVE projects, so one set inactive
  // simply stops appearing — without this it would linger on the dashboard
  // with its old record counts (Ben, 2026-09-30). Reaching here means every
  // page was read, so "not seen this sync" really means "not in the list".
  await dbQuery(
    env,
    `update portfolio_projects set active = false
     where tenant_id = $1 and listed_at < $2::timestamptz and active is not false`,
    [tenantId, syncStartedAt]
  );
  await dbQuery(
    env,
    `insert into portfolio_sync_state (tenant_id, projects_listed_at) values ($1, now())
     on conflict (tenant_id) do update set projects_listed_at = now()`,
    [tenantId]
  );
  return remaining;
}

// Procore webhook receiver. Procore sends the shared secret as the
// Authorization header configured on the hook; anything else is refused.
// Only marks the project dirty — the scheduled run refreshes it once changes
// go quiet, so a 200-row import costs one refresh, not 200.
export async function handleProcoreWebhook(request, env) {
  const secret = env.PROCORE_WEBHOOK_SECRET;
  if (!secret) return new Response('webhook secret not configured', { status: 503 });
  const auth = request.headers.get('Authorization') || '';
  if (auth !== secret && auth !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response('bad payload', { status: 400 });
  }
  // A "Projects" event (stage, fiscal year…) names the project as its resource.
  const projectId = payload?.project_id ?? payload?.metadata?.project_id
    ?? (payload?.resource_name === 'Projects' ? payload?.resource_id : null);
  if (projectId) {
    await dbQuery(
      env,
      `insert into portfolio_projects (tenant_id, project_id, dirty_at) values ($1, $2, now())
       on conflict (tenant_id, project_id) do update set dirty_at = now()`,
      [String(env.PROCORE_COMPANY_ID), String(projectId)]
    );
  }
  return new Response('ok', { status: 200 });
}

// Counting a project's records costs ~8-10 requests, so the sweep only starts
// one when Procore reports at least this many left (the PM reserve plus one
// count's worth).
const COUNT_SWEEP_MIN_REMAINING = RESERVED_REQUESTS + 12;

// Background work steps aside while a person is using LEDGER (Ben, 2026-09-30:
// a commitment write-off crawled while the portfolio re-refresh was running —
// each background run drains Procore's 25/minute down to the reserve, and the
// sidebar then waits on the rest). Every sidebar action and dashboard
// drill-in marks the time; the scheduled run skips itself for a few minutes
// after. Marked at most every 30s per worker instance to keep DB writes down.
const PAUSE_AFTER_USER_ACTIVITY_MS = 3 * 60 * 1000;
let activityColumnReady = false;
let lastActivityMark = 0;

async function ensureActivityColumn(env) {
  if (activityColumnReady) return;
  await dbQuery(env, `alter table portfolio_sync_state add column if not exists user_active_at timestamptz`, []);
  activityColumnReady = true;
}

export async function markUserActive(env) {
  if (Date.now() - lastActivityMark < 25 * 1000) return;
  lastActivityMark = Date.now();
  await ensureActivityColumn(env);
  await dbQuery(
    env,
    `insert into portfolio_sync_state (tenant_id, user_active_at) values ($1, now())
     on conflict (tenant_id) do update set user_active_at = now()`,
    [String(env.PROCORE_COMPANY_ID)]
  );
}

// Holds the pause for as long as a person's request is still running, not just
// when it starts: a refresh or invoice that outlasted the 3-minute pause let
// the background sweep back in to compete for Procore's 25/min (Ben,
// 2026-10-07). Re-marks every 30s, capped at 15 minutes; returns stop().
export function keepUserActive(env) {
  const tick = () => markUserActive(env).catch(() => {});
  tick();
  const timer = setInterval(tick, 30 * 1000);
  const cap = setTimeout(() => clearInterval(timer), 15 * 60 * 1000);
  return () => { clearInterval(timer); clearTimeout(cap); };
}

// One scheduled pass, paced to leave RESERVED_REQUESTS free for PMs:
//   1. re-list all projects if that's more than 12 hours old,
//   2. refresh projects a webhook marked dirty (quiet for 90s+),
//   3. sweep stale ones: open projects nightly, closed ones monthly,
//   4. recount one project's LEDGER records (Ben's ask 2026-09-29) — same
//      cadence, skipping stages the company page hides.
// Steps 3 and 4 (and older dirty marks) wait for quiet hours; see isQuietHours.
export async function runScheduled(env) {
  const tenantId = String(env.PROCORE_COMPANY_ID);
  await ensureBudgetColumns(env);
  const budget = await dbQuery(
    env,
    `select coalesce(case when bg_hour = date_trunc('hour', now()) then bg_calls end, 0)::int as used
     from portfolio_sync_state where tenant_id = $1`,
    [tenantId]
  );
  if ((budget[0]?.used ?? 0) >= BACKGROUND_CALLS_PER_HOUR) return ['hourly Procore budget used — waiting for the next hour'];
  const callsBefore = procoreCallCount();
  try {
    return await runScheduledPass(env, tenantId);
  } finally {
    const used = procoreCallCount() - callsBefore;
    if (used > 0) {
      await dbQuery(
        env,
        `update portfolio_sync_state
           set bg_calls = case when bg_hour = date_trunc('hour', now()) then coalesce(bg_calls, 0) + $2 else $2 end,
               bg_hour = date_trunc('hour', now())
         where tenant_id = $1`,
        [tenantId, used]
      ).catch(() => {});
    }
  }
}

let budgetColumnsReady = false;
async function ensureBudgetColumns(env) {
  if (budgetColumnsReady) return;
  await dbQuery(env, `alter table portfolio_sync_state
    add column if not exists bg_hour timestamptz,
    add column if not exists bg_calls integer`, []);
  budgetColumnsReady = true;
}

async function runScheduledPass(env, tenantId) {
  const log = [];
  let lastRemaining = null;
  const night = isQuietHours();
  const maxRefreshes = night ? 4 : 1;
  try {
    await ensureActivityColumn(env);
    const state = await dbQuery(env, `select projects_listed_at, user_active_at from portfolio_sync_state where tenant_id = $1`, [tenantId]);
    const activeAt = state[0]?.user_active_at ? new Date(state[0].user_active_at).getTime() : 0;
    if (Date.now() - activeAt < PAUSE_AFTER_USER_ACTIVITY_MS) {
      log.push('paused — someone is using LEDGER');
      return log;
    }
    const listedAt = state[0]?.projects_listed_at ? new Date(state[0].projects_listed_at).getTime() : 0;
    if (Date.now() - listedAt > 12 * 60 * 60 * 1000) {
      const remaining = await syncProjectList(env, tenantId);
      log.push('project list synced');
      if (remaining != null && remaining < RESERVED_REQUESTS) throw new RateBudgetExhausted();
    }

    // 2. Bulk reconciliations an admin queued on the dashboard — one project
    //    per run, only with enough requests spare (see bulk.js).
    if (await hasQueuedBulkReconciliation(env, tenantId)) {
      if (lastRemaining == null) {
        lastRemaining = (await procoreGet(env, `/rest/v1.0/companies/${env.PROCORE_COMPANY_ID}/project_regions`)).remaining;
      }
      if (lastRemaining == null || lastRemaining < COUNT_SWEEP_MIN_REMAINING) throw new RateBudgetExhausted();
      const result = await processNextBulkReconciliation(env, tenantId);
      if (result) {
        log.push(result);
        throw new RateBudgetExhausted(); // that used this run's requests
      }
    }

    const due = await dbQuery(
      env,
      `select project_id from portfolio_projects
       where tenant_id = $1 and (
         (dirty_at is not null and dirty_at < now() - interval '90 seconds'
           and ($4 or dirty_at > now() - make_interval(hours => $5)))
         or ($4 and dirty_at is null and active is not false and (
           refreshed_at is null
           or (coalesce(stage, '') <> all($2::text[]) and refreshed_at < now() - interval '20 hours')
           or (stage = any($2::text[]) and refreshed_at < now() - interval '30 days')
         ))
       )
       order by dirty_at desc nulls last, refreshed_at asc nulls first
       limit $3`,
      [tenantId, CLOSED_STAGES, maxRefreshes, night, RECENT_CHANGE_HOURS]
    );
    for (const { project_id } of due) {
      const remaining = await refreshProjectSnapshot(env, tenantId, project_id);
      lastRemaining = remaining;
      log.push(`refreshed ${project_id}`);
      if (remaining != null && remaining < RESERVED_REQUESTS) throw new RateBudgetExhausted();
    }

    if (!night) return log; // record recounts are overnight work
    const countDue = await dbQuery(
      env,
      `select project_id from portfolio_projects
       where tenant_id = $1 and name is not null and active is not false
         and coalesce(stage, 'None') <> all($2::text[]) and (
         counts_at is null
         or (coalesce(stage, '') <> all($3::text[]) and counts_at < now() - interval '24 hours')
         or (stage = any($3::text[]) and counts_at < now() - interval '30 days')
       )
       order by counts_at asc nulls first
       limit 1`,
      [tenantId, HIDDEN_STAGES, CLOSED_STAGES]
    );
    if (countDue.length > 0) {
      // Nothing refreshed this run means no fresh reading — one cheap request finds out.
      if (lastRemaining == null) {
        lastRemaining = (await procoreGet(env, `/rest/v1.0/companies/${env.PROCORE_COMPANY_ID}/project_regions`)).remaining;
      }
      if (lastRemaining == null || lastRemaining < COUNT_SWEEP_MIN_REMAINING) throw new RateBudgetExhausted();
      const projectId = countDue[0].project_id;
      try {
        await refreshProjectCounts(env, tenantId, projectId);
        log.push(`counted ${projectId}`);
      } catch (e) {
        if (e instanceof RateBudgetExhausted || /\b429\b|rate limit/i.test(e.message)) throw new RateBudgetExhausted(e.message);
        // Don't retry a failing project every minute — try again tomorrow.
        await saveProjectCounts(env, tenantId, projectId, {});
        log.push(`count failed ${projectId}: ${e.message}`);
      }
    }
  } catch (e) {
    if (!(e instanceof RateBudgetExhausted)) throw e;
    log.push(e.message ? `stopped: ${e.message}` : 'stopped early to leave requests for PMs');
  }
  return log;
}

// Einbau ID (auth-worker, the suite's shared login). Only accounts granted
// LEDGER in HELM get in — app ids are uppercase ("PUNCH", "SCOUT", …; see
// HELM's apps.js). Fails closed if the verify response has no apps list.
// Since the Einbau ID role matrix (2026-09-30), access to LEDGER is decided by
// user.appRoles.LEDGER alone — see roles.js.
export function hasLedgerApp(user) {
  return ledgerLevel(user) != null;
}

// For the portfolio page and every Procore-sidebar call:
//   null                                — no valid Einbau ID session
//   { denied: true }                    — valid session, but no LEDGER access
//   { user, refreshedToken, level }     — LEDGER level per roles.js
export async function verifyEinbauSession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    // Service binding, not fetch(): worker → *.workers.dev is blocked (error 1042).
    const res = await env.AUTH_WORKER.fetch('https://auth.ben-a90.workers.dev/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: '{}'
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.valid) return null;
    const level = ledgerLevel(data.user);
    if (!level) return { denied: true };
    return { user: data.user, refreshedToken: data.refreshedToken || null, level };
  } catch {
    return null;
  }
}

export async function verifyEinbauUser(request, env) {
  const session = await verifyEinbauSession(request, env);
  return session && !session.denied ? session.user : null;
}

// Stages the company page never shows (Ben, 2026-09-29): Overhead isn't a job
// (its costs would swamp the totals), and Cancelled / Warranty / no stage
// aren't live work. Everything else stays — a PM marking a job "Completed and
// Invoiced" or "On Hold" still needs accounting to check it, and Bidding /
// Pre-Construction are a heads-up of what's coming.
const HIDDEN_STAGES = ['Overhead', 'Cancelled', 'Warranty', 'None'];

// Project search for LEDGER opened outside Procore (phone / home-screen app,
// 2026-09-29) — reads the project list the portfolio already keeps, so it
// costs no Procore requests. Matches name or number, or an exact project id
// (used to put a name to a project opened by link). Live projects first.
export async function searchProjects(env, tenantId, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  // Escape ILIKE wildcards so "50%" searches for a literal percent sign.
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return dbQuery(
    env,
    `select project_id, name, project_number, stage, region, departments from portfolio_projects
     where tenant_id = $1 and name is not null and coalesce(stage, 'None') <> all($2::text[])
       and (name ilike $3 or project_number ilike $3 or project_id = $4)
     order by (stage = any($5::text[])) asc, name
     limit 20`,
    [tenantId, HIDDEN_STAGES, like, q, CLOSED_STAGES]
  );
}

export async function listPortfolio(env, tenantId) {
  await ensureBulkSchema(env);
  return dbQuery(
    env,
    `select p.*, b.status as bulk_status, b.disposition as bulk_disposition, b.requested_by_name as bulk_by,
            coalesce(b.completed_at, b.requested_at) as bulk_at, b.record_count as bulk_record_count,
            b.amount as bulk_amount, b.error as bulk_error, b.notes as bulk_notes
     from portfolio_projects p
     left join lateral (
       select * from bulk_reconciliations r
       where r.tenant_id = p.tenant_id and r.project_id = p.project_id
         and r.status in ('queued', 'running', 'done', 'failed')
       order by r.requested_at desc
       limit 1
     ) b on true
     where p.tenant_id = $1 and p.name is not null and p.active is not false
       and coalesce(p.stage, 'None') <> all($2::text[])
     order by p.name`,
    [tenantId, HIDDEN_STAGES]
  );
}
