// LEDGER Worker — router.
//
// Two kinds of requests:
//   1. { target: "procore" | "db", ... } — generic passthrough, used for
//      manual testing/debugging against real Procore/Neon data directly.
//   2. { action: "...", ... } — LEDGER's actual business logic (app.js).
//      This is what the real frontend calls.
//
// Required secrets (set via `wrangler secret put <NAME>` — never committed):
//   PROCORE_CLIENT_ID       — LEDGER's own Procore Developer app client id
//   PROCORE_CLIENT_SECRET   — matching client secret
//   PROCORE_COMPANY_ID      — Einbau's Procore company id
//   NEON_DATABASE_URL       — Neon connection string (postgres://user:pass@host/db)
//   LEDGER_SERVICE_KEY      — shared secret our own apps send back to us,
//                             so this isn't an open proxy for anyone who finds the URL.

import { procoreRequest } from './procore.js';
import { dbQuery } from './db.js';
import {
  listPendingTickets, ticketDetail, generateInvoice, pushToDraftCO, previewBilling,
  setProjectBillingMode, getProjectSettings, saveProjectSettings, setProjectRates, listPrimeContracts, listBillingPeriods, nextInvoiceNumber, revertToUnbilled, revertDirectCost,
  listPendingDirectCosts, directCostLineDetail, previewDirectCostBilling, generateDirectCostInvoice, pushDirectCostToDraftCO,
  previewCombinedBilling, generateCombinedInvoice, pushCombinedToDraftCO, writeOffRecords, markAsBudgeted, markAsAlreadyBilled,
  invoiceExistingChangeOrder,
  listCommitments, commitmentLineDetail, previewCommitmentBilling, generateCommitmentInvoice, pushCommitmentToDraftCO,
  revertCommitment
} from './app.js';
import {
  handleProcoreWebhook, refreshIfStale, refreshProjectSnapshot, refreshProjectCounts, saveProjectCounts, projectSourceRecords,
  runScheduled, verifyEinbauUser, listPortfolio
} from './portfolio.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ledger-Service-Key, Authorization',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

// One NDJSON line per progress event, terminated by a {type:'done'} or
// {type:'error'} line — lets generate_invoice/push_to_draft_co stream "CE
// created — id X", "CO created — id Y", per-line-item progress, etc. back to
// the panel as they happen, instead of one silent wait for the whole batch.
// Always resolves to a 200 response; success/failure lives in the final NDJSON
// line, not the HTTP status (the frontend's stream reader checks that line,
// not res.ok — see api.js streamAction).
function ndjsonResponse() {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  async function send(obj) {
    try {
      await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // client went away mid-stream — nothing to do
    }
  }
  return {
    response: new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', ...CORS_HEADERS }
    }),
    send,
    close: () => writer.close().catch(() => {})
  };
}

async function handleStreamingBillingAction(env, body) {
  const {
    action, tenant_id, project_id, entry_id, entry_ids, user_id,
    prime_contract_id, confirm_unlinked, group_by, rate_overrides, edited_lines,
    billing_period_id, new_billing_period, invoice_number, billing_date
  } = body;
  const haveEntries = entry_id || (Array.isArray(entry_ids) && entry_ids.length > 0);
  const { response, send, close } = ndjsonResponse();

  (async () => {
    try {
      if (!tenant_id || !project_id || !haveEntries) {
        throw new Error('tenant_id, project_id, and entry_id (or entry_ids) are required');
      }
      const fn = action === 'generate_invoice' ? generateInvoice : pushToDraftCO;
      const result = await fn(env, {
        tenantId: tenant_id, projectId: project_id,
        entryId: entry_id, entryIds: entry_ids,
        userId: user_id, primeContractId: prime_contract_id, confirmUnlinked: !!confirm_unlinked,
        groupBy: group_by, rateOverrides: rate_overrides, editedLines: edited_lines,
        billingPeriodId: billing_period_id,
        newBillingPeriod: new_billing_period && {
          startDate: new_billing_period.start_date,
          endDate: new_billing_period.end_date,
          dueDate: new_billing_period.due_date
        },
        invoiceNumber: invoice_number,
        billingDate: billing_date,
        onProgress: (evt) => send({ type: 'progress', ...evt })
      });
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message, code: e.code, unlinkedCount: e.unlinkedCount, ticketNumbers: e.ticketNumbers });
    } finally {
      await close();
    }
  })();

  return response;
}

