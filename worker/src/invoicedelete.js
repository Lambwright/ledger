// Delete a LEDGER invoice from LEDGER (Ben, 2026-11-11). A "run" is everything one LEDGER billing made:
//   invoice run   — the owner invoice, the Change Order and Change Event built for it (or, for a standalone
//                   invoice, the Prime Contract made for it), and the billing records pointing at the invoice
//   draft CO run  — a "Push to CO" that was never invoiced: the draft Change Order, its Change Event, and records
// Deleting a run removes those Procore records and returns the billing records to Unbilled in one go,
// instead of undoing every ticket, Direct Cost and commitment one by one.
//
// Rules (Ben):
//   - Only records LEDGER made. The CO and CE come from the run's own billing records; a Prime Contract is
//     only touched when it's one of LEDGER's standalone contracts (its description says so) and has no other
//     invoice on it. The project's main contract is never touched.
//   - Nothing synced to NetSuite: if the invoice, the CO (or its package) or the standalone contract carries
//     an ERP origin_id, the whole delete is refused.
//   - pm/accounting can only delete runs they billed themselves; admins anyone's (same as Undo).
// Already-deleted records (404) are skipped, so this also cleans up after an invoice someone deleted in Procore.

import { dbQuery } from './db.js';
import { ensureBulkSchema } from './schema.js';
import { requestWithRetry, deleteLinkedWriteOffs } from './app.js';

const ok = (r) => r.status >= 200 && r.status < 300;
const originOf = (r) => (r?.origin_id == null ? '' : String(r.origin_id).trim());
const round2 = (n) => Math.round(n * 100) / 100;
const STANDALONE_MARK = 'LEDGER-generated standalone invoice';

// Every LEDGER-built run on a project, newest first. Database only, no Procore calls.
export async function listLedgerRuns(env, { tenantId, projectId }) {
  await ensureBulkSchema(env);
  const rows = await dbQuery(env, `
    select invoice_id, max(invoice_number) as invoice_number, max(change_order_id) as change_order_id,
           count(*)::int as records, sum(amount_billed) as amount, array_agg(distinct reconciled_by) as by,
           min(created_at) as created_at
      from billing_records
     where tenant_id = $1 and project_id = $2
       and billed_outside_ledger is not true and bulk_reconciliation_id is null
       and ((status = 'billed' and invoice_id is not null) or (status = 'draft_co' and invoice_id is null and change_order_id is not null))
     group by invoice_id, case when invoice_id is null then change_order_id end
     order by min(created_at) desc`,
    [String(tenantId), String(projectId)]);
  return rows.map((r) => ({
    kind: r.invoice_id ? 'invoice' : 'draft_co',
    invoiceId: r.invoice_id || null,
    invoiceNumber: r.invoice_number || null,
    changeOrderId: r.change_order_id || null,
    records: r.records,
    amount: round2(Number(r.amount || 0)),
    by: (r.by || []).filter(Boolean),
    createdAt: r.created_at
  }));
}

async function runRows(env, { tenantId, projectId, invoiceId, changeOrderId }) {
  const common = `tenant_id = $1 and project_id = $2 and billed_outside_ledger is not true and bulk_reconciliation_id is null`;
  return invoiceId
    ? dbQuery(env, `select id, change_order_id, change_event_id, invoice_number, reconciled_by, amount_billed from billing_records
                     where ${common} and status = 'billed' and invoice_id = $3`, [String(tenantId), String(projectId), String(invoiceId)])
    : dbQuery(env, `select id, change_order_id, change_event_id, invoice_number, reconciled_by, amount_billed from billing_records
                     where ${common} and status = 'draft_co' and invoice_id is null and change_order_id = $3`, [String(tenantId), String(projectId), String(changeOrderId)]);
}

const distinct = (rows, key) => [...new Set(rows.map((r) => r[key]).filter(Boolean).map(String))];

