// LEDGER Worker client. Uses the scoped frontend key (action-based routes
// only) — see worker/src/index.js for why this is deliberately a different,
// narrower key than the one used for direct testing.

const WORKER_URL = import.meta.env.VITE_WORKER_URL;
const FRONTEND_KEY = import.meta.env.VITE_LEDGER_FRONTEND_KEY;

async function callAction(action, payload) {
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ledger-Service-Key': FRONTEND_KEY
    },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await res.json();
  if (!res.ok) {
    // Carry code/unlinkedCount through so callers can distinguish the
    // "confirm and retry" case (UNLINKED_TIMECARDS) from a plain failure.
    const err = new Error(body.error || `Request failed with status ${res.status}`);
    err.code = body.code;
    err.unlinkedCount = body.unlinkedCount;
    throw err;
  }
  return body;
}

// generate_invoice / push_to_draft_co stream NDJSON — one line per progress
// event, ending in {type:'done', result} or {type:'error', ...}. Always a 200
// HTTP response; success/failure lives in that final line, not res.ok.
async function streamAction(action, payload, onProgress) {
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ledger-Service-Key': FRONTEND_KEY
    },
    body: JSON.stringify({ action, ...payload })
  });

  if (!res.body) {
    // No streaming support (very old browser) — fall back to a plain read.
    const body = await res.json();
    if (body.type === 'error' || !res.ok) {
      const err = new Error(body.error || `Request failed with status ${res.status}`);
      err.code = body.code;
      err.unlinkedCount = body.unlinkedCount;
      throw err;
    }
    return body.result ?? body;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;
  let errorEvt = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.type === 'done') result = evt.result;
      else if (evt.type === 'error') errorEvt = evt;
      else onProgress?.(evt);
    }
  }

  if (errorEvt) {
    const err = new Error(errorEvt.error || 'Request failed');
    err.code = errorEvt.code;
    err.unlinkedCount = errorEvt.unlinkedCount;
    err.ticketNumbers = errorEvt.ticketNumbers;
    throw err;
  }
  return result;
}

export function listPendingTickets({ tenantId, projectId }) {
  return callAction('list_pending_tickets', { tenant_id: tenantId, project_id: projectId });
}

export function ticketDetail({ tenantId, projectId, entryId }) {
  return callAction('ticket_detail', {
    tenant_id: tenantId, project_id: projectId, entry_id: entryId
  });
}

export function listPrimeContracts({ projectId }) {
  return callAction('list_prime_contracts', { project_id: projectId });
}

// Only relevant to generateInvoice (pushToDraftCO never creates an invoice,
// so never touches a billing period).
export function listBillingPeriods({ projectId }) {
  return callAction('list_billing_periods', { project_id: projectId });
}

// Preview/edit step (Ben's ask 2026-09-15) — computes exactly what a real
// push would create, without touching Procore, using the SAME logic the
// real path runs. Returns { label, multi, totalAmount, unlinkedCount, lines }
// where each line is { description, hours, rate, amount, timeType }.
export function previewBilling({ tenantId, projectId, entryIds, groupBy, rateOverrides }) {
  return callAction('preview_billing', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds,
    group_by: groupBy, rate_overrides: rateOverrides
  });
}

// The biggest existing invoice_number across every Prime Contract on the
// project, plus 1 — Ben's ask 2026-09-14, replacing the old
// "LEDGER-T5+6-1789368228392" scheme that stood out from every other
// invoice. Shown as a suggestion the PM can type over, not a hard rule.
export async function nextInvoiceNumber({ projectId }) {
  const res = await callAction('next_invoice_number', { project_id: projectId });
  return res.next;
}

// `groupBy`: 'timecard' | 'worker_type' | 'ticket_type' | 'type' | 'total'.
// `rateOverrides`: { regular?, overtime?, double_time?, per_diem? } — a
// one-off override for this build only, not persisted to the rate table.
// `billingPeriodId`: bill against this exact period. `newBillingPeriod`:
// {startDate, endDate, dueDate?} — create one instead of picking an existing
// one. Neither given → the Worker's old fallback (the open period, or one
// dated today) — found live 2026-09-14 that a project with no open period
// silently failed AFTER the Change Event + Change Order were already
// created and approved, so this is exposed here rather than left implicit.
// `onProgress(evt)` fires for each streamed progress line.
// `billingDate`: required — the Worker throws without it. Found live
// 2026-09-14 that this was silently defaulting to the billing period's own
// end date, with no PM visibility or control over it at all.
// `editedLines`: from the preview/edit screen — an array parallel to the
// preview's `lines` (same order/length), each { description?, rate? }.
// Omitted/empty fields on a line mean "keep what preview computed."
export function generateInvoice({
  tenantId, projectId, entryIds, userId, confirmUnlinked, primeContractId, groupBy, rateOverrides,
  editedLines, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress
}) {
  return streamAction('generate_invoice', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, user_id: userId,
    confirm_unlinked: !!confirmUnlinked,
    group_by: groupBy,
    rate_overrides: rateOverrides,
    // Only send when the panel knows which Prime Contract it's in (Procore
    // passed it as context, or the user picked one) — omitted → the Worker
    // picks the first Approved PC, which is ambiguous on a multi-contract project.
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(editedLines ? { edited_lines: editedLines } : {}),
    ...(billingPeriodId ? { billing_period_id: billingPeriodId } : {}),
    ...(newBillingPeriod ? {
      new_billing_period: {
        start_date: newBillingPeriod.startDate, end_date: newBillingPeriod.endDate, due_date: newBillingPeriod.dueDate
      }
    } : {}),
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
    billing_date: billingDate
  }, onProgress);
}

