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

import { procoreRequest } from './procore.js';
import { dbQuery } from './db.js';

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
  margin_to_date: 'Margin to Date ($)',
  margin_to_date_pct: 'Margin to Date (%)',
  budgeted_margin: 'Budgeted Margin ($)',
  budgeted_margin_pct: 'Budgeted Margin (%)',
  retainage: 'Retainage'
};

// Stages that are finished — refreshed rarely, not on every sweep.
const CLOSED_STAGES = ['Completed and Invoiced', 'Cancelled', 'Closed', 'Warranty Complete'];

// Keep this many requests of the 25/minute allowance free for PMs using the
// sidebar. Background work stops as soon as Procore reports fewer left.
const RESERVED_REQUESTS = 12;

class RateBudgetExhausted extends Error {}

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
  if (res.status === 200) return res;
  const views = await procoreGet(env, `/rest/v1.0/budget_views?project_id=${projectId}`);
  const view = Array.isArray(views.data) ? views.data.find(v => v.name === REPORTING_VIEW_NAME) : null;
  if (!view) return { status: 404, data: null, remaining: views.remaining };
  return procoreGet(env, `/rest/v1.0/budget_views/${view.id}/summary_rows?project_id=${projectId}`);
}

// Refreshes one project's row. Returns Procore's reported remaining requests
// (lowest seen) so background callers can stop before starving the sidebar.
export async function refreshProjectSnapshot(env, tenantId, projectId) {
  const startedAt = new Date().toISOString();
  const show = await procoreGet(env, `/rest/v1.0/projects/${projectId}?company_id=${env.PROCORE_COMPANY_ID}`);
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
  const row = summary.status === 200 && Array.isArray(summary.data) ? summary.data[0] || {} : null;

  const values = {};
  for (const [col, label] of Object.entries(COLUMN_MAP)) values[col] = row ? num(row[label]) : null;
  const budgetStatus = !row ? 'no_view' : (values.revised_budget ?? 0) === 0 ? 'no_budget' : 'ok';

  const cols = Object.keys(COLUMN_MAP);
  const params = [
    tenantId, String(projectId),
    p.name || null, p.project_number || null, p.project_stage?.name || p.stage || null,
    p.project_region?.name || null, (p.departments || []).map(d => d.name).join(', ') || null,
    p.office?.name || null, p.city || null, p.state_code || null, p.active !== false, p.created_at || null,
    ...cols.map(c => values[c]),
    budgetStatus, row ? null : `Budget view unavailable (${summary.status})`, startedAt
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
  return Math.min(...[show.remaining, summary.remaining].filter(r => r != null), 999);
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
  const projectId = payload?.project_id ?? payload?.metadata?.project_id;
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

// One scheduled pass, paced to leave RESERVED_REQUESTS free for PMs:
//   1. re-list all projects if that's more than 12 hours old,
//   2. refresh projects a webhook marked dirty (quiet for 90s+),
//   3. sweep stale ones: open projects daily, closed ones monthly.
export async function runScheduled(env, { maxRefreshes = 4 } = {}) {
  const tenantId = String(env.PROCORE_COMPANY_ID);
  const log = [];
  try {
    const state = await dbQuery(env, `select projects_listed_at from portfolio_sync_state where tenant_id = $1`, [tenantId]);
    const listedAt = state[0]?.projects_listed_at ? new Date(state[0].projects_listed_at).getTime() : 0;
    if (Date.now() - listedAt > 12 * 60 * 60 * 1000) {
      const remaining = await syncProjectList(env, tenantId);
      log.push('project list synced');
      if (remaining != null && remaining < RESERVED_REQUESTS) throw new RateBudgetExhausted();
    }

    const due = await dbQuery(
      env,
      `select project_id from portfolio_projects
       where tenant_id = $1 and (
         (dirty_at is not null and dirty_at < now() - interval '90 seconds')
         or (dirty_at is null and active is not false and (
           refreshed_at is null
           or (coalesce(stage, '') <> all($2::text[]) and refreshed_at < now() - interval '24 hours')
           or (stage = any($2::text[]) and refreshed_at < now() - interval '30 days')
         ))
       )
       order by dirty_at asc nulls last, refreshed_at asc nulls first
       limit $3`,
      [tenantId, CLOSED_STAGES, maxRefreshes]
    );
    for (const { project_id } of due) {
      const remaining = await refreshProjectSnapshot(env, tenantId, project_id);
      log.push(`refreshed ${project_id}`);
      if (remaining != null && remaining < RESERVED_REQUESTS) throw new RateBudgetExhausted();
    }
  } catch (e) {
    if (!(e instanceof RateBudgetExhausted)) throw e;
    log.push('stopped early to leave requests for PMs');
  }
  return log;
}

// Einbau ID (auth-worker, the suite's shared login). Only accounts granted
// LEDGER in HELM get in — app ids are uppercase ("PUNCH", "SCOUT", …; see
// HELM's apps.js). Fails closed if the verify response has no apps list.
export async function verifyEinbauUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const base = env.EINBAU_AUTH_URL || 'https://auth.ben-a90.workers.dev';
  try {
    const res = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: '{}'
    });
    const data = await res.json().catch(() => ({}));
    const apps = data?.user?.apps;
    if (!data?.valid || !Array.isArray(apps) || !apps.some(a => String(a).toUpperCase() === 'LEDGER')) return null;
    return data.user;
  } catch {
    return null;
  }
}

export async function listPortfolio(env, tenantId) {
  return dbQuery(
    env,
    `select * from portfolio_projects where tenant_id = $1 and name is not null order by name`,
    [tenantId]
  );
}
