// Project money for CRM's SCOUT stats tab (Ben, 2026-10-15): for projects won
// from SCOUT-prequalified bids, CRM shows LEDGER's real contract and invoicing
// figures beside the bid estimate. LEDGER pushes; CRM never calls Procore.
//
//   - Every 15 minutes the scheduled run sends CRM every portfolio row refreshed
//     since the last successful push (pushFinancialsToCrm). Zero Procore calls.
//   - CRM's per-project Refresh button calls POST /crm/project-financials/refresh
//     (handleCrmRefresh), which refreshes that one project live — counted as a
//     person's use, not background — and answers with the item directly.
//
// Both directions go through service bindings (CRM_WORKER here, LEDGER_WORKER
// on crm-worker): a plain fetch between *.workers.dev URLs is error 1042. Both
// carry the shared CRM_FINANCE_KEY secret as X-CRM-Finance-Key.
//
// null means unknown, never 0 (CRM's rule too). paid_to_date and currency are
// null until LEDGER reads them (payments need extra Procore calls; currency is
// a project custom field whose id HANDOFF knows).

import { dbQuery } from './db.js';
import { refreshProjectSnapshot, keepUserActive } from './portfolio.js';

const BATCH = 500; // CRM's per-request maximum

const round2 = (n) => Math.round(n * 100) / 100;
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// One portfolio row → CRM's item shape.
export function financialsItem(row) {
  const contract = numOrNull(row.pc_original_all);
  const revised = numOrNull(row.revised_contract);
  return {
    procore_project_id: String(row.project_id),
    project_name: row.name || null,
    contract_value: contract,
    approved_change_orders: contract != null && revised != null ? round2(revised - contract) : null,
    revised_contract: revised,
    invoiced_to_date: numOrNull(row.invoiced),
    paid_to_date: null,
    currency: null,
    as_of: row.refreshed_at ? new Date(row.refreshed_at).toISOString() : null
  };
}

let pushColumnReady = false;
async function ensurePushColumn(env) {
  if (pushColumnReady) return;
  await dbQuery(env, `alter table portfolio_sync_state add column if not exists crm_pushed_through timestamptz`, []);
  pushColumnReady = true;
}

// Sends rows refreshed since the last successful push, oldest first, in
// batches of 500 (at most 4 batches a run). The watermark only moves after CRM
// accepts a batch, so a failed push is retried next time.
export async function pushFinancialsToCrm(env) {
  if (!env.CRM_FINANCE_KEY || !env.CRM_WORKER) return 'CRM push not configured';
  const tenantId = String(env.PROCORE_COMPANY_ID);
  await ensurePushColumn(env);
  const state = await dbQuery(env, `select crm_pushed_through from portfolio_sync_state where tenant_id = $1`, [tenantId]);
  let through = state[0]?.crm_pushed_through || null;
  let sent = 0;
  let stored = 0;
  const invalid = [];
  for (let round = 0; round < 4; round++) {
    const rows = await dbQuery(
      env,
      `select project_id, name, pc_original_all, revised_contract, invoiced, refreshed_at
       from portfolio_projects
       where tenant_id = $1 and name is not null and refreshed_at is not null
         and ($2::timestamptz is null or refreshed_at > $2::timestamptz)
       order by refreshed_at asc
       limit ${BATCH}`,
      [tenantId, through]
    );
    if (rows.length === 0) break;
    const res = await env.CRM_WORKER.fetch('https://crm-worker/internal/project-financials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Finance-Key': env.CRM_FINANCE_KEY },
      body: JSON.stringify({ items: rows.map(financialsItem) })
    });
    if (!res.ok) return `CRM push refused (${res.status}) after ${sent} sent — will retry`;
    // CRM answers { received, stored, invalid, invalid_ids }; log any shortfall.
    const ack = await res.json().catch(() => null);
    if (ack) {
      stored += Number(ack.stored) || 0;
      invalid.push(...(Array.isArray(ack.invalid_ids) ? ack.invalid_ids : []));
    }
    through = rows[rows.length - 1].refreshed_at;
    await dbQuery(env, `update portfolio_sync_state set crm_pushed_through = $2 where tenant_id = $1`, [tenantId, through]);
    sent += rows.length;
    if (rows.length < BATCH) break;
  }
  if (!sent) return null;
  return `CRM push: sent ${sent}, CRM stored ${stored}` + (invalid.length ? `, invalid ids: ${invalid.slice(0, 10).join(', ')}` : '');
}

// CRM's Refresh button. 401 on a wrong key, 503 when not configured or when
// Procore's rate limit is in the way (with retry_after_seconds, straight away —
// a person is waiting).
export async function handleCrmRefresh(request, env) {
  const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.CRM_FINANCE_KEY) return json({ error: 'LEDGER is not connected to CRM yet' }, 503);
  if (request.headers.get('X-CRM-Finance-Key') !== env.CRM_FINANCE_KEY) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  const projectId = String(body?.procore_project_id || '');
  if (!/^\d{5,}$/.test(projectId)) return json({ error: 'procore_project_id must be a Procore project id' }, 400);

  const tenantId = String(env.PROCORE_COMPANY_ID);
  const stop = keepUserActive(env);
  try {
    await refreshProjectSnapshot(env, tenantId, projectId);
  } catch (e) {
    if (e.retryAfterSeconds !== undefined) {
      return json({ error: e.message, retry_after_seconds: e.retryAfterSeconds }, 503);
    }
    return json({ error: e.message }, 502);
  } finally {
    stop();
  }
  const rows = await dbQuery(
    env,
    `select project_id, name, pc_original_all, revised_contract, invoiced, refreshed_at, refresh_error
     from portfolio_projects where tenant_id = $1 and project_id = $2`,
    [tenantId, projectId]
  );
  if (!rows[0]) return json({ error: 'project not found in Procore' }, 404);
  return json({ item: financialsItem(rows[0]), refresh_error: rows[0].refresh_error || null }, 200);
}
