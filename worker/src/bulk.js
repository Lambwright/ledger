// ============================================================
// Bulk project reconciliation (Ben's ask 2026-09-30).
//
// LEDGER counted ~5,000 unbilled records company-wide, most of them on old
// jobs nobody will review line by line. A LEDGER admin (Ben, Leela) can pick
// projects on the company dashboard and mark everything still unbilled on
// them as Already Billed, Budgeted or Written Off ("Bulk reconciliation"
// reason) in one go.
//
// Rules Ben agreed:
//   - Real statuses, not hiding — so the double-billing guards keep working.
//   - Only records still Unbilled are touched; anything already billed,
//     written off or budgeted is left alone. So "undo" always means "back to
//     Unbilled".
//   - Each project's run is one batch (bulk_reconciliations row); every record
//     it creates carries bulk_reconciliation_id. The project is flagged in the
//     dashboard and the sidebar.
//   - Records that arrive later show as Unbilled as usual; reconciling them by
//     hand never touches the batch or the flag.
//   - Batch records can't be undone one by one — only an admin "Reopen
//     project", which returns the whole batch to Unbilled.
//   - Queued from the dashboard and worked through by the scheduled run, one
//     project at a time, because listing a project's records costs ~8-10
//     Procore requests of the shared 25/minute.
// ============================================================

import { dbQuery } from './db.js';
import { ensureBulkSchema } from './schema.js';
import {
  listPendingTickets, listPendingDirectCosts, listCommitments, writeOffRecords, markAsBudgeted, markAsAlreadyBilled
} from './app.js';

export const BULK_DISPOSITION_LABELS = {
  billed: 'Already Billed',
  reconciled_to_period: 'Budgeted',
  written_off: 'Written Off'
};

// LEDGER admin = the LEDGER role set in HELM (Einbau ID per-app roles, live
// 2026-09-30: user.appRoles, always present, e.g. { "LEDGER": "admin" }).
// Always read from LEDGER's own /auth/verify call, never from the page.
// Roles: viewer | pm | accounting | admin; no LEDGER entry = LEDGER's default (pm).
export const LEDGER_DEFAULT_ROLE = 'pm';

export function ledgerRole(user) {
  return String(user?.appRoles?.LEDGER || LEDGER_DEFAULT_ROLE).toLowerCase();
}

export function isLedgerAdmin(user) {
  return ledgerRole(user) === 'admin';
}

export async function queueBulkReconciliation(env, tenantId, { projectIds, disposition, notes, invoiceNumber, user }) {
  await ensureBulkSchema(env);
  if (!BULK_DISPOSITION_LABELS[disposition]) throw new Error(`Unknown status: ${disposition}`);
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).map(String).filter(Boolean))];
  if (ids.length === 0) throw new Error('Pick at least one project.');
  if (ids.length > 1000) throw new Error('Too many projects at once — 1,000 at most.');
  // A project with a batch already queued, running or done is skipped — reopen it first.
  const queued = await dbQuery(
    env,
    `insert into bulk_reconciliations (tenant_id, project_id, disposition, notes, invoice_number, requested_by, requested_by_name)
     select $1, pid, $3, $4, $5, $6, $7 from unnest($2::text[]) as pid
     where not exists (
       select 1 from bulk_reconciliations b
       where b.tenant_id = $1 and b.project_id = pid and b.status in ('queued', 'running', 'done')
     )
     returning project_id`,
    [tenantId, ids, disposition, notes?.trim() || null, invoiceNumber?.trim() || null,
     user.username, user.displayName || user.username]
  );
  return { queued: queued.length, skipped: ids.length - queued.length };
}

// Admin "Reopen project": the whole batch goes back to Unbilled. A queued
// batch is simply cancelled; a running one has to finish first.
export async function reopenProject(env, tenantId, projectId, user) {
  await ensureBulkSchema(env);
  const batches = await dbQuery(
    env,
    `select id, status from bulk_reconciliations
     where tenant_id = $1 and project_id = $2 and status in ('queued', 'running', 'done', 'failed')
     order by requested_at desc limit 1`,
    [tenantId, String(projectId)]
  );
  const batch = batches[0];
  if (!batch) throw new Error('This project has no bulk reconciliation to reopen.');
  if (batch.status === 'running') throw new Error("This project's reconciliation is running right now — try again in a few minutes.");
  if (batch.status === 'queued') {
    await dbQuery(env, `update bulk_reconciliations set status = 'cancelled', reopened_by = $2, reopened_at = now() where id = $1`, [batch.id, user.username]);
    return { reverted: 0, cancelled: true };
  }
  const rows = await dbQuery(env, `select id from billing_records where bulk_reconciliation_id = $1`, [batch.id]);
  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    await dbQuery(env, `delete from write_offs where billing_record_id = any($1::uuid[])`, [ids]);
    await dbQuery(env, `delete from billing_records where id = any($1::uuid[])`, [ids]);
  }
  await dbQuery(env, `update bulk_reconciliations set status = 'reopened', reopened_by = $2, reopened_at = now() where id = $1`, [batch.id, user.username]);
  // The record counts are stale now — the count sweep picks nulls first.
  await dbQuery(env, `update portfolio_projects set counts_at = null where tenant_id = $1 and project_id = $2`, [tenantId, String(projectId)]);
  return { reverted: ids.length };
}