// What a delete would do, without changing anything. The sidebar shows this before the PM confirms, and the
// delete itself re-runs it so nothing is acted on from a stale screen.
export async function planRunDeletion(env, { tenantId, projectId, invoiceId = null, changeOrderId = null, onlyReconciledBy = null, onProgress }) {
  if (!invoiceId && !changeOrderId) throw new Error('Pick an invoice or a draft Change Order.');
  await ensureBulkSchema(env);
  const rows = await runRows(env, { tenantId, projectId, invoiceId, changeOrderId });
  if (rows.length === 0) throw new Error(invoiceId ? "LEDGER didn't build this invoice (or it's already been deleted from LEDGER)." : 'LEDGER has no records on this draft Change Order.');
  if (onlyReconciledBy != null && rows.some((r) => r.reconciled_by !== onlyReconciledBy)) {
    throw new Error('Someone else billed this. Ask a LEDGER admin to delete it.');
  }

  const p = String(projectId);
  const steps = [];
  const blocked = [];
  const get = (path) => requestWithRetry(env, 'GET', path, null, onProgress);

  let contractId = null;
  if (invoiceId) {
    const res = await get(`/rest/v1.0/payment_applications/${invoiceId}?project_id=${p}`);
    const inv = res.status === 200 ? res.data : null;
    if (res.status !== 200 && res.status !== 404) throw new Error(`Couldn't read the invoice from Procore (${res.status}).`);
    // The invoice names its contract as contract.id (no contract_id field, checked 2026-11-11).
    contractId = inv ? String(inv.contract?.id ?? inv.contract_id ?? '') || null : null;
    const label = `Invoice ${inv?.invoice_number ?? rows[0].invoice_number ?? invoiceId}`;
    steps.push({ key: 'invoice', id: String(invoiceId), contractId, label, exists: !!inv, status: inv?.status || null });
    if (inv && originOf(inv)) blocked.push(`${label} is synced to NetSuite (${originOf(inv)}).`);
  }

  for (const coId of distinct(rows, 'change_order_id')) {
    const res = await get(`/rest/v1.0/projects/${p}/prime_change_orders/${coId}`);
    if (res.status !== 200 && res.status !== 404) throw new Error(`Couldn't read Change Order ${coId} from Procore (${res.status}).`);
    const co = res.status === 200 ? res.data : null;
    let synced = co ? originOf(co) : '';
    // NetSuite links sit on the CO package (Ben unlinked those on 2026_0357), so check that too.
    if (co?.legacy_package_id && !synced) {
      const pkg = await get(`/rest/v1.0/change_order_packages/${co.legacy_package_id}?project_id=${p}`);
      if (pkg.status === 200) synced = originOf(pkg.data);
    }
    const label = `Change Order ${co?.number != null ? `#${co.number}` : coId}${co?.title ? ` (${co.title})` : ''}`;
    steps.push({ key: 'change_order', id: coId, label, exists: !!co, status: co?.status || null });
    if (synced) blocked.push(`${label} is synced to NetSuite (${synced}).`);
  }

  for (const ceId of distinct(rows, 'change_event_id')) {
    const res = await get(`/rest/v1.1/change_events/${ceId}?project_id=${p}`);
    if (res.status !== 200 && res.status !== 404) throw new Error(`Couldn't read Change Event ${ceId} from Procore (${res.status}).`);
    const ce = res.status === 200 ? res.data : null;
    steps.push({ key: 'change_event', id: ceId, label: `Change Event ${ce?.number != null ? `#${ce.number}` : ceId}`, exists: !!ce, status: ce?.status?.name || (typeof ce?.status === 'string' ? ce.status : null) });
  }

  // A standalone invoice has no CO: its contract was made for it. Only that kind of contract is ever deleted.
  if (invoiceId && contractId && !rows.some((r) => r.change_order_id)) {
    const res = await get(`/rest/v1.0/prime_contract/${contractId}?project_id=${p}`);
    const pc = res.status === 200 ? res.data : null;
    if (pc && String(pc.description || '').includes(STANDALONE_MARK)) {
      const label = `Prime Contract #${pc.number}${pc.title ? ` (${pc.title})` : ''}`;
      const invs = await get(`/rest/v1.0/payment_applications?project_id=${p}`);
      const others = (Array.isArray(invs.data) ? invs.data : [])
        .filter((i) => String(i.contract_id ?? i.contract?.id) === String(contractId) && String(i.id) !== String(invoiceId));
      if (invs.status !== 200 || others.length) {
        steps.push({ key: 'prime_contract', id: String(contractId), label, exists: true, keep: invs.status !== 200 ? "couldn't check its other invoices" : 'it has other invoices' });
      } else {
        steps.push({ key: 'prime_contract', id: String(contractId), label, exists: true, status: pc.status || null });
        if (originOf(pc)) blocked.push(`${label} is synced to NetSuite (${originOf(pc)}).`);
      }
    }
  }

  return {
    kind: invoiceId ? 'invoice' : 'draft_co',
    records: rows.length,
    amount: round2(rows.reduce((s, r) => s + Number(r.amount_billed || 0), 0)),
    steps,
    blocked
  };
}

// Deletes the run: Procore records first (invoice, CO, CE, standalone contract), then LEDGER's records.
// Stops before touching LEDGER's records if the gate record (the invoice, or a draft run's CO) won't delete,
// so LEDGER never says "unbilled" while the invoice still exists.
export async function deleteRun(env, { tenantId, projectId, invoiceId = null, changeOrderId = null, onlyReconciledBy = null, onProgress = () => {} }) {
  const plan = await planRunDeletion(env, { tenantId, projectId, invoiceId, changeOrderId, onlyReconciledBy, onProgress });
  if (plan.blocked.length) throw new Error(`Nothing was deleted. ${plan.blocked.join(' ')}`);
  const p = String(projectId);
  const done = [];
  const leftover = [];
  const say = (message) => onProgress({ message });
  const call = (method, path, body) => requestWithRetry(env, method, path, body, onProgress);
  const step = (key) => plan.steps.filter((s) => s.key === key);

  // 1. The invoice.
  for (const s of step('invoice')) {
    if (!s.exists) { say(`${s.label} was already gone from Procore`); continue; }
    const r = await deleteInvoice(call, p, s);
    if (!ok(r)) throw new Error(`Couldn't delete ${s.label} (${r.status} ${JSON.stringify(r.data)}). Nothing was changed.`);
    done.push(s.label);
    say(`Deleted ${s.label}`);
  }

  // 2. The Change Order. An invoiced one was approved by LEDGER, so it goes back to draft first.
  for (const s of step('change_order')) {
    if (!s.exists) { say(`${s.label} was already gone from Procore`); continue; }
    const r = await deleteChangeOrder(call, p, s);
    if (ok(r)) { done.push(s.label); say(`Deleted ${s.label}`); continue; }
    if (plan.kind === 'draft_co') throw new Error(`Couldn't delete ${s.label} (${r.status} ${JSON.stringify(r.data)}). Nothing was changed.`);
    leftover.push(`${s.label}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  // 3. The Change Event (only once its CO is gone; Procore won't delete one still on a CO).
  for (const s of step('change_event')) {
    if (!s.exists) continue;
    if (leftover.length) { leftover.push(`${s.label}: kept, because its Change Order couldn't be deleted`); continue; }
    const r = await call('DELETE', `/rest/v1.1/change_events/${s.id}?project_id=${p}`, null);
    if (ok(r)) { done.push(s.label); say(`Deleted ${s.label}`); } else leftover.push(`${s.label}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  // 4. A standalone invoice's own Prime Contract.
  for (const s of step('prime_contract')) {
    if (s.keep) { leftover.push(`${s.label}: kept, because ${s.keep}`); continue; }
    const r = await deleteStandaloneContract(env, call, p, s);
    if (ok(r)) { done.push(s.label); say(`Deleted ${s.label}`); } else leftover.push(`${s.label}: ${r.status} ${JSON.stringify(r.data)}`);
  }

  // 5. LEDGER's records go back to Unbilled.
  const rows = await runRows(env, { tenantId, projectId, invoiceId, changeOrderId });
  const ids = rows.map((r) => r.id);
  await deleteLinkedWriteOffs(env, ids);
  if (ids.length) await dbQuery(env, `delete from billing_records where id = any($1::uuid[])`, [ids]);
  say(`${ids.length} record(s) back to Unbilled`);
  return { deleted: done, leftover, records: ids.length };
}

// All three tested on the Test Project, 2026-11-11: standalone run, CO invoice run, draft CO run.
// See api-directory "Deleting a LEDGER invoice run".
async function deleteInvoice(call, p, s) {
  return call('DELETE', `/rest/v1.0/payment_applications/${s.id}?project_id=${p}`, null);
}

async function deleteChangeOrder(call, p, s) {
  if (s.status && s.status !== 'draft') {
    const r = await call('PATCH', `/rest/v1.0/projects/${p}/prime_change_orders/${s.id}`, { change_order: { status: 'draft', executed: false } });
    if (!ok(r)) return r;
  }
  return call('DELETE', `/rest/v1.0/projects/${p}/prime_change_orders/${s.id}`, null);
}

async function deleteStandaloneContract(env, call, p, s) {
  const v2 = `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${p}/prime_contracts/${s.id}`;
  if (s.status && String(s.status).toLowerCase() !== 'draft') {
    const r = await call('PATCH', v2, { status: 'Draft', executed: false });
    if (!ok(r)) return r;
  }
  return call('DELETE', v2, null);
}
