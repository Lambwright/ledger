// LEDGER's actual business logic — the T&M reconciliation/billing pipeline.
// Every Procore mechanic used here was proven live against real Einbau data
// before this was written; see api-directory/README.md for the evidence trail.

import { procoreRequest } from './procore.js';
import { dbQuery } from './db.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Confirmed live 2026-09-14 by reading Procore's own rate-limit headers
// (x-rate-limit-limit/-remaining/-reset) off real responses: 25 requests per
// rolling 60-second window, ONE shared bucket for the whole Connector app +
// company — not per-project, not per-user, every LEDGER call from anyone
// draws from the same pool. A single CO line-item/g703-claim loop of even
// 10 lines, plus the handful of setup calls around it, can exceed 25 on its
// own. A flat inter-request delay (tried first) can't fix that — it just
// slows down hitting the same wall. Checking the real remaining/reset off
// each response and pausing until the window actually refreshes is the only
// approach that's correct regardless of operation size.
async function throttleForRateLimit(headers, onProgress) {
  const remaining = headers?.['x-rate-limit-remaining'];
  const reset = headers?.['x-rate-limit-reset'];
  if (remaining == null || reset == null || Number(remaining) > 1) return;
  const waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000; // +1s buffer past the boundary
  if (waitMs <= 0) return;
  onProgress?.({ message: `Pausing ~${Math.ceil(waitMs / 1000)}s — near Procore's rate limit (25 requests/60s, shared account-wide)` });
  await sleep(waitMs);
}

// throttleForRateLimit is proactive (checks headers AFTER a successful call to
// pace the NEXT one) — it can't stop the current call from landing on a 429 if
// the shared account-wide bucket got drained by something else in the same
// window (another user, another LEDGER run, or another flow Ben is running at
// the same time). Proven live 2026-09-22: Ben pushing 23 T&M tickets to one CO
// still hit a real 429 (died at 16/23) even after a ONE-retry version of this
// shipped — under heavy simultaneous testing the bucket can still be empty
// after a single wait-for-reset. Loops up to maxAttempts times (default 5),
// each time waiting for Procore's own reported reset rather than guessing —
// worst case is slow, never a silent partial failure.
async function requestWithRetry(env, method, path, body, onProgress, maxAttempts = 5) {
  const doRequest = () => procoreRequest(env, method, path, body);
  let r = await doRequest();
  for (let attempt = 1; r.status === 429 && attempt < maxAttempts; attempt++) {
    const reset = r.headers?.['x-rate-limit-reset'];
    const waitMs = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) + 1000 : 5000;
    onProgress?.({ message: `Rate-limited (429) — waiting ~${Math.ceil(waitMs / 1000)}s for Procore's window to reset, then retrying (attempt ${attempt + 1}/${maxAttempts})…` });
    await sleep(waitMs);
    r = await doRequest();
  }
  return r;
}

// Maps Procore's real timecard_time_type strings to LEDGER's own enum.
// Confirmed live: Procore uses "Regular Time" / "Overtime" / "Double Time",
// not the lowercase words the original intake sheet assumed.
const TIME_TYPE_MAP = {
  'Regular Time': 'regular',
  'Overtime': 'overtime',
  'Double Time': 'double_time',
  'Per Diem': 'per_diem'
};

const TIME_TYPE_LABEL = {
  regular: 'Regular Time',
  overtime: 'Overtime',
  double_time: 'Double Time',
  per_diem: 'Per Diem'
};

// The 49-04 T&M cost code series' STABLE (company-wide) standard_cost_code_id
// for each time type — resolved once, from real project data, 2026-09-04.
// Per Diem deliberately excluded: it lives under Travel/Expenses (49-01-06-05),
// not this family — out of scope for this first pass.
const STANDARD_COST_CODE_BY_TIME_TYPE = {
  regular: '562949960221301',
  overtime: '562949960221302',
  double_time: '562949960221303'
};

// The reconciliation key for a timecard. Prefer the real timecard_entry_id
// (the reference to the underlying raw timesheet entry — this is what catches
// the SAME hours being billed via two different T&M tickets). BUT: proven
// live 2026-09-09 on the KPS Costco project that timecard_entry_id is null
// for timecards that have no linked timesheet entry (most of them, on that
// project) — String(null) collapsed every such timecard to the same "null"
// key, so billing ONE of them silently marked every other null-ID timecard on
// the whole project as already billed. Fall back to the timecard's own
// (always-present, always-unique) id when timecard_entry_id is null.
function reconciliationKey(tc) {
  return String(tc.timecard_entry_id ?? tc.id);
}

// procore_record_id -> { status, invoiceNumber } for every timecard LEDGER has
// already touched on this project. A 'billed' row always wins over a 'draft_co'
// row for the same key (a draft later invoiced for real).
// Shared by T&M timecards and direct costs (generalized 2026-09-16, was
// hardcoded to record_type = 'timecard') — the anti-double-billing lookup
// underlying both: which Procore records already have a billing_records row.
// Left-joins write_offs so a 'written_off' row's reason travels with it —
// needed to show the reason on the new Written-off tab (Ben's ask
// 2026-09-17) without a second round trip per record.
async function getBilledRecordMap(env, tenantId, projectId, recordType) {
  const rows = await dbQuery(
    env,
    `select br.procore_record_id, br.status, br.invoice_number, br.invoice_id, br.amount_billed, br.write_off_reason,
            br.is_estimated, br.billed_outside_ledger, wo.reason_category, wo.reason_notes
     from billing_records br
     left join write_offs wo on wo.billing_record_id = br.id
     where br.tenant_id = $1 and br.project_id = $2 and br.record_type = $3`,
    [tenantId, projectId, recordType]
  );
  const map = new Map();
  for (const r of rows) {
    const existing = map.get(r.procore_record_id);
    if (!existing || (existing.status !== 'billed' && r.status === 'billed')) {
      map.set(r.procore_record_id, {
        status: r.status,
        invoiceNumber: r.invoice_number,
        invoiceId: r.invoice_id,
        amount: r.amount_billed != null ? Number(r.amount_billed) : null,
        reasonCategory: r.reason_category || null,
        // 'written_off' rows have a real write_offs row (reason_notes);
        // 'reconciled_to_period' ("Budgeted") rows don't — they use
        // billing_records.write_off_reason directly as a plain note instead
        // (see markAsBudgeted) — fall back to that when there's no join match.
        reasonNotes: r.reason_notes || r.write_off_reason || null,
        // Commitments only (2026-09-24) — see dcLineReconciliationKey's
        // Commitment equivalent below for why this is commitment-level, not
        // line-level, despite living on a per-line-item row.
        isEstimated: r.is_estimated === true,
        // "Already Billed" (Ben's ask 2026-09-25): billed on an invoice LEDGER
        // didn't create — counts as billed everywhere, but has its own undo.
        billedOutsideLedger: r.billed_outside_ledger === true
      });
    }
  }
  return map;
}

// Also folds in hours billed through a COMMITMENT line (Einvoice builds one
// commitment line per subcontractor timecard, and the same timecard can sit
// on a T&M ticket) so every T&M path — list, detail, billing, write-off —
// treats them as already billed with no changes of its own. Only
// billed/draft_co count: a written-off or budgeted commitment line never
// reached the client. A real T&M row always wins over a commitment one.
async function getBilledTimecardMap(env, tenantId, projectId) {
  const [map, viaCommitment] = await Promise.all([
    getBilledRecordMap(env, tenantId, projectId, 'timecard'),
    dbQuery(
      env,
      `select source_timecard_key, status, invoice_number, invoice_id, amount_billed
       from billing_records
       where tenant_id = $1 and project_id = $2 and record_type = 'commitment_line'
         and source_timecard_key is not null and status in ('billed', 'draft_co')`,
      [tenantId, projectId]
    )
  ]);
  for (const r of viaCommitment) {
    if (map.has(r.source_timecard_key)) continue;
    map.set(r.source_timecard_key, {
      status: r.status,
      invoiceNumber: r.invoice_number,
      invoiceId: r.invoice_id,
      amount: r.amount_billed != null ? Number(r.amount_billed) : null,
      reasonCategory: null,
      reasonNotes: null,
      isEstimated: false,
      viaCommitment: true
    });
  }
  return map;
}

async function getBilledTimecardIds(env, tenantId, projectId) {
  return new Set((await getBilledTimecardMap(env, tenantId, projectId)).keys());
}

async function getBilledDirectCostMap(env, tenantId, projectId) {
  return getBilledRecordMap(env, tenantId, projectId, 'direct_cost');
}

// Per-line DC billing (Ben's ask 2026-09-22) — keyed by dcLineReconciliationKey
// ("<direct_cost_id>:<line_item_id>"), NOT the whole DC's own id. Deliberately
// a separate record_type from 'direct_cost' rather than sharing one — a DC
// billed whole under the OLD scheme must never be reconciled against this new
// per-line map (see dcLineReconciliationKey below for the full reasoning).
async function getBilledDirectCostLineMap(env, tenantId, projectId) {
  return getBilledRecordMap(env, tenantId, projectId, 'direct_cost_line');
}

// "<direct_cost_id>:<line_item_id>" — the DC-id prefix isn't needed for
// uniqueness (Procore line item ids are real, globally unique ids — confirmed
// live 2026-09-22 against a real 3-line-item direct cost) but lets the cheap
// list view (listPendingDirectCosts) group per-line billing_records rows back
// to their parent DC using only the string key, with zero extra Procore
// calls — direct costs have no bulk line-item endpoint the way T&M has a bulk
// timecards endpoint. Throws on a null id rather than silently colliding two
// different lines onto one key — same lesson reconciliationKey's
// timecard_entry_id fallback taught this project (see above): no known
// null-id case for DC line items, but no proven-safe fallback either, so fail
// loud instead of risking silent double-billing.
function dcLineReconciliationKey(directCostId, lineItem) {
  if (lineItem?.id == null) {
    throw new Error(`Direct cost ${directCostId} has a line item with no id — cannot bill it individually.`);
  }
  return `${directCostId}:${lineItem.id}`;
}

// Flattens computeDirectCostLines' per-DC `lineItems` (each an aggregate of
// possibly several real line items) into one billing_records row per REAL
// line item — shared by every direct-cost/combined push+generate function so
// they can't drift on this. Each row's own amount is its own line's real
// dollar value marked up individually (not an even split of the DC's
// aggregate `amount`) — sums back to the aggregate modulo independent
// per-line rounding, same acceptable tolerance T&M's own per-timecard
// amounts already have. Caller adds tenantId/projectId/status/etc.
function dcBillingRows(lineItems) {
  return lineItems.flatMap(line =>
    line.rawLines.map(raw => ({
      recordType: 'direct_cost_line',
      procoreRecordId: dcLineReconciliationKey(line.directCostId, raw),
      amount: Math.round(Number(raw.amount ?? 0) * (1 + line.markupPercent / 100) * 100) / 100
    }))
  );
}

// Writes many billing_records rows in ONE statement instead of one dbQuery
// per row. Proven live 2026-09-14: a 28-timecard push hit Cloudflare's
// per-invocation subrequest limit right AFTER Procore was already fully and
// correctly updated (real CE + CO + all 28 lines) — the sequential inserts
// died partway, leaving 17 of 28 timecards looking "unbilled" to LEDGER while
// they were already sitting on a real Procore Change Order. That's a live
// double-billing risk (nothing stops a second push of the same timecards),
// not just a cosmetic gap. One multi-row INSERT removes N-1 of those
// subrequests regardless of batch size.
// `recordType` defaults to 'timecard' (T&M's own longstanding caller never
// had to pass it) — generalized 2026-09-16 for direct-cost billing, which
// passes 'direct_cost' explicitly. Schema already had both values in its
// check constraint from day one (db/schema.sql), just never wired up.
// Returns the inserted rows' ids, in the same order as `rows` — Postgres
// preserves input order for a multi-row INSERT's RETURNING — so a caller that
// also needs a second, linked insert (write-offs, below) can zip them back
// together without a round trip per row.
async function insertBillingRecordsBatch(env, rows) {
  if (rows.length === 0) return [];
  const cols = [
    'tenant_id', 'project_id', 'record_type', 'procore_record_id', 'invoice_id', 'invoice_number',
    'amount_billed', 'status', 'write_off_reason', 'reconciled_by', 'change_order_id', 'change_event_id',
    'is_estimated', 'source_timecard_key', 'billed_outside_ledger'
  ];
  const values = [];
  const params = [];
  rows.forEach((row, i) => {
    const base = i * cols.length;
    values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`);
    params.push(
      row.tenantId, row.projectId, row.recordType || 'timecard', row.procoreRecordId,
      row.invoiceId ?? null, row.invoiceNumber ?? null, row.amount, row.status, row.writeOffReason ?? null,
      row.reconciledBy, row.changeOrderId ?? null, row.changeEventId ?? null,
      row.isEstimated === true, // Commitments only — everything else defaults false, matching the DB column default
      row.sourceTimecardKey ?? null,
      row.billedOutsideLedger === true
    );
  });
  const inserted = await dbQuery(
    env,
    `insert into billing_records (${cols.join(', ')}) values ${values.join(', ')} returning id`,
    params
  );
  return inserted.map(r => r.id);
}

// Batch insert into the write_offs audit table (db/schema.sql) — one row per
// written-off billing_records row, linked via billing_record_id. Same
// one-multi-row-INSERT-instead-of-N discipline as insertBillingRecordsBatch.
async function insertWriteOffsBatch(env, rows) {
  if (rows.length === 0) return;
  const cols = [
    'billing_record_id', 'tenant_id', 'project_id', 'reason_category', 'reason_notes', 'written_off_by', 'amount'
  ];
  const values = [];
  const params = [];
  rows.forEach((row, i) => {
    const base = i * cols.length;
    values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`);
    params.push(
      row.billingRecordId, row.tenantId, row.projectId, row.reasonCategory, row.reasonNotes ?? null,
      row.writtenOffBy, row.amount
    );
  });
  await dbQuery(env, `insert into write_offs (${cols.join(', ')}) values ${values.join(', ')}`, params);
}

