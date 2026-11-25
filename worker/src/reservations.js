// Billing runs reserve their items BEFORE touching Procore (Ben, 2026-11-25).
//
// Why: billing_records are written only after the Procore work is done. On
// 2026-11-23 (project 562949955461743) a run created CO 002 and a draft
// invoice, then died while waiting for Procore's invoice lines. It wrote no
// billing_records, so the same 23 tickets still looked unbilled, and Confirm
// pressed again 20 seconds later billed them a second time (CO 003).
//
// Now a run inserts one row per item here first (same keys as billing_records),
// and a second run on any of those items is refused up front. The row goes when
// the run's billing_records are written. A run that fails after creating
// something in Procore keeps its rows, marked 'failed' with what it created; a
// run that's cut off keeps them as 'running'. Either way the items stay blocked
// until a person checks Procore and releases them.
import { dbQuery } from './db.js';

// Longer than any live run holds its reservation: the CE/CO build plus up to
// ~90 s waiting for invoice lines. Backups are uploaded after the release.
const STALE_MS = 10 * 60 * 1000;

let ready = false;
async function ensureReservationSchema(env) {
  if (ready) return;
  await dbQuery(env, `create table if not exists billing_reservations (
    tenant_id text not null,
    project_id text not null,
    record_type text not null,
    procore_record_id text not null,
    run_id uuid not null,
    action text not null,
    label text,
    reserved_by text not null,
    reserved_at timestamptz not null default now(),
    status text not null default 'running' check (status in ('running', 'failed')),
    change_event_id text,
    change_order_id text,
    contract_id text,
    invoice_id text,
    error text,
    primary key (tenant_id, project_id, record_type, procore_record_id)
  )`, []);
  await dbQuery(env, `create index if not exists billing_reservations_run on billing_reservations (run_id)`, []);
  ready = true;
}

function dedupe(keys) {
  const seen = new Map();
  for (const k of keys || []) {
    if (k?.recordType && k?.procoreRecordId != null) seen.set(`${k.recordType}|${k.procoreRecordId}`, k);
  }
  const list = [...seen.values()];
  return { types: list.map(k => String(k.recordType)), ids: list.map(k => String(k.procoreRecordId)) };
}

const ago = (ts) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return mins < 1 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};

// One entry per run holding any of these items.
async function runsHolding(env, tenantId, projectId, types, ids) {
  const rows = await dbQuery(env, `
    select r.run_id, r.action, r.label, r.reserved_by, r.reserved_at, r.status, r.error,
           r.change_event_id, r.change_order_id, r.contract_id, r.invoice_id, count(*)::int as items
    from billing_reservations r
    join unnest($3::text[], $4::text[]) as k(record_type, procore_record_id)
      on k.record_type = r.record_type and k.procore_record_id = r.procore_record_id
    where r.tenant_id = $1 and r.project_id = $2
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    order by r.reserved_at`, [String(tenantId), String(projectId), types, ids]);
  return rows.map(r => {
    const stale = Date.now() - new Date(r.reserved_at).getTime() > STALE_MS;
    return {
      runId: r.run_id, label: r.label || 'An earlier billing run', by: r.reserved_by, startedAt: r.reserved_at,
      status: r.status, items: r.items, error: r.error,
      created: { changeEventId: r.change_event_id, changeOrderId: r.change_order_id, contractId: r.contract_id, invoiceId: r.invoice_id },
      releasable: r.status === 'failed' || stale
    };
  });
}

function inProgressError(runs) {
  const lines = runs.map(r => {
    const made = [
      r.created.changeEventId && `Change Event id ${r.created.changeEventId}`,
      r.created.changeOrderId && `Change Order id ${r.created.changeOrderId}`,
      r.created.contractId && `Prime Contract id ${r.created.contractId}`,
      r.created.invoiceId && `invoice id ${r.created.invoiceId}`
    ].filter(Boolean);
    const state = r.status === 'failed'
      ? `failed partway (${r.error || 'error'})`
      : r.releasable ? 'never finished' : 'is running right now';
    return `"${r.label}", started by ${r.by} ${ago(r.startedAt)}, ${state}.` +
      (made.length ? ` It created ${made.join(', ')} in Procore.` : ' It may not have created anything in Procore yet.');
  });
  const anyLive = runs.some(r => !r.releasable);
  const held = runs.reduce((n, r) => n + r.items, 0);
  const err = new Error(
    `${held === 1 ? '1 of these items is' : `${held} of these items are`} already in a billing run: ${lines.join(' ')} ` +
    (anyLive
      ? 'Wait for it to finish, then refresh.'
      : 'Check Procore first: delete anything it left behind, or finish it there by hand. Then release the run and bill again.')
  );
  err.code = 'BILLING_IN_PROGRESS';
  err.runs = runs.map(({ runId, label, by, startedAt, status, releasable, created }) => ({ runId, label, by, startedAt, status, releasable, created }));
  return err;
}

// For the preview: refuse early if any item is in a run. No writes.
export async function assertNotReserved(env, { tenantId, projectId, keys }) {
  const { types, ids } = dedupe(keys);
  if (ids.length === 0) return;
  await ensureReservationSchema(env);
  const runs = await runsHolding(env, tenantId, projectId, types, ids);
  if (runs.length > 0) throw inProgressError(runs);
}