export function pushToDraftCO({ tenantId, projectId, entryIds, userId, confirmUnlinked, primeContractId, groupBy, rateOverrides, editedLines, onProgress }) {
  return streamAction('push_to_draft_co', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, user_id: userId,
    confirm_unlinked: !!confirmUnlinked,
    group_by: groupBy,
    rate_overrides: rateOverrides,
    ...(editedLines ? { edited_lines: editedLines } : {}),
    ...(primeContractId ? { prime_contract_id: primeContractId } : {})
  }, onProgress);
}

// Undoes a 'draft_co' push for a ticket — either because the PM deleted the
// Change Order/Event in Procore (LEDGER also self-heals this automatically on
// the next load, but not for rows written before that tracking existed) or
// just wants to redo it with different settings. Never touches an already-
// invoiced ('billed') row.
export function revertToUnbilled({ tenantId, projectId, entryId, includeBilled, includeWrittenOff, includeBudgeted, includeBilledOutside }) {
  return callAction('revert_to_unbilled', {
    tenant_id: tenantId, project_id: projectId, entry_id: entryId,
    include_billed: !!includeBilled, include_written_off: !!includeWrittenOff,
    include_budgeted: !!includeBudgeted, include_billed_outside: !!includeBilledOutside
  });
}

// Direct costs' own undo (Ben's ask 2026-09-17) — they never had one before.
export function revertDirectCost({ tenantId, projectId, directCostId, includeBilled, includeWrittenOff, includeBudgeted, includeBilledOutside }) {
  return callAction('revert_direct_cost', {
    tenant_id: tenantId, project_id: projectId, direct_cost_id: directCostId,
    include_billed: !!includeBilled, include_written_off: !!includeWrittenOff,
    include_budgeted: !!includeBudgeted, include_billed_outside: !!includeBilledOutside
  });
}

// billingMode: 'tm' | 'fixed_price' | 'non_billable' | null/'auto' to clear
// back to whatever Procore's own project_type derives.
export function setProjectBillingMode({ tenantId, projectId, billingMode, userId }) {
  return callAction('set_project_billing_mode', {
    tenant_id: tenantId, project_id: projectId, billing_mode: billingMode, user_id: userId
  });
}

// ============================================================
// Direct costs (Ben's ask 2026-09-15/16) — same list/detail/preview/commit
// shape as T&M tickets above, parallel actions rather than overloaded ones.
// ============================================================

export function listPendingDirectCosts({ tenantId, projectId }) {
  return callAction('list_pending_direct_costs', { tenant_id: tenantId, project_id: projectId });
}

// Replaces the old directCostDetail (never actually returned line items) —
// per-line DC billing (Ben's ask 2026-09-22) needs tenantId too, to look up
// each line's own billed status.
export function directCostLineDetail({ tenantId, projectId, directCostId }) {
  return callAction('direct_cost_line_detail', { tenant_id: tenantId, project_id: projectId, direct_cost_id: directCostId });
}

// `markupPercent` — omit to use the Worker's own default (20%). `groupBy`:
// 'per_dc' (default) | 'per_line_item' | 'total' — Ben's ask 2026-09-17.
// `directCostLineIds` ("<dcId>:<lineItemId>" strings) — explicit per-line
// picks (Ben's ask 2026-09-22), alongside or instead of whole-DC `directCostIds`.
export function previewDirectCostBilling({ projectId, directCostIds, directCostLineIds, markupPercent, groupBy }) {
  return callAction('preview_direct_cost_billing', {
    project_id: projectId, direct_cost_ids: directCostIds,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(groupBy ? { group_by: groupBy } : {})
  });
}