// Self-heals billing_records when a PM deletes a draft Change Order directly
// in Procore instead of (or in addition to) any LEDGER action — added
// 2026-09-14 after exactly that happened. Deliberately 'draft_co' ONLY —
// widened to also cover 'billed' rows the same day, then reverted minutes
// later after it wrongly nuked a real, valid invoice: once a Change Order is
// approved+executed (every 'billed' row's CO is, by the time generateInvoice
// finishes), Procore's `GET .../prime_change_orders` list stops returning it
// at all — same for the linked change_event and its payment_application in
// their own list endpoints. There's no confirmed way yet to positively check
// "is this executed CO still real" via a list call, so an executed CO not
// appearing there is NOT evidence it was deleted — don't treat it as such.
// 'draft_co' stays safe to check this way because a draft is never executed.
async function reconcileStaleDraftCOs(env, tenantId, projectId) {
  const rows = await dbQuery(
    env,
    `select distinct change_order_id from billing_records
     where tenant_id = $1 and project_id = $2 and status = 'draft_co' and change_order_id is not null`,
    [tenantId, projectId]
  );
  if (rows.length === 0) return 0;

  const { status, data } = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/prime_change_orders`);
  if (status !== 200) return 0; // can't confirm either way — leave existing rows alone rather than guess
  const liveIds = new Set(data.map(co => String(co.id)));

  const staleCoIds = rows.map(r => r.change_order_id).filter(id => !liveIds.has(String(id)));
  if (staleCoIds.length === 0) return 0;

  const deleted = await dbQuery(
    env,
    `delete from billing_records
     where tenant_id = $1 and project_id = $2 and status = 'draft_co' and change_order_id = any($3::text[])
     returning id`,
    [tenantId, projectId, staleCoIds]
  );
  return deleted.length;
}

// Deletes the write_offs row(s) for whichever billing_records ids are about
// to be reverted, BEFORE deleting those billing_records rows — write_offs.
// billing_record_id is a plain FK with no ON DELETE clause (db/schema.sql),
// so deleting the parent row first would fail with a foreign-key violation
// on any row that was actually written off. Harmless no-op when none of the
// ids were ever written off (a DELETE matching zero rows is not an error).
async function deleteLinkedWriteOffs(env, billingRecordIds) {
  if (billingRecordIds.length === 0) return;
  await dbQuery(env, `delete from write_offs where billing_record_id = any($1::uuid[])`, [billingRecordIds]);
}

// Manual fallback for the same problem, for whenever a PM wants to undo a
// push without necessarily having a tracked change_order_id to auto-detect
// against (rows written before that column existed), or wants to undo
// something Procore hasn't been told about yet. `includeBilled` widens it to
// an already-invoiced row too — real case 2026-09-14 (T&M #5: PM deleted the
// invoice in Procore directly) — defaulting it off keeps the normal "Undo
// draft push" UI button from ever touching a real invoice by accident.
// `includeWrittenOff` (Ben's ask 2026-09-17) does the same for a written-off
// row — "Undo write-off" always passes it, everything else leaves it off.
export async function revertToUnbilled(env, { tenantId, projectId, entryId, includeBilled = false, includeWrittenOff = false, includeBudgeted = false, includeBilledOutside = false }) {
  const entryRes = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_entries/${entryId}`);
  if (entryRes.status !== 200) {
    throw new Error(`Failed to fetch T&M entry: ${entryRes.status} ${JSON.stringify(entryRes.data)}`);
  }
  const tcRes = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_timecards`);
  if (tcRes.status !== 200) {
    throw new Error(`Failed to fetch timecards: ${tcRes.status} ${JSON.stringify(tcRes.data)}`);
  }
  const keys = tcRes.data
    .filter(tc => tc.time_and_material_entry?.id === entryRes.data.id)
    .map(reconciliationKey);
  if (keys.length === 0) return { reverted: 0 };

  const statuses = [
    'draft_co',
    ...(includeBilled ? ['billed'] : []),
    ...(includeWrittenOff ? ['written_off'] : []),
    ...(includeBudgeted ? ['reconciled_to_period'] : [])
  ];
  const matches = await dbQuery(
    env,
    `select id from billing_records
     where tenant_id = $1 and project_id = $2 and record_type = 'timecard'
       and (status = any($4::text[]) or ($5 and status = 'billed' and billed_outside_ledger))
       and procore_record_id = any($3::text[])`,
    [tenantId, projectId, keys, statuses, includeBilledOutside]
  );
  if (matches.length === 0) return { reverted: 0 };
  const ids = matches.map(m => m.id);
  await deleteLinkedWriteOffs(env, ids);
  await dbQuery(env, `delete from billing_records where id = any($1::uuid[])`, [ids]);
  return { reverted: ids.length };
}

// Direct costs' own revert — they'd never had ANY undo path until now (not
// even for a draft push), unlike T&M. Matches BOTH the legacy whole-DC rows
// (record_type='direct_cost', procore_record_id = the DC's own id) AND any
// per-line rows (record_type='direct_cost_line', 2026-09-22 — see
// dcLineReconciliationKey above) belonging to this DC, via a "<directCostId>:"
// prefix match — same resolve-parent-to-children shape revertToUnbilled uses
// for T&M's entry->timecard-key resolution, just done in SQL instead of a
// separate fetch since a DC's own id already IS the prefix, no extra Procore
// call needed to find it. A PM undoing a DC therefore always gets everything
// billed against it back to Unbilled in one action, regardless of which
// scheme wrote it.
export async function revertDirectCost(env, { tenantId, projectId, directCostId, includeBilled = false, includeWrittenOff = false, includeBudgeted = false, includeBilledOutside = false }) {
  const statuses = [
    'draft_co',
    ...(includeBilled ? ['billed'] : []),
    ...(includeWrittenOff ? ['written_off'] : []),
    ...(includeBudgeted ? ['reconciled_to_period'] : [])
  ];
  const matches = await dbQuery(
    env,
    `select id from billing_records
     where tenant_id = $1 and project_id = $2
       and (status = any($4::text[]) or ($5 and status = 'billed' and billed_outside_ledger))
       and (
         (record_type = 'direct_cost' and procore_record_id = $3)
         or (record_type = 'direct_cost_line' and procore_record_id like $3 || ':%')
       )`,
    [tenantId, projectId, String(directCostId), statuses, includeBilledOutside]
  );
  if (matches.length === 0) return { reverted: 0 };
  const ids = matches.map(m => m.id);
  await deleteLinkedWriteOffs(env, ids);
  await dbQuery(env, `delete from billing_records where id = any($1::uuid[])`, [ids]);
  return { reverted: ids.length };
}

// Commitments' undo — mirrors revertDirectCost: every commitment_line row for
// this commitment (prefix match on "<commitmentId>:") in the chosen statuses
// goes back to Unbilled. Undoing an estimated bill also lifts the
// is_estimated lock, since the lock lives on those same rows.
export async function revertCommitment(env, { tenantId, projectId, commitmentId, includeBilled = false, includeWrittenOff = false, includeBudgeted = false, includeBilledOutside = false }) {
  const statuses = [
    'draft_co',
    ...(includeBilled ? ['billed'] : []),
    ...(includeWrittenOff ? ['written_off'] : []),
    ...(includeBudgeted ? ['reconciled_to_period'] : [])
  ];
  const matches = await dbQuery(
    env,
    `select id from billing_records
     where tenant_id = $1 and project_id = $2
       and (status = any($4::text[]) or ($5 and status = 'billed' and billed_outside_ledger))
       and record_type = 'commitment_line' and procore_record_id like $3 || ':%'`,
    [tenantId, projectId, String(commitmentId), statuses, includeBilledOutside]
  );
  if (matches.length === 0) return { reverted: 0 };
  const ids = matches.map(m => m.id);
  await deleteLinkedWriteOffs(env, ids);
  await dbQuery(env, `delete from billing_records where id = any($1::uuid[])`, [ids]);
  return { reverted: ids.length };
}

// region -> time_type -> bill_rate, project override taking precedence over
// the tenant-wide default (project_id is null).
async function getRateLookup(env, tenantId, projectId) {
  const rows = await dbQuery(
    env,
    `select region, time_type, bill_rate, project_id from labour_rates
     where tenant_id = $1 and (project_id = $2 or project_id is null)
     order by project_id nulls last`,
    [tenantId, projectId]
  );
  const lookup = {};
  for (const row of rows) {
    const key = `${row.region}|${row.time_type}`;
    // First row wins per key since project-specific rows were NOT sorted last —
    // "order by project_id nulls last" puts the override (non-null) FIRST.
    if (!(key in lookup)) lookup[key] = Number(row.bill_rate);
  }
  return lookup;
}

// NOTE: region is hardcoded to 'Default' for now — LEDGER has no resolved way
// yet to know which region a given project is in (open question from the
// intake sheet, never answered). Safe today because every region currently
// carries the identical rate ($80/$120/$160/$50); revisit once that's decided.
const REGION_PLACEHOLDER = 'Default';

// Procore's own project-type vocabulary (confirmed live 2026-09-10 against all
// 567 Einbau projects) mapped to LEDGER's billing mode. See the
// project-billing-mode memory for the full reasoning behind this split:
//   'tm'           — every timecard must be individually billed; an unlinked
//                    timecard is a real flag (a billing leak).
//   'fixed_price'  — base labour is absorbed into the quoted SOV, not tracked
//                    here. T&M tickets are genuine change work, still billed,
//                    but an unlinked timecard on one is normal, not a red flag.
//   'non_billable' — Overhead / Warranty. Not billed to a client at all.
const PROJECT_TYPE_TO_MODE = {
  'Time & Material': 'tm',
  'Service Call': 'tm',
  'Contract': 'fixed_price',
  'Overhead': 'non_billable',
  'Warranty': 'non_billable'
};

// The project's own type, straight from Procore. The `?company_id=` query
// param is required on this endpoint — without it, it 400s (confirmed live;
// see api-directory/README.md). Null if the project has no type set.
async function getProjectType(env, projectId) {
  return (await getProjectInfo(env, projectId)).typeName;
}

async function getProjectInfo(env, projectId) {
  const { status, data } = await procoreRequest(
    env, 'GET', `/rest/v1.0/projects/${projectId}?company_id=${env.PROCORE_COMPANY_ID}`
  );
  if (status !== 200) return { typeName: null, createdAt: null };
  return { typeName: data.project_type?.name || null, createdAt: data.created_at || null };
}

// Projects created before this date predate the automations that keep
// budget codes and subcontractor timecards traceable (Einvoice launches
// around then — Ben, 2026-09-24). LEDGER can't detect double-billing on
// commitments for them, so the frontend shows a blanket review-first warning
// instead of the standard labour guardrails. Unknown creation date counts as
// legacy — the warning is the safer default.
const LEGACY_PROJECT_CUTOFF = '2026-10-11';

async function isLegacyProject(env, projectId) {
  const { createdAt } = await getProjectInfo(env, projectId);
  return { legacyProject: !createdAt || createdAt.slice(0, 10) < LEGACY_PROJECT_CUTOFF, projectCreatedAt: createdAt };
}

async function getProjectModeOverride(env, tenantId, projectId) {
  const rows = await dbQuery(
    env,
    `select billing_mode from project_settings where tenant_id = $1 and project_id = $2`,
    [tenantId, projectId]
  );
  return rows[0]?.billing_mode || null;
}

// Resolves which billing mode governs a project: a PM override in
// project_settings wins if one exists; otherwise derive it from Procore's own
// project_type; otherwise (no type set, or an unrecognized one — 27 of 567
// projects have no type) default to 'tm', the fullest and safest behaviour —
// nothing billable slips through unflagged. A PM can always override down to
// 'fixed_price' or 'non_billable' if that default is wrong for a project.
export async function resolveBillingMode(env, { tenantId, projectId }) {
  const [override, projectTypeName] = await Promise.all([
    getProjectModeOverride(env, tenantId, projectId),
    getProjectType(env, projectId)
  ]);
  const derivedMode = projectTypeName ? (PROJECT_TYPE_TO_MODE[projectTypeName] || null) : null;
  const mode = override || derivedMode || 'tm';
  return {
    mode,
    source: override ? 'override' : (derivedMode ? 'project_type' : 'default'),
    projectTypeName
  };
}

// PM sets (or clears, with billingMode 'auto'/null) an explicit per-project
// override. Returns the freshly resolved mode so the caller can display it
// immediately without a second round trip.
export async function setProjectBillingMode(env, { tenantId, projectId, billingMode, userId }) {
  if (!billingMode || billingMode === 'auto') {
    // Clears just the override — the row may also hold other project settings.
    await dbQuery(
      env,
      `update project_settings set billing_mode = null, updated_by = $3, updated_at = now()
       where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId, userId || 'ledger-system']
    );
  } else {
    if (!['tm', 'fixed_price', 'non_billable'].includes(billingMode)) {
      throw new Error(`Invalid billing_mode: ${billingMode}`);
    }
    await dbQuery(
      env,
      `insert into project_settings (tenant_id, project_id, billing_mode, updated_by)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, project_id)
       do update set billing_mode = excluded.billing_mode, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, projectId, billingMode, userId || 'ledger-system']
    );
  }
  return await resolveBillingMode(env, { tenantId, projectId });
}

// ============================================================
// Project Settings (spec agreed with Ben 2026-09-24) — per-project defaults
// that pre-fill the Configure screen. Null/blank always means "use the
// company default". Company defaults themselves stay DB-only for now (no
// admin screen): labour_rates rows with project_id null, and the constants
// below.
// ============================================================

const COMPANY_DEFAULTS = {
  dcMarkupPercent: 20,
  cmMarkupPercent: 20,
  tmGroupBy: 'worker_type',
  dcGroupBy: 'per_dc',
  cmGroupBy: 'per_commitment'
};
const TM_GROUP_BY_VALUES = ['worker_type', 'timecard', 'ticket_type', 'type', 'total'];
const DC_GROUP_BY_VALUES = ['per_dc', 'per_line_item', 'total'];
const CM_GROUP_BY_VALUES = ['per_commitment', 'per_line_item', 'total'];
const RATE_TIME_TYPES = ['regular', 'overtime', 'double_time', 'per_diem'];

export async function getProjectSettings(env, { tenantId, projectId }) {
  const [rows, rateRows, billing] = await Promise.all([
    dbQuery(env, `select * from project_settings where tenant_id = $1 and project_id = $2`, [tenantId, projectId]),
    dbQuery(
      env,
      `select time_type, bill_rate, project_id from labour_rates
       where tenant_id = $1 and region = $3 and (project_id = $2 or project_id is null)`,
      [tenantId, projectId, REGION_PLACEHOLDER]
    ),
    resolveBillingMode(env, { tenantId, projectId })
  ]);
  const row = rows[0] || {};
  const num = (v) => (v == null ? null : Number(v));
  const rates = {};
  for (const tt of RATE_TIME_TYPES) {
    const company = rateRows.find(r => r.time_type === tt && r.project_id == null);
    const project = rateRows.find(r => r.time_type === tt && r.project_id != null);
    rates[tt] = { company: num(company?.bill_rate), project: num(project?.bill_rate) };
  }
  return {
    billingMode: billing.mode,
    billingModeSource: billing.source,
    billingModeOverride: row.billing_mode || null,
    projectTypeName: billing.projectTypeName,
    rates,
    dcMarkupPercent: num(row.dc_markup_percent),
    cmMarkupPercent: num(row.cm_markup_percent),
    tmGroupBy: row.tm_group_by || null,
    dcGroupBy: row.dc_group_by || null,
    cmGroupBy: row.cm_group_by || null,
    defaultPrimeContractId: row.default_prime_contract_id || null,
    companyDefaults: COMPANY_DEFAULTS,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null
  };
}

// Whole-form save: every field in `settings` is written as given (null/''
// clears it back to the company default). Rates: { regular: 85 | null, ... }.
export async function saveProjectSettings(env, { tenantId, projectId, userId, settings = {} }) {
  const blank = (v) => v === null || v === undefined || v === '';
  const markup = (v, label) => {
    if (blank(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error(`Invalid ${label}: ${v}`);
    return n;
  };
  const oneOf = (v, allowed, label) => {
    if (blank(v)) return null;
    if (!allowed.includes(v)) throw new Error(`Invalid ${label}: ${v}`);
    return v;
  };
  const billingMode = blank(settings.billingMode) || settings.billingMode === 'auto'
    ? null : oneOf(settings.billingMode, ['tm', 'fixed_price', 'non_billable'], 'billing mode');
  const values = [
    billingMode,
    markup(settings.dcMarkupPercent, 'direct cost markup'),
    markup(settings.cmMarkupPercent, 'commitment markup'),
    oneOf(settings.tmGroupBy, TM_GROUP_BY_VALUES, 'T&M grouping'),
    oneOf(settings.dcGroupBy, DC_GROUP_BY_VALUES, 'direct cost grouping'),
    oneOf(settings.cmGroupBy, CM_GROUP_BY_VALUES, 'commitment grouping'),
    blank(settings.defaultPrimeContractId) ? null : String(settings.defaultPrimeContractId)
  ];
  const rates = {};
  for (const tt of RATE_TIME_TYPES) {
    const v = settings.rates?.[tt];
    if (blank(v)) { rates[tt] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${tt} rate: ${v}`);
    rates[tt] = n;
  }

  const actor = userId || 'ledger-system';
  await dbQuery(
    env,
    `insert into project_settings
       (tenant_id, project_id, billing_mode, dc_markup_percent, cm_markup_percent, tm_group_by, dc_group_by, cm_group_by,
        default_prime_contract_id, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (tenant_id, project_id) do update set
       billing_mode = excluded.billing_mode, dc_markup_percent = excluded.dc_markup_percent,
       cm_markup_percent = excluded.cm_markup_percent, tm_group_by = excluded.tm_group_by,
       dc_group_by = excluded.dc_group_by, cm_group_by = excluded.cm_group_by,
       default_prime_contract_id = excluded.default_prime_contract_id,
       updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, projectId, ...values, actor]
  );

  for (const [tt, rate] of Object.entries(rates)) {
    if (rate == null) {
      await dbQuery(
        env,
        `delete from labour_rates where tenant_id = $1 and project_id = $2 and region = $3 and time_type = $4`,
        [tenantId, projectId, REGION_PLACEHOLDER, tt]
      );
    } else {
      await dbQuery(
        env,
        `insert into labour_rates (tenant_id, project_id, region, time_type, bill_rate, set_by_user_id, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (tenant_id, coalesce(project_id, ''), region, time_type)
         do update set bill_rate = excluded.bill_rate, set_by_user_id = excluded.set_by_user_id, updated_at = now()`,
        [tenantId, projectId, REGION_PLACEHOLDER, tt, rate, actor]
      );
    }
  }
  return getProjectSettings(env, { tenantId, projectId });
}

// Normalizes the two shapes the router accepts — entry_id (single) or
// entry_ids (array) — into a de-duped array of string ids.
function normalizeEntryIds(entryId, entryIds) {
  const raw = (Array.isArray(entryIds) && entryIds.length)
    ? entryIds
    : (entryId != null ? [entryId] : []);
  const ids = [...new Set(raw.map(String).filter(Boolean))];
  if (ids.length === 0) throw new Error('entry_id or entry_ids is required');
  return ids;
}

// Same normalization as normalizeEntryIds, but for the two single-source DC
// functions below — a selection can now be satisfied by whole-DC ids ALONE,
// line ids ALONE, or both together (2026-09-22, per-line billing), so it
// can't reuse normalizeEntryIds' "at least one of these two must be
// non-empty" check unchanged (a line-only request has directCostId/
// directCostIds both empty on purpose).
function normalizeDcIds(directCostId, directCostIds) {
  const raw = (Array.isArray(directCostIds) && directCostIds.length)
    ? directCostIds
    : (directCostId != null ? [directCostId] : []);
  return [...new Set(raw.map(String).filter(Boolean))];
}

// Human label for one or many tickets, used as the Change Event / Change Order
// title so a reviewer in Procore can see what it covers at a glance.
function ticketLabel(numbers) {
  if (numbers.length === 1) return `T&M Ticket #${numbers[0]}`;
  if (numbers.length <= 5) return `T&M Tickets ${numbers.map(n => `#${n}`).join(', ')}`;
  return `T&M Tickets ${numbers.slice(0, 4).map(n => `#${n}`).join(', ')} +${numbers.length - 4} more`;
}

// { tenant_id, project_id } -> every T&M entry on the project, each split into
// its unbilled timecard lines (still actionable) and its billed / draft-CO
// lines (history), with dollar totals for both. The frontend's "Unbilled" and
// "Billed" tabs are both rendered from this one response.
export async function listPendingTickets(env, { tenantId, projectId }) {
  // Self-heal first — if a PM deleted a draft CO directly in Procore, the
  // billing_records rows for it need to disappear before we compute what's
  // billed vs. unbilled below, or the ticket stays wrongly "billed" forever.
  await reconcileStaleDraftCOs(env, tenantId, projectId);

  const [entriesRes, timecardsRes, billedMap, rates, billingMode] = await Promise.all([
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_entries`, null),
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_timecards`, null),
    getBilledTimecardMap(env, tenantId, projectId),
    getRateLookup(env, tenantId, projectId),
    resolveBillingMode(env, { tenantId, projectId })
  ]);

  if (entriesRes.status !== 200) {
    throw new Error(`Failed to list T&M entries: ${entriesRes.status} ${JSON.stringify(entriesRes.data)}`);
  }
  if (timecardsRes.status !== 200) {
    throw new Error(`Failed to list timecards: ${timecardsRes.status} ${JSON.stringify(timecardsRes.data)}`);
  }

  const timecardsByEntry = {};
  for (const tc of timecardsRes.data) {
    const entryId = tc.time_and_material_entry?.id;
    if (!entryId) continue;
    (timecardsByEntry[entryId] ||= []).push(tc);
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  const tickets = entriesRes.data.map(entry => {
    const allTimecards = timecardsByEntry[entry.id] || [];

    const unbilledLines = [];
    const billedLines = [];
    const writtenOffLines = [];
    const budgetedLines = [];
    for (const tc of allTimecards) {
      const key = reconciliationKey(tc);
      const timeType = TIME_TYPE_MAP[tc.timecard_time_type?.time_type] || 'regular';
      const rate = rates[`${REGION_PLACEHOLDER}|${timeType}`] ?? null;
      const hours = Number(tc.hours_worked);
      const billed = billedMap.get(key);
      // Billed lines use the REAL amount_billed from billing_records, not a
      // live recompute off the current default rate table — found live
      // 2026-09-14: a rate override only ever applies to that one build, so
      // recomputing later with the default rate silently disagreed with what
      // Procore actually got billed for. Same fix for `rate` (amount/hours)
      // so the displayed rate matches what was really charged too.
      const amount = billed && billed.amount != null ? billed.amount : (rate !== null ? round2(rate * hours) : null);
      const line = {
        timecardEntryId: key,
        workerName: tc.party?.name || 'Unknown',
        timeType,
        hours,
        rate: billed && billed.amount != null && hours > 0 ? round2(billed.amount / hours) : rate,
        amount,
        // No timecard_entry_id means this T&M timecard line isn't linked to an
        // actual submitted timecard in Procore's timesheet system — billable,
        // but nothing on the timesheet side to reconcile against yet.
        hasTimecard: tc.timecard_entry_id != null
      };
      // 'written_off' and 'reconciled_to_period' ("Budgeted", Ben's ask
      // 2026-09-21) each get their own bucket — both used to land in
      // billedLines with no real frontend handling, mislabeled "invoiced".
      if (billed?.status === 'written_off') {
        // invoiceNumber (Ben's ask 2026-09-23) — only meaningful for the
        // 'already_billed' reason ("this was already invoiced elsewhere, not
        // through LEDGER") but stored as a plain optional field on
        // billing_records the same way a real 'billed' row already uses it,
        // so no schema change was needed — see writeOffRecords below.
        writtenOffLines.push({ ...line, reasonCategory: billed.reasonCategory, reasonNotes: billed.reasonNotes, invoiceNumber: billed.invoiceNumber });
      } else if (billed?.status === 'reconciled_to_period') {
        budgetedLines.push({ ...line, reasonNotes: billed.reasonNotes });
      } else if (billed) {
        billedLines.push({
          ...line,
          billedStatus: billed.status,          // 'billed' | 'draft_co'
          invoiceNumber: billed.invoiceNumber,
          invoiceId: billed.invoiceId,
          billedOutsideLedger: billed.billedOutsideLedger === true
        });
      } else {
        unbilledLines.push(line);
      }
    }

    const estimatedTotal = round2(unbilledLines.reduce((s, l) => s + (l.amount || 0), 0));
    const billedAmount = round2(billedLines.reduce((s, l) => s + (l.amount || 0), 0));
    const writtenOffAmount = round2(writtenOffLines.reduce((s, l) => s + (l.amount || 0), 0));
    const budgetedAmount = round2(budgetedLines.reduce((s, l) => s + (l.amount || 0), 0));
    const invoiceNumbers = [...new Set(
      billedLines.filter(l => l.billedStatus === 'billed' && l.invoiceNumber).map(l => l.invoiceNumber)
    )];

    return {
      id: entry.id,
      number: entry.number,
      description: entry.description,
      status: entry.status,
      workPerformedOnDate: entry.work_performed_on_date,
      totalTimecards: allTimecards.length,
      unbilledCount: unbilledLines.length,
      unbilledLines,
      unlinkedCount: unbilledLines.filter(l => !l.hasTimecard).length,
      estimatedTotal,
      billedCount: billedLines.length,
      billedLines,
      billedAmount,
      invoiceNumbers,
      hasDraftCO: billedLines.some(l => l.billedStatus === 'draft_co'),
      billedOutsideLedgerCount: billedLines.filter(l => l.billedOutsideLedger).length,
      writtenOffCount: writtenOffLines.length,
      writtenOffLines,
      writtenOffAmount,
      budgetedCount: budgetedLines.length,
      budgetedLines,
      budgetedAmount
    };
  });

  return {
    billingMode: billingMode.mode,
    billingModeSource: billingMode.source,   // 'override' | 'project_type' | 'default'
    projectTypeName: billingMode.projectTypeName,
    tickets
  };
}

// Full detail for one T&M ticket — powers the frontend's pop-out modal. Unlike
// listPendingTickets this returns EVERY timecard (billed + draft + unbilled),
// each tagged with its billing status, plus attachments and a totals breakdown.
export async function ticketDetail(env, { tenantId, projectId, entryId }) {
  await reconcileStaleDraftCOs(env, tenantId, projectId);

  const [entryRes, tcRes, billedMap, rates] = await Promise.all([
    procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_entries/${entryId}`),
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_timecards`, null),
    getBilledTimecardMap(env, tenantId, projectId),
    getRateLookup(env, tenantId, projectId)
  ]);
  if (entryRes.status !== 200) {
    throw new Error(`Failed to fetch T&M entry: ${entryRes.status} ${JSON.stringify(entryRes.data)}`);
  }
  if (tcRes.status !== 200) {
    throw new Error(`Failed to fetch timecards: ${tcRes.status} ${JSON.stringify(tcRes.data)}`);
  }
  const entry = entryRes.data;
  const timecards = tcRes.data.filter(tc => tc.time_and_material_entry?.id === entry.id);

  const lines = timecards.map(tc => {
    const key = reconciliationKey(tc);
    const timeType = TIME_TYPE_MAP[tc.timecard_time_type?.time_type] || 'regular';
    const rate = rates[`${REGION_PLACEHOLDER}|${timeType}`] ?? null;
    const hours = Number(tc.hours_worked);
    const billed = billedMap.get(key) || null;
    // Same fix as listPendingTickets: a billed line's real amount is
    // whatever billing_records actually recorded (may reflect a one-off
    // rate override), not a live recompute off the current default rate.
    const amount = billed && billed.amount != null ? billed.amount : (rate != null ? Math.round(rate * hours * 100) / 100 : null);
    return {
      timecardEntryId: key,
      workerName: tc.party?.name || 'Unknown',
      classification: tc.work_classification?.name || null,
      timeType,
      timeTypeLabel: tc.timecard_time_type?.time_type || timeType,
      hours,
      rate: billed && billed.amount != null && hours > 0 ? Math.round((billed.amount / hours) * 100) / 100 : rate,
      amount,
      hasTimecard: tc.timecard_entry_id != null,
      billedStatus: billed ? billed.status : null,   // 'billed' | 'draft_co' | null
      invoiceNumber: billed ? billed.invoiceNumber : null
    };
  });

  const sumWhere = (pred) =>
    Math.round(lines.filter(pred).reduce((s, l) => s + (l.amount || 0), 0) * 100) / 100;

  const attachments = (entry.time_and_material_entry_attachments || entry.attachments || [])
    .map(a => ({
      filename: a.filename || a.name || 'attachment',
      url: a.url || a.file_url || null,
      thumbnailUrl: a.thumbnail_url || null
    }))
    .filter(a => a.url);

  return {
    id: entry.id,
    number: entry.number,
    description: entry.description || '',
    status: entry.status || null,
    workPerformedOnDate: entry.work_performed_on_date || null,
    createdAt: entry.created_at || null,
    changeEventId: entry.change_event?.id || null,
    lines,
    attachments,
    totals: {
      total: sumWhere(() => true),
      billed: sumWhere(l => l.billedStatus === 'billed'),
      draft: sumWhere(l => l.billedStatus === 'draft_co'),
      unbilled: sumWhere(l => !l.billedStatus)
    }
  };
}

async function findWbsCodeIds(env, projectId) {
  const { status, data } = await procoreRequest(
    env, 'GET',
    `/rest/v1.0/projects/${projectId}/work_breakdown_structure/wbs_codes?query=49-04`
  );
  if (status !== 200) {
    throw new Error(`Failed to look up WBS codes: ${status} ${JSON.stringify(data)}`);
  }

  // Match on the stable standard_cost_code_id of the Cost Code segment, not the
  // project-scoped id (which differs per project) — see reference_infrastructure
  // memory on why. Each wbs_codes entry's segment_items includes both a
  // 'cost_code' segment and a 'line_item_type' segment; we want the ".L" (Labor) combo.
  const byTimeType = {};
  for (const combo of data) {
    const costCodeSegment = combo.segment_items?.find(s => s.segment?.type === 'cost_code');
    const lineItemSegment = combo.segment_items?.find(s => s.segment?.type === 'line_item_type');
    if (!costCodeSegment || lineItemSegment?.code !== 'L') continue;

    for (const [timeType] of Object.entries(STANDARD_COST_CODE_BY_TIME_TYPE)) {
      // costCodeSegment.id here is the project-scoped cost_codes id, not the
      // standard one — but wbs_codes search results don't carry standard_cost_code_id
      // directly, so match on flat_code instead, which is stable in content (just
      // not in id) across projects: "49-04-01.L", "49-04-02.L", "49-04-03.L".
      const expectedSuffix = { regular: '49-04-01.L', overtime: '49-04-02.L', double_time: '49-04-03.L' }[timeType];
      if (combo.flat_code === expectedSuffix) {
        byTimeType[timeType] = combo.id;
      }
    }
  }
  return byTimeType;
}

async function findPrimeContracts(env, projectId) {
  const { status, data } = await procoreRequest(env, 'GET', `/rest/v1.0/prime_contracts?project_id=${projectId}`);
  if (status !== 200) {
    throw new Error(`Failed to list prime contracts: ${status} ${JSON.stringify(data)}`);
  }
  return data.map(c => ({
    id: c.id, title: c.title || null, number: c.number || null, status: c.status,
    accountingMethod: c.accounting_method || null
  }));
}

// Exported for the frontend's invoice-number field — the highest existing
// invoice_number across every Prime Contract on the PROJECT (Ben's ask
// 2026-09-14: sequential "at the project level", not per-contract), plus 1.
// Only purely-numeric invoice_numbers count toward "biggest" — LEDGER's own
// prior scheme ("LEDGER-T5+6-1789368228392") and any other non-numeric native
// ones are ignored rather than breaking the parse. Defaults to 1 when there's
// nothing numeric yet (a project with only LEDGER-style numbers so far, or no
// invoices at all).
export async function nextInvoiceNumber(env, { projectId }) {
  const contracts = await findPrimeContracts(env, projectId);
  let max = 0;
  for (const c of contracts) {
    const { status, data } = await procoreRequest(
      env, 'GET', `/rest/v1.0/prime_contracts/${c.id}/payment_applications?project_id=${projectId}&per_page=300`
    );
    if (status !== 200) continue;
    for (const inv of data) {
      if (/^\d+$/.test(String(inv.invoice_number).trim())) {
        max = Math.max(max, Number(inv.invoice_number));
      }
    }
  }
  return max + 1;
}

// Exported for the frontend's contract picker — every prime contract on the
// project, not just the auto-picked Approved one.
export async function listPrimeContracts(env, { projectId }) {
  return await findPrimeContracts(env, projectId);
}

async function findBillableContract(env, projectId) {
  const contracts = await findPrimeContracts(env, projectId);
  // First executed, approved contract that allows payment applications. Good enough
  // when there's only one live contract; a project with several needs the PM to
  // choose explicitly via primeContractId (the frontend's contract picker sends it).
  const candidate = contracts.find(c => c.status === 'Approved');
  if (!candidate) throw new Error('No Approved Prime Contract found on this project');
  return candidate.id;
}

// Exported for the frontend's billing-period picker — same reasoning as
// listPrimeContracts: an auto-pick is fine when there's one obvious answer,
// ambiguous otherwise, and worth letting the PM see/choose explicitly since
// a wrong or missing period silently blocks invoicing entirely (see below).
export async function listBillingPeriods(env, { projectId }) {
  const { status, data } = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/billing_periods`);
  if (status !== 200) {
    throw new Error(`Failed to list billing periods: ${status} ${JSON.stringify(data)}`);
  }
  return data.map(p => ({ id: p.id, startDate: p.start_date, endDate: p.end_date, status: p.status }));
}

// `billingPeriodId`: use this exact period (from the frontend's picker) —
// throws if it's not real, rather than silently falling back, since that'd
// bill against a period the PM didn't choose. `newPeriod`: create one with
// these dates instead of defaulting to today (also from the picker, "create
// new"). Neither given → old behavior: the open period, or one dated today.
async function findOrCreateBillingPeriod(env, projectId, billingPeriodId, newPeriod) {
  const { status, data } = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/billing_periods`);
  if (status !== 200) {
    throw new Error(`Failed to list billing periods: ${status} ${JSON.stringify(data)}`);
  }

  if (billingPeriodId) {
    const match = data.find(p => String(p.id) === String(billingPeriodId));
    if (!match) throw new Error(`Billing period ${billingPeriodId} not found on this project`);
    return match;
  }

  if (newPeriod) {
    const created = await procoreRequest(env, 'POST', `/rest/v1.0/projects/${projectId}/billing_periods`, {
      billing_period: {
        start_date: newPeriod.startDate, end_date: newPeriod.endDate,
        due_date: newPeriod.dueDate || newPeriod.endDate
      }
    });
    if (created.status !== 201) {
      throw new Error(`Failed to create billing period: ${created.status} ${JSON.stringify(created.data)}`);
    }
    return created.data;
  }

  const open = data.find(p => p.status === 'open');
  if (open) return open;

  const today = new Date().toISOString().slice(0, 10);
  const created = await procoreRequest(env, 'POST', `/rest/v1.0/projects/${projectId}/billing_periods`, {
    billing_period: { start_date: today, end_date: today, due_date: today }
  });
  if (created.status !== 201) {
    throw new Error(`Failed to create billing period: ${created.status} ${JSON.stringify(created.data)}`);
  }
  return created.data;
}

