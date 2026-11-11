// LEDGER in the Procore side panel on an owner invoice (Ben, 2026-11-11): when an invoice is open, show what
// LEDGER knows about it — who billed it and when, which records built it, and each record's own files (with
// their signed download links), whether or not those files were attached to the invoice.
//
// Two groups, kept apart on purpose:
//   built          — records LEDGER billed onto this invoice (billing_records.invoice_id = this invoice)
//   alreadyBilled  — records a PM marked "Already Billed" against this invoice. Those only carry an invoice id
//                    once the Already Billed screen offers the project's real invoices (not built yet); until
//                    then they hold a typed invoice number and won't show here.
//
// Everything here is a read: nothing in Procore or billing_records changes.

import { procoreRequest } from './procore.js';
import { dbQuery } from './db.js';
import { fetchProjectMaterials } from './app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (n) => Math.round(n * 100) / 100;
const MAX_FETCH = 30; // direct costs / commitments looked up per invoice; anything beyond is listed without files

// Reads with a short wait on a 429. procoreRequest already retries gateway errors (502/503/504).
async function get(env, path) {
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await procoreRequest(env, 'GET', path);
    if (res.status !== 429) return res;
    await sleep(1500 * (attempt + 1));
  }
  return res;
}
const listOf = (res) => (Array.isArray(res?.data) ? res.data : Array.isArray(res?.data?.data) ? res.data.data : []);
const filesOf = (attachments, source) => (attachments || [])
  .map((a) => ({ name: a.name || a.filename || 'File', url: a.url || a.presentation_url || null, source }))
  .filter((f) => f.url);

// The T&M reconciliation key LEDGER stores for a timecard (see reconciliationKey in app.js).
const timecardKey = (tc) => String(tc.timecard_entry_id ?? tc.id);

export async function invoicePanelDetail(env, { tenantId, projectId, invoiceId }) {
  const invRes = await get(env, `/rest/v1.0/payment_applications/${invoiceId}?project_id=${projectId}`);
  if (invRes.status === 404) return { found: false };
  if (invRes.status !== 200) throw new Error(`Couldn't read the invoice from Procore (${invRes.status}).`);
  const inv = invRes.data;

  const rows = await dbQuery(env,
    `select record_type, procore_record_id, amount_billed, billed_outside_ledger, reconciled_by, created_at
       from billing_records
      where tenant_id = $1 and project_id = $2 and invoice_id = $3 and status = 'billed'
      order by created_at`,
    [String(tenantId), String(projectId), String(invoiceId)]);

  const items = await describeRecords(env, projectId, rows);
  return {
    found: true,
    invoice: {
      id: String(inv.id),
      number: inv.invoice_number ?? inv.number ?? null,
      status: inv.status || null,
      contract: inv.contract?.title || inv.contract?.number || null,
      billingDate: inv.billing_date || null
    },
    built: summarize(rows.filter((r) => !r.billed_outside_ledger), items),
    alreadyBilled: summarize(rows.filter((r) => r.billed_outside_ledger), items)
  };
}

// One panel item per ticket / direct cost / commitment: a ticket's timecards and materials fold into it.
function summarize(rows, items) {
  if (rows.length === 0) return null;
  const groupOf = (r) => items.get(itemKeyOf(r))?.groupKey || itemKeyOf(r);
  const groups = new Map();
  for (const r of rows) {
    const key = groupOf(r);
    if (!groups.has(key)) {
      const { groupKey, ...item } = items.get(itemKeyOf(r)) || { kind: 'other', title: itemKeyOf(r), files: [] };
      groups.set(key, { ...item, amount: 0, records: 0 });
    }
    const g = groups.get(key);
    g.amount = round2(g.amount + Number(r.amount_billed || 0));
    g.records += 1;
  }
  return {
    total: round2(rows.reduce((s, r) => s + Number(r.amount_billed || 0), 0)),
    records: rows.length,
    by: [...new Set(rows.map((r) => r.reconciled_by).filter(Boolean))],
    firstAt: rows[0].created_at,
    lastAt: rows[rows.length - 1].created_at,
    items: [...groups.values()]
  };
}

