// LEDGER permission levels — Einbau ID role matrix (shipped 2026-09-30; see
// auth-worker/README.md "Role matrix" and HELM/docs/permissions-matrix.xlsx).
//
// The level comes ONLY from user.appRoles.LEDGER, read from LEDGER's own
// /auth/verify call — never from the page, never from user.role/jobRole.
//   'admin' | 'accounting' | 'pm' | 'viewer'  — enforced as below
//   'access'      — LEDGER's "Live" switch in HELM is still off: behave exactly
//                   as LEDGER did before roles, so nobody loses anything until
//                   Ben flips it
//   'no_access', missing, anything else — no access to LEDGER at all
//
// Levels (Ben's signed-off sheet):
//   viewer      dashboard + read-only sidebar (Review Project). No writes.
//   pm          + invoice / push to CO / standalone; Already Billed / Budgeted /
//                 Write Off; undo their OWN marks; Project Settings
//   accounting  identical to pm FOR NOW — kept as its own branch on purpose:
//                 it may later become narrower than pm, never broader. People in
//                 accounting who need more are made admin, per person.
//   admin       + undo ANYONE's marks, dashboard source-record drill-down,
//                 bulk reconcile / Reopen project (and company defaults, if
//                 that screen is ever built)

export const NO_ACCESS_MESSAGE = "You don't have access to LEDGER — ask Ben to grant it in HELM.";

const KNOWN = new Set(['admin', 'accounting', 'pm', 'viewer', 'access']);

// The user's LEDGER level, or null for no access.
export function ledgerLevel(user) {
  const value = String(user?.appRoles?.LEDGER ?? '').toLowerCase();
  return KNOWN.has(value) ? value : null;
}

// One function per capability, each listing its levels explicitly — so
// narrowing accounting later is a one-line change in the right place.
export const can = {
  // Billing, dispositions, Project Settings — anything that writes.
  write: (level) => level === 'admin' || level === 'pm' || level === 'accounting' || level === 'access',
  // Undo someone else's mark. pm/accounting can only undo their own.
  undoAnyone: (level) => level === 'admin' || level === 'access',
  // Dashboard source-record drill-down.
  sourceRecords: (level) => level === 'admin' || level === 'access',
  // Bulk reconcile / Reopen project. Not available before the switch either:
  // it only ever existed for people set to LEDGER admin.
  bulkReconcile: (level) => level === 'admin'
};

// Sidebar actions every level may call (they only read). Anything NOT listed
// here needs can.write — so a new action is closed to viewers by default.
export const READ_ACTIONS = new Set([
  'list_pending_tickets', 'list_pending_direct_costs', 'list_commitments',
  'ticket_detail', 'direct_cost_line_detail', 'commitment_line_detail',
  'preview_billing', 'preview_combined_billing', 'preview_commitment_billing', 'preview_direct_cost_billing',
  'list_prime_contracts', 'list_billing_periods', 'next_invoice_number',
  'get_project_settings', 'search_projects', 'project_reconciliation',
  // Record-count upkeep for the dashboard (the sidebar posts counts it already
  // has) — no billing data changes.
  'save_portfolio_counts'
]);

export const UNDO_ACTIONS = new Set(['revert_to_unbilled', 'revert_direct_cost', 'revert_commitment']);