// Direct-cost billing actions get their own streaming handler rather than
// overloading handleStreamingBillingAction with T&M-only params
// (group_by/confirm_unlinked mean nothing here) or direct-cost-only ones
// (markup_percent means nothing there).
async function handleStreamingDirectCostAction(env, body) {
  const {
    action, tenant_id, project_id, direct_cost_id, direct_cost_ids, direct_cost_line_ids, user_id,
    prime_contract_id, markup_percent, group_by,
    billing_period_id, new_billing_period, invoice_number, billing_date
  } = body;
  const haveEntries = direct_cost_id || (Array.isArray(direct_cost_ids) && direct_cost_ids.length > 0) ||
    (Array.isArray(direct_cost_line_ids) && direct_cost_line_ids.length > 0);
  const { response, send, close } = ndjsonResponse();

  (async () => {
    try {
      if (!tenant_id || !project_id || !haveEntries) {
        throw new Error('tenant_id, project_id, and direct_cost_id (or direct_cost_ids/direct_cost_line_ids) are required');
      }
      const fn = action === 'generate_direct_cost_invoice' ? generateDirectCostInvoice : pushDirectCostToDraftCO;
      const result = await fn(env, {
        tenantId: tenant_id, projectId: project_id,
        directCostId: direct_cost_id, directCostIds: direct_cost_ids, directCostLineIds: direct_cost_line_ids,
        userId: user_id, primeContractId: prime_contract_id, markupPercent: markup_percent, groupBy: group_by,
        billingPeriodId: billing_period_id,
        newBillingPeriod: new_billing_period && {
          startDate: new_billing_period.start_date,
          endDate: new_billing_period.end_date,
          dueDate: new_billing_period.due_date
        },
        invoiceNumber: invoice_number,
        billingDate: billing_date,
        onProgress: (evt) => send({ type: 'progress', ...evt })
      });
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message, code: e.code });
    } finally {
      await close();
    }
  })();

  return response;
}

// Commitments get their own streaming handler for the same reason direct
// costs did — the param shape (commitment_id(s)/commitment_line_ids, no
// group_by concerns beyond per_commitment/per_line_item/total) doesn't fit
// either of the other two handlers cleanly.
async function handleStreamingCommitmentAction(env, body) {
  const {
    action, tenant_id, project_id, commitment_id, commitment_ids, commitment_line_ids, user_id,
    prime_contract_id, markup_percent, group_by,
    billing_period_id, new_billing_period, invoice_number, billing_date
  } = body;
  const haveEntries = commitment_id || (Array.isArray(commitment_ids) && commitment_ids.length > 0) ||
    (Array.isArray(commitment_line_ids) && commitment_line_ids.length > 0);
  const { response, send, close } = ndjsonResponse();

  (async () => {
    try {
      if (!tenant_id || !project_id || !haveEntries) {
        throw new Error('tenant_id, project_id, and commitment_id (or commitment_ids/commitment_line_ids) are required');
      }
      const fn = action === 'generate_commitment_invoice' ? generateCommitmentInvoice : pushCommitmentToDraftCO;
      const result = await fn(env, {
        tenantId: tenant_id, projectId: project_id,
        commitmentId: commitment_id, commitmentIds: commitment_ids, commitmentLineIds: commitment_line_ids,
        userId: user_id, primeContractId: prime_contract_id, markupPercent: markup_percent, groupBy: group_by,
        billingPeriodId: billing_period_id,
        newBillingPeriod: new_billing_period && {
          startDate: new_billing_period.start_date,
          endDate: new_billing_period.end_date,
          dueDate: new_billing_period.due_date
        },
        invoiceNumber: invoice_number,
        billingDate: billing_date,
        onProgress: (evt) => send({ type: 'progress', ...evt })
      });
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message, code: e.code });
    } finally {
      await close();
    }
  })();

  return response;
}