// Fetches the selected T&M entries plus the project's timecards, filtered to
// just those entries. Proven live 2026-09-22: this used to fire every entry
// GET concurrently via Promise.all — fine for a couple of tickets, but a
// 23-ticket push fires 23 requests in one burst, blowing straight through the
// shared 25-req/60s account-wide bucket before throttleForRateLimit ever gets
// a response to react to (it only paces BETWEEN sequential calls). Now
// sequential, with the same requestWithRetry the CO line-item loops use.
async function fetchEntriesAndTimecards(env, projectId, entryIds, onProgress = () => {}) {
  const entries = [];
  for (const id of entryIds) {
    const res = await requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_entries/${id}`, null, onProgress);
    if (res.status !== 200) {
      throw new Error(`Failed to fetch T&M entry ${id}: ${res.status} ${JSON.stringify(res.data)}`);
    }
    await throttleForRateLimit(res.headers, onProgress);
    entries.push(res.data);
  }

  const tcRes = await requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_timecards`, null, onProgress);
  if (tcRes.status !== 200) {
    throw new Error(`Failed to fetch timecards: ${tcRes.status} ${JSON.stringify(tcRes.data)}`);
  }
  const wanted = new Set(entries.map(e => e.id));
  const timecards = tcRes.data.filter(tc => wanted.has(tc.time_and_material_entry?.id));
  return { entries, timecards };
}

// Best-effort cleanup after ANYTHING fails partway through building a CE/CO
// pair — never leave an orphaned Change Event (or a partial Change Order)
// sitting in Procore silently. `changeOrderId` is optional — pass null/
// undefined when the failure happened before the CO even got created (e.g.
// the create-CO call itself 403'd) and only the CE needs cleaning up.
// Swallows its own failures (this already runs from inside an error path);
// the caller reports whether each side actually got removed.
async function rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId) {
  // Retries on 429 too (2026-09-23) — a rollback that fails just because it
  // got rate-limited would leave a real orphaned CO/CE behind and report it
  // as a genuine deletion failure, when a retry would likely have succeeded.
  const result = { coDeleted: !changeOrderId, ceDeleted: false };
  if (changeOrderId) {
    try {
      const r = await requestWithRetry(env, 'DELETE', `/rest/v1.0/projects/${projectId}/prime_change_orders/${changeOrderId}`, null);
      result.coDeleted = r.status >= 200 && r.status < 300;
    } catch {
      // best-effort — fall through with coDeleted: false
    }
  }
  try {
    const r = await requestWithRetry(env, 'DELETE', `/rest/v1.1/change_events/${changeEventId}?project_id=${projectId}`, null);
    result.ceDeleted = r.status >= 200 && r.status < 300;
  } catch {
    // best-effort — fall through with ceDeleted: false
  }
  return result;
}

// Collapses the flat, per-timecard `lineItems` into what actually gets POSTed
// to Procore as Change Order line items. The reconciliation key stays
// per-timecard regardless of this — `members` keeps every underlying line so
// billing_records and (in generateInvoice) G703 claiming are unaffected by
// how the CO displays it.
//
// Procore requires one wbs_code_id per line, and each time type maps to a
// DIFFERENT cost code (49-04-01/02/03 for regular/overtime/double_time) — so
// no grouping mode can merge different time types onto one line EXCEPT
// 'total', which deliberately blends them onto a single WBS code (regular)
// with an averaged rate. That's a real trade-off, not a bug — the description
// says so, and the frontend labels it accordingly.
function buildCOLines(lineItems, groupBy, label) {
  // No grouping specified at all (vs. explicitly 'timecard') defaults to the
  // SAFE choice, not the riskiest one — proven live 2026-09-14 testing
  // directly against the Worker without going through the frontend (which
  // always sends an explicit groupBy): omitting it silently fell through to
  // the finest, most subrequest-hungry mode and hit the exact ceiling this
  // whole feature exists to avoid.
  const effectiveGroupBy = groupBy || 'worker_type';
  if (effectiveGroupBy === 'timecard') {
    return lineItems.map(l => ({ ...l, members: [l] }));
  }
  groupBy = effectiveGroupBy;

  const keyFor = {
    worker_type: (l) => `${l.workerName}|${l.timeType}`,
    ticket_type: (l) => `${l.ticketNumber}|${l.timeType}`,
    type: (l) => l.timeType,
    total: () => 'total'
  }[groupBy];
  if (!keyFor) throw new Error(`Unknown group_by: ${groupBy}`);

  const groups = new Map();
  for (const l of lineItems) {
    const key = keyFor(l);
    (groups.get(key) || groups.set(key, []).get(key)).push(l);
  }

  return [...groups.values()].map(members => {
    const hours = Math.round(members.reduce((s, m) => s + m.hours, 0) * 100) / 100;
    const amount = Math.round(members.reduce((s, m) => s + m.amount, 0) * 100) / 100;
    const rate = hours > 0 ? Math.round((amount / hours) * 100) / 100 : 0;
    const timeType = groupBy === 'total' ? 'regular' : members[0].timeType;

    let description;
    if (groupBy === 'worker_type') {
      description = `${members[0].workerName} - ${TIME_TYPE_LABEL[members[0].timeType]} - ${hours} hrs (${members.length} entries)`;
    } else if (groupBy === 'ticket_type') {
      // Ticket's own description + date, not worker classification (Ben's
      // ask 2026-09-15) — this grouping is one line per ticket, so its
      // description belongs on every line that ticket produces.
      const ticketDesc = members[0].ticketDescription;
      const ticketDate = members[0].ticketDate;
      description = `T&M #${members[0].ticketNumber}${ticketDesc ? ` - ${ticketDesc}` : ''}${ticketDate ? ` (${ticketDate})` : ''} - ${TIME_TYPE_LABEL[members[0].timeType]} - ${hours} hrs (${members.length} entries)`;
    } else if (groupBy === 'type') {
      description = `${TIME_TYPE_LABEL[members[0].timeType]} - ${hours} hrs, all workers (${members.length} entries)`;
    } else {
      description = `${label} - ${hours} hrs total, blended rate across time types (${members.length} entries)`;
    }

    return { description, hours, rate, timeType, amount, members };
  });
}

// Applies a PM's preview-screen edit (description and/or rate) to one
// computed CO line, in place. Rate edits propagate down to every underlying
// per-timecard member (same object references coLines was built from — see
// buildCOLines), NOT just the group's own display fields: `lineItems` and
// `coLines[].members` share those objects, so this is also what
// insertBillingRecordsBatch ends up recording. Without that propagation, an
// edited line's rate would bill correctly in Procore while billing_records
// (and therefore every ticket-card total) kept the old amount — the exact
// LEDGER-vs-Procore mismatch bug found and fixed earlier tonight, just
// reintroduced from a different direction.
function applyLineEdit(coLine, edit) {
  if (!edit) return;
  if (edit.description != null && String(edit.description).trim() !== '') {
    coLine.description = String(edit.description);
  }
  if (edit.rate != null && edit.rate !== '') {
    const newRate = Number(edit.rate);
    if (!Number.isFinite(newRate) || newRate < 0) {
      throw new Error(`Invalid rate for line "${coLine.description}": ${edit.rate}`);
    }
    coLine.rate = newRate;
    for (const m of coLine.members) {
      m.rate = newRate;
      m.amount = Math.round(newRate * m.hours * 100) / 100;
    }
    coLine.amount = Math.round(coLine.members.reduce((s, m) => s + m.amount, 0) * 100) / 100;
  }
}

// Everything through "here are the real unbilled T&M line items and their
// dollar amounts" — the part of computeCOLines that's genuinely shared with
// write-offs (writeOffRecords below), extracted 2026-09-17. A write-off never
// posts anything to Procore, so it must NOT require a WBS/cost-code mapping
// the way billing does (that check, plus grouping into CO lines, lives in
// computeCOLines below this — this helper stops one step before that).
async function fetchUnbilledTmLines(env, {
  tenantId, projectId, entryIds, rateOverrides, confirmUnlinked, onProgress = () => {}
}) {
  const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
  if (mode === 'non_billable') {
    const err = new Error(
      `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
      `Override the billing mode for this project in LEDGER if that's wrong.`
    );
    err.code = 'NON_BILLABLE_PROJECT';
    throw err;
  }

  const { entries, timecards } = await fetchEntriesAndTimecards(env, projectId, entryIds, onProgress);
  const multi = entries.length > 1;
  const numbers = entries.map(e => e.number);
  const label = ticketLabel(numbers);
  onProgress({ message: `Fetched ${entries.length} ticket(s), ${timecards.length} timecard(s) on the project` });

  const [billedIds, rawRates] = await Promise.all([
    getBilledTimecardIds(env, tenantId, projectId),
    getRateLookup(env, tenantId, projectId)
  ]);

  // A one-off rate override for this build only — NOT persisted to the
  // labour_rates table. { regular?, overtime?, double_time?, per_diem? }.
  const rates = { ...rawRates };
  if (rateOverrides) {
    for (const [timeType, value] of Object.entries(rateOverrides)) {
      if (value === null || value === undefined || value === '') continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0) throw new Error(`Invalid rate override for ${timeType}: ${value}`);
      rates[`${REGION_PLACEHOLDER}|${timeType}`] = num;
    }
  }

  const numberByEntryId = new Map(entries.map(e => [e.id, e.number]));
  const ticketDescByEntryId = new Map(entries.map(e => [e.id, e.description || '']));
  // Ticket-level only — confirmed live 2026-09-15 that a raw Procore timecard
  // record carries no date field of its own (just created_at/updated_at
  // record metadata, not the date the work was actually performed).
  // work_performed_on_date is the real one, and it's per-ticket.
  const ticketDateByEntryId = new Map(entries.map(e => [e.id, e.work_performed_on_date || '']));

  // Build unbilled line items across every selected ticket, de-duped by the
  // reconciliation key so a timecard shared across two selected tickets is
  // only billed once.
  const seen = new Set();
  const lineItems = [];
  let unlinkedCount = 0;
  for (const tc of timecards) {
    const key = reconciliationKey(tc);
    if (billedIds.has(key) || seen.has(key)) continue;
    seen.add(key);

    const timeType = TIME_TYPE_MAP[tc.timecard_time_type?.time_type] || 'regular';
    const rate = rates[`${REGION_PLACEHOLDER}|${timeType}`];
    if (rate === undefined) throw new Error(`No rate configured for time type: ${timeType}`);
    const hours = Number(tc.hours_worked);
    const num = numberByEntryId.get(tc.time_and_material_entry?.id);
    const ticketDescription = ticketDescByEntryId.get(tc.time_and_material_entry?.id) || '';
    const ticketDate = ticketDateByEntryId.get(tc.time_and_material_entry?.id) || '';
    const hasTimecard = tc.timecard_entry_id != null;
    if (!hasTimecard) unlinkedCount++;

    lineItems.push({
      timecardEntryId: key,
      ticketNumber: num,
      ticketDescription,
      ticketDate,
      // The T&M ticket's own description (+ date — Ben's ask 2026-09-15), not
      // the worker's job classification (Ben's ask 2026-09-15: classification
      // "does not belong anywhere on our invoices, COs, nowhere" — it's noise
      // to the client, the ticket's own description is what actually
      // identifies the work).
      description:
        `${multi ? `T&M #${num} · ` : ''}` +
        `${tc.party?.name || 'Unknown'}${ticketDescription ? ` - ${ticketDescription}` : ''}${ticketDate ? ` (${ticketDate})` : ''} - ` +
        `${tc.timecard_time_type?.time_type || timeType} - ${hours} hrs`,
      workerName: tc.party?.name || 'Unknown',
      timeType,
      hours,
      rate,
      amount: Math.round(rate * hours * 100) / 100,
      hasTimecard
    });
  }

  if (lineItems.length === 0) {
    throw new Error('Nothing to bill — every timecard on the selected ticket(s) is already billed, written off, or already in a draft Change Order.');
  }
  const rawTotal = Math.round(lineItems.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  onProgress({ message: `${lineItems.length} unbilled timecard(s) to bill — $${rawTotal.toLocaleString()}` });

  // Stopgap flagged 2026-09-09: a T&M timecard line with no timecard_entry_id
  // isn't backed by an actual submitted timecard in Procore's timesheet system
  // — nothing to reconcile against. Require explicit confirmation before
  // billing those lines rather than letting them through silently.
  // NOT applied in 'fixed_price' mode (added 2026-09-11): on a quoted job, an
  // ad hoc T&M change ticket routinely has no linked timecard — that's normal
  // for how that extra work gets entered, not a billing-leak signal the way it
  // is on a genuine T&M job. Only 'tm' (and the 'default' fallback) gate on it.
  if (unlinkedCount > 0 && mode !== 'fixed_price' && !confirmUnlinked) {
    const err = new Error(
      `${unlinkedCount} of ${lineItems.length} line item(s)` +
      `${multi ? ` across ${entries.length} tickets (${label})` : ` on ${label}`} have no timecard ` +
      `linked in Procore. Apply a timecard to them in Procore, or confirm to submit anyway.`
    );
    err.code = 'UNLINKED_TIMECARDS';
    err.unlinkedCount = unlinkedCount;
    err.ticketNumbers = numbers;
    throw err;
  }

  return { entries, multi, label, numbers, lineItems, unlinkedCount, mode };
}

// Everything through "what would this bill?" — shared by the preview action
// and buildChangeEventAndOrder, so a preview can never drift from what
// actually gets created: same function, same result, right up to the point
// nothing has touched Procore yet. `editedLines` (from the preview/edit
// screen, Ben's ask 2026-09-15): an array parallel to the computed coLines
// (same order, same length) carrying a PM's description/rate overrides —
// length mismatch means the underlying selection changed since the preview
// was shown (e.g. someone else billed one of these timecards meanwhile), so
// this refuses rather than silently misapplying edits to the wrong lines.
async function computeCOLines(env, {
  tenantId, projectId, entryIds, groupBy, rateOverrides, editedLines, confirmUnlinked, onProgress = () => {}
}) {
  const [{ entries, multi, label, numbers, lineItems, unlinkedCount, mode }, wbsCodeIds] = await Promise.all([
    fetchUnbilledTmLines(env, { tenantId, projectId, entryIds, rateOverrides, confirmUnlinked, onProgress }),
    findWbsCodeIds(env, projectId)
  ]);

  const coLines = buildCOLines(lineItems, groupBy, label);
  onProgress({ message: `Grouped into ${coLines.length} Change Order line item(s) (${groupBy || 'worker_type (default)'})` });

  // Preview/edit screen overrides (Ben's ask 2026-09-15) — description and/or
  // rate per line, applied before anything downstream (WBS validation, the
  // line-count cap, totalAmount) sees the lines, so every check after this
  // point already reflects the PM's edits.
  if (editedLines) {
    if (editedLines.length !== coLines.length) {
      throw new Error(
        `This selection has changed since the preview was shown (${coLines.length} line(s) now vs. ${editedLines.length} previewed) — ` +
        `go back and preview again before confirming.`
      );
    }
    coLines.forEach((line, i) => applyLineEdit(line, editedLines[i]));
  }

  // Fail before creating anything (not partway through) if a time type in
  // this selection has no WBS/cost-code mapping on the project.
  for (const line of coLines) {
    if (!wbsCodeIds[line.timeType]) {
      throw new Error(`No WBS code found for time type: ${line.timeType} on this project`);
    }
  }

  // Refuse up front — before creating anything — if this selection would
  // still be too large even after grouping. Proven live 2026-09-14: past a
  // certain line count, Cloudflare's per-invocation subrequest ceiling hits
  // partway through adding lines, AND the rollback's own DELETE calls are
  // themselves subrequests that can fail for the same reason, leaving a
  // genuinely stuck partial CO neither built nor cleanly undone. Better to
  // never start than to risk landing there. Threshold is a guess at real
  // headroom under the setup calls this function already makes, not a
  // documented Cloudflare number — revisit if it's ever too conservative.
  const MAX_CO_LINES = 35;
  if (coLines.length > MAX_CO_LINES) {
    throw new Error(
      `This selection needs ${coLines.length} Change Order line items even after grouping — too many for one ` +
      `reliable build (limit ${MAX_CO_LINES}). Pick a coarser "Group lines" option, or bill fewer tickets at once.`
    );
  }

  const totalAmount = Math.round(lineItems.reduce((s, l) => s + l.amount, 0) * 100) / 100;

  return { entries, multi, label, numbers, lineItems, coLines, totalAmount, unlinkedCount, wbsCodeIds, mode };
}

// Preview-only: computes exactly what a real push would create, without
// touching Procore at all — same computeCOLines the real path uses, not a
// separate approximation that could drift from it. Ben's ask 2026-09-15: a
// step between the rate-override settings and actually confirming, so the
// PM sees the real lines (and can edit description/rate — see
// applyLineEdit) before anything gets created. `confirmUnlinked: true`
// always — a preview can't commit anything, so the unlinked-timecard gate
// belongs at the real confirm step, not here; `unlinkedCount` is still
// returned so the preview can show the same warning.
export async function previewBilling(env, {
  tenantId, projectId, entryId, entryIds, groupBy, rateOverrides, onProgress = () => {}
}) {
  const ids = normalizeEntryIds(entryId, entryIds);
  const { coLines, totalAmount, unlinkedCount, label, multi } = await computeCOLines(env, {
    tenantId, projectId, entryIds: ids, groupBy, rateOverrides, confirmUnlinked: true, onProgress
  });
  return {
    label,
    multi,
    totalAmount,
    unlinkedCount,
    lines: coLines.map(l => ({ description: l.description, hours: l.hours, rate: l.rate, amount: l.amount, timeType: l.timeType }))
  };
}

// Steps shared by generateInvoice (full pipeline) and pushToDraftCO (stops
// here, leaves the CO in draft for manual review). Handles one OR many T&M
// entries: gather every unbilled timecard across the selection, build ONE
// Change Event, link every selected ticket back to it, build ONE Prime Change
// Order whose line items are grouped per `groupBy`. Does NOT approve anything
// or touch billing_records — callers decide what "done" means for their flow.
// `onProgress(evt)` fires at each milestone so the caller can stream it back.
async function buildChangeEventAndOrder(env, {
  tenantId, projectId, entryIds, primeContractId, confirmUnlinked,
  groupBy, rateOverrides, editedLines, onProgress = () => {}
}) {
  const { entries, multi, label, lineItems, coLines, totalAmount, wbsCodeIds } =
    await computeCOLines(env, { tenantId, projectId, entryIds, groupBy, rateOverrides, editedLines, confirmUnlinked, onProgress });

  // 1. Build the Change Event ourselves — see api-directory/README.md on why
  // Procore's native push can't be patched after the fact to carry real names.
  // change_items give the CE its own dollar value (confirmed live 2026-09-14
  // against a native-pushed CE's real shape): revenue_impact.estimate with
  // calculation_strategy 'manual' so Procore takes our number directly rather
  // than trying to auto-derive it from a linked CO (there's no CO yet at this
  // point — we build that next). budget_code is the SAME wbs combo id already
  // used for the CO's own line items. cost_impact is deliberately left unset
  // — LEDGER has no real labour COST rate anywhere, only the bill rate, and
  // setting cost = revenue would misrepresent margin as zero.
  // CE/CO creation and the link-back PATCH now retry on 429 the same way the
  // line-item loop already did (Ben's ask 2026-09-23, after a stress-test
  // 429 landed here instead) — safe to retry as-is: a 429 means Procore
  // rejected the request before doing anything, never that it partially
  // created something, so a retry can't double up a CE, a CO, or a line
  // item. This is a per-call retry only, not a whole-pipeline retry — it
  // never re-runs a step that already succeeded.
  const ceRes = await requestWithRetry(env, 'POST', `/rest/v1.1/change_events?project_id=${projectId}`, {
    change_event: {
      title: label,
      description:
        `LEDGER-generated from ${label}` +
        (multi ? '' : `: ${entries[0].description || ''}`),
      scope: 'in_scope',
      status: { id: 562949953739902 }, // Open — confirmed real id for this company
      change_items: coLines.map(line => ({
        description: line.description,
        revenue_impact: {
          estimate: {
            quantity: String(line.hours),
            unit_cost: String(line.rate),
            amount: String(line.amount),
            unit_of_measure: 'Hours',
            calculation_strategy: 'manual'
          }
        },
        budget_code: { id: String(wbsCodeIds[line.timeType]) }
      }))
    }
  }, onProgress);
  if (ceRes.status !== 201) {
    throw new Error(`Failed to create Change Event: ${ceRes.status} ${JSON.stringify(ceRes.data)}`);
  }
  const changeEventId = ceRes.data.id;
  onProgress({ message: `Change Event created — id ${changeEventId} ($${totalAmount.toLocaleString()} value)`, changeEventId });

  // 2 & 3. Link every selected ticket back to the CE, then build the Prime
  // Change Order. Wrapped together: EITHER step failing (e.g. the CO-create
  // 403 hit live 2026-09-14 — a permission gap, not a bug, but it still left
  // a real orphaned Change Event behind the first time because nothing rolled
  // it back) leaves the just-created CE dangling, unlinked to anything, with
  // no CO to show for it. Roll the CE back too in that case, not just when a
  // line item fails later.
  let contractId, changeOrderId;
  try {
    // 2. Link every selected ticket back so Procore's native UI shows them
    // attached. bulk_update takes an array — proven it handles many at once.
    // Also just a SET of change_event_id on the given ticket ids, not an
    // append — retrying it is unambiguously safe even setting 429 aside.
    const linkRes = await requestWithRetry(env, 'PATCH', `/rest/v1.0/projects/${projectId}/time_and_material_entries/bulk_update`, {
      time_and_material_entry: {
        time_and_material_entry_ids: entries.map(e => e.id),
        change_event_id: changeEventId,
        update_change_event_attachment: true
      }
    }, onProgress);
    if (linkRes.status !== 200) {
      throw new Error(`Failed to link Change Event back to ticket(s): ${linkRes.status} ${JSON.stringify(linkRes.data)}`);
    }
    onProgress({ message: `Linked ${entries.length} ticket(s) to the Change Event` });

    // 3. Build the Prime Change Order.
    contractId = primeContractId || await findBillableContract(env, projectId);
    const coRes = await requestWithRetry(env, 'POST', `/rest/v1.0/projects/${projectId}/prime_change_orders`, {
      change_order: {
        contract_id: contractId,
        title: label,
        description: `LEDGER-generated from ${label}`,
        status: 'draft',
        reason: 'T&M billing'
      }
    }, onProgress);
    if (coRes.status !== 201) {
      throw new Error(`Failed to create Prime Change Order: ${coRes.status} ${JSON.stringify(coRes.data)}`);
    }
    changeOrderId = coRes.data.id;
    onProgress({ message: `Change Order created (draft) — id ${changeOrderId}`, changeOrderId });
  } catch (e) {
    onProgress({ message: 'Failed before the Change Order was ready — rolling back the Change Event…' });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    throw new Error(
      `${e.message} ${rb.ceDeleted ? '(the Change Event was rolled back — nothing left behind)' : '(COULD NOT roll back the Change Event — check Procore manually, it may still exist)'}`
    );
  }

  // Add every CO line item. Proven live 2026-09-13 to be a real failure mode
  // on large aggregates (68 raw timecards across 2 tickets, one-line-per-
  // timecard): it silently stopped partway, leaving a draft CO for the wrong
  // (partial) amount, no error ever surfaced. Grouping (this function's whole
  // point) shrinks the request count a lot, but NEVER leave a wrong-amount
  // partial CO behind silently again regardless: catch the first failure,
  // roll back what was created, and throw a clear, honest error instead.
  let addedCount = 0;
  let lineFailure = null;
  for (const line of coLines) {
    const wbsCodeId = wbsCodeIds[line.timeType];
    if (!wbsCodeId) {
      lineFailure = { description: line.description, error: `No WBS code found for time type: ${line.timeType} on this project` };
      break;
    }
    try {
      const lineRes = await requestWithRetry(
        env, 'POST',
        `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/prime_change_orders/${changeOrderId}/line_items`,
        { description: line.description, quantity: String(line.hours), unit_cost: String(line.rate), uom: 'Hours', wbs_code_id: String(wbsCodeId) },
        onProgress
      );
      await throttleForRateLimit(lineRes.headers, onProgress);
      if (lineRes.status !== 201) {
        lineFailure = { description: line.description, error: `${lineRes.status} ${JSON.stringify(lineRes.data)}` };
        break;
      }
      addedCount++;
      onProgress({ message: `Added line ${addedCount}/${coLines.length}: ${line.description} — $${line.amount.toLocaleString()}` });
    } catch (e) {
      lineFailure = { description: line.description, error: e.message };
      break;
    }
  }

  if (lineFailure) {
    onProgress({ message: `Failed on line ${addedCount + 1}/${coLines.length} — rolling back…` });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    const rollbackNote = (rb.coDeleted && rb.ceDeleted)
      ? 'Rolled back the Change Event and Change Order — nothing was left half-built.'
      : `Rollback ${rb.coDeleted ? 'removed' : 'could NOT remove'} the Change Order and ` +
        `${rb.ceDeleted ? 'removed' : 'could NOT remove'} the Change Event — check Procore manually if either failed.`;
    throw new Error(
      `Only added ${addedCount} of ${coLines.length} line items to the Change Order, then failed on ` +
      `"${lineFailure.description}": ${lineFailure.error}. ${rollbackNote} Try fewer tickets, or a coarser grouping.`
    );
  }
  onProgress({ message: `All ${coLines.length} line item(s) added — $${totalAmount.toLocaleString()} total` });

  return { entries, contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label };
}