export function generateDirectCostInvoice({
  tenantId, projectId, directCostIds, directCostLineIds, userId, primeContractId, markupPercent,
  billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress
}) {
  return streamAction('generate_direct_cost_invoice', {
    tenant_id: tenantId, project_id: projectId, direct_cost_ids: directCostIds, user_id: userId,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(billingPeriodId ? { billing_period_id: billingPeriodId } : {}),
    ...(newBillingPeriod ? {
      new_billing_period: {
        start_date: newBillingPeriod.startDate, end_date: newBillingPeriod.endDate, due_date: newBillingPeriod.dueDate
      }
    } : {}),
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
    billing_date: billingDate
  }, onProgress);
}

export function pushDirectCostToDraftCO({ tenantId, projectId, directCostIds, directCostLineIds, userId, primeContractId, markupPercent, onProgress }) {
  return streamAction('push_direct_cost_to_draft_co', {
    tenant_id: tenantId, project_id: projectId, direct_cost_ids: directCostIds, user_id: userId,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {})
  }, onProgress);
}

// ============================================================
// Commitments / subcontractor invoices (Ben's ask 2026-09-24) — same shape
// as direct costs. `commitmentLineIds` are "<commitmentId>:<lineItemId>".
// `groupBy`: 'per_commitment' (default) | 'per_line_item' | 'total'.
// Preview lines carry `isEstimated` — true when the sub hasn't invoiced the
// commitment yet; once billed that way, the Worker blocks further billing on it.
// ============================================================

export function revertCommitment({ tenantId, projectId, commitmentId, includeBilled, includeWrittenOff, includeBudgeted, includeBilledOutside }) {
  return callAction('revert_commitment', {
    tenant_id: tenantId, project_id: projectId, commitment_id: commitmentId,
    include_billed: !!includeBilled, include_written_off: !!includeWrittenOff, include_budgeted: !!includeBudgeted,
    include_billed_outside: !!includeBilledOutside
  });
}

// Project Settings (2026-09-24) — per-project defaults that pre-fill the
// Configure screen. `settings` is the whole form: blank/null fields clear
// back to the company default.
export function getProjectSettings({ tenantId, projectId }) {
  return callAction('get_project_settings', { tenant_id: tenantId, project_id: projectId });
}

export function saveProjectSettings({ tenantId, projectId, userId, settings }) {
  return callAction('save_project_settings', { tenant_id: tenantId, project_id: projectId, user_id: userId, settings });
}

export function listCommitments({ tenantId, projectId }) {
  return callAction('list_commitments', { tenant_id: tenantId, project_id: projectId });
}

export function commitmentLineDetail({ tenantId, projectId, commitmentId }) {
  return callAction('commitment_line_detail', { tenant_id: tenantId, project_id: projectId, commitment_id: commitmentId });
}

export function previewCommitmentBilling({ tenantId, projectId, commitmentIds, commitmentLineIds, markupPercent, groupBy }) {
  return callAction('preview_commitment_billing', {
    tenant_id: tenantId, project_id: projectId, commitment_ids: commitmentIds,
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(groupBy ? { group_by: groupBy } : {})
  });
}

export function generateCommitmentInvoice({
  tenantId, projectId, commitmentIds, commitmentLineIds, userId, primeContractId, markupPercent, groupBy,
  billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress
}) {
  return streamAction('generate_commitment_invoice', {
    tenant_id: tenantId, project_id: projectId, commitment_ids: commitmentIds, user_id: userId,
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(groupBy ? { group_by: groupBy } : {}),
    ...(billingPeriodId ? { billing_period_id: billingPeriodId } : {}),
    ...(newBillingPeriod ? {
      new_billing_period: {
        start_date: newBillingPeriod.startDate, end_date: newBillingPeriod.endDate, due_date: newBillingPeriod.dueDate
      }
    } : {}),
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
    billing_date: billingDate
  }, onProgress);
}

export function pushCommitmentToDraftCO({ tenantId, projectId, commitmentIds, commitmentLineIds, userId, primeContractId, markupPercent, groupBy, onProgress }) {
  return streamAction('push_commitment_to_draft_co', {
    tenant_id: tenantId, project_id: projectId, commitment_ids: commitmentIds, user_id: userId,
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(groupBy ? { group_by: groupBy } : {})
  }, onProgress);
}

// ============================================================
// Combined billing (Ben's ask 2026-09-16) — the action-first flow: pick
// Create Invoice / Push to CO first, then aggregate T&M tickets AND direct
// costs into one submission. Either entryIds or directCostIds may be empty
// (a selection can be all-T&M, all-direct-cost, or a genuine mix) — the
// Worker's combined functions handle all three the same way.
// ============================================================

export function previewCombinedBilling({ tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, groupBy, rateOverrides, markupPercent, cmMarkupPercent, dcGroupBy, cmGroupBy, title }) {
  return callAction('preview_combined_billing', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(cmGroupBy ? { cm_group_by: cmGroupBy } : {}),
    ...(cmMarkupPercent != null && cmMarkupPercent !== '' ? { cm_markup_percent: cmMarkupPercent } : {}),
    group_by: groupBy, rate_overrides: rateOverrides,
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(dcGroupBy ? { dc_group_by: dcGroupBy } : {}),
    ...(title ? { title } : {})
  });
}

