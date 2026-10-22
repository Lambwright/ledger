// LEDGER permission levels — Einbau ID role matrix (shipped 2026-09-30; see
// auth-worker/README.md "Role matrix" and HELM/docs/permissions-matrix.xlsx).
//
// The level comes ONLY from user.appRoles.LEDGER, read from LEDGER's own
// /auth/verify call — never from the page, never from user.role/jobRole.
//   'admin' | 'accounting' | 'pm' | 'viewer'  — enforced as below
//   'no_access', missing, anything else — no access to LEDGER at all
// (The pre-Live 'access' level was removed 2026-10-21: every app has been Live
// since 2026-10-06. Who has which level is managed only in HELM — no people
// are named anywhere in LEDGER's code.)
//
// Levels (Ben's signed-off sheet):
//   viewer      dashboard + read-only sidebar (Review Project). No writes.
//   pm          + invoice / push to CO / standalone; Already Billed / Budgeted /
//                 Write Off; undo their OWN marks; Project Settings
//   accounting  identical to pm FOR NOW — kept as its own branch on purpose:
//                 it may later become narrower than pm, never broader. People in
//                 accounting who need more are made admin, per person.
//   admin       + undo ANYONE's marks, bulk reconcile / Reopen project,
//                 publishing shared dashboard views (and company defaults, if
//                 that screen is ever built). The dashboard's source-record
//                 drill-down is open to every level.

export const NO_ACCESS_MESSAGE = "You don't have access to LEDGER — ask a HELM admin to grant it.";

const KNOWN = new Set(['admin', 'accounting', 'pm', 'viewer']);

// The user's LEDGER level, or null for no access.
export function ledgerLevel(user) {
  const value = String(user?.appRoles?.LEDGER ?? '').toLowerCase();
  return KNOWN.has(value) ? value : null;
}

// HELM tool permissions (Ben, 2026-10-21): give one feature to specific people
// without making them LEDGER admin. Ben grants them in HELM → Role Matrix →
// Tool permissions; they arrive as user.appExtras.LEDGER (a list of ids, or
// an {id: true} map — both accepted). Admins always have them.
//   bulk_reconcile — Bulk reconcile projects (and Reopen)
//   publish_views  — Publish standard dashboard views
function hasTool(user, id) {
  const extras = user?.appExtras?.LEDGER;
  if (Array.isArray(extras)) return extras.map((x) => String(x).toLowerCase()).includes(id);
  if (extras && typeof extras === 'object') return extras[id] === true;
  return false;
}

// One function per capability, each listing its levels explicitly — so
// narrowing accounting later is a one-line change in the right place.
// The tool-permission ones take the user too.
export const can = {
  // Billing, dispositions, Project Settings — anything that writes.
  write: (level) => level === 'admin' || level === 'pm' || level === 'accounting',
  // Undo someone else's mark. pm/accounting can only undo their own.
  undoAnyone: (level) => level === 'admin',
  // Dashboard source-record drill-down: basic, read-only LEDGER functionality,
  // open to every level (Ben, 2026-10-21).
  sourceRecords: (level) => level != null,
  // Bulk reconcile / Reopen project.
  bulkReconcile: (level, user) => level === 'admin' || (level != null && hasTool(user, 'bulk_reconcile')),
  // Create, edit and delete the shared (standard) dashboard views.
  publishViews: (level, user) => level === 'admin' || (level != null && hasTool(user, 'publish_views'))
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