// "Push to CO" flow: everything above, then STOP — leaves the Change Order in
// draft for a human to review and approve manually in Procore. Still writes
// billing_records (status 'draft_co') so the same timecards can't be pushed
// again from LEDGER while the draft is awaiting review.
export async function pushToDraftCO(env, {
  tenantId, projectId, entryId, entryIds, userId, primeContractId, confirmUnlinked,
  groupBy, rateOverrides, editedLines, onProgress = () => {}
}) {
  const ids = normalizeEntryIds(entryId, entryIds);
  const { entries, contractId, changeEventId, changeOrderId, lineItems, totalAmount, label } =
    await buildChangeEventAndOrder(env, {
      tenantId, projectId, entryIds: ids, primeContractId, confirmUnlinked, groupBy, rateOverrides, editedLines, onProgress
    });

  await insertBillingRecordsBatch(env, lineItems.map(line => ({
    tenantId, projectId, procoreRecordId: line.timecardEntryId,
    amount: line.amount, status: 'draft_co', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${lineItems.length} timecard(s) as pushed to draft` });

  return {
    contractId,
    changeEventId,
    changeOrderId,
    totalAmount,
    linesPushed: lineItems.length,
    ticketNumbers: entries.map(e => e.number),
    ticketLabel: label
  };
}

// Shared by generateInvoice (T&M) and generateDirectCostInvoice: approve an
// already-built Prime Change Order, create the draft invoice against it, and
// claim every one of its g703 lines to 100%. Fully generic — only needs
// `coLines` shaped like { description, amount, hours } (T&M's real hours, or
// a direct cost's flat quantity=1 — see buildDirectCostLines), never anything
// T&M-specific — so both callers share this instead of duplicating it.
//
// Found live 2026-09-14 (Mecart: nothing landed at 100%, ever): g703 is
// Procore's full continuation sheet — one row per (cost code, contributing
// source) pair, `added_from_source` being either 'contract' (the base SOV)
// or 'change_order' (+ `added_from_source_id`, that CO's own id) — going
// back through every CO that's ever touched that cost code, not just this
// push's new lines. Recurring cost codes mean a project with billing history
// has several old rows sharing a cost code; the old code's "find a
// $0.00-to-date row with a matching dollar amount" heuristic couldn't tell
// them apart and often matched nothing. Filter to rows THIS run's own Change
// Order actually created before matching by amount — scoped that way,
// matching by amount is unambiguous again since these rows are guaranteed
// fresh and ours alone. The create response's inline g703 doesn't carry
// these fields — re-fetch via the real show endpoint (a flat
// /rest/v1.0/payment_applications/{id}, not nested under the contract — the
// nested path 404s) to get them.
//
// Retries + explicit failure tracking added 2026-09-14 after Ben caught this
// landing at 0% again under heavy API load: neither the re-fetch GET nor
// each claim PATCH checked its response status, so a transient 429
// (Procore's real rate limit, hit hard by everyone's testing tonight)
// silently skipped claiming with no error — the invoice still reported
// success. This is the CO's real dollar amount already approved+executed in
// Procore by this point, so a claim failure here can't roll anything back —
// it has to be surfaced instead, not swallowed. On an actual 429, wait for
// the REAL window reset (from this response's own headers) rather than a
// blind guess — the window is a full 60 seconds (confirmed live
// 2026-09-14), so a short fixed delay just re-hits the same 429 repeatedly
// until the real reset passes.
async function approveAndInvoiceChangeOrder(env, {
  projectId, contractId, changeOrderId, coLines, billingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  // 4. Approve it. Direct-approve works today because Einbau has no active
  // Change Order workflow — if this starts failing with the specific
  // "set via workflow" 422, that means a workflow got re-enabled and this
  // needs a human-approves-in-Procore fallback instead.
  const approveRes = await procoreRequest(env, 'PATCH', `/rest/v1.0/projects/${projectId}/prime_change_orders/${changeOrderId}`, {
    change_order: { status: 'approved', executed: true }
  });
  if (approveRes.status !== 200) {
    throw new Error(`Failed to approve Change Order: ${approveRes.status} ${JSON.stringify(approveRes.data)}`);
  }
  onProgress({ message: 'Change Order approved' });

  // 5. Draft invoice (billing period was already ensured by the caller).
  // Plain sequential invoice_number now (Ben's ask 2026-09-14) instead of the
  // old "LEDGER-T5+6-1789368228392" scheme, which stood out from every other
  // invoice on the contract. The frontend shows the suggested next number
  // (nextInvoiceNumber, above) and lets the PM override it before confirming;
  // this only recomputes it server-side as a fallback if none was sent.
  const finalInvoiceNumber = invoiceNumber
    ? String(invoiceNumber)
    : String(await nextInvoiceNumber(env, { projectId }));
  const invoiceRes = await procoreRequest(env, 'POST', `/rest/v1.0/prime_contracts/${contractId}/payment_applications`, {
    project_id: Number(projectId),
    payment_application: {
      commitment_billing_period_id: billingPeriod.id,
      period_start: billingPeriod.start_date,
      period_end: billingPeriod.end_date,
      billing_date: billingDate,
      invoice_number: finalInvoiceNumber,
      status: 'draft'
    }
  });
  if (invoiceRes.status !== 201) {
    throw new Error(`Failed to create draft invoice: ${invoiceRes.status} ${JSON.stringify(invoiceRes.data)}`);
  }
  const invoice = invoiceRes.data;
  onProgress({ message: `Invoice created — id ${invoice.id}, number ${invoice.invoice_number}`, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number });

  // 6. Claim each of THIS Change Order's own g703 lines at their full amount.
  // getWithRetry/patchWithRetry used to retry a 429 exactly once inline here —
  // proven live 2026-09-22 to not be enough under heavy simultaneous testing
  // (Ben got 0 of 6 lines claimed after 10 poll attempts, because the very
  // first read-back hit a 429 that survived its one retry, which aborted the
  // whole poll loop before it ever really started). Now delegates to the
  // shared requestWithRetry (same one the CO line-item loops use), which
  // retries up to 5 times instead of once.
  async function getWithRetry(path) {
    return requestWithRetry(env, 'GET', path, null, onProgress);
  }
  async function patchWithRetry(path, body) {
    return requestWithRetry(env, 'PATCH', path, body, onProgress);
  }
  // Claiming a line takes a quantity on a 'unit' accounting contract
  // (rejects a dollar-only claim: "Work Completed This Period Quantity is
  // required") but rejects a quantity on an 'amount' accounting contract
  // ("Quantity update not allowed on amount accounting contract") — found
  // live 2026-09-14 on two different real contracts, one of each kind.
  // Determined upfront from the contract's own accounting_method (findPrimeContracts
  // already carries it) rather than guessing and eating a failed request —
  // the adaptive retry stays as a safety net in case that field is ever
  // missing or wrong for a contract we haven't seen yet.
  const contractsForMethod = await findPrimeContracts(env, projectId);
  const accountingMethod = contractsForMethod.find(c => String(c.id) === String(contractId))?.accountingMethod;

  // g703's added_from_source_id does NOT reliably equal the Prime Change
  // Order's own `id` — confirmed live 2026-09-23 on a real unit-accounting
  // contract: added_from_source_id matched the CO's `legacy_package_id`
  // field instead, a completely different number. Matching on `id` alone
  // (the only thing this function checked before today) silently found ZERO
  // rows despite them being present the whole time with correct amounts AND
  // quantities — the poll then "gave up" and every line got surfaced as
  // "likely rate-limited," which was the wrong diagnosis: this had nothing
  // to do with rate limits. Match against whichever of the two ids g703
  // actually used, rather than assuming one is always right.
  const coDetailRes = await getWithRetry(`/rest/v1.0/projects/${projectId}/prime_change_orders/${changeOrderId}`);
  const legacyPackageId = coDetailRes.status === 200 ? coDetailRes.data.legacy_package_id : null;
  const sourceIdsToMatch = new Set([String(changeOrderId), ...(legacyPackageId != null ? [String(legacyPackageId)] : [])]);

  async function claimLine(path, amount, hours) {
    const includeQty = accountingMethod !== 'amount';
    const body = includeQty
      ? { work_completed_this_period: String(amount.toFixed(2)), work_completed_this_period_quantity: String(hours) }
      : { work_completed_this_period: String(amount.toFixed(2)) };
    let r = await patchWithRetry(path, { project_id: Number(projectId), payment_application_line_item: body });
    if (r.status === 422 && includeQty && JSON.stringify(r.data).includes('not allowed on amount accounting')) {
      r = await patchWithRetry(path, {
        project_id: Number(projectId),
        payment_application_line_item: { work_completed_this_period: String(amount.toFixed(2)) }
      });
    } else if (r.status === 422 && !includeQty && JSON.stringify(r.data).includes('Quantity is required')) {
      r = await patchWithRetry(path, {
        project_id: Number(projectId),
        payment_application_line_item: { work_completed_this_period: String(amount.toFixed(2)), work_completed_this_period_quantity: String(hours) }
      });
    }
    return r;
  }

  // Poll for the CO's own g703 rows to actually show up, with real backoff —
  // found live 2026-09-22 via a real HAR capture of a human doing this by
  // hand: Procore's backend needs real wall-clock time after a CO's approval
  // before a brand-new invoice's g703 reflects it. The human's own natural
  // click-through pacing gave it ~58 seconds end-to-end (CO approved -> new
  // invoice created -> both lines claimed), and it worked perfectly — even
  // on a cost code that had NEVER been touched before on the project,
  // directly ruling out the earlier "fresh cost code" theory. LEDGER's
  // pipeline used to do the whole approve -> create invoice -> read-back
  // sequence in under 2 seconds with zero pauses, racing right past the
  // window Procore's backend actually needed. Poll with growing delays for
  // up to ~90s (comfortably past the observed real-world gap) instead of a
  // single shot — exits as soon as every expected line shows up, so this
  // only costs real time when it's actually needed.
  const pollDelaysMs = [3000, 3000, 5000, 5000, 8000, 8000, 10000, 15000, 15000, 15000];
  let shown = await getWithRetry(`/rest/v1.0/payment_applications/${invoice.id}?project_id=${projectId}`);
  let ownRows = shown.status === 200
    ? (shown.data.g703 || []).filter(row =>
        row.added_from_source === 'change_order' && sourceIdsToMatch.has(String(row.added_from_source_id)))
    : [];
  for (let attempt = 0; shown.status === 200 && ownRows.length < coLines.length && attempt < pollDelaysMs.length; attempt++) {
    onProgress({
      message: `${ownRows.length} of ${coLines.length} line(s) have landed on the invoice so far — waiting for Procore to finish syncing before claiming (can take under a minute)…`
    });
    await sleep(pollDelaysMs[attempt]);
    shown = await getWithRetry(`/rest/v1.0/payment_applications/${invoice.id}?project_id=${projectId}`);
    ownRows = shown.status === 200
      ? (shown.data.g703 || []).filter(row =>
          row.added_from_source === 'change_order' && sourceIdsToMatch.has(String(row.added_from_source_id)))
      : [];
  }
  if (shown.status !== 200) {
    onProgress({ message: `Could not read the invoice back to claim its lines (${shown.status}) — every line needs manual 100% completion in Procore.` });
  } else if (ownRows.length < coLines.length) {
    // Diagnostic dump (added 2026-09-23, after the added_from_source_id vs
    // legacy_package_id bug took a full manual investigation to root-cause) —
    // if this fires again for a NEW reason, the actual source ids g703
    // reported are right here in the log instead of requiring another
    // by-hand comparison against the CO's own id/legacy_package_id.
    const seenSourceIds = [...new Set(
      (shown.data.g703 || []).filter(row => row.added_from_source === 'change_order').map(row => String(row.added_from_source_id))
    )];
    onProgress({
      message: `Still only ${ownRows.length} of ${coLines.length} line(s) present after waiting — proceeding with what's there. ` +
        `(Matching against: ${[...sourceIdsToMatch].join(', ')} — g703 change-order source ids actually seen: ${seenSourceIds.join(', ') || 'none'})`
    });
  }

  const claimedIds = new Set();
  let claimedCount = 0;
  const failedLines = [];
  for (const line of coLines) {
    const row = ownRows.find(r => !claimedIds.has(r.id) && Math.abs(Number(r.scheduled_value) - line.amount) < 0.01);
    if (!row) { failedLines.push(line.description); continue; }
    claimedIds.add(row.id);
    const r = await claimLine(
      `/rest/v1.0/prime_contracts/${contractId}/payment_application_line_items/${row.id}`,
      line.amount, line.hours
    );
    await throttleForRateLimit(r.headers, onProgress);
    if (r.status === 200) {
      claimedCount++;
    } else {
      failedLines.push(line.description);
    }
  }
  if (failedLines.length > 0) {
    onProgress({
      message: `Claimed ${claimedCount} of ${coLines.length} invoice line(s) — ${failedLines.length} still need manual completion in Procore: ${failedLines.join('; ')}`
    });
  } else {
    onProgress({ message: `Claimed all ${claimedCount} invoice line(s) at 100%` });
  }

  return { invoice, claimedCount, failedLines };
}

// Invoices an already-existing, already-approved Change Order that LEDGER
// did NOT build itself — e.g. created in Estimating or directly in Procore
// (Ben's ask 2026-09-23/24, testing how far this can act on a CO it has no
// prior tracking for). Unlike every other invoice path in this file, this
// CO's line items aren't sourced from any T&M ticket or direct cost LEDGER
// tracks — there is genuinely nothing to write to billing_records here, and
// that's a real, known gap (flagged, not yet solved): if this is ever
// exposed as a general-purpose "PM asks an agent to invoice a CO" tool, the
// agent side needs its own record of what it was asked to do and did. The
// one safety net available without that tracking: check whether an invoice
// already exists for this CO before creating another (same
// legacy_package_id-aware match approveAndInvoiceChangeOrder's own g703
// matching uses), so re-running this can't silently double-invoice.
export async function invoiceExistingChangeOrder(env, {
  projectId, contractId, changeOrderId, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  if (!billingDate) {
    throw new Error('billingDate is required');
  }
  const coRes = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/prime_change_orders/${changeOrderId}`);
  if (coRes.status !== 200) {
    throw new Error(`Failed to fetch Change Order: ${coRes.status} ${JSON.stringify(coRes.data)}`);
  }
  const co = coRes.data;
  if (String(co.status).toLowerCase() !== 'approved') {
    throw new Error(`Change Order ${changeOrderId} is "${co.status}", not approved — approve it in Procore first.`);
  }
  onProgress({ message: `Found Change Order "${co.title}" — $${Number(co.grand_total).toLocaleString()}` });

  // Refuse a duplicate — the only guard available without billing_records
  // tracking for this CO. Matches against both the CO's own id and its
  // legacy_package_id, same as the claim-matching fix (2026-09-23) —
  // added_from_source_id can be either depending on the contract.
  const sourceIds = new Set([String(changeOrderId), ...(co.legacy_package_id != null ? [String(co.legacy_package_id)] : [])]);
  const existingRes = await procoreRequest(env, 'GET', `/rest/v1.0/prime_contracts/${contractId}/payment_applications?project_id=${projectId}`);
  if (existingRes.status === 200) {
    for (const inv of existingRes.data) {
      const detailRes = await procoreRequest(env, 'GET', `/rest/v1.0/payment_applications/${inv.id}?project_id=${projectId}`);
      if (detailRes.status !== 200) continue;
      const already = (detailRes.data.g703 || []).some(row =>
        row.added_from_source === 'change_order' && sourceIds.has(String(row.added_from_source_id)));
      if (already) {
        throw new Error(`Change Order ${changeOrderId} already has invoice #${inv.invoice_number} (id ${inv.id}) referencing it — refusing to create a duplicate.`);
      }
    }
  }

  // The v2.0 line_items response shape has been observed both as a bare
  // array and as { data: [...] } on different projects — handle both.
  const liRes = await procoreRequest(env, 'GET', `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/prime_change_orders/${changeOrderId}/line_items`);
  if (liRes.status !== 200) {
    throw new Error(`Failed to fetch Change Order line items: ${liRes.status} ${JSON.stringify(liRes.data)}`);
  }
  const rawLines = Array.isArray(liRes.data) ? liRes.data : (liRes.data?.data || []);
  if (rawLines.length === 0) {
    throw new Error('This Change Order has no line items to invoice.');
  }
  const coLines = rawLines.map(l => ({
    description: l.description,
    amount: Math.round(Number(l.amount ?? 0) * 100) / 100,
    hours: Number(l.quantity ?? 1)
  }));
  onProgress({ message: `Fetched ${coLines.length} real line item(s) from the Change Order` });

  const billingPeriod = await findOrCreateBillingPeriod(env, projectId, billingPeriodId, newBillingPeriod);
  onProgress({ message: `Billing period ready — id ${billingPeriod.id}` });

  const { invoice, claimedCount, failedLines } = await approveAndInvoiceChangeOrder(env, {
    projectId, contractId, changeOrderId, coLines, billingPeriod, invoiceNumber, billingDate, onProgress
  });

  return {
    contractId, changeOrderId,
    invoiceId: invoice.id, invoiceNumber: invoice.invoice_number,
    totalAmount: Math.round(coLines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    label: co.title, claimedCount, totalCoLines: coLines.length, unclaimedLines: failedLines
  };
}