const firstLine = (text, max = 140) => {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Which panel item a billing record belongs to. T&M rows are keyed per timecard or material and get folded
// into their ticket later; that needs Procore's lists, so they're grouped by a placeholder key first.
function itemKeyOf(r) {
  const id = String(r.procore_record_id);
  switch (r.record_type) {
    case 'direct_cost': return `dc:${id}`;
    case 'direct_cost_line': return `dc:${id.split(':')[0]}`;
    case 'commitment_line': return `cm:${id.split(':')[0]}`;
    case 'tm_ticket': return `tm:${id}`;
    case 'timecard': return `tc:${id}`;
    case 'tm_material': return `mt:${id}`;
    default: return `${r.record_type}:${id}`;
  }
}

// key -> { kind, title, subtitle, files, entryId? }. T&M placeholders (tc:/mt:) resolve to their ticket's item.
async function describeRecords(env, projectId, rows) {
  const items = new Map();
  const keys = [...new Set(rows.map(itemKeyOf))];
  const has = (prefix) => keys.some((k) => k.startsWith(prefix));

  // T&M: tickets, their timecards and materials, and the files on each ticket.
  if (has('tm:') || has('tc:') || has('mt:')) {
    const [entriesRes, timecardsRes, materials] = await Promise.all([
      get(env, `/rest/v1.0/projects/${projectId}/time_and_material_entries`),
      has('tc:') ? get(env, `/rest/v1.0/projects/${projectId}/time_and_material_timecards`) : null,
      has('mt:') ? fetchProjectMaterials(env, projectId).catch(() => []) : []
    ]);
    const entries = new Map(listOf(entriesRes).map((e) => [String(e.id), e]));
    // groupKey folds every timecard and material on one ticket into that ticket's item.
    const ticketItem = (entryId) => {
      const e = entries.get(String(entryId));
      return e
        ? { kind: 'tm', groupKey: `tm:${e.id}`, procoreId: String(e.id), title: `T&M #${e.number}`, subtitle: [e.date, firstLine(e.description)].filter(Boolean).join(' · ') || null, files: filesOf(e.time_and_material_entry_attachments, 'Ticket'), ticketPdfOnInvoice: true }
        : { kind: 'tm', groupKey: 'tm:missing', title: 'T&M ticket (no longer in Procore)', files: [] };
    };
    const entryOfTimecard = new Map(listOf(timecardsRes).map((tc) => [timecardKey(tc), tc.time_and_material_entry?.id]));
    const entryOfMaterial = new Map((materials || []).map((m) => [String(m.id), m.time_and_material_entry_id]));
    for (const key of keys) {
      const [kind, id] = [key.slice(0, 2), key.slice(3)];
      if (kind === 'tm') items.set(key, ticketItem(id));
      if (kind === 'tc') items.set(key, entryOfTimecard.has(id) ? ticketItem(entryOfTimecard.get(id)) : { kind: 'tm', groupKey: 'tm:missing', title: 'T&M hours (timecard no longer in Procore)', files: [] });
      if (kind === 'mt') items.set(key, entryOfMaterial.has(id) ? ticketItem(entryOfMaterial.get(id)) : { kind: 'tm', groupKey: 'tm:missing', title: 'T&M material (no longer in Procore)', files: [] });
    }
  }

  // Direct costs: the DC itself carries its files.
  const dcIds = keys.filter((k) => k.startsWith('dc:')).map((k) => k.slice(3));
  for (const [i, id] of dcIds.entries()) {
    if (i >= MAX_FETCH) { items.set(`dc:${id}`, { kind: 'dc', title: `Direct Cost #${id}`, files: [] }); continue; }
    const res = await get(env, `/rest/v1.0/projects/${projectId}/direct_costs/${id}`);
    const dc = res.status === 200 ? res.data : null;
    items.set(`dc:${id}`, dc
      ? {
          kind: 'dc',
          procoreId: String(id),
          subtitle: [dc.invoice_number ? `#${dc.invoice_number}` : null, dc.direct_cost_date].filter(Boolean).join(' · ') || null,
          title: firstLine([dc.vendor_name || dc.vendor?.name, String(dc.description || '').trim()].filter(Boolean).join(' - ')) || `Direct Cost #${id}`,
          files: filesOf(dc.attachments, 'Direct Cost')
        }
      : { kind: 'dc', title: `Direct Cost #${id} (no longer in Procore)`, files: [] });
  }

  // Commitments: the commitment's own documents, plus every sub invoice against it (the sub's real backup).
  const cmIds = keys.filter((k) => k.startsWith('cm:')).map((k) => k.slice(3));
  if (cmIds.length) {
    const subInvoices = listOf(await get(env, `/rest/v1.0/requisitions?project_id=${projectId}`));
    const subInvoicesOf = (id) => subInvoices.filter((s) => String(s.commitment_id ?? s.contract_id ?? s.contract?.id ?? s.commitment?.id) === String(id));
    for (const [i, id] of cmIds.entries()) {
      const subFiles = subInvoicesOf(id).flatMap((s) => filesOf(s.attachments, `Sub invoice #${s.number ?? s.invoice_number ?? s.id}`));
      if (i >= MAX_FETCH) { items.set(`cm:${id}`, { kind: 'cm', title: `Commitment #${id}`, files: subFiles }); continue; }
      let c = null;
      let commitmentType = null;
      for (const type of ['work_order_contracts', 'purchase_order_contracts']) {
        const res = await get(env, `/rest/v1.0/${type}/${id}?project_id=${projectId}`);
        if (res.status === 200) { c = res.data; commitmentType = type; break; }
      }
      items.set(`cm:${id}`, {
        kind: 'cm',
        procoreId: c ? String(id) : null,
        commitmentType,
        title: c ? [c.vendor?.name, c.number].filter(Boolean).join(' — ') || `Commitment #${id}` : `Commitment #${id}`,
        subtitle: c?.title || null,
        files: [...subFiles, ...filesOf(c?.attachments, 'Commitment')]
      });
    }
  }
  return items;
}