// The latest live batch on a project, for the sidebar banner.
export async function projectReconciliation(env, tenantId, projectId) {
  await ensureBulkSchema(env);
  const rows = await dbQuery(
    env,
    `select disposition, status, requested_by_name, requested_at, completed_at, record_count, amount, notes
     from bulk_reconciliations
     where tenant_id = $1 and project_id = $2 and status in ('queued', 'running', 'done')
     order by requested_at desc limit 1`,
    [tenantId, String(projectId)]
  );
  const b = rows[0];
  if (!b) return { reconciliation: null };
  return {
    reconciliation: {
      disposition: b.disposition,
      label: BULK_DISPOSITION_LABELS[b.disposition],
      status: b.status,
      by: b.requested_by_name,
      at: b.completed_at || b.requested_at,
      recordCount: b.record_count,
      amount: b.amount != null ? Number(b.amount) : null,
      notes: b.notes
    }
  };
}

export async function hasQueuedBulkReconciliation(env, tenantId) {
  await ensureBulkSchema(env);
  const rows = await dbQuery(env, `select 1 from bulk_reconciliations where tenant_id = $1 and status = 'queued' limit 1`, [tenantId]);
  return rows.length > 0;
}

// One project per call, and only one at a time company-wide: a big project
// can take longer than a minute at 25 requests/minute, and two at once would
// just starve the sidebar.
export async function processNextBulkReconciliation(env, tenantId) {
  await ensureBulkSchema(env);
  // A worker that died mid-run leaves 'running' behind — requeue after 20 min.
  // Safe to redo: records already dispositioned are simply skipped.
  await dbQuery(
    env,
    `update bulk_reconciliations set status = 'queued'
     where tenant_id = $1 and status = 'running' and started_at < now() - interval '20 minutes'`,
    [tenantId]
  );
  const claimed = await dbQuery(
    env,
    `update bulk_reconciliations set status = 'running', started_at = now()
     where id = (
       select id from bulk_reconciliations
       where tenant_id = $1 and status = 'queued'
         and not exists (select 1 from bulk_reconciliations r where r.tenant_id = $1 and r.status = 'running')
       order by requested_at
       limit 1
       for update skip locked
     )
     returning *`,
    [tenantId]
  );
  const batch = claimed[0];
  if (!batch) return null;

  const projectId = batch.project_id;
  const label = BULK_DISPOSITION_LABELS[batch.disposition];
  const note = `Bulk reconciliation by ${batch.requested_by_name || batch.requested_by}${batch.notes ? ` — ${batch.notes}` : ''}`;
  const common = { tenantId, projectId, userId: batch.requested_by, bulkReconciliationId: batch.id };
  let count = 0;
  let amount = 0;
  const errors = [];

  try {
    // Read-only listing (selfHeal:false) — same lists the sidebar shows.
    const tm = await listPendingTickets(env, { tenantId, projectId, selfHeal: false });
    const dc = await listPendingDirectCosts(env, { tenantId, projectId });
    const cm = await listCommitments(env, { tenantId, projectId });
    const sources = [
      ['T&M', { entryIds: (tm.tickets || []).filter(t => t.unbilledCount > 0).map(t => t.id) }],
      ['direct costs', { directCostIds: (dc.unbilled || []).map(d => d.id) }],
      ['commitments', { commitmentIds: (cm.unbilled || []).map(c => c.id) }]
    ];
    for (const [name, selection] of sources) {
      if (Object.values(selection)[0].length === 0) continue;
      try {
        const args = { ...common, ...selection };
        const result = batch.disposition === 'written_off'
          ? await writeOffRecords(env, { ...args, reasonCategory: 'bulk_reconciliation', reasonNotes: note })
          : batch.disposition === 'billed'
            ? await markAsAlreadyBilled(env, { ...args, notes: note, invoiceNumber: batch.invoice_number })
            : await markAsBudgeted(env, { ...args, notes: note });
        count += result.count;
        amount += result.totalAmount;
      } catch (e) {
        if (!/^Nothing to /.test(e.message)) errors.push(`${name}: ${e.message}`);
      }
    }
  } catch (e) {
    errors.push(e.message);
  }

  const failed = count === 0 && errors.length > 0;
  await dbQuery(
    env,
    `update bulk_reconciliations set status = $2, completed_at = now(), record_count = $3, amount = $4, error = $5 where id = $1`,
    [batch.id, failed ? 'failed' : 'done', count, Math.round(amount * 100) / 100, errors.length ? errors.join(' | ') : null]
  );
  await dbQuery(env, `update portfolio_projects set counts_at = null where tenant_id = $1 and project_id = $2`, [tenantId, projectId]);
  return `bulk ${failed ? 'failed' : 'reconciled'} ${projectId} as ${label}: ${count} record(s)${errors.length ? ` (${errors.join(' | ')})` : ''}`;
}