// The whole proven pipeline for one OR many T&M entries: ensure a billing
// period -> build a Change Event with all the line items -> link every
// ticket back -> build + approve a Prime Change Order -> create a draft
// invoice -> claim each line at its full amount -> record every included
// timecard in billing_records so it can never be billed again.
export async function generateInvoice(env, {
  tenantId, projectId, entryId, entryIds, userId, primeContractId, confirmUnlinked,
  groupBy, rateOverrides, editedLines, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  // Required, not defaulted — found live 2026-09-14 that this was silently
  // defaulting to the billing period's own end date, which the PM never
  // actually saw or chose. Checked here, before anything real exists in
  // Procore, same reasoning as the billing period check right below.
  if (!billingDate) {
    throw new Error('billingDate is required');
  }

  // Billing period is checked FIRST, before anything real exists in Procore —
  // found live 2026-09-14 on a project with no billing periods yet: the old
  // order (check this only right before creating the invoice, after the
  // Change Event + Change Order were already created AND approved+executed)
  // meant a missing/failed billing period left a real, executed CO behind
  // with no invoice and no billing_records row for it — same double-billing
  // shape as every other partial-failure bug this project has hit, just at a
  // later step. Failing here means nothing has been created yet.
  const billingPeriod = await findOrCreateBillingPeriod(env, projectId, billingPeriodId, newBillingPeriod);
  onProgress({ message: `Billing period ready — id ${billingPeriod.id}` });

  const ids = normalizeEntryIds(entryId, entryIds);
  const { entries, contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label } =
    await buildChangeEventAndOrder(env, {
      tenantId, projectId, entryIds: ids, primeContractId, confirmUnlinked, groupBy, rateOverrides, editedLines, onProgress
    });

  const { invoice, claimedCount, failedLines } = await approveAndInvoiceChangeOrder(env, {
    projectId, contractId, changeOrderId, coLines, billingPeriod, invoiceNumber, billingDate, onProgress
  });

  // 7. Record every included timecard so none of them can ever be billed
  // again — the actual anti-double-billing enforcement.
  await insertBillingRecordsBatch(env, lineItems.map(line => ({
    tenantId, projectId, procoreRecordId: line.timecardEntryId,
    invoiceId: String(invoice.id), invoiceNumber: invoice.invoice_number,
    amount: line.amount, status: 'billed', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${lineItems.length} timecard(s) as billed` });

  return {
    contractId,
    changeEventId,
    changeOrderId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    totalAmount,
    linesbilled: lineItems.length,
    ticketNumbers: entries.map(e => e.number),
    ticketLabel: label,
    claimedCount,
    totalCoLines: coLines.length,
    unclaimedLines: failedLines
  };
}

// ============================================================
// Direct costs — first slice of billing beyond T&M tickets (Ben's ask
// 2026-09-15/16). Confirmed live against the DDMA/Dior project:
// `direct_cost_type` is a real native dropdown ('expense' | 'invoice' |
// 'payroll') — 'payroll' is T&M/timesheet money, already covered by the
// ticket flow above, so it's filtered out here rather than double-billed.
// Markup is baked into each line's own amount and rides that direct cost's
// OWN real cost code (confirmed live: a direct cost's line items carry a
// real wbs_code, e.g. a Lee Valley purchase tagged "Woodworking Hardware &
// Materials Supplies") — Ben was explicit 2026-09-16 that markup must NOT
// get its own line or its own cost code, it's folded into the one line
// billed to the client.
//
// No self-heal for a deleted CO yet (unlike T&M's reconcileStaleDraftCOs) —
// new record type, add that once real usage shows it's needed the same way.
// ============================================================

// A partly-dispositioned direct cost or commitment stays in Unbilled (it
// still has open lines); these fields let the Billed / Written off /
// Budgeted history tabs list it as well, so its undo is reachable.
function partialDispositionFields(billedRows, writtenOffRows, budgetedRows) {
  return {
    billedStatus: billedRows.length ? (billedRows.some(r => r.status === 'draft_co') ? 'draft_co' : 'billed') : null,
    invoiceNumber: billedRows.find(r => r.invoiceNumber)?.invoiceNumber || null,
    outsideLedgerLineCount: billedRows.filter(r => r.billedOutsideLedger).length,
    reasonCategory: writtenOffRows[0]?.reasonCategory || null,
    writeOffNotes: writtenOffRows[0]?.reasonNotes || null,
    budgetedNotes: budgetedRows[0]?.reasonNotes || null
  };
}

export async function listPendingDirectCosts(env, { tenantId, projectId }) {
  const [dcRes, billedMap, lineMap] = await Promise.all([
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs?per_page=300`, null),
    getBilledDirectCostMap(env, tenantId, projectId),
    getBilledDirectCostLineMap(env, tenantId, projectId)
  ]);
  if (dcRes.status !== 200) {
    throw new Error(`Failed to list direct costs: ${dcRes.status} ${JSON.stringify(dcRes.data)}`);
  }

  // Group per-line rows back to their parent DC (split "<dcId>:<lineItemId>"
  // on the first ':') — zero extra Procore calls, just string parsing.
  const lineRowsByDc = new Map();
  for (const [key, info] of lineMap) {
    const sep = key.indexOf(':');
    if (sep === -1) continue;
    const dcId = key.slice(0, sep);
    const lineItemId = Number(key.slice(sep + 1));
    if (!lineRowsByDc.has(dcId)) lineRowsByDc.set(dcId, []);
    lineRowsByDc.get(dcId).push({ ...info, lineItemId });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const billable = dcRes.data.filter(dc => dc.direct_cost_type !== 'payroll');
  const unbilled = [];
  const billed = [];
  const writtenOff = [];
  const budgeted = [];
  const needsLineFetch = []; // DCs with per-line rows and no legacy row — need a real fetch to find what's left

  for (const dc of billable) {
    const key = String(dc.id);
    const billedInfo = billedMap.get(key);
    const rawAmount = dc.amount != null ? Number(dc.amount) : (dc.grand_total != null ? Number(dc.grand_total) : 0);
    const record = {
      id: dc.id,
      type: dc.direct_cost_type,
      vendor: dc.vendor_name || dc.vendor?.name || null,
      description: dc.description || '',
      date: dc.direct_cost_date || null,
      amount: round2(rawAmount),
      status: dc.status || null
    };
    // 'written_off' and 'reconciled_to_period' ("Budgeted", Ben's ask
    // 2026-09-21) each get their own bucket — same reasoning as
    // listPendingTickets. A legacy whole-DC row (record_type='direct_cost')
    // always wins outright — per-line rows are never even consulted for a DC
    // that has one (see dcLineReconciliationKey above for why).
    if (billedInfo?.status === 'written_off') {
      writtenOff.push({
        ...record,
        writtenOffAmount: billedInfo.amount ?? record.amount,
        reasonCategory: billedInfo.reasonCategory,
        reasonNotes: billedInfo.reasonNotes,
        invoiceNumber: billedInfo.invoiceNumber
      });
    } else if (billedInfo?.status === 'reconciled_to_period') {
      budgeted.push({
        ...record,
        budgetedAmount: billedInfo.amount ?? record.amount,
        reasonNotes: billedInfo.reasonNotes
      });
    } else if (billedInfo) {
      billed.push({
        ...record,
        billedStatus: billedInfo.status,
        invoiceNumber: billedInfo.invoiceNumber,
        outsideLedgerLineCount: billedInfo.billedOutsideLedger ? 1 : 0,
        // Real billed amount (with markup) when we have it, not the raw cost —
        // same reasoning as T&M's billed-line display fix from 2026-09-14.
        billedAmount: billedInfo.amount ?? record.amount
      });
    } else if (lineRowsByDc.has(key)) {
      // Per-line billing activity, no legacy row — needs a real line-item
      // fetch to know how much (if anything) is left. Bounded to just DCs
      // actively mid-partial-billing, never the whole project's DC list.
      needsLineFetch.push({ record, lineRows: lineRowsByDc.get(key) });
    } else {
      unbilled.push(record);
    }
  }

  for (const { record, lineRows } of needsLineFetch) {
    const liRes = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs/${record.id}/line_items`);
    const rawLines = liRes.status === 200 ? (liRes.data || []) : [];
    const remaining = rawLines.filter(li => !lineRows.some(r => r.lineItemId === li.id));

    // Per-line write-off/budgeted (2026-09-23) means a DC's covering rows can
    // now be a MIX of billed/draft_co, written_off, and reconciled_to_period —
    // not just billed. Always attach the full breakdown so the frontend can
    // show e.g. "1 billed · 1 written off" regardless of which bucket wins.
    const billedRows = lineRows.filter(r => r.status === 'billed' || r.status === 'draft_co');
    const writtenOffRows = lineRows.filter(r => r.status === 'written_off');
    const budgetedRows = lineRows.filter(r => r.status === 'reconciled_to_period');
    const sumAmt = (rows) => round2(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
    const breakdown = {
      billedLineCount: billedRows.length,
      writtenOffLineCount: writtenOffRows.length,
      budgetedLineCount: budgetedRows.length,
      totalLineCount: rawLines.length,
      // Exact per-status dollars regardless of which bucket the DC lands in —
      // Review Project's rollup sums these.
      billedLineAmount: sumAmt(billedRows),
      writtenOffLineAmount: sumAmt(writtenOffRows),
      budgetedLineAmount: sumAmt(budgetedRows)
    };

    if (remaining.length === 0) {
      // Deterministic priority when covered by more than one disposition:
      // billed wins (a real Procore CO/invoice exists — most consequential),
      // then written off (carries a reason-category audit trail), then
      // budgeted. The three row sets partition lineRows, so no ties.
      if (billedRows.length > 0) {
        billed.push({
          ...record, ...breakdown,
          billedStatus: billedRows.some(r => r.status === 'draft_co') ? 'draft_co' : 'billed',
          outsideLedgerLineCount: billedRows.filter(r => r.billedOutsideLedger).length,
          invoiceNumber: billedRows.find(r => r.invoiceNumber)?.invoiceNumber || null,
          billedAmount: round2(billedRows.reduce((s, r) => s + (r.amount ?? 0), 0))
        });
      } else if (writtenOffRows.length > 0) {
        writtenOff.push({
          ...record, ...breakdown,
          writtenOffAmount: round2(writtenOffRows.reduce((s, r) => s + (r.amount ?? 0), 0)),
          reasonCategory: writtenOffRows[0].reasonCategory,
          reasonNotes: writtenOffRows[0].reasonNotes,
          invoiceNumber: writtenOffRows.find(r => r.invoiceNumber)?.invoiceNumber || null
        });
      } else {
        budgeted.push({
          ...record, ...breakdown,
          budgetedAmount: round2(budgetedRows.reduce((s, r) => s + (r.amount ?? 0), 0)),
          reasonNotes: budgetedRows[0].reasonNotes
        });
      }
    } else {
      const remainingAmount = round2(remaining.reduce((s, li) => s + Number(li.amount ?? 0), 0));
      unbilled.push({
        ...record, ...breakdown, ...partialDispositionFields(billedRows, writtenOffRows, budgetedRows),
        partialBilled: true,
        remainingAmount
      });
    }
  }

  return { unbilled, billed, writtenOff, budgeted };
}

// Serves both the inline "expand to pick lines" panel and a read-only "Full
// details" popout (Ben's ask 2026-09-22) — the caller decides whether to
// render checkboxes. Replaces the old directCostDetail, which never actually
// fetched line items and was never called from the frontend at all.
export async function directCostLineDetail(env, { tenantId, projectId, directCostId }) {
  const [dcRes, liRes, legacyMap, lineMap] = await Promise.all([
    procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs/${directCostId}`),
    procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs/${directCostId}/line_items`),
    getBilledDirectCostMap(env, tenantId, projectId),
    getBilledDirectCostLineMap(env, tenantId, projectId)
  ]);
  if (dcRes.status !== 200) {
    throw new Error(`Failed to fetch direct cost: ${dcRes.status} ${JSON.stringify(dcRes.data)}`);
  }
  if (liRes.status !== 200) {
    throw new Error(`Failed to fetch direct cost line items: ${liRes.status} ${JSON.stringify(liRes.data)}`);
  }
  const d = dcRes.data;
  const legacy = legacyMap.get(String(directCostId));
  const lines = (liRes.data || []).map(li => {
    const billed = legacy
      ? { status: legacy.status, invoiceNumber: legacy.invoiceNumber, amount: null }
      : lineMap.get(dcLineReconciliationKey(directCostId, li)) || null;
    return {
      id: li.id,
      description: li.description || '',
      costCode: li.cost_code?.full_code || null,
      wbsCodeId: li.wbs_code?.id || null,
      quantity: li.quantity != null ? Number(li.quantity) : null,
      unitCost: li.unit_cost != null ? Number(li.unit_cost) : null,
      uom: li.uom || null,
      amount: Number(li.amount ?? 0),
      billedStatus: billed?.status || null,
      invoiceNumber: billed?.invoiceNumber || null,
      billedAmount: billed?.amount ?? null
    };
  });
  return {
    id: d.id,
    type: d.direct_cost_type,
    vendor: d.vendor_name || d.vendor?.name || null,
    description: d.description || '',
    date: d.direct_cost_date || null,
    amount: d.amount != null ? Number(d.amount) : null,
    status: d.status || null,
    attachments: (d.attachments || [])
      .map(a => ({ filename: a.filename || a.name || 'attachment', url: a.url || null }))
      .filter(a => a.url),
    lines
  };
}

// One entry per selected direct cost, aggregating whichever of its line
// items are actually in play. Until 2026-09-22 a direct cost was ALWAYS
// tracked as one whole record for anti-double-billing purposes — the picker
// could only select a whole DC. Per-line billing (Ben's ask 2026-09-22)
// changed that: `resolvedSelection` may carry just a subset of a DC's real
// line items (see fetchUnbilledDcLines below), and billing_records now gets
// written per REAL LINE ITEM (record_type 'direct_cost_line', keyed by
// dcLineReconciliationKey), not per whole DC — see pushDirectCostToDraftCO /
// generateDirectCostInvoice / pushCombinedToDraftCO / generateCombinedInvoice
// below. A DC with no usable line items (seen live: a $0 void/placeholder
// expense, or every real line already billed) has no cost code to bill
// against and is skipped, surfaced to the caller rather than silently
// dropped. `rawLines` (the selected/remaining real line items, not
// necessarily all of them) is carried along for 'per_line_item' grouping
// below AND for the per-line billing_records write; every grouping mode
// still uses it for the latter even though only 'per_line_item' uses it for
// the former.
// Takes an already-resolved selection (Map<dcId, {dc, rawLines}> from
// fetchUnbilledDcLines below — rawLines already filtered to just this
// selection's still-unbilled lines) and turns it into one aggregate lineItem
// per DC. `cost` now sums the SELECTED lines' own real `amount` fields rather
// than trusting the DC's header total (`dc.amount`/`grand_total`) — confirmed
// live 2026-09-22 that the header can sit null indefinitely on a DC that's
// had lines added to it (not just transiently, per the original 2026-09-17
// note below), so summing the real lines is the only reliable path once
// per-line selection exists, not just a nicety for partial bills.
async function buildDirectCostLineItems(resolvedSelection, markupPercent) {
  const markup = markupPercent != null && markupPercent !== '' ? Number(markupPercent) : 20;
  if (!Number.isFinite(markup) || markup < 0) {
    throw new Error(`Invalid markup percent: ${markupPercent}`);
  }
  const lineItems = [];
  const skipped = [];
  for (const { dc, rawLines } of resolvedSelection.values()) {
    const wbsCodeId = rawLines[0]?.wbs_code?.id;
    if (!wbsCodeId) {
      skipped.push({ id: dc.id, description: dc.description });
      continue;
    }
    const cost = Math.round(rawLines.reduce((s, li) => s + Number(li.amount ?? 0), 0) * 100) / 100;
    const amount = Math.round(cost * (1 + markup / 100) * 100) / 100;
    const vendor = dc.vendor_name || dc.vendor?.name || 'Unknown vendor';
    lineItems.push({
      directCostId: dc.id,
      description: `${vendor}${dc.description ? ` - ${dc.description}` : ''}${dc.direct_cost_date ? ` (${dc.direct_cost_date})` : ''}`,
      cost,
      markupPercent: markup,
      amount,
      hours: 1,
      wbsCodeId,
      rawLines
    });
  }
  return { lineItems, skipped, markup };
}

// Groups the flat per-DC lineItems into the actual CO lines for the chosen
// mode (Ben's ask 2026-09-17, mirrors T&M's buildCOLines/computeCOLines
// above — same finest/unchanged/blended three-way split, same `members`
// back-reference so a grouped line's amount can be traced to what it's made
// of):
//   'per_dc' (default) — today's original behavior: one CO line per direct
//     cost, unchanged.
//   'per_line_item' — one CO line per direct cost's own real line item, each
//     under ITS OWN cost code (fixes a real gap: a direct cost with several
//     differently-coded line items used to get billed entirely under just
//     the first one's code). A line item missing a cost code fails the whole
//     build rather than silently dropping its dollar amount, same principle
//     as a whole direct cost with no line items at all.
//   'total' — every selected direct cost's marked-up amount summed onto ONE
//     line, under the FIRST selected direct cost's cost code — same
//     "blended, you lose the breakdown" tradeoff as T&M's 'total' mode.
function buildDirectCostCOLines(lineItems, groupBy, markup) {
  const effectiveGroupBy = groupBy || 'per_dc';

  if (effectiveGroupBy === 'per_dc') {
    return lineItems.map(l => ({ ...l, members: [l] }));
  }

  if (effectiveGroupBy === 'per_line_item') {
    const coLines = [];
    for (const l of lineItems) {
      for (const raw of l.rawLines) {
        const wbsCodeId = raw.wbs_code?.id;
        if (!wbsCodeId) {
          throw new Error(
            `"${raw.description || 'a line item'}" on "${l.description}" has no cost code in Procore — ` +
            `fix it there, or switch to a different grouping, before billing this selection.`
          );
        }
        const cost = Number(raw.amount ?? 0);
        const amount = Math.round(cost * (1 + markup / 100) * 100) / 100;
        coLines.push({
          description: `${l.description}${raw.description ? ` - ${raw.description}` : ''}`,
          cost, markupPercent: markup, amount, hours: 1, wbsCodeId, members: [l]
        });
      }
    }
    return coLines;
  }

  if (effectiveGroupBy === 'total') {
    const totalCost = Math.round(lineItems.reduce((s, l) => s + l.cost, 0) * 100) / 100;
    const amount = Math.round(totalCost * (1 + markup / 100) * 100) / 100;
    const label = lineItems.length > 1
      ? `${lineItems.length} Direct Costs — blended`
      : (lineItems[0]?.description || 'Direct Cost');
    return [{
      description: label, cost: totalCost, markupPercent: markup, amount, hours: 1,
      wbsCodeId: lineItems[0]?.wbsCodeId, members: lineItems
    }];
  }

  throw new Error(`Unknown direct-cost group_by: ${groupBy}`);
}

// Applies a PM's preview-screen description edit to one computed direct-cost
// line — description only (unlike T&M's applyLineEdit, which also lets the
// rate change). A direct-cost line has no "rate" to edit without touching
// cost/markup/amount, and Ben was explicit 2026-09-16 that markup must stay
// baked into the one line, never exposed as its own adjustable thing — so
// the only safe edit here is cosmetic.
function applyDirectCostLineEdit(coLine, edit) {
  if (!edit) return;
  if (edit.description != null && String(edit.description).trim() !== '') {
    coLine.description = String(edit.description);
  }
}

// Fetches many direct costs by id sequentially, with requestWithRetry — same
// concurrent-burst risk fetchEntriesAndTimecards had for T&M entries applies
// here too: a Promise.all over a large directCostIds batch fires every GET at
// once and can blow through the shared rate-limit bucket before any pacing
// logic sees a response to react to.
async function fetchDirectCostsByIds(env, projectId, directCostIds, onProgress = () => {}) {
  const directCosts = [];
  for (const id of directCostIds) {
    const res = await requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs/${id}`, null, onProgress);
    if (res.status !== 200) throw new Error(`Failed to fetch direct cost ${id}: ${res.status} ${JSON.stringify(res.data)}`);
    await throttleForRateLimit(res.headers, onProgress);
    directCosts.push(res.data);
  }
  return directCosts;
}

// Resolves the caller's selection into real Procore direct costs plus,
// per DC, exactly which of its real line items are still billable —
// mirrors fetchUnbilledTmLines' per-timecard filtering (see above) for DC
// line items instead of timecards. `directCostIds` (whole DCs) get the
// 'ALL' sentinel — "bill everything still unbilled here," T&M's ticket-level
// checkbox convenience. `directCostLineIds` ("<dcId>:<lineItemId>" strings,
// matching dcLineReconciliationKey's own format) are explicit per-line picks.
// A DC with an existing LEGACY whole-DC row (record_type='direct_cost') is a
// hard error here, never a silent skip — that DC was billed under the old
// atomic scheme and must never be reconciled against the new per-line map
// (see dcLineReconciliationKey above). A DC whose selected lines are
// individually already-billed under the NEW per-line scheme is filtered out
// silently instead — that's the whole point, "leave it for later," same as
// fetchUnbilledTmLines' `if (billedIds.has(key)) continue`.
async function fetchUnbilledDcLines(env, {
  tenantId, projectId, directCostIds = [], directCostLineIds = [], onProgress = () => {},
  nothingMessage = 'Nothing to bill — every selected line item is already billed, in a draft Change Order, or accounted for.'
}) {
  const selectedLineIdsByDc = new Map(); // dcId(string) -> 'ALL' | Set<lineItemId(number)>
  for (const id of directCostIds) {
    selectedLineIdsByDc.set(String(id), 'ALL');
  }
  for (const key of directCostLineIds) {
    const sep = String(key).indexOf(':');
    if (sep === -1) throw new Error(`Malformed direct cost line id: ${key}`);
    const dcId = key.slice(0, sep);
    const lineId = Number(key.slice(sep + 1));
    const existing = selectedLineIdsByDc.get(dcId);
    if (existing === 'ALL') continue; // whole-DC selection already covers it
    const set = existing instanceof Set ? existing : new Set();
    set.add(lineId);
    selectedLineIdsByDc.set(dcId, set);
  }
  if (selectedLineIdsByDc.size === 0) {
    throw new Error('Nothing selected — pick at least one direct cost or direct cost line item.');
  }

  const legacyMap = await getBilledDirectCostMap(env, tenantId, projectId);
  const alreadyBilledWhole = [...selectedLineIdsByDc.keys()].filter(id => legacyMap.has(id));
  if (alreadyBilledWhole.length > 0) {
    throw new Error(`${alreadyBilledWhole.length} of these direct cost(s) are already billed or in a draft Change Order — refresh and try again.`);
  }

  const lineMap = await getBilledDirectCostLineMap(env, tenantId, projectId);
  const dcIds = [...selectedLineIdsByDc.keys()];
  const directCosts = await fetchDirectCostsByIds(env, projectId, dcIds, onProgress);

  const resolvedSelection = new Map(); // dcId -> { dc, rawLines }
  for (const dc of directCosts) {
    const dcId = String(dc.id);
    const liRes = await requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/direct_costs/${dc.id}/line_items`, null, onProgress);
    if (liRes.status !== 200) {
      throw new Error(`Failed to fetch line items for direct cost ${dc.id}: ${liRes.status} ${JSON.stringify(liRes.data)}`);
    }
    await throttleForRateLimit(liRes.headers, onProgress);
    const rawLines = liRes.data || [];
    const selection = selectedLineIdsByDc.get(dcId);
    const candidates = selection === 'ALL' ? rawLines : rawLines.filter(li => selection.has(li.id));
    const remaining = candidates.filter(li => !lineMap.has(dcLineReconciliationKey(dc.id, li)));
    if (remaining.length > 0) {
      resolvedSelection.set(dcId, { dc, rawLines: remaining });
    }
  }
  if (resolvedSelection.size === 0) {
    throw new Error(nothingMessage);
  }
  return resolvedSelection;
}

// Everything through "what would this bill?" for direct costs — mirrors
// computeCOLines' role for T&M (mode check, already-billed check, fetch,
// build lines, apply preview edits, validate) so previewDirectCostBilling and
// buildDirectCostChangeEventAndOrder can never drift from each other, same
// reasoning as computeCOLines/buildChangeEventAndOrder above. Previously
// inlined directly in buildDirectCostChangeEventAndOrder; extracted
// 2026-09-16 so the new combined (T&M + direct cost) flow can compute direct
// cost lines without also building a Change Event.
async function computeDirectCostLines(env, {
  tenantId, projectId, directCostIds = [], directCostLineIds = [], markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
  if (mode === 'non_billable') {
    const err = new Error(
      `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
      `Override the billing mode for this project in LEDGER if that's wrong.`
    );
    err.code = 'NON_BILLABLE_PROJECT';
    throw err;
  }

  const resolvedSelection = await fetchUnbilledDcLines(env, { tenantId, projectId, directCostIds, directCostLineIds, onProgress });
  const directCosts = [...resolvedSelection.values()].map(v => v.dc);
  const multi = directCosts.length > 1;
  const label = multi
    ? `${directCosts.length} Direct Costs`
    : (directCosts[0].description || `Direct Cost #${directCosts[0].id}`);
  onProgress({ message: `Fetched ${directCosts.length} direct cost(s)` });

  const { lineItems, skipped, markup } = await buildDirectCostLineItems(resolvedSelection, markupPercent);
  if (skipped.length > 0) {
    throw new Error(
      `Could not find a cost code on ${skipped.length} direct cost(s) — ` +
      `${skipped.map(s => `"${s.description || s.id}"`).join(', ')}. Each needs at least one line item with a ` +
      `cost code in Procore before LEDGER can bill it (a $0 void/placeholder direct cost has none, for example).`
    );
  }
  if (lineItems.length === 0) {
    throw new Error('Nothing to bill — none of the selected direct costs have a usable cost code.');
  }

  const coLines = buildDirectCostCOLines(lineItems, groupBy, markup);
  onProgress({ message: `Grouped into ${coLines.length} Change Order line item(s) (${groupBy || 'per_dc (default)'})` });

  // Preview/edit screen overrides (description only — see
  // applyDirectCostLineEdit) — same length-mismatch guard as computeCOLines'
  // editedLines handling, same reasoning: the selection changed since preview.
  if (editedLines) {
    if (editedLines.length !== coLines.length) {
      throw new Error(
        `This selection has changed since the preview was shown (${coLines.length} line(s) now vs. ${editedLines.length} previewed) — ` +
        `go back and preview again before confirming.`
      );
    }
    coLines.forEach((line, i) => applyDirectCostLineEdit(line, editedLines[i]));
  }

  const totalAmount = Math.round(coLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  onProgress({ message: `${coLines.length} direct cost(s) to bill — $${totalAmount.toLocaleString()} (markup included)` });

  const MAX_CO_LINES = 35;
  if (coLines.length > MAX_CO_LINES) {
    throw new Error(
      `This selection needs ${coLines.length} Change Order line items — too many for one reliable build ` +
      `(limit ${MAX_CO_LINES}). Bill fewer direct costs at once.`
    );
  }

  return { directCosts, multi, label, lineItems, coLines, totalAmount, mode };
}

// Preview for direct costs — mirrors previewBilling (T&M), same idea: exactly
// what a real push would create, no Procore writes. Doesn't need the
// unlinked-timecard concept T&M's preview has (nothing analogous exists for
// direct costs).
export async function previewDirectCostBilling(env, { tenantId, projectId, directCostIds, directCostLineIds, markupPercent, groupBy }) {
  const { label, totalAmount, coLines } = await computeDirectCostLines(env, {
    tenantId, projectId, directCostIds, directCostLineIds, markupPercent, groupBy
  });
  return {
    label,
    totalAmount,
    lines: coLines.map(l => ({ description: l.description, cost: l.cost, markupPercent: l.markupPercent, amount: l.amount }))
  };
}

// Mirrors buildChangeEventAndOrder's shape (CE create -> CO create -> line
// items -> rollback-on-failure) but for direct costs instead of T&M
// timecards — kept as its own function rather than forcing a shared
// abstraction over two meaningfully different domains (no "link back to a
// ticket" step exists for direct costs; lines are flat dollar amounts, not
// hours). Reuses the genuinely generic pieces: resolveBillingMode,
// findBillableContract, rollbackChangeEventAndOrder, throttleForRateLimit.
async function buildDirectCostChangeEventAndOrder(env, {
  tenantId, projectId, directCostIds, directCostLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const { directCosts, label, lineItems, coLines, totalAmount } = await computeDirectCostLines(env, {
    tenantId, projectId, directCostIds, directCostLineIds, markupPercent, groupBy, editedLines, onProgress
  });

  // 1. Build the Change Event — same reasoning as T&M's (see
  // buildChangeEventAndOrder above): gives the CE its own real dollar value
  // instead of leaving Procore to derive it later. quantity is always 1 here
  // (unit_of_measure 'LS' — lump sum) since these are dollar costs, not hours.
  // Retries on 429 same as the CO line-item loop and generic build above —
  // see buildChangeEventAndOrder's comment for the full reasoning.
  const ceRes = await requestWithRetry(env, 'POST', `/rest/v1.1/change_events?project_id=${projectId}`, {
    change_event: {
      title: label,
      description: `LEDGER-generated from ${label}`,
      scope: 'in_scope',
      status: { id: 562949953739902 }, // Open — confirmed real id for this company
      change_items: coLines.map(line => ({
        description: line.description,
        revenue_impact: {
          estimate: {
            quantity: '1',
            unit_cost: String(line.amount),
            amount: String(line.amount),
            unit_of_measure: 'LS',
            calculation_strategy: 'manual'
          }
        },
        budget_code: { id: String(line.wbsCodeId) }
      }))
    }
  }, onProgress);
  if (ceRes.status !== 201) {
    throw new Error(`Failed to create Change Event: ${ceRes.status} ${JSON.stringify(ceRes.data)}`);
  }
  const changeEventId = ceRes.data.id;
  onProgress({ message: `Change Event created — id ${changeEventId} ($${totalAmount.toLocaleString()} value)`, changeEventId });

  // 2. Build the Prime Change Order. No "link back" step here — unlike T&M
  // tickets, direct costs have no equivalent bulk_update endpoint to attach
  // them to a Change Event in Procore's own UI.
  let contractId, changeOrderId;
  try {
    contractId = primeContractId || await findBillableContract(env, projectId);
    const coRes = await requestWithRetry(env, 'POST', `/rest/v1.0/projects/${projectId}/prime_change_orders`, {
      change_order: {
        contract_id: contractId,
        title: label,
        description: `LEDGER-generated from ${label}`,
        status: 'draft',
        reason: 'Direct cost billing'
      }
    }, onProgress);
    if (coRes.status !== 201) {
      throw new Error(`Failed to create Prime Change Order: ${coRes.status} ${JSON.stringify(coRes.data)}`);
    }
    changeOrderId = coRes.data.id;
    onProgress({ message: `Change Order created (draft) — id ${changeOrderId}`, changeOrderId });
  } catch (e) {
    onProgress({ message: 'Failed before the Change Order was ready — rolling back the Change Event…' });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    throw new Error(
      `${e.message} ${rb.ceDeleted ? '(the Change Event was rolled back — nothing left behind)' : '(COULD NOT roll back the Change Event — check Procore manually, it may still exist)'}`
    );
  }

  // 3. Add every CO line item — same rollback-on-first-failure discipline as
  // T&M (see buildChangeEventAndOrder above): never leave a wrong-amount
  // partial CO behind silently.
  let addedCount = 0;
  let lineFailure = null;
  for (const line of coLines) {
    try {
      const lineRes = await requestWithRetry(
        env, 'POST',
        `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/prime_change_orders/${changeOrderId}/line_items`,
        { description: line.description, quantity: '1', unit_cost: String(line.amount), uom: 'LS', wbs_code_id: String(line.wbsCodeId) },
        onProgress
      );
      await throttleForRateLimit(lineRes.headers, onProgress);
      if (lineRes.status !== 201) {
        lineFailure = { description: line.description, error: `${lineRes.status} ${JSON.stringify(lineRes.data)}` };
        break;
      }
      addedCount++;
      onProgress({ message: `Added line ${addedCount}/${coLines.length}: ${line.description} — $${line.amount.toLocaleString()}` });
    } catch (e) {
      lineFailure = { description: line.description, error: e.message };
      break;
    }
  }

  if (lineFailure) {
    onProgress({ message: `Failed on line ${addedCount + 1}/${coLines.length} — rolling back…` });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    const rollbackNote = (rb.coDeleted && rb.ceDeleted)
      ? 'Rolled back the Change Event and Change Order — nothing was left half-built.'
      : `Rollback ${rb.coDeleted ? 'removed' : 'could NOT remove'} the Change Order and ` +
        `${rb.ceDeleted ? 'removed' : 'could NOT remove'} the Change Event — check Procore manually if either failed.`;
    throw new Error(
      `Only added ${addedCount} of ${coLines.length} line items to the Change Order, then failed on ` +
      `"${lineFailure.description}": ${lineFailure.error}. ${rollbackNote}`
    );
  }
  onProgress({ message: `All ${coLines.length} line item(s) added — $${totalAmount.toLocaleString()} total` });

  return { directCosts, contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label };
}

// "Push to CO" for direct costs — stops at a draft Change Order for manual
// review, same as pushToDraftCO does for T&M tickets. billing_records is
// written per REAL LINE ITEM (see dcBillingRows above), not per whole direct
// cost — a DC can be billed partially since 2026-09-22, so that's the real
// anti-double-billing granularity now.
export async function pushDirectCostToDraftCO(env, {
  tenantId, projectId, directCostId, directCostIds, directCostLineIds = [], userId, primeContractId, markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const ids = normalizeDcIds(directCostId, directCostIds);
  if (ids.length === 0 && directCostLineIds.length === 0) {
    throw new Error('direct_cost_id, direct_cost_ids, or direct_cost_line_ids is required');
  }
  const { contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label } =
    await buildDirectCostChangeEventAndOrder(env, { tenantId, projectId, directCostIds: ids, directCostLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress });

  const rows = dcBillingRows(lineItems);
  await insertBillingRecordsBatch(env, rows.map(row => ({
    ...row, tenantId, projectId, status: 'draft_co', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${rows.length} direct cost line item(s) as pushed to draft` });

  return { contractId, changeEventId, changeOrderId, totalAmount, linesPushed: coLines.length, label };
}

// "Generate Invoice" for direct costs — same full pipeline as T&M's
// generateInvoice (billing period -> CE/CO -> approve -> invoice -> claim to
// 100%), reusing approveAndInvoiceChangeOrder since that part is already
// fully generic.
export async function generateDirectCostInvoice(env, {
  tenantId, projectId, directCostId, directCostIds, directCostLineIds = [], userId, primeContractId, markupPercent, groupBy,
  editedLines, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  if (!billingDate) {
    throw new Error('billingDate is required');
  }
  const billingPeriod = await findOrCreateBillingPeriod(env, projectId, billingPeriodId, newBillingPeriod);
  onProgress({ message: `Billing period ready — id ${billingPeriod.id}` });

  const ids = normalizeDcIds(directCostId, directCostIds);
  if (ids.length === 0 && directCostLineIds.length === 0) {
    throw new Error('direct_cost_id, direct_cost_ids, or direct_cost_line_ids is required');
  }
  const { contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label } =
    await buildDirectCostChangeEventAndOrder(env, { tenantId, projectId, directCostIds: ids, directCostLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress });

  const { invoice, claimedCount, failedLines } = await approveAndInvoiceChangeOrder(env, {
    projectId, contractId, changeOrderId, coLines, billingPeriod, invoiceNumber, billingDate, onProgress
  });

  const rows = dcBillingRows(lineItems);
  await insertBillingRecordsBatch(env, rows.map(row => ({
    ...row, tenantId, projectId, invoiceId: String(invoice.id), invoiceNumber: invoice.invoice_number,
    status: 'billed', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${rows.length} direct cost line item(s) as billed` });

  return {
    contractId,
    changeEventId,
    changeOrderId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    totalAmount,
    linesbilled: lineItems.length,
    label,
    claimedCount,
    totalCoLines: coLines.length,
    unclaimedLines: failedLines
  };
}

// ============================================================
// Commitments / subcontractor invoices (Ben's ask 2026-09-24) — billable
// line-by-line, same shape as direct costs (bill/write-off/budget with
// markup), but for a Commitment's (Work Order / Purchase Order Contract) own
// real line items. LEDGER never creates or modifies a Commitment or a
// Requisition itself — Einvoice owns that (see project memory) — this only
// uses a commitment's line items as a billing SOURCE.
//
// Uses Procore's v2.0 commitment_contracts endpoints (verified live
// 2026-09-24): the list carries grand_total (one call for the whole project)
// and each line carries its own budget code (wbs_code_id), same as a direct
// cost line. The older v1.0 /commitments endpoints hide both — don't go back
// to them. Neither version returns the vendor's name, only its id, so names
// come from the project vendors directory (one call).
//
// The `is_estimated` rule (Ben's ask, confirmed 2026-09-24): Procore's public
// API only exposes a Requisition's COMMITMENT-level totals, never which
// specific line the subcontractor has invoiced. So the flag is
// commitment-level: the first time ANY line on a commitment is billed before
// a real Requisition exists for it, that commitment's new rows get
// `is_estimated = true`, and NO further billing is allowed on it until the
// (deferred, not built) CO-delta reconciliation workflow exists. Write-off
// and Mark-as-Budgeted are exempt — see resolveCommitmentSelection.
//
// Labour from a commitment (Ben's ask 2026-09-24): Einvoice builds Work Order
// Contract lines one per subcontractor timecard, and the SAME timecard can sit
// on a T&M ticket. Billing both double-bills the client. The link is the
// "Timecard #<n>" in Einvoice's line description, where <n> is the T&M
// timecard's timecard_entry_id (LEDGER's T&M reconciliation key). Hours
// already billed/drafted through T&M are a hard block here; hours billed
// through a commitment are treated as billed on the T&M side too (see
// getBilledTimecardMap). Everything short of a certain double-bill (labour
// lines generally, hours on a not-yet-billed T&M ticket) is a soft warning
// in the frontend, not a block — Ben doesn't want it outlawed.
// ============================================================

// Subcontractor labour = a line Einvoice built from a sub's timecard. NOT
// identified by cost type or cost code (Ben, 2026-09-24): sub labour comes
// through as cost type S (Commitment), not L, and historical cost code/type
// use is too inconsistent to key guardrails on without blocking legitimate
// billing on older projects.
function isLabourLine(line) {
  return einvoiceTimecardKey(line) != null;
}

// Einvoice-specific: parses "Timecard #<n>" out of the line description. A
// description-format change on Einvoice's side silently breaks this — the
// structured fix (Einvoice writing it to the line's origin_id) is noted in
// project memory, not built.
function einvoiceTimecardKey(line) {
  return (line.description || '').match(/Timecard #(\d+)/)?.[1] ?? null;
}

// What goes on the client's CO/invoice: Einvoice's "(Timecard #…)" is an
// internal reference only (Ben, 2026-09-24). LEDGER's own UI keeps it.
function clientLineDescription(line) {
  return (line.description || '').replace(/\s*\(Timecard #\d+\)/g, '').trim();
}

// A line with no real budget code can't go on a Prime CO. Old test-project
// Purchase Orders have a wbs_code object with an EMPTY flat_code — treated
// the same as missing.
function hasBudgetCode(line) {
  return !!(line.wbs_code_id && line.wbs_code?.flat_code);
}

function commitmentLabel(c) {
  return `${c.vendor_name || c.title || 'Unknown vendor'} — ${c.number || `Commitment #${c.id}`}`;
}

function commitmentsBase(env, projectId) {
  return `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/commitment_contracts`;
}

async function getBilledCommitmentLineMap(env, tenantId, projectId) {
  return getBilledRecordMap(env, tenantId, projectId, 'commitment_line');
}

// "<commitment_id>:<line_item_id>" — mirrors dcLineReconciliationKey exactly:
// fail loud on a null line id rather than risk colliding two lines onto one key.
function commitmentLineReconciliationKey(commitmentId, lineItem) {
  if (lineItem?.id == null) {
    throw new Error(`Commitment ${commitmentId} has a line item with no id — cannot bill it individually.`);
  }
  return `${commitmentId}:${lineItem.id}`;
}

// Mirrors dcBillingRows — one billing_records row per REAL line item.
// `isEstimated` is a commitment-level fact carried on every row (that's where
// getBilledRecordMap reads it from). `sourceTimecardKey` is what lets T&M
// see these hours as billed (see getBilledTimecardMap).
function commitmentBillingRows(lineItems) {
  return lineItems.flatMap(line =>
    line.rawLines.map(raw => ({
      recordType: 'commitment_line',
      procoreRecordId: commitmentLineReconciliationKey(line.commitmentId, raw),
      amount: Math.round(Number(raw.amount ?? 0) * (1 + line.markupPercent / 100) * 100) / 100,
      isEstimated: line.isEstimated === true,
      sourceTimecardKey: einvoiceTimecardKey(raw)
    }))
  );
}

function normalizeCommitmentIds(commitmentId, commitmentIds) {
  const raw = (Array.isArray(commitmentIds) && commitmentIds.length)
    ? commitmentIds
    : (commitmentId != null ? [commitmentId] : []);
  return [...new Set(raw.map(String).filter(Boolean))];
}

// Procore's v2.0 endpoints page their results (default page size is 10 —
// verified 2026-09-24 when a 21-line commitment came back with only 10). Walks
// pages until one comes back short. Unwraps v2.0's {data: [...]} envelope.
async function fetchAllV2Pages(env, path, onProgress = () => {}) {
  const PER_PAGE = 100;
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await requestWithRetry(env, 'GET', `${path}${sep}page=${page}&per_page=${PER_PAGE}`, null, onProgress);
    if (res.status !== 200) return { status: res.status, data: res.data, items: null };
    await throttleForRateLimit(res.headers, onProgress);
    const items = res.data?.data || [];
    all.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return { status: 200, items: all };
}

async function fetchVendorNames(env, projectId) {
  const res = await procoreRequest(env, 'GET', `/rest/v1.0/projects/${projectId}/vendors`);
  const names = new Map();
  if (res.status === 200 && Array.isArray(res.data)) {
    for (const v of res.data) names.set(String(v.id), v.name || v.company || null);
  }
  return names;
}

// Every commitment header on the project, with vendor_name attached.
async function fetchCommitmentHeaders(env, projectId) {
  const [listRes, vendorNames] = await Promise.all([
    fetchAllV2Pages(env, commitmentsBase(env, projectId)),
    fetchVendorNames(env, projectId)
  ]);
  if (listRes.status !== 200) {
    throw new Error(`Failed to list commitments: ${listRes.status} ${JSON.stringify(listRes.data)}`);
  }
  return listRes.items.map(c => ({ ...c, vendor_name: vendorNames.get(String(c.vendor?.id)) || null }));
}

async function fetchCommitmentLines(env, projectId, commitmentId, onProgress = () => {}) {
  const res = await fetchAllV2Pages(env, `${commitmentsBase(env, projectId)}/${commitmentId}/line_items`, onProgress);
  if (res.status !== 200) {
    throw new Error(`Failed to fetch line items for commitment ${commitmentId}: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.items;
}

// Headers come from ONE list call; lines are one call per commitment,
// sequential (same concurrent-burst reasoning as fetchDirectCostsByIds).
// Returned objects carry `line_items` so callers can treat them like a
// self-contained commitment.
async function fetchCommitmentsByIds(env, projectId, commitmentIds, onProgress = () => {}) {
  const headers = await fetchCommitmentHeaders(env, projectId);
  const byId = new Map(headers.map(c => [String(c.id), c]));
  const commitments = [];
  for (const id of commitmentIds) {
    const header = byId.get(String(id));
    if (!header) throw new Error(`Commitment ${id} not found on this project — it may have been deleted in Procore.`);
    commitments.push({ ...header, line_items: await fetchCommitmentLines(env, projectId, id, onProgress) });
  }
  return commitments;
}

// Non-empty result = the subcontractor has actually invoiced this commitment.
// A failed lookup defaults to FALSE (treat as not-yet-invoiced) — the safer bias.
async function hasRealRequisition(env, projectId, commitmentId) {
  const res = await procoreRequest(env, 'GET', `/rest/v1.0/requisitions?project_id=${projectId}&filters[commitment_id]=${commitmentId}`);
  if (res.status !== 200) return false;
  return Array.isArray(res.data) && res.data.length > 0;
}

// Shared selection resolution — turns a caller's pick ('ALL' whole commitments
// or explicit "<commitmentId>:<lineItemId>" picks) into a
// Map<commitmentId, {commitment, rawLines}> of exactly what's still unbilled.
// Deliberately applies NEITHER the is_estimated gate NOR the T&M
// double-billing block — write-off/markAsBudgeted share this and must stay
// exempt (they never bill the client). The billing path layers both on top
// — see fetchUnbilledCommitmentLines. Line ids are compared as strings (v2.0
// returns string ids).
async function resolveCommitmentSelection(env, { tenantId, projectId, commitmentIds = [], commitmentLineIds = [], onProgress = () => {} }) {
  const selectedLineIdsByCommitment = new Map(); // commitmentId -> 'ALL' | Set<lineItemId string>
  for (const id of commitmentIds) {
    selectedLineIdsByCommitment.set(String(id), 'ALL');
  }
  for (const key of commitmentLineIds) {
    const sep = String(key).indexOf(':');
    if (sep === -1) throw new Error(`Malformed commitment line id: ${key}`);
    const commitmentId = key.slice(0, sep);
    const lineId = key.slice(sep + 1);
    const existing = selectedLineIdsByCommitment.get(commitmentId);
    if (existing === 'ALL') continue;
    const set = existing instanceof Set ? existing : new Set();
    set.add(lineId);
    selectedLineIdsByCommitment.set(commitmentId, set);
  }
  if (selectedLineIdsByCommitment.size === 0) {
    throw new Error('Nothing selected — pick at least one commitment or commitment line item.');
  }

  const lineMap = await getBilledCommitmentLineMap(env, tenantId, projectId);
  const commitments = await fetchCommitmentsByIds(env, projectId, [...selectedLineIdsByCommitment.keys()], onProgress);

  const resolvedSelection = new Map();
  for (const commitment of commitments) {
    const commitmentId = String(commitment.id);
    const selection = selectedLineIdsByCommitment.get(commitmentId);
    const candidates = selection === 'ALL' ? commitment.line_items : commitment.line_items.filter(li => selection.has(String(li.id)));
    const remaining = candidates.filter(li => !lineMap.has(commitmentLineReconciliationKey(commitmentId, li)));
    if (remaining.length > 0) {
      resolvedSelection.set(commitmentId, { commitment, rawLines: remaining });
    }
  }
  return { resolvedSelection, lineMap };
}

// Billing-only wrapper around resolveCommitmentSelection. Two hard blocks,
// both certain double-bills rather than judgement calls:
//   1. is_estimated — see header comment.
//   2. The line's timecard was already billed or drafted through T&M (or via
//      another commitment line) — see header comment.
// Then attaches whether each commitment's NEW rows should be is_estimated.
async function fetchUnbilledCommitmentLines(env, {
  tenantId, projectId, commitmentIds = [], commitmentLineIds = [], onProgress = () => {},
  nothingMessage = 'Nothing to bill — every selected line item is already billed, in a draft Change Order, or accounted for.'
}) {
  const [{ resolvedSelection, lineMap }, billedTimecards] = await Promise.all([
    resolveCommitmentSelection(env, { tenantId, projectId, commitmentIds, commitmentLineIds, onProgress }),
    getBilledTimecardMap(env, tenantId, projectId)
  ]);

  const estimatedCommitmentIds = new Set();
  for (const [key, info] of lineMap) {
    if (info.isEstimated) {
      const sep = key.indexOf(':');
      if (sep !== -1) estimatedCommitmentIds.add(key.slice(0, sep));
    }
  }
  const blockedEstimated = [...resolvedSelection.keys()].filter(id => estimatedCommitmentIds.has(id));
  if (blockedEstimated.length > 0) {
    throw new Error(
      `${blockedEstimated.length} of these commitment(s) already have an ESTIMATED line billed (billed before the ` +
      `subcontractor invoiced it) — no further billing is allowed on ${blockedEstimated.length > 1 ? 'them' : 'it'} until a real ` +
      `Requisition exists and a reconciling Change Order is built. Reconcile manually in Procore for now.`
    );
  }

  const alreadyBilledHours = [];
  for (const { commitment, rawLines } of resolvedSelection.values()) {
    for (const li of rawLines) {
      const tcKey = einvoiceTimecardKey(li);
      const billed = tcKey && billedTimecards.get(tcKey);
      if (billed && (billed.status === 'billed' || billed.status === 'draft_co')) {
        alreadyBilledHours.push(
          `"${li.description || commitmentLabel(commitment)}" (${billed.status === 'draft_co' ? 'in a draft Change Order' : `invoice ${billed.invoiceNumber || '—'}`})`
        );
      }
    }
  }
  if (alreadyBilledHours.length > 0) {
    const err = new Error(
      `${alreadyBilledHours.length} selected line(s) are hours that were already billed — billing them again from ` +
      `the commitment would double-bill the client: ${alreadyBilledHours.join('; ')}. Deselect them to continue.`
    );
    err.code = 'TIMECARD_ALREADY_BILLED';
    throw err;
  }

  const withEstimatedFlag = new Map();
  for (const [commitmentId, { commitment, rawLines }] of resolvedSelection) {
    const isEstimated = !(await hasRealRequisition(env, projectId, commitment.id));
    withEstimatedFlag.set(commitmentId, { commitment, rawLines, isEstimated });
  }
  if (withEstimatedFlag.size === 0) {
    throw new Error(nothingMessage);
  }
  return withEstimatedFlag;
}

// One entry per selected commitment — mirrors buildDirectCostLineItems,
// including its simplification of billing the aggregate under the FIRST
// selected line's budget code ('per_line_item' grouping keeps each line's
// own). A commitment whose lines lack a budget code is skipped and reported,
// never silently dropped.
function buildCommitmentLineItems(resolvedSelection, markupPercent) {
  const markup = markupPercent != null && markupPercent !== '' ? Number(markupPercent) : 20;
  if (!Number.isFinite(markup) || markup < 0) {
    throw new Error(`Invalid markup percent: ${markupPercent}`);
  }
  const lineItems = [];
  const skipped = [];
  for (const { commitment, rawLines, isEstimated } of resolvedSelection.values()) {
    const first = rawLines.find(hasBudgetCode);
    if (!first) {
      skipped.push({ id: commitment.id, description: commitmentLabel(commitment), reason: 'no budget code on its line items' });
      continue;
    }
    const cost = Math.round(rawLines.reduce((s, li) => s + Number(li.amount ?? 0), 0) * 100) / 100;
    const amount = Math.round(cost * (1 + markup / 100) * 100) / 100;
    lineItems.push({
      commitmentId: commitment.id,
      // Never put the estimated flag in the description — it lands on the
      // client-facing CO/invoice. isEstimated travels as its own field instead.
      description: commitmentLabel(commitment),
      cost,
      markupPercent: markup,
      amount,
      wbsCodeId: first.wbs_code_id,
      isEstimated,
      rawLines
    });
  }
  return { lineItems, skipped, markup };
}

// Mirrors buildDirectCostCOLines' three grouping modes ('per_commitment' ~
// DC's 'per_dc', 'per_line_item', 'total').
function buildCommitmentCOLines(lineItems, groupBy, markup) {
  const effectiveGroupBy = groupBy || 'per_commitment';

  if (effectiveGroupBy === 'per_commitment') {
    return lineItems.map(l => ({ ...l, members: [l] }));
  }

  if (effectiveGroupBy === 'per_line_item') {
    const coLines = [];
    for (const l of lineItems) {
      for (const raw of l.rawLines) {
        if (!hasBudgetCode(raw)) {
          throw new Error(
            `"${raw.description || 'a line item'}" on "${l.description}" has no budget code in Procore — ` +
            `fix it there, or switch to a different grouping, before billing this selection.`
          );
        }
        const cost = Number(raw.amount ?? 0);
        const amount = Math.round(cost * (1 + markup / 100) * 100) / 100;
        const rawDescription = clientLineDescription(raw);
        coLines.push({
          description: `${l.description}${rawDescription ? ` - ${rawDescription}` : ''}`,
          cost, markupPercent: markup, amount, wbsCodeId: raw.wbs_code_id, isEstimated: l.isEstimated, members: [l]
        });
      }
    }
    return coLines;
  }

  if (effectiveGroupBy === 'total') {
    const totalCost = Math.round(lineItems.reduce((s, l) => s + l.cost, 0) * 100) / 100;
    const amount = Math.round(totalCost * (1 + markup / 100) * 100) / 100;
    const label = lineItems.length > 1
      ? `${lineItems.length} Commitments — blended`
      : (lineItems[0]?.description || 'Commitment');
    return [{
      description: label, cost: totalCost, markupPercent: markup, amount,
      wbsCodeId: lineItems[0]?.wbsCodeId, isEstimated: lineItems.some(l => l.isEstimated), members: lineItems
    }];
  }

  throw new Error(`Unknown commitment group_by: ${groupBy}`);
}

// Mirrors applyDirectCostLineEdit exactly — description only, same reasoning
// (markup must stay baked into the one line, never exposed as its own
// adjustable thing).
function applyCommitmentLineEdit(coLine, edit) {
  if (!edit) return;
  if (edit.description != null && String(edit.description).trim() !== '') {
    coLine.description = String(edit.description);
  }
}

// Mirrors computeDirectCostLines' role for commitments — the single place
// preview/build/write-off can never drift from each other.
async function computeCommitmentLines(env, {
  tenantId, projectId, commitmentIds = [], commitmentLineIds = [], markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
  if (mode === 'non_billable') {
    const err = new Error(
      `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
      `Override the billing mode for this project in LEDGER if that's wrong.`
    );
    err.code = 'NON_BILLABLE_PROJECT';
    throw err;
  }

  const resolvedSelection = await fetchUnbilledCommitmentLines(env, { tenantId, projectId, commitmentIds, commitmentLineIds, onProgress });
  const commitments = [...resolvedSelection.values()].map(v => v.commitment);
  const multi = commitments.length > 1;
  const label = multi ? `${commitments.length} Commitments` : commitmentLabel(commitments[0]);
  onProgress({ message: `Fetched ${commitments.length} commitment(s)` });

  const { lineItems, skipped, markup } = buildCommitmentLineItems(resolvedSelection, markupPercent);
  if (skipped.length > 0) {
    throw new Error(
      `Could not bill ${skipped.length} commitment(s) — ` +
      `${skipped.map(s => `"${s.description}" (${s.reason})`).join(', ')}.`
    );
  }
  if (lineItems.length === 0) {
    throw new Error('Nothing to bill — none of the selected commitments have a usable budget code.');
  }

  const coLines = buildCommitmentCOLines(lineItems, groupBy, markup);
  onProgress({ message: `Grouped into ${coLines.length} Change Order line item(s) (${groupBy || 'per_commitment (default)'})` });

  // Preview/edit screen overrides — same length-mismatch guard as
  // computeDirectCostLines' editedLines handling.
  if (editedLines) {
    if (editedLines.length !== coLines.length) {
      throw new Error(
        `This selection has changed since the preview was shown (${coLines.length} line(s) now vs. ${editedLines.length} previewed) — ` +
        `go back and preview again before confirming.`
      );
    }
    coLines.forEach((line, i) => applyCommitmentLineEdit(line, editedLines[i]));
  }

  const totalAmount = Math.round(coLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const estimatedCount = coLines.filter(l => l.isEstimated).length;
  onProgress({
    message: `${coLines.length} commitment line item(s) to bill — $${totalAmount.toLocaleString()} (markup included)` +
      (estimatedCount > 0 ? ` — ${estimatedCount} not yet sub-invoiced (estimated)` : '')
  });

  const MAX_CO_LINES = 35;
  if (coLines.length > MAX_CO_LINES) {
    throw new Error(
      `This selection needs ${coLines.length} Change Order line items — too many for one reliable build ` +
      `(limit ${MAX_CO_LINES}). Bill fewer commitments at once.`
    );
  }

  return { commitments, multi, label, lineItems, coLines, totalAmount, mode };
}

// Mirrors previewDirectCostBilling.
export async function previewCommitmentBilling(env, { tenantId, projectId, commitmentIds, commitmentLineIds, markupPercent, groupBy }) {
  const { label, totalAmount, coLines } = await computeCommitmentLines(env, {
    tenantId, projectId, commitmentIds, commitmentLineIds, markupPercent, groupBy
  });
  return {
    label,
    totalAmount,
    lines: coLines.map(l => ({ description: l.description, cost: l.cost, markupPercent: l.markupPercent, amount: l.amount, isEstimated: l.isEstimated }))
  };
}

// Mirrors buildDirectCostChangeEventAndOrder's shape exactly (CE create -> CO
// create -> line items -> rollback-on-failure), including the same
// requestWithRetry discipline throughout (established this session — see
// requestWithRetry above).
async function buildCommitmentChangeEventAndOrder(env, {
  tenantId, projectId, commitmentIds, commitmentLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const { commitments, label, lineItems, coLines, totalAmount } = await computeCommitmentLines(env, {
    tenantId, projectId, commitmentIds, commitmentLineIds, markupPercent, groupBy, editedLines, onProgress
  });

  const ceRes = await requestWithRetry(env, 'POST', `/rest/v1.1/change_events?project_id=${projectId}`, {
    change_event: {
      title: label,
      description: `LEDGER-generated from ${label}`,
      scope: 'in_scope',
      status: { id: 562949953739902 }, // Open — confirmed real id for this company
      change_items: coLines.map(line => ({
        description: line.description,
        revenue_impact: {
          estimate: {
            quantity: '1',
            unit_cost: String(line.amount),
            amount: String(line.amount),
            unit_of_measure: 'LS',
            calculation_strategy: 'manual'
          }
        },
        budget_code: { id: String(line.wbsCodeId) }
      }))
    }
  }, onProgress);
  if (ceRes.status !== 201) {
    throw new Error(`Failed to create Change Event: ${ceRes.status} ${JSON.stringify(ceRes.data)}`);
  }
  const changeEventId = ceRes.data.id;
  onProgress({ message: `Change Event created — id ${changeEventId} ($${totalAmount.toLocaleString()} value)`, changeEventId });

  let contractId, changeOrderId;
  try {
    contractId = primeContractId || await findBillableContract(env, projectId);
    const coRes = await requestWithRetry(env, 'POST', `/rest/v1.0/projects/${projectId}/prime_change_orders`, {
      change_order: {
        contract_id: contractId,
        title: label,
        description: `LEDGER-generated from ${label}`,
        status: 'draft',
        reason: 'Commitment / subcontractor invoice billing'
      }
    }, onProgress);
    if (coRes.status !== 201) {
      throw new Error(`Failed to create Prime Change Order: ${coRes.status} ${JSON.stringify(coRes.data)}`);
    }
    changeOrderId = coRes.data.id;
    onProgress({ message: `Change Order created (draft) — id ${changeOrderId}`, changeOrderId });
  } catch (e) {
    onProgress({ message: 'Failed before the Change Order was ready — rolling back the Change Event…' });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    throw new Error(
      `${e.message} ${rb.ceDeleted ? '(the Change Event was rolled back — nothing left behind)' : '(COULD NOT roll back the Change Event — check Procore manually, it may still exist)'}`
    );
  }

  let addedCount = 0;
  let lineFailure = null;
  for (const line of coLines) {
    try {
      const lineRes = await requestWithRetry(
        env, 'POST',
        `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/prime_change_orders/${changeOrderId}/line_items`,
        { description: line.description, quantity: '1', unit_cost: String(line.amount), uom: 'LS', wbs_code_id: String(line.wbsCodeId) },
        onProgress
      );
      await throttleForRateLimit(lineRes.headers, onProgress);
      if (lineRes.status !== 201) {
        lineFailure = { description: line.description, error: `${lineRes.status} ${JSON.stringify(lineRes.data)}` };
        break;
      }
      addedCount++;
      onProgress({ message: `Added line ${addedCount}/${coLines.length}: ${line.description} — $${line.amount.toLocaleString()}` });
    } catch (e) {
      lineFailure = { description: line.description, error: e.message };
      break;
    }
  }

  if (lineFailure) {
    onProgress({ message: `Failed on line ${addedCount + 1}/${coLines.length} — rolling back…` });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    const rollbackNote = (rb.coDeleted && rb.ceDeleted)
      ? 'Rolled back the Change Event and Change Order — nothing was left half-built.'
      : `Rollback ${rb.coDeleted ? 'removed' : 'could NOT remove'} the Change Order and ` +
        `${rb.ceDeleted ? 'removed' : 'could NOT remove'} the Change Event — check Procore manually if either failed.`;
    throw new Error(
      `Only added ${addedCount} of ${coLines.length} line items to the Change Order, then failed on ` +
      `"${lineFailure.description}": ${lineFailure.error}. ${rollbackNote}`
    );
  }
  onProgress({ message: `All ${coLines.length} line item(s) added — $${totalAmount.toLocaleString()} total` });

  return { commitments, contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label };
}

// Mirrors pushDirectCostToDraftCO.
export async function pushCommitmentToDraftCO(env, {
  tenantId, projectId, commitmentId, commitmentIds, commitmentLineIds = [], userId, primeContractId, markupPercent, groupBy, editedLines, onProgress = () => {}
}) {
  const ids = normalizeCommitmentIds(commitmentId, commitmentIds);
  if (ids.length === 0 && commitmentLineIds.length === 0) {
    throw new Error('commitment_id, commitment_ids, or commitment_line_ids is required');
  }
  const { contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label } =
    await buildCommitmentChangeEventAndOrder(env, { tenantId, projectId, commitmentIds: ids, commitmentLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress });

  const rows = commitmentBillingRows(lineItems);
  await insertBillingRecordsBatch(env, rows.map(row => ({
    ...row, tenantId, projectId, status: 'draft_co', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${rows.length} commitment line item(s) as pushed to draft` });

  return { contractId, changeEventId, changeOrderId, totalAmount, linesPushed: coLines.length, label };
}

// Mirrors generateDirectCostInvoice.
export async function generateCommitmentInvoice(env, {
  tenantId, projectId, commitmentId, commitmentIds, commitmentLineIds = [], userId, primeContractId, markupPercent, groupBy,
  editedLines, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  if (!billingDate) {
    throw new Error('billingDate is required');
  }
  const billingPeriod = await findOrCreateBillingPeriod(env, projectId, billingPeriodId, newBillingPeriod);
  onProgress({ message: `Billing period ready — id ${billingPeriod.id}` });

  const ids = normalizeCommitmentIds(commitmentId, commitmentIds);
  if (ids.length === 0 && commitmentLineIds.length === 0) {
    throw new Error('commitment_id, commitment_ids, or commitment_line_ids is required');
  }
  const { contractId, changeEventId, changeOrderId, lineItems, coLines, totalAmount, label } =
    await buildCommitmentChangeEventAndOrder(env, { tenantId, projectId, commitmentIds: ids, commitmentLineIds, primeContractId, markupPercent, groupBy, editedLines, onProgress });

  const { invoice, claimedCount, failedLines } = await approveAndInvoiceChangeOrder(env, {
    projectId, contractId, changeOrderId, coLines, billingPeriod, invoiceNumber, billingDate, onProgress
  });

  const rows = commitmentBillingRows(lineItems);
  await insertBillingRecordsBatch(env, rows.map(row => ({
    ...row, tenantId, projectId, invoiceId: String(invoice.id), invoiceNumber: invoice.invoice_number,
    status: 'billed', reconciledBy: userId || 'ledger-system',
    changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
  })));
  onProgress({ message: `Recorded ${rows.length} commitment line item(s) as billed` });

  return {
    contractId,
    changeEventId,
    changeOrderId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    totalAmount,
    linesBilled: lineItems.length,
    label,
    claimedCount,
    totalCoLines: coLines.length,
    unclaimedLines: failedLines
  };
}

// Mirrors listPendingDirectCosts' bucket logic (billed > written_off >
// budgeted priority, partialBilled/breakdown fields for a commitment mid
// partial-billing). One list call covers every commitment's total; line items
// are only fetched for commitments with existing billing activity, same as DC.
export async function listCommitments(env, { tenantId, projectId }) {
  const [headers, lineMap, legacy] = await Promise.all([
    fetchCommitmentHeaders(env, projectId),
    getBilledCommitmentLineMap(env, tenantId, projectId),
    isLegacyProject(env, projectId)
  ]);

  const lineRowsByCommitment = new Map();
  for (const [key, info] of lineMap) {
    const sep = key.indexOf(':');
    if (sep === -1) continue;
    const commitmentId = key.slice(0, sep);
    if (!lineRowsByCommitment.has(commitmentId)) lineRowsByCommitment.set(commitmentId, []);
    lineRowsByCommitment.get(commitmentId).push({ ...info, lineItemId: key.slice(sep + 1) });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const unbilled = [];
  const billed = [];
  const writtenOff = [];
  const budgeted = [];

  for (const c of headers) {
    const record = {
      id: c.id,
      number: c.number || null,
      title: c.title || null,
      type: c.type || null,
      vendor: c.vendor_name,
      status: c.status || null,
      executed: c.executed === true,
      amount: round2(Number(c.grand_total ?? 0))
    };

    const lineRows = lineRowsByCommitment.get(String(c.id)) || [];
    if (lineRows.length === 0) {
      unbilled.push(record);
      continue;
    }

    const rawLines = await fetchCommitmentLines(env, projectId, c.id);
    const remaining = rawLines.filter(li => !lineRows.some(r => r.lineItemId === String(li.id)));
    const billedRows = lineRows.filter(r => r.status === 'billed' || r.status === 'draft_co');
    const writtenOffRows = lineRows.filter(r => r.status === 'written_off');
    const budgetedRows = lineRows.filter(r => r.status === 'reconciled_to_period');
    const sumAmt = (rows) => round2(rows.reduce((s, r) => s + (r.amount ?? 0), 0));
    const breakdown = {
      billedLineCount: billedRows.length,
      writtenOffLineCount: writtenOffRows.length,
      budgetedLineCount: budgetedRows.length,
      totalLineCount: rawLines.length,
      isEstimated: lineRows.some(r => r.isEstimated),
      estimatedLineCount: billedRows.filter(r => r.isEstimated).length,
      billedLineAmount: sumAmt(billedRows),
      writtenOffLineAmount: sumAmt(writtenOffRows),
      budgetedLineAmount: sumAmt(budgetedRows)
    };

    if (remaining.length === 0) {
      // Same deterministic priority as listPendingDirectCosts — the three row
      // sets partition lineRows, so no ties.
      if (billedRows.length > 0) {
        billed.push({
          ...record, ...breakdown,
          billedStatus: billedRows.some(r => r.status === 'draft_co') ? 'draft_co' : 'billed',
          outsideLedgerLineCount: billedRows.filter(r => r.billedOutsideLedger).length,
          invoiceNumber: billedRows.find(r => r.invoiceNumber)?.invoiceNumber || null,
          billedAmount: round2(billedRows.reduce((s, r) => s + (r.amount ?? 0), 0))
        });
      } else if (writtenOffRows.length > 0) {
        writtenOff.push({
          ...record, ...breakdown,
          writtenOffAmount: round2(writtenOffRows.reduce((s, r) => s + (r.amount ?? 0), 0)),
          reasonCategory: writtenOffRows[0].reasonCategory,
          reasonNotes: writtenOffRows[0].reasonNotes,
          invoiceNumber: writtenOffRows.find(r => r.invoiceNumber)?.invoiceNumber || null
        });
      } else {
        budgeted.push({
          ...record, ...breakdown,
          budgetedAmount: round2(budgetedRows.reduce((s, r) => s + (r.amount ?? 0), 0)),
          reasonNotes: budgetedRows[0].reasonNotes
        });
      }
    } else {
      const remainingAmount = round2(remaining.reduce((s, li) => s + Number(li.amount ?? 0), 0));
      unbilled.push({ ...record, ...breakdown, ...partialDispositionFields(billedRows, writtenOffRows, budgetedRows), partialBilled: true, remainingAmount });
    }
  }

  return { unbilled, billed, writtenOff, budgeted, ...legacy };
}

// Full per-line detail for the picker's expand panel and the "Full details"
// popout. Each line also carries what the frontend's labour warnings need:
//   isLabour       — see isLabourLine
//   tmTicketNumbers — T&M ticket(s) these same hours sit on (soft warning:
//                     "bill it from the ticket instead")
//   tmBilled       — those hours were already billed/drafted elsewhere (the
//                     backend hard-blocks billing it; the UI can disable it)
export async function commitmentLineDetail(env, { tenantId, projectId, commitmentId }) {
  const [headers, rawLines, lineMap, billedTimecards, hasReq, timecardsRes, entriesRes] = await Promise.all([
    fetchCommitmentHeaders(env, projectId),
    fetchCommitmentLines(env, projectId, commitmentId),
    getBilledCommitmentLineMap(env, tenantId, projectId),
    getBilledTimecardMap(env, tenantId, projectId),
    hasRealRequisition(env, projectId, commitmentId),
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_timecards`, null),
    requestWithRetry(env, 'GET', `/rest/v1.0/projects/${projectId}/time_and_material_entries`, null)
  ]);
  const c = headers.find(h => String(h.id) === String(commitmentId));
  if (!c) throw new Error(`Commitment ${commitmentId} not found on this project — it may have been deleted in Procore.`);

  const entryNumberById = new Map(
    (entriesRes.status === 200 ? entriesRes.data : []).map(e => [e.id, e.number])
  );
  const ticketNumbersByTimecardKey = new Map();
  for (const tc of (timecardsRes.status === 200 ? timecardsRes.data : [])) {
    if (tc.timecard_entry_id == null) continue;
    const key = String(tc.timecard_entry_id);
    const num = entryNumberById.get(tc.time_and_material_entry?.id);
    if (num == null) continue;
    if (!ticketNumbersByTimecardKey.has(key)) ticketNumbersByTimecardKey.set(key, new Set());
    ticketNumbersByTimecardKey.get(key).add(num);
  }

  const lines = rawLines.map(li => {
    const billed = lineMap.get(commitmentLineReconciliationKey(commitmentId, li)) || null;
    const timecardKey = einvoiceTimecardKey(li);
    const tmRow = !billed && timecardKey ? billedTimecards.get(timecardKey) : null;
    const tmBilled = tmRow && (tmRow.status === 'billed' || tmRow.status === 'draft_co')
      ? { status: tmRow.status, invoiceNumber: tmRow.invoiceNumber || null, viaCommitment: tmRow.viaCommitment === true }
      : null;
    return {
      id: li.id,
      description: li.description || '',
      budgetCode: li.wbs_code?.flat_code || null,
      hasBudgetCode: hasBudgetCode(li),
      isLabour: isLabourLine(li),
      amount: Number(li.amount ?? 0),
      billedStatus: billed?.status || null,
      invoiceNumber: billed?.invoiceNumber || null,
      billedAmount: billed?.amount ?? null,
      isEstimated: billed?.isEstimated === true,
      timecardKey,
      tmTicketNumbers: timecardKey ? [...(ticketNumbersByTimecardKey.get(timecardKey) || [])] : [],
      tmBilled
    };
  });
  return {
    id: c.id,
    number: c.number || null,
    title: c.title || null,
    type: c.type || null,
    vendor: c.vendor_name,
    status: c.status || null,
    executed: c.executed === true,
    grandTotal: c.grand_total != null ? Number(c.grand_total) : null,
    hasRealRequisition: hasReq,
    lines
  };
}

// ============================================================
// Combined billing (Ben's ask 2026-09-16) — "pick an action first (Invoice or
// CO), then aggregate items from T&M tickets AND direct costs into one
// submission" instead of the old per-source tab flow. Reuses computeCOLines
// and computeDirectCostLines exactly as-is (each already does its own
// billing-mode check and WBS/cost-code validation) — this section's only new
// work is normalizing both sources' lines into one shape for a SINGLE Change
// Event + Change Order, and doing the T&M-only "link back" step conditionally.
// Standalone invoicing and subcontractor invoices (Commitments) are still not
// aggregatable sources — deferred, per the plan.
// ============================================================

// A T&M coLine's wbs code isn't on the line itself (it's looked up by
// timeType against the project-wide wbsCodeIds map — see computeCOLines); a
// direct-cost coLine already carries its own wbsCodeId (see
// buildDirectCostLines). Normalizing both into {quantity, unitCost, uom,
// wbsCodeId} here is what lets ONE CE-create / CO-line-add loop below handle
// either source, or a mix, without caring which it's looking at.
function normalizeTmLine(line, wbsCodeIds) {
  return { ...line, quantity: line.hours, unitCost: line.rate, uom: 'Hours', wbsCodeId: wbsCodeIds[line.timeType] };
}
function normalizeDcLine(line) {
  return { ...line, quantity: 1, unitCost: line.amount, uom: 'LS' };
}

// Computes each selected source's lines once, for both preview and build.
// Also the within-one-submission double-billing guard: T&M lines and
// commitment lines can be the same subcontractor timecard (see the
// Commitments header comment) — both in ONE submission would bill it twice,
// and the already-billed checks can't catch that since neither is billed yet.
async function computeCombinedSources(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  groupBy, rateOverrides, editedTmLines, confirmUnlinked, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, onProgress = () => {}
}) {
  if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 &&
      commitmentIds.length === 0 && commitmentLineIds.length === 0) {
    throw new Error('Nothing selected — pick at least one T&M ticket, direct cost, or commitment to bill.');
  }
  const tm = entryIds.length > 0
    ? await computeCOLines(env, { tenantId, projectId, entryIds, groupBy, rateOverrides, editedLines: editedTmLines, confirmUnlinked, onProgress })
    : null;
  const dc = (directCostIds.length > 0 || directCostLineIds.length > 0)
    ? await computeDirectCostLines(env, { tenantId, projectId, directCostIds, directCostLineIds, markupPercent, groupBy: dcGroupBy, editedLines: editedDcLines, onProgress })
    : null;
  const cm = (commitmentIds.length > 0 || commitmentLineIds.length > 0)
    ? await computeCommitmentLines(env, {
        tenantId, projectId, commitmentIds, commitmentLineIds, markupPercent: cmMarkupPercent ?? markupPercent,
        groupBy: cmGroupBy, editedLines: editedCmLines, onProgress
      })
    : null;

  if (tm && cm) {
    const tmKeys = new Set(tm.lineItems.map(l => String(l.timecardEntryId)));
    const overlaps = cm.lineItems.flatMap(l => l.rawLines)
      .filter(raw => { const k = einvoiceTimecardKey(raw); return k && tmKeys.has(k); });
    if (overlaps.length > 0) {
      const err = new Error(
        `${overlaps.length} commitment line(s) are the same hours as timecards on the selected T&M ticket(s) — billing both would ` +
        `double-bill the client: ${overlaps.map(o => `"${o.description}"`).join('; ')}. Deselect them from the commitment and bill them from the T&M ticket.`
      );
      err.code = 'TIMECARD_IN_BOTH_SOURCES';
      throw err;
    }
  }
  return { tm, dc, cm };
}

async function buildCombinedChangeEventAndOrder(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  primeContractId, confirmUnlinked, groupBy, rateOverrides, editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines,
  cmGroupBy, editedCmLines, title, onProgress = () => {}
}) {
  const { tm, dc, cm } = await computeCombinedSources(env, {
    tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds,
    groupBy, rateOverrides, editedTmLines, confirmUnlinked, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, onProgress
  });

  const normalizedLines = [
    ...(tm ? tm.coLines.map(l => normalizeTmLine(l, tm.wbsCodeIds)) : []),
    ...(dc ? dc.coLines.map(normalizeDcLine) : []),
    ...(cm ? cm.coLines.map(normalizeDcLine) : [])
  ];

  // Each source already checked MAX_CO_LINES against its own subset — this
  // catches a combination that's only too big once merged (e.g. 20 T&M lines
  // + 20 direct-cost lines, 35 each alone but 40 combined).
  const MAX_CO_LINES = 35;
  if (normalizedLines.length > MAX_CO_LINES) {
    throw new Error(
      `This selection needs ${normalizedLines.length} Change Order line items combined — too many for one ` +
      `reliable build (limit ${MAX_CO_LINES}). Bill fewer items at once, or split into separate submissions.`
    );
  }

  const totalAmount = Math.round(normalizedLines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  // Ben's ask 2026-09-22: override the auto-generated CO/CE name with a real
  // custom one — becomes the actual title on both records (and what LEDGER
  // itself shows back), not just cosmetic on one side.
  const label = title?.trim() ? title.trim() : [tm?.label, dc?.label, cm?.label].filter(Boolean).join(' + ');
  const reason = [tm && 'T&M', dc && 'Direct Cost', cm && 'Commitment'].filter(Boolean).join(' + ') + ' billing';

  // 1. Build the Change Event — same shape as buildChangeEventAndOrder/
  // buildDirectCostChangeEventAndOrder above, just fed from the combined line
  // list so both sources land on ONE Change Event.
  // Retries on 429 — see buildChangeEventAndOrder's comment for the full
  // reasoning (safe: a 429 means rejected, never partially created).
  const ceRes = await requestWithRetry(env, 'POST', `/rest/v1.1/change_events?project_id=${projectId}`, {
    change_event: {
      title: label,
      description: `LEDGER-generated from ${label}`,
      scope: 'in_scope',
      status: { id: 562949953739902 }, // Open — confirmed real id for this company
      change_items: normalizedLines.map(line => ({
        description: line.description,
        revenue_impact: {
          estimate: {
            quantity: String(line.quantity),
            unit_cost: String(line.unitCost),
            amount: String(line.amount),
            unit_of_measure: line.uom,
            calculation_strategy: 'manual'
          }
        },
        budget_code: { id: String(line.wbsCodeId) }
      }))
    }
  }, onProgress);
  if (ceRes.status !== 201) {
    throw new Error(`Failed to create Change Event: ${ceRes.status} ${JSON.stringify(ceRes.data)}`);
  }
  const changeEventId = ceRes.data.id;
  onProgress({ message: `Change Event created — id ${changeEventId} ($${totalAmount.toLocaleString()} value)`, changeEventId });

  // 2. Link T&M tickets back to the CE (only if any are in this selection —
  // direct costs have no equivalent), then build the Prime Change Order.
  let contractId, changeOrderId;
  try {
    if (tm) {
      const linkRes = await requestWithRetry(env, 'PATCH', `/rest/v1.0/projects/${projectId}/time_and_material_entries/bulk_update`, {
        time_and_material_entry: {
          time_and_material_entry_ids: tm.entries.map(e => e.id),
          change_event_id: changeEventId,
          update_change_event_attachment: true
        }
      }, onProgress);
      if (linkRes.status !== 200) {
        throw new Error(`Failed to link Change Event back to ticket(s): ${linkRes.status} ${JSON.stringify(linkRes.data)}`);
      }
      onProgress({ message: `Linked ${tm.entries.length} ticket(s) to the Change Event` });
    }

    contractId = primeContractId || await findBillableContract(env, projectId);
    const coRes = await requestWithRetry(env, 'POST', `/rest/v1.0/projects/${projectId}/prime_change_orders`, {
      change_order: { contract_id: contractId, title: label, description: `LEDGER-generated from ${label}`, status: 'draft', reason }
    }, onProgress);
    if (coRes.status !== 201) {
      throw new Error(`Failed to create Prime Change Order: ${coRes.status} ${JSON.stringify(coRes.data)}`);
    }
    changeOrderId = coRes.data.id;
    onProgress({ message: `Change Order created (draft) — id ${changeOrderId}`, changeOrderId });
  } catch (e) {
    onProgress({ message: 'Failed before the Change Order was ready — rolling back the Change Event…' });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    throw new Error(
      `${e.message} ${rb.ceDeleted ? '(the Change Event was rolled back — nothing left behind)' : '(COULD NOT roll back the Change Event — check Procore manually, it may still exist)'}`
    );
  }

  // 3. Add every combined line item — same rollback-on-first-failure
  // discipline as the two single-source builders above.
  let addedCount = 0;
  let lineFailure = null;
  for (const line of normalizedLines) {
    try {
      const lineRes = await requestWithRetry(
        env, 'POST',
        `/rest/v2.0/companies/${env.PROCORE_COMPANY_ID}/projects/${projectId}/prime_change_orders/${changeOrderId}/line_items`,
        { description: line.description, quantity: String(line.quantity), unit_cost: String(line.unitCost), uom: line.uom, wbs_code_id: String(line.wbsCodeId) },
        onProgress
      );
      await throttleForRateLimit(lineRes.headers, onProgress);
      if (lineRes.status !== 201) {
        lineFailure = { description: line.description, error: `${lineRes.status} ${JSON.stringify(lineRes.data)}` };
        break;
      }
      addedCount++;
      onProgress({ message: `Added line ${addedCount}/${normalizedLines.length}: ${line.description} — $${line.amount.toLocaleString()}` });
    } catch (e) {
      lineFailure = { description: line.description, error: e.message };
      break;
    }
  }

  if (lineFailure) {
    onProgress({ message: `Failed on line ${addedCount + 1}/${normalizedLines.length} — rolling back…` });
    const rb = await rollbackChangeEventAndOrder(env, projectId, changeEventId, changeOrderId);
    const rollbackNote = (rb.coDeleted && rb.ceDeleted)
      ? 'Rolled back the Change Event and Change Order — nothing was left half-built.'
      : `Rollback ${rb.coDeleted ? 'removed' : 'could NOT remove'} the Change Order and ` +
        `${rb.ceDeleted ? 'removed' : 'could NOT remove'} the Change Event — check Procore manually if either failed.`;
    throw new Error(
      `Only added ${addedCount} of ${normalizedLines.length} line items to the Change Order, then failed on ` +
      `"${lineFailure.description}": ${lineFailure.error}. ${rollbackNote}`
    );
  }
  onProgress({ message: `All ${normalizedLines.length} line item(s) added — $${totalAmount.toLocaleString()} total` });

  return {
    tmEntries: tm?.entries || [], tmLineItems: tm?.lineItems || [], tmCoLines: tm?.coLines || [], unlinkedCount: tm?.unlinkedCount || 0,
    dcRecords: dc?.directCosts || [], dcLineItems: dc?.lineItems || [], dcCoLines: dc?.coLines || [],
    cmLineItems: cm?.lineItems || [], cmCoLines: cm?.coLines || [],
    contractId, changeEventId, changeOrderId, totalAmount, label
  };
}

// Read-only: exactly what a real combined push would create, no Procore
// writes — same reasoning as previewBilling/previewDirectCostBilling.
// `confirmUnlinked: true` always, same as previewBilling — a preview can't
// commit anything, so the unlinked-timecard gate belongs at the real confirm
// step.
export async function previewCombinedBilling(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  groupBy, rateOverrides, markupPercent, cmMarkupPercent, dcGroupBy, cmGroupBy, title
}) {
  const { tm, dc, cm } = await computeCombinedSources(env, {
    tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds,
    groupBy, rateOverrides, confirmUnlinked: true, markupPercent, cmMarkupPercent, dcGroupBy, cmGroupBy
  });

  return {
    // Ben's ask 2026-09-22: preview shows the real CO/CE name it'll get,
    // including a PM-typed override — display-only here, no Procore writes.
    label: title?.trim() ? title.trim() : [tm?.label, dc?.label, cm?.label].filter(Boolean).join(' + '),
    totalAmount: Math.round(((tm?.totalAmount || 0) + (dc?.totalAmount || 0) + (cm?.totalAmount || 0)) * 100) / 100,
    unlinkedCount: tm?.unlinkedCount || 0,
    tmLines: (tm?.coLines || []).map(l => ({ description: l.description, hours: l.hours, rate: l.rate, amount: l.amount, timeType: l.timeType })),
    dcLines: (dc?.coLines || []).map(l => ({ description: l.description, cost: l.cost, markupPercent: l.markupPercent, amount: l.amount })),
    cmLines: (cm?.coLines || []).map(l => ({ description: l.description, cost: l.cost, markupPercent: l.markupPercent, amount: l.amount, isEstimated: l.isEstimated }))
  };
}

// "Push to CO" for a combined selection — stops at a draft Change Order for
// manual review, same as the two single-source versions.
export async function pushCombinedToDraftCO(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  userId, primeContractId, confirmUnlinked, groupBy, rateOverrides, editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines,
  cmGroupBy, editedCmLines, title, onProgress = () => {}
}) {
  const { tmLineItems, dcLineItems, cmLineItems, contractId, changeEventId, changeOrderId, totalAmount, label } =
    await buildCombinedChangeEventAndOrder(env, {
      tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, primeContractId, confirmUnlinked,
      groupBy, rateOverrides, editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, title, onProgress
    });

  const dcRows = [...dcBillingRows(dcLineItems), ...commitmentBillingRows(cmLineItems)];
  await insertBillingRecordsBatch(env, [
    ...tmLineItems.map(line => ({
      tenantId, projectId, procoreRecordId: line.timecardEntryId,
      amount: line.amount, status: 'draft_co', reconciledBy: userId || 'ledger-system',
      changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
    })),
    ...dcRows.map(row => ({
      ...row, tenantId, projectId, status: 'draft_co', reconciledBy: userId || 'ledger-system',
      changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
    }))
  ]);
  onProgress({ message: `Recorded ${tmLineItems.length + dcRows.length} item(s) as pushed to draft` });

  return { contractId, changeEventId, changeOrderId, totalAmount, linesPushed: tmLineItems.length + dcRows.length, label };
}

// "Generate Invoice" for a combined selection — same pipeline as the two
// single-source versions (billing period -> CE/CO -> approve -> invoice ->
// claim to 100%), reusing approveAndInvoiceChangeOrder unchanged: it only
// reads description/amount/hours per line, so a mixed T&M + direct-cost line
// list needs no special handling there.
export async function generateCombinedInvoice(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  userId, primeContractId, confirmUnlinked, groupBy, rateOverrides, editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines,
  cmGroupBy, editedCmLines, title, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress = () => {}
}) {
  if (!billingDate) {
    throw new Error('billingDate is required');
  }
  const billingPeriod = await findOrCreateBillingPeriod(env, projectId, billingPeriodId, newBillingPeriod);
  onProgress({ message: `Billing period ready — id ${billingPeriod.id}` });

  const { tmEntries, tmLineItems, tmCoLines, dcLineItems, dcCoLines, cmLineItems, cmCoLines, contractId, changeEventId, changeOrderId, totalAmount, label } =
    await buildCombinedChangeEventAndOrder(env, {
      tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, primeContractId, confirmUnlinked,
      groupBy, rateOverrides, editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, title, onProgress
    });

  const { invoice, claimedCount, failedLines } = await approveAndInvoiceChangeOrder(env, {
    projectId, contractId, changeOrderId, coLines: [...tmCoLines, ...dcCoLines, ...cmCoLines], billingPeriod, invoiceNumber, billingDate, onProgress
  });

  const dcRows = [...dcBillingRows(dcLineItems), ...commitmentBillingRows(cmLineItems)];
  await insertBillingRecordsBatch(env, [
    ...tmLineItems.map(line => ({
      tenantId, projectId, procoreRecordId: line.timecardEntryId,
      invoiceId: String(invoice.id), invoiceNumber: invoice.invoice_number,
      amount: line.amount, status: 'billed', reconciledBy: userId || 'ledger-system',
      changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
    })),
    ...dcRows.map(row => ({
      ...row, tenantId, projectId, invoiceId: String(invoice.id), invoiceNumber: invoice.invoice_number,
      status: 'billed', reconciledBy: userId || 'ledger-system',
      changeOrderId: String(changeOrderId), changeEventId: String(changeEventId)
    }))
  ]);
  onProgress({ message: `Recorded ${tmLineItems.length + dcRows.length} item(s) as billed` });

  return {
    contractId,
    changeEventId,
    changeOrderId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    totalAmount,
    linesbilled: tmLineItems.length + dcRows.length,
    ticketNumbers: tmEntries.map(e => e.number),
    label,
    claimedCount,
    totalCoLines: tmCoLines.length + dcCoLines.length + cmCoLines.length,
    unclaimedLines: failedLines
  };
}

// ============================================================
// Write-offs (Ben's ask 2026-09-17) — mark an unbilled T&M line or direct
// cost as written off, with a reason, instead of pushing anything to Procore
// at all. Pure LEDGER bookkeeping: no CE/CO/invoice ever gets created here,
// so none of the Procore-write machinery above applies — just "what would
// this have cost" (fetchUnbilledTmLines' shared front half for T&M; each
// direct cost's own header amount for direct costs, no cost-code/line-item
// fetch needed since nothing is ever billed against a code) plus two linked
// DB inserts. `db/schema.sql` already had `billing_records.status =
// 'written_off'` + `write_off_reason`, and a full `write_offs` audit table —
// nobody had wired it up until now, same situation direct costs were in.
// ============================================================

const WRITE_OFF_REASONS = ['warranty', 'service_call', 'goodwill', 'pm_decision', 'other'];

export async function writeOffRecords(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [],
  userId, reasonCategory, reasonNotes, invoiceNumber
}) {
  if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentIds.length === 0 && commitmentLineIds.length === 0) {
    throw new Error('Nothing selected — pick at least one T&M ticket, direct cost, or commitment to write off.');
  }
  if (!WRITE_OFF_REASONS.includes(reasonCategory)) {
    throw new Error(`Invalid write-off reason: ${reasonCategory} (must be one of ${WRITE_OFF_REASONS.join(', ')})`);
  }
  // Only meaningful for reason 'already_billed' ("this was already invoiced
  // elsewhere, not through LEDGER") — Ben's ask 2026-09-23. Reuses
  // billing_records.invoice_number, the exact same column a real 'billed'
  // row already uses — no schema change needed, this was already generic
  // across every record type, just never populated for a write-off before.
  const trimmedInvoiceNumber = invoiceNumber?.trim() || null;

  // T&M — same "what's actually unbilled and for how much" fetch billing
  // uses, minus the WBS/cost-code/grouping concerns that only matter once
  // something is about to be posted to a real Change Order. confirmUnlinked
  // is always true here: an unlinked timecard is a billing-leak signal for
  // ACTUAL billing, but writing something off never claims it was
  // reconciled against a timecard in the first place, so the gate doesn't
  // apply.
  let tmEntries = [];
  const tmRows = [];
  if (entryIds.length > 0) {
    const tm = await fetchUnbilledTmLines(env, { tenantId, projectId, entryIds, confirmUnlinked: true });
    tmEntries = tm.entries;
    for (const line of tm.lineItems) {
      tmRows.push({
        tenantId, projectId, recordType: 'timecard', procoreRecordId: line.timecardEntryId,
        amount: line.amount, status: 'written_off', writeOffReason: reasonNotes, reconciledBy: userId || 'ledger-system',
        invoiceNumber: trimmedInvoiceNumber
      });
    }
  }

  // Direct costs — per-line since 2026-09-23 (Ben's ask), same
  // fetchUnbilledDcLines resolution billing already uses: 'ALL' for a
  // whole-DC pick (write off everything still available on it), explicit
  // "dcId:lineId" picks for individual lines. Writes one
  // record_type='direct_cost_line' row per real line item via dcBillingRows
  // at markupPercent 0 — write-offs have never applied markup, and
  // dcBillingRows' formula reduces to the raw per-line amount at 0%, so this
  // needs no new rounding logic. The old whole-DC-only guard (block if ANY
  // per-line rows already exist) is gone — writing one row per actually-
  // remaining line makes the double-accounting that guard prevented
  // structurally impossible now. The legacy-row hard-block for a DC billed
  // under the OLD whole-DC scheme still lives inside fetchUnbilledDcLines
  // itself and applies exactly as before.
  let directCosts = [];
  const dcRows = [];
  if (directCostIds.length > 0 || directCostLineIds.length > 0) {
    const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
    if (mode === 'non_billable') {
      const err = new Error(
        `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
        `Override the billing mode for this project in LEDGER if that's wrong.`
      );
      err.code = 'NON_BILLABLE_PROJECT';
      throw err;
    }
    const resolvedSelection = await fetchUnbilledDcLines(env, {
      tenantId, projectId, directCostIds, directCostLineIds,
      nothingMessage: 'Nothing to write off — every selected line item is already billed, written off, budgeted, or in a draft Change Order.'
    });
    directCosts = [...resolvedSelection.values()].map(v => v.dc);
    const lineItems = [...resolvedSelection.values()].map(({ dc, rawLines }) => ({ directCostId: dc.id, rawLines, markupPercent: 0 }));
    for (const row of dcBillingRows(lineItems)) {
      dcRows.push({
        ...row, tenantId, projectId, status: 'written_off',
        writeOffReason: reasonNotes, reconciledBy: userId || 'ledger-system', invoiceNumber: trimmedInvoiceNumber
      });
    }
  }

  // Commitments — exempt from the is_estimated billing gate on purpose (see
  // resolveCommitmentSelection above): writing something off never claims it
  // was billed to the client, so the "billed twice" risk that gate guards
  // against doesn't apply. Uses resolveCommitmentSelection directly rather
  // than fetchUnbilledCommitmentLines for exactly that reason. markupPercent
  // 0 — write-offs have never applied markup, same as direct costs.
  let commitments = [];
  const commitmentRows = [];
  if (commitmentIds.length > 0 || commitmentLineIds.length > 0) {
    const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
    if (mode === 'non_billable') {
      const err = new Error(
        `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
        `Override the billing mode for this project in LEDGER if that's wrong.`
      );
      err.code = 'NON_BILLABLE_PROJECT';
      throw err;
    }
    const { resolvedSelection } = await resolveCommitmentSelection(env, { tenantId, projectId, commitmentIds, commitmentLineIds });
    if (resolvedSelection.size === 0) {
      throw new Error('Nothing to write off — every selected line item is already billed, written off, budgeted, or in a draft Change Order.');
    }
    commitments = [...resolvedSelection.values()].map(v => v.commitment);
    const lineItems = [...resolvedSelection.values()].map(({ commitment, rawLines }) => ({ commitmentId: commitment.id, rawLines, markupPercent: 0 }));
    for (const row of commitmentBillingRows(lineItems)) {
      commitmentRows.push({
        ...row, tenantId, projectId, status: 'written_off',
        writeOffReason: reasonNotes, reconciledBy: userId || 'ledger-system', invoiceNumber: trimmedInvoiceNumber
      });
    }
  }

  const allRows = [...tmRows, ...dcRows, ...commitmentRows];
  const ids = await insertBillingRecordsBatch(env, allRows);
  await insertWriteOffsBatch(env, allRows.map((row, i) => ({
    billingRecordId: ids[i], tenantId, projectId, reasonCategory, reasonNotes,
    writtenOffBy: userId || 'ledger-system', amount: row.amount
  })));

  const totalAmount = Math.round(allRows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const label = [
    tmEntries.length > 0 ? ticketLabel(tmEntries.map(e => e.number)) : null,
    directCosts.length > 0 ? (directCosts.length > 1 ? `${directCosts.length} Direct Costs` : (directCosts[0].description || 'Direct Cost')) : null,
    commitments.length > 0 ? (commitments.length > 1 ? `${commitments.length} Commitments` : commitmentLabel(commitments[0])) : null
  ].filter(Boolean).join(' + ');

  return { count: allRows.length, totalAmount, label };
}

// ============================================================
// "Mark as Budgeted" (Ben's ask 2026-09-21) — a third disposition alongside
// Bill and Write Off: "this line was already accounted for in our budgeting,
// don't bill it to the client, don't write it off either — just stop
// flagging it as pending." Mirrors writeOffRecords almost exactly (same
// no-Procore-writes, pure-bookkeeping shape), with two differences: it uses
// billing_records.status = 'reconciled_to_period' — already in
// db/schema.sql, originally scoped for the (still unbuilt) fixed-price
// billing-period gap-coverage view, but the exact same "already covered,
// don't ask again" meaning applies here — and it's just a free-text note,
// no fixed reason-category enum (confirmed with Ben: unlike a write-off,
// "already budgeted" doesn't split into meaningful sub-reasons) — so there's
// no matching write_offs-style audit table row, just the billing_records row
// itself, reusing its write_off_reason column as a generic note field.
// ============================================================

export async function markAsBudgeted(env, args) {
  return recordDisposition(env, { ...args, status: 'reconciled_to_period', verb: 'mark as budgeted' });
}

// "Already Billed" (Ben's ask 2026-09-25) — billed on an invoice LEDGER didn't
// create (e.g. billed by hand in Procore). Recorded as a real 'billed' row, so
// it lands in Billed and blocks double-billing like any LEDGER invoice, with
// billed_outside_ledger marking it so it gets its own, simpler undo.
export async function markAsAlreadyBilled(env, args) {
  return recordDisposition(env, { ...args, status: 'billed', verb: 'mark as already billed', billedOutsideLedger: true });
}

// Shared by Mark as Budgeted and Already Billed: pure LEDGER bookkeeping, no
// Procore writes.
async function recordDisposition(env, {
  tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentIds = [], commitmentLineIds = [], userId, notes,
  invoiceNumber, status, verb, billedOutsideLedger = false
}) {
  if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentIds.length === 0 && commitmentLineIds.length === 0) {
    throw new Error(`Nothing selected — pick at least one T&M ticket, direct cost, or commitment to ${verb}.`);
  }
  const extra = { invoiceNumber: invoiceNumber?.trim() || null, billedOutsideLedger };

  let tmEntries = [];
  const tmRows = [];
  if (entryIds.length > 0) {
    const tm = await fetchUnbilledTmLines(env, { tenantId, projectId, entryIds, confirmUnlinked: true });
    tmEntries = tm.entries;
    for (const line of tm.lineItems) {
      tmRows.push({
        tenantId, projectId, recordType: 'timecard', procoreRecordId: line.timecardEntryId,
        amount: line.amount, status, writeOffReason: notes, reconciledBy: userId || 'ledger-system', ...extra
      });
    }
  }

  // Same per-line shape as writeOffRecords above (2026-09-23) — see its
  // comment for the full reasoning.
  let directCosts = [];
  const dcRows = [];
  if (directCostIds.length > 0 || directCostLineIds.length > 0) {
    const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
    if (mode === 'non_billable') {
      const err = new Error(
        `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
        `Override the billing mode for this project in LEDGER if that's wrong.`
      );
      err.code = 'NON_BILLABLE_PROJECT';
      throw err;
    }
    const resolvedSelection = await fetchUnbilledDcLines(env, {
      tenantId, projectId, directCostIds, directCostLineIds,
      nothingMessage: `Nothing to ${verb} — every selected line item is already billed, written off, budgeted, or in a draft Change Order.`
    });
    directCosts = [...resolvedSelection.values()].map(v => v.dc);
    const lineItems = [...resolvedSelection.values()].map(({ dc, rawLines }) => ({ directCostId: dc.id, rawLines, markupPercent: 0 }));
    for (const row of dcBillingRows(lineItems)) {
      dcRows.push({
        ...row, tenantId, projectId, status,
        writeOffReason: notes, reconciledBy: userId || 'ledger-system', ...extra
      });
    }
  }

  // Commitments — same exemption from the is_estimated gate as writeOffRecords
  // above, same reasoning (a budgeted line is never billed to the client).
  let commitments = [];
  const commitmentRows = [];
  if (commitmentIds.length > 0 || commitmentLineIds.length > 0) {
    const { mode, projectTypeName } = await resolveBillingMode(env, { tenantId, projectId });
    if (mode === 'non_billable') {
      const err = new Error(
        `This project is type "${projectTypeName || 'unknown'}" — not client-billable. ` +
        `Override the billing mode for this project in LEDGER if that's wrong.`
      );
      err.code = 'NON_BILLABLE_PROJECT';
      throw err;
    }
    const { resolvedSelection } = await resolveCommitmentSelection(env, { tenantId, projectId, commitmentIds, commitmentLineIds });
    if (resolvedSelection.size === 0) {
      throw new Error(`Nothing to ${verb} — every selected line item is already billed, written off, budgeted, or in a draft Change Order.`);
    }
    commitments = [...resolvedSelection.values()].map(v => v.commitment);
    const lineItems = [...resolvedSelection.values()].map(({ commitment, rawLines }) => ({ commitmentId: commitment.id, rawLines, markupPercent: 0 }));
    for (const row of commitmentBillingRows(lineItems)) {
      commitmentRows.push({
        ...row, tenantId, projectId, status,
        writeOffReason: notes, reconciledBy: userId || 'ledger-system', ...extra
      });
    }
  }

  const allRows = [...tmRows, ...dcRows, ...commitmentRows];
  await insertBillingRecordsBatch(env, allRows);

  const totalAmount = Math.round(allRows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const label = [
    tmEntries.length > 0 ? ticketLabel(tmEntries.map(e => e.number)) : null,
    directCosts.length > 0 ? (directCosts.length > 1 ? `${directCosts.length} Direct Costs` : (directCosts[0].description || 'Direct Cost')) : null,
    commitments.length > 0 ? (commitments.length > 1 ? `${commitments.length} Commitments` : commitmentLabel(commitments[0])) : null
  ].filter(Boolean).join(' + ');

  return { count: allRows.length, totalAmount, label };
}