// One billing run's reservation. Call reserve() after the items are resolved
// and before the first Procore write; wrap onProgress with watch() so the
// Change Event / Change Order / contract / invoice ids land on the rows as
// they're created; done() after billing_records are written; failed(e) in the
// catch.
export function billingRun(env, { tenantId, projectId, userId, action }) {
  const runId = crypto.randomUUID();
  let reserved = false;
  const created = {};
  let pending = Promise.resolve();

  const COLUMNS = { changeEventId: 'change_event_id', changeOrderId: 'change_order_id', contractId: 'contract_id', invoiceId: 'invoice_id' };

  async function release() {
    if (!reserved) return;
    await pending;
    await dbQuery(env, `delete from billing_reservations where run_id = $1::uuid`, [runId]);
    reserved = false;
  }

  return {
    runId,

    async reserve(keys, label) {
      const { types, ids } = dedupe(keys);
      if (ids.length === 0) return;
      await ensureReservationSchema(env);
      const got = await dbQuery(env, `
        insert into billing_reservations (tenant_id, project_id, record_type, procore_record_id, run_id, action, label, reserved_by)
        select $1, $2, k.record_type, k.procore_record_id, $5::uuid, $6, $7, $8
        from unnest($3::text[], $4::text[]) as k(record_type, procore_record_id)
        on conflict do nothing
        returning procore_record_id`,
        [String(tenantId), String(projectId), types, ids, runId, action, label || null, userId || 'ledger-system']);
      if (got.length < ids.length) {
        await dbQuery(env, `delete from billing_reservations where run_id = $1::uuid`, [runId]);
        const runs = (await runsHolding(env, tenantId, projectId, types, ids)).filter(r => r.runId !== runId);
        if (runs.length > 0) throw inProgressError(runs);
        throw new Error('Some of these items were being reserved by another run at the same moment. Refresh and try again.');
      }
      reserved = true;
      // A run that finished between this run's "what's unbilled" check and now
      // has already released its reservation, so look at billing_records too.
      const billed = await dbQuery(env, `
        select count(*)::int as n from billing_records b
        join unnest($3::text[], $4::text[]) as k(record_type, procore_record_id)
          on k.record_type = b.record_type and k.procore_record_id = b.procore_record_id
        where b.tenant_id = $1 and b.project_id = $2`, [String(tenantId), String(projectId), types, ids]);
      if (billed[0]?.n > 0) {
        await release();
        throw new Error(`${billed[0].n} of these items were just billed or marked by someone else. Refresh to see where they went. Nothing was created.`);
      }
    },

    // Records each Procore id as it's announced, so a run that's cut off still
    // says what it left behind.
    watch(onProgress) {
      return (evt) => {
        const set = {};
        for (const [key, col] of Object.entries(COLUMNS)) {
          if (evt?.[key] != null && created[key] !== String(evt[key])) {
            created[key] = String(evt[key]);
            set[col] = created[key];
          }
        }
        if (reserved && Object.keys(set).length > 0) {
          const cols = Object.keys(set);
          pending = pending
            .then(() => dbQuery(env,
              `update billing_reservations set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where run_id = $1::uuid`,
              [runId, ...cols.map(c => set[c])]))
            .catch(() => {});
        }
        return onProgress(evt);
      };
    },

    // billing_records are written: the items are no longer "in a run".
    async done() {
      await release();
    },

    // Nothing left in Procore (nothing created yet, or the run's own rollback
    // removed it all): free the items. Otherwise keep them blocked, with why.
    async failed(e) {
      if (!reserved) return;
      const anythingCreated = Object.keys(created).length > 0;
      if (!anythingCreated || e?.nothingLeft) {
        await release().catch(() => {});
        return;
      }
      await pending;
      await dbQuery(env, `update billing_reservations set status = 'failed', error = $2 where run_id = $1::uuid`,
        [runId, String(e?.message || e || 'error').slice(0, 500)]).catch(() => {});
    }
  };
}

// A person releasing a failed or cut-off run, after checking Procore. A run
// that's still within its normal running time can't be released.
export async function releaseBillingRun(env, { tenantId, projectId, runId, userId }) {
  await ensureReservationSchema(env);
  const rows = await dbQuery(env, `
    select status, reserved_at, label, reserved_by, count(*) over ()::int as items
    from billing_reservations where tenant_id = $1 and project_id = $2 and run_id = $3::uuid limit 1`,
    [String(tenantId), String(projectId), String(runId)]);
  if (rows.length === 0) return { released: 0 };
  const r = rows[0];
  if (r.status === 'running' && Date.now() - new Date(r.reserved_at).getTime() <= STALE_MS) {
    throw new Error(`"${r.label}" started ${ago(r.reserved_at)} and may still be running. Wait for it to finish.`);
  }
  await dbQuery(env, `delete from billing_reservations where tenant_id = $1 and project_id = $2 and run_id = $3::uuid`,
    [String(tenantId), String(projectId), String(runId)]);
  console.log(`[billing-run] released run ${runId} on project ${projectId} ("${r.label}", ${r.items} item(s), started by ${r.reserved_by}) by ${userId || 'service'}`);
  return { released: r.items };
}