export function generateCombinedInvoice({
  tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, userId, confirmUnlinked, primeContractId, groupBy, rateOverrides,
  editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, title, billingPeriodId, newBillingPeriod, invoiceNumber, billingDate, onProgress
}) {
  return streamAction('generate_combined_invoice', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds, user_id: userId,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(cmGroupBy ? { cm_group_by: cmGroupBy } : {}),
    ...(cmMarkupPercent != null && cmMarkupPercent !== '' ? { cm_markup_percent: cmMarkupPercent } : {}),
    ...(editedCmLines ? { edited_cm_lines: editedCmLines } : {}),
    confirm_unlinked: !!confirmUnlinked,
    group_by: groupBy, rate_overrides: rateOverrides,
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(editedTmLines ? { edited_tm_lines: editedTmLines } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(dcGroupBy ? { dc_group_by: dcGroupBy } : {}),
    ...(editedDcLines ? { edited_dc_lines: editedDcLines } : {}),
    ...(title ? { title } : {}),
    ...(billingPeriodId ? { billing_period_id: billingPeriodId } : {}),
    ...(newBillingPeriod ? {
      new_billing_period: {
        start_date: newBillingPeriod.startDate, end_date: newBillingPeriod.endDate, due_date: newBillingPeriod.dueDate
      }
    } : {}),
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}),
    billing_date: billingDate
  }, onProgress);
}

export function pushCombinedToDraftCO({
  tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, userId, confirmUnlinked, primeContractId, groupBy, rateOverrides,
  editedTmLines, markupPercent, cmMarkupPercent, dcGroupBy, editedDcLines, cmGroupBy, editedCmLines, title, onProgress
}) {
  return streamAction('push_combined_to_draft_co', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds, user_id: userId,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    ...(cmGroupBy ? { cm_group_by: cmGroupBy } : {}),
    ...(cmMarkupPercent != null && cmMarkupPercent !== '' ? { cm_markup_percent: cmMarkupPercent } : {}),
    ...(editedCmLines ? { edited_cm_lines: editedCmLines } : {}),
    confirm_unlinked: !!confirmUnlinked,
    group_by: groupBy, rate_overrides: rateOverrides,
    ...(primeContractId ? { prime_contract_id: primeContractId } : {}),
    ...(editedTmLines ? { edited_tm_lines: editedTmLines } : {}),
    ...(markupPercent != null && markupPercent !== '' ? { markup_percent: markupPercent } : {}),
    ...(dcGroupBy ? { dc_group_by: dcGroupBy } : {}),
    ...(editedDcLines ? { edited_dc_lines: editedDcLines } : {}),
    ...(title ? { title } : {})
  }, onProgress);
}

// ============================================================
// Write-offs (Ben's ask 2026-09-17) — pure LEDGER bookkeeping, no Procore
// writes, so this is a plain action (like revert_to_unbilled), not streamed.
// ============================================================

export function writeOffRecords({ tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, userId, reasonCategory, reasonNotes, invoiceNumber }) {
  return callAction('write_off_records', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    user_id: userId, reason_category: reasonCategory, reason_notes: reasonNotes,
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {})
  });
}

// ============================================================
// "Mark as Budgeted" (Ben's ask 2026-09-21) — a third disposition alongside
// Bill and Write Off: "already accounted for in our budgeting, don't bill
// it." Same shape as write-offs (plain action, no Procore writes), just a
// free-text note instead of a fixed reason category.
// ============================================================

// "Already Billed" (Ben's ask 2026-09-25) — billed on an invoice LEDGER didn't
// create; recorded as billed (lands in Billed), with its own simple undo.
export function markAlreadyBilled({ tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, userId, invoiceNumber, notes }) {
  return callAction('mark_already_billed', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    user_id: userId, notes,
    ...(invoiceNumber ? { invoice_number: invoiceNumber } : {})
  });
}

export function markAsBudgeted({ tenantId, projectId, entryIds, directCostIds, directCostLineIds, commitmentIds, commitmentLineIds, userId, notes }) {
  return callAction('mark_as_budgeted', {
    tenant_id: tenantId, project_id: projectId, entry_ids: entryIds, direct_cost_ids: directCostIds,
    ...(directCostLineIds?.length ? { direct_cost_line_ids: directCostLineIds } : {}),
    ...(commitmentIds?.length ? { commitment_ids: commitmentIds } : {}),
    ...(commitmentLineIds?.length ? { commitment_line_ids: commitmentLineIds } : {}),
    user_id: userId, notes
  });
}