// Invoices an already-existing, already-approved Change Order LEDGER didn't
// build itself (Ben's ask 2026-09-23/24) — see invoiceExistingChangeOrder's
// own comment in app.js for the real scope/gap (no billing_records tracking
// possible for a CO with no underlying T&M/DC source).
async function handleStreamingInvoiceExistingCoAction(env, body) {
  const {
    project_id, contract_id, change_order_id,
    billing_period_id, new_billing_period, invoice_number, billing_date
  } = body;
  const { response, send, close } = ndjsonResponse();

  (async () => {
    try {
      if (!project_id || !contract_id || !change_order_id) {
        throw new Error('project_id, contract_id, and change_order_id are required');
      }
      const result = await invoiceExistingChangeOrder(env, {
        projectId: project_id, contractId: contract_id, changeOrderId: change_order_id,
        billingPeriodId: billing_period_id,
        newBillingPeriod: new_billing_period && {
          startDate: new_billing_period.start_date,
          endDate: new_billing_period.end_date,
          dueDate: new_billing_period.due_date
        },
        invoiceNumber: invoice_number,
        billingDate: billing_date,
        onProgress: (evt) => send({ type: 'progress', ...evt })
      });
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message, code: e.code });
    } finally {
      await close();
    }
  })();

  return response;
}

// Combined billing (Ben's ask 2026-09-16) — "pick an action first, then
// aggregate T&M tickets AND direct costs into one submission" instead of the
// old per-source tab flow. Gets its own streaming handler for the same reason
// the direct-cost one did: the param shape genuinely differs (both entry_ids
// AND direct_cost_ids may be present together, plus group_by/rate_overrides
// AND markup_percent may both matter on the same request).
async function handleStreamingCombinedAction(env, body) {
  const {
    action, tenant_id, project_id, entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids, user_id,
    prime_contract_id, confirm_unlinked, group_by, rate_overrides, edited_tm_lines,
    markup_percent, cm_markup_percent, dc_group_by, edited_dc_lines, cm_group_by, edited_cm_lines,
    title, billing_period_id, new_billing_period, invoice_number, billing_date
  } = body;
  const haveEntries = [entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids]
    .some(a => Array.isArray(a) && a.length > 0);
  const { response, send, close } = ndjsonResponse();

  (async () => {
    try {
      if (!tenant_id || !project_id || !haveEntries) {
        throw new Error('tenant_id, project_id, and at least one T&M ticket, direct cost, or commitment are required');
      }
      const fn = action === 'generate_combined_invoice' ? generateCombinedInvoice : pushCombinedToDraftCO;
      const result = await fn(env, {
        tenantId: tenant_id, projectId: project_id,
        entryIds: entry_ids || [], directCostIds: direct_cost_ids || [], directCostLineIds: direct_cost_line_ids || [],
        commitmentIds: commitment_ids || [], commitmentLineIds: commitment_line_ids || [],
        cmGroupBy: cm_group_by, editedCmLines: edited_cm_lines, cmMarkupPercent: cm_markup_percent,
        userId: user_id, primeContractId: prime_contract_id, confirmUnlinked: !!confirm_unlinked,
        groupBy: group_by, rateOverrides: rate_overrides, editedTmLines: edited_tm_lines,
        markupPercent: markup_percent, dcGroupBy: dc_group_by, editedDcLines: edited_dc_lines, title,
        billingPeriodId: billing_period_id,
        newBillingPeriod: new_billing_period && {
          startDate: new_billing_period.start_date,
          endDate: new_billing_period.end_date,
          dueDate: new_billing_period.due_date
        },
        invoiceNumber: invoice_number,
        billingDate: billing_date,
        onProgress: (evt) => send({ type: 'progress', ...evt })
      });
      await send({ type: 'done', result });
    } catch (e) {
      await send({ type: 'error', error: e.message, code: e.code, unlinkedCount: e.unlinkedCount, ticketNumbers: e.ticketNumbers });
    } finally {
      await close();
    }
  })();

  return response;
}

async function handleGenericProcore(env, body) {
  const { status, data } = await procoreRequest(env, body.method, body.path, body.data);
  return json(data, status);
}

async function handleGenericDb(env, body) {
  const { query, params } = body;
  if (!query || typeof query !== 'string') {
    return json({ error: 'query (SQL string) is required' }, 400);
  }
  const rows = await dbQuery(env, query, params);
  return json(rows, 200);
}

async function handleAction(env, body, ctx) {
  const { action } = body;

  // The sidebar already has every list loaded — it sends its record counts
  // here so the portfolio stays current at no extra Procore cost.
  if (action === 'save_portfolio_counts') {
    const { tenant_id, project_id, counts } = body;
    if (!tenant_id || !project_id || !counts) return json({ error: 'tenant_id, project_id and counts are required' }, 400);
    await saveProjectCounts(env, String(tenant_id), project_id, counts);
    return json({ ok: true }, 200);
  }


  if (action === 'revert_to_unbilled') {
    const { tenant_id, project_id, entry_id, include_billed, include_written_off, include_budgeted, include_billed_outside } = body;
    if (!tenant_id || !project_id || !entry_id) {
      return json({ error: 'tenant_id, project_id, and entry_id are required' }, 400);
    }
    const result = await revertToUnbilled(env, {
      tenantId: tenant_id, projectId: project_id, entryId: entry_id,
      includeBilled: !!include_billed, includeWrittenOff: !!include_written_off, includeBudgeted: !!include_budgeted,
      includeBilledOutside: !!include_billed_outside
    });
    return json(result, 200);
  }

  if (action === 'revert_direct_cost') {
    const { tenant_id, project_id, direct_cost_id, include_billed, include_written_off, include_budgeted, include_billed_outside } = body;
    if (!tenant_id || !project_id || !direct_cost_id) {
      return json({ error: 'tenant_id, project_id, and direct_cost_id are required' }, 400);
    }
    const result = await revertDirectCost(env, {
      tenantId: tenant_id, projectId: project_id, directCostId: direct_cost_id,
      includeBilled: !!include_billed, includeWrittenOff: !!include_written_off, includeBudgeted: !!include_budgeted,
      includeBilledOutside: !!include_billed_outside
    });
    return json(result, 200);
  }

  if (action === 'revert_commitment') {
    const { tenant_id, project_id, commitment_id, include_billed, include_written_off, include_budgeted, include_billed_outside } = body;
    if (!tenant_id || !project_id || !commitment_id) {
      return json({ error: 'tenant_id, project_id, and commitment_id are required' }, 400);
    }
    const result = await revertCommitment(env, {
      tenantId: tenant_id, projectId: project_id, commitmentId: commitment_id,
      includeBilled: !!include_billed, includeWrittenOff: !!include_written_off, includeBudgeted: !!include_budgeted,
      includeBilledOutside: !!include_billed_outside
    });
    return json(result, 200);
  }

  // Write-offs (Ben's ask 2026-09-17) — pure LEDGER bookkeeping, no Procore
  // writes, so this is a plain (non-streamed) action like revert_to_unbilled.
  if (action === 'write_off_records') {
    const {
      tenant_id, project_id, entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids,
      user_id, reason_category, reason_notes, invoice_number
    } = body;
    const haveEntries = (Array.isArray(entry_ids) && entry_ids.length > 0) ||
      (Array.isArray(direct_cost_ids) && direct_cost_ids.length > 0) ||
      (Array.isArray(direct_cost_line_ids) && direct_cost_line_ids.length > 0) ||
      (Array.isArray(commitment_ids) && commitment_ids.length > 0) ||
      (Array.isArray(commitment_line_ids) && commitment_line_ids.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and entry_ids, direct_cost_ids/direct_cost_line_ids, or commitment_ids/commitment_line_ids are required' }, 400);
    }
    try {
      const result = await writeOffRecords(env, {
        tenantId: tenant_id, projectId: project_id, entryIds: entry_ids || [], directCostIds: direct_cost_ids || [],
        directCostLineIds: direct_cost_line_ids || [], commitmentIds: commitment_ids || [], commitmentLineIds: commitment_line_ids || [],
        userId: user_id, reasonCategory: reason_category, reasonNotes: reason_notes, invoiceNumber: invoice_number
      });
      return json(result, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  // "Already Billed" (Ben's ask 2026-09-25) — same shape as Mark as Budgeted,
  // recorded as billed on an invoice LEDGER didn't create.
  if (action === 'mark_already_billed') {
    const {
      tenant_id, project_id, entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids,
      user_id, notes, invoice_number
    } = body;
    const haveEntries = [entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids]
      .some(a => Array.isArray(a) && a.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and at least one item are required' }, 400);
    }
    try {
      const result = await markAsAlreadyBilled(env, {
        tenantId: tenant_id, projectId: project_id, entryIds: entry_ids || [], directCostIds: direct_cost_ids || [],
        directCostLineIds: direct_cost_line_ids || [], commitmentIds: commitment_ids || [], commitmentLineIds: commitment_line_ids || [],
        userId: user_id, notes, invoiceNumber: invoice_number
      });
      return json(result, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  // "Mark as Budgeted" (Ben's ask 2026-09-21) — same shape as write-offs,
  // just a different status and a plain note instead of a reason category.
  if (action === 'mark_as_budgeted') {
    const {
      tenant_id, project_id, entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids,
      user_id, notes
    } = body;
    const haveEntries = (Array.isArray(entry_ids) && entry_ids.length > 0) ||
      (Array.isArray(direct_cost_ids) && direct_cost_ids.length > 0) ||
      (Array.isArray(direct_cost_line_ids) && direct_cost_line_ids.length > 0) ||
      (Array.isArray(commitment_ids) && commitment_ids.length > 0) ||
      (Array.isArray(commitment_line_ids) && commitment_line_ids.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and entry_ids, direct_cost_ids/direct_cost_line_ids, or commitment_ids/commitment_line_ids are required' }, 400);
    }
    try {
      const result = await markAsBudgeted(env, {
        tenantId: tenant_id, projectId: project_id, entryIds: entry_ids || [], directCostIds: direct_cost_ids || [],
        directCostLineIds: direct_cost_line_ids || [], commitmentIds: commitment_ids || [], commitmentLineIds: commitment_line_ids || [],
        userId: user_id, notes
      });
      return json(result, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  if (action === 'list_pending_tickets') {
    const { tenant_id, project_id } = body;
    if (!tenant_id || !project_id) {
      return json({ error: 'tenant_id and project_id are required' }, 400);
    }
    const tickets = await listPendingTickets(env, { tenantId: tenant_id, projectId: project_id });
    // Opening a project in the sidebar keeps its portfolio row current.
    ctx?.waitUntil(refreshIfStale(env, tenant_id, project_id).catch(() => {}));
    return json(tickets, 200);
  }

  if (action === 'ticket_detail') {
    const { tenant_id, project_id, entry_id } = body;
    if (!tenant_id || !project_id || !entry_id) {
      return json({ error: 'tenant_id, project_id, and entry_id are required' }, 400);
    }
    const detail = await ticketDetail(env, { tenantId: tenant_id, projectId: project_id, entryId: entry_id });
    return json(detail, 200);
  }

  if (action === 'set_project_billing_mode') {
    const { tenant_id, project_id, billing_mode, user_id } = body;
    if (!tenant_id || !project_id) {
      return json({ error: 'tenant_id and project_id are required' }, 400);
    }
    const result = await setProjectBillingMode(env, {
      tenantId: tenant_id, projectId: project_id, billingMode: billing_mode, userId: user_id
    });
    return json(result, 200);
  }

  if (action === 'get_project_settings') {
    const { tenant_id, project_id } = body;
    if (!tenant_id || !project_id) return json({ error: 'tenant_id and project_id are required' }, 400);
    return json(await getProjectSettings(env, { tenantId: tenant_id, projectId: project_id }), 200);
  }

  if (action === 'save_project_settings') {
    const { tenant_id, project_id, user_id, settings } = body;
    if (!tenant_id || !project_id || !settings) return json({ error: 'tenant_id, project_id and settings are required' }, 400);
    try {
      return json(await saveProjectSettings(env, { tenantId: tenant_id, projectId: project_id, userId: user_id, settings }), 200);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  // HANDOFF → LEDGER: set a project's T&M bill rates (only the time types
  // given). See HANDOFF's README, "LEDGER: project T&M rates".
  if (action === 'set_project_rates') {
    const { tenant_id, project_id, user_id, rates } = body;
    if (!tenant_id || !project_id || !rates) return json({ error: 'tenant_id, project_id and rates are required' }, 400);
    try {
      return json({ rates: await setProjectRates(env, { tenantId: tenant_id, projectId: project_id, userId: user_id, rates }) }, 200);
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  }

  if (action === 'list_prime_contracts') {
    const { project_id } = body;
    if (!project_id) return json({ error: 'project_id is required' }, 400);
    const contracts = await listPrimeContracts(env, { projectId: project_id });
    return json(contracts, 200);
  }

  if (action === 'list_billing_periods') {
    const { project_id } = body;
    if (!project_id) return json({ error: 'project_id is required' }, 400);
    const periods = await listBillingPeriods(env, { projectId: project_id });
    return json(periods, 200);
  }

  if (action === 'next_invoice_number') {
    const { project_id } = body;
    if (!project_id) return json({ error: 'project_id is required' }, 400);
    const next = await nextInvoiceNumber(env, { projectId: project_id });
    return json({ next }, 200);
  }

  // Preview/edit step (Ben's ask 2026-09-15) — computes exactly what a real
  // push would create, without touching Procore. Not streamed: it's reads +
  // computation only, no long Procore write sequence to report progress on.
  if (action === 'preview_billing') {
    const { tenant_id, project_id, entry_id, entry_ids, group_by, rate_overrides } = body;
    if (!tenant_id || !project_id || !(entry_id || (Array.isArray(entry_ids) && entry_ids.length > 0))) {
      return json({ error: 'tenant_id, project_id, and entry_id (or entry_ids) are required' }, 400);
    }
    try {
      const preview = await previewBilling(env, {
        tenantId: tenant_id, projectId: project_id, entryId: entry_id, entryIds: entry_ids,
        groupBy: group_by, rateOverrides: rate_overrides
      });
      return json(preview, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  // Both billing actions take entry_id (single) OR entry_ids (array) — the
  // frontend's multi-select sends entry_ids; app.js normalizes either shape.
  // Streamed as NDJSON (see ndjsonResponse) so the panel gets live progress —
  // "CE created", "CO created", per-line-item progress — instead of one
  // silent wait for the whole batch.
  if (action === 'generate_invoice' || action === 'push_to_draft_co') {
    return await handleStreamingBillingAction(env, body);
  }

  // Direct costs (Ben's ask 2026-09-15/16) — same list/detail/preview/commit
  // shape as T&M tickets, parallel actions rather than overloading the T&M
  // ones (see app.js for why they're separate functions).
  if (action === 'list_pending_direct_costs') {
    const { tenant_id, project_id } = body;
    if (!tenant_id || !project_id) {
      return json({ error: 'tenant_id and project_id are required' }, 400);
    }
    const result = await listPendingDirectCosts(env, { tenantId: tenant_id, projectId: project_id });
    return json(result, 200);
  }

  if (action === 'direct_cost_line_detail') {
    const { tenant_id, project_id, direct_cost_id } = body;
    if (!tenant_id || !project_id || !direct_cost_id) {
      return json({ error: 'tenant_id, project_id and direct_cost_id are required' }, 400);
    }
    const result = await directCostLineDetail(env, { tenantId: tenant_id, projectId: project_id, directCostId: direct_cost_id });
    return json(result, 200);
  }

  if (action === 'preview_direct_cost_billing') {
    const { tenant_id, project_id, direct_cost_ids, direct_cost_line_ids, markup_percent, group_by } = body;
    const haveEntries = (Array.isArray(direct_cost_ids) && direct_cost_ids.length > 0) ||
      (Array.isArray(direct_cost_line_ids) && direct_cost_line_ids.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and direct_cost_ids or direct_cost_line_ids are required' }, 400);
    }
    try {
      const preview = await previewDirectCostBilling(env, {
        tenantId: tenant_id, projectId: project_id, directCostIds: direct_cost_ids, directCostLineIds: direct_cost_line_ids,
        markupPercent: markup_percent, groupBy: group_by
      });
      return json(preview, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  if (action === 'generate_direct_cost_invoice' || action === 'push_direct_cost_to_draft_co') {
    return await handleStreamingDirectCostAction(env, body);
  }

  if (action === 'invoice_existing_change_order') {
    return await handleStreamingInvoiceExistingCoAction(env, body);
  }

  // Commitments / subcontractor invoices (Ben's ask 2026-09-24) — same
  // list/detail/preview/commit shape as direct costs, parallel actions rather
  // than overloading the direct-cost ones (see app.js for why).
  if (action === 'list_commitments') {
    const { tenant_id, project_id } = body;
    if (!tenant_id || !project_id) {
      return json({ error: 'tenant_id and project_id are required' }, 400);
    }
    const result = await listCommitments(env, { tenantId: tenant_id, projectId: project_id });
    return json(result, 200);
  }

  if (action === 'commitment_line_detail') {
    const { tenant_id, project_id, commitment_id } = body;
    if (!tenant_id || !project_id || !commitment_id) {
      return json({ error: 'tenant_id, project_id and commitment_id are required' }, 400);
    }
    const result = await commitmentLineDetail(env, { tenantId: tenant_id, projectId: project_id, commitmentId: commitment_id });
    return json(result, 200);
  }

  if (action === 'preview_commitment_billing') {
    const { tenant_id, project_id, commitment_ids, commitment_line_ids, markup_percent, group_by } = body;
    const haveEntries = (Array.isArray(commitment_ids) && commitment_ids.length > 0) ||
      (Array.isArray(commitment_line_ids) && commitment_line_ids.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and commitment_ids or commitment_line_ids are required' }, 400);
    }
    try {
      const preview = await previewCommitmentBilling(env, {
        tenantId: tenant_id, projectId: project_id, commitmentIds: commitment_ids, commitmentLineIds: commitment_line_ids,
        markupPercent: markup_percent, groupBy: group_by
      });
      return json(preview, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  if (action === 'generate_commitment_invoice' || action === 'push_commitment_to_draft_co') {
    return await handleStreamingCommitmentAction(env, body);
  }

  // Combined billing (Ben's ask 2026-09-16) — the action-first flow that
  // aggregates T&M tickets AND direct costs into one CE/CO/invoice.
  if (action === 'preview_combined_billing') {
    const {
      tenant_id, project_id, entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids,
      group_by, rate_overrides, markup_percent, cm_markup_percent, dc_group_by, cm_group_by, title
    } = body;
    const haveEntries = [entry_ids, direct_cost_ids, direct_cost_line_ids, commitment_ids, commitment_line_ids]
      .some(a => Array.isArray(a) && a.length > 0);
    if (!tenant_id || !project_id || !haveEntries) {
      return json({ error: 'tenant_id, project_id, and at least one T&M ticket, direct cost, or commitment are required' }, 400);
    }
    try {
      const preview = await previewCombinedBilling(env, {
        tenantId: tenant_id, projectId: project_id, entryIds: entry_ids || [], directCostIds: direct_cost_ids || [],
        directCostLineIds: direct_cost_line_ids || [], commitmentIds: commitment_ids || [], commitmentLineIds: commitment_line_ids || [],
        groupBy: group_by, rateOverrides: rate_overrides, markupPercent: markup_percent, cmMarkupPercent: cm_markup_percent,
        dcGroupBy: dc_group_by, cmGroupBy: cm_group_by, title
      });
      return json(preview, 200);
    } catch (e) {
      return json({ error: e.message, code: e.code }, 400);
    }
  }

  if (action === 'generate_combined_invoice' || action === 'push_combined_to_draft_co') {
    return await handleStreamingCombinedAction(env, body);
  }

  return json({ error: `unknown action: ${action}` }, 400);
}

// Company portfolio page (lambwright.github.io/ledger/) — Einbau ID gated,
// never the LEDGER frontend key. Reads stored rows; 'refresh_project' is the
// drill-in, a live refresh of one project.
async function handlePortfolio(request, env) {
  const user = await verifyEinbauUser(request, env);
  if (!user) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  const tenantId = String(env.PROCORE_COMPANY_ID);
  if (body.action === 'list') {
    return json({ projects: await listPortfolio(env, tenantId) }, 200);
  }
  if (body.action === 'refresh_project') {
    if (!body.project_id) return json({ error: 'project_id is required' }, 400);
    await refreshProjectSnapshot(env, tenantId, body.project_id);
    await refreshProjectCounts(env, tenantId, body.project_id);
    const rows = await dbQuery(env, 'select * from portfolio_projects where tenant_id = $1 and project_id = $2', [tenantId, String(body.project_id)]);
    return json({ project: rows[0] || null }, 200);
  }
  if (body.action === 'source_records') {
    if (!body.project_id) return json({ error: 'project_id is required' }, 400);
    return json(await projectSourceRecords(env, tenantId, body.project_id), 200);
  }
  return json({ error: `unknown action: ${body.action}` }, 400);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const path = new URL(request.url).pathname;
    if (path === '/procore-webhook') {
      return handleProcoreWebhook(request, env);
    }
    if (path === '/portfolio') {
      try {
        return await handlePortfolio(request, env);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    const callerKey = request.headers.get('X-Ledger-Service-Key');
    const isFullAccess = env.LEDGER_SERVICE_KEY && callerKey === env.LEDGER_SERVICE_KEY;
    // The frontend key is scoped to action-based business logic ONLY — it's embedded
    // in client-side JS (visible to anyone who inspects the page), so it must never
    // be able to reach the raw target:"procore"/"db" passthrough (arbitrary API calls /
    // arbitrary SQL). LEDGER_SERVICE_KEY (full access) stays server-side only.
    const isFrontendAccess = env.LEDGER_FRONTEND_KEY && callerKey === env.LEDGER_FRONTEND_KEY;
    if (!isFullAccess && !isFrontendAccess) {
      return json({ error: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }

    try {
      if (isFrontendAccess && !isFullAccess) {
        if (!body.action) return json({ error: 'this key can only call actions' }, 403);
        return await handleAction(env, body, ctx);
      }
      if (body.target === 'db') {
        return await handleGenericDb(env, body);
      }
      if (body.target === 'procore') {
        return await handleGenericProcore(env, body);
      }
      if (body.action) {
        return await handleAction(env, body, ctx);
      }
      // Backward compatibility: every call made before "target"/"action" existed
      // was an implicit Procore passthrough.
      return await handleGenericProcore(env, body);
    } catch (e) {
      // generate_invoice/push_to_draft_co never throw up to here — they're
      // streamed (see handleStreamingBillingAction), and report UNLINKED_TIMECARDS
      // / NON_BILLABLE_PROJECT as a {type:'error'} line inside their own stream.
      // Everything else (list_pending_tickets, ticket_detail, etc.) lands here.
      return json({ error: e.message }, 500);
    }
  }
};
