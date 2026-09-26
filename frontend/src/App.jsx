import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listPendingTickets, listPendingDirectCosts, listPrimeContracts, listBillingPeriods, nextInvoiceNumber,
  previewCombinedBilling, generateCombinedInvoice, pushCombinedToDraftCO, getProjectSettings, saveProjectSettings, revertToUnbilled,
  revertDirectCost, writeOffRecords, markAsBudgeted, markAlreadyBilled, directCostLineDetail, listCommitments, commitmentLineDetail, revertCommitment, saveProjectCounts,
  previewCommitmentReconciliation, reconcileCommitment
} from './api';
import { connectProcoreSidePanel, isEmbedded } from './procore';

const MODE_LABEL = { tm: 'T&M', fixed_price: 'Fixed-Price', non_billable: 'Not Billable' };
const TIME_TYPE_LABEL = { regular: 'Regular', overtime: 'Overtime', double_time: 'Double Time', per_diem: 'Per Diem' };
const ACTION_LABEL = {
  invoice: 'Generate Invoice', draft: 'Push to CO (draft)', writeoff: 'Write Off', budgeted: 'Mark as Budgeted',
  already_billed: 'Already Billed',
  review: 'Review Project', settings: 'Project Settings'
};

// How the selected tickets' timecards collapse onto Change Order lines.
// 'worker_type' is the default — it already cuts the failure mode that broke
// a 68-line aggregate live 2026-09-13 down to a handful of lines, without
// losing per-worker detail. Procore requires one wbs_code_id (= cost code)
// per line, and each time type is a different cost code, so no mode below
// 'type' can merge different time types onto one line — 'total' is the one
// exception, and it says so in its own label.
const GROUP_BY_OPTIONS = [
  { value: 'worker_type', label: 'Per worker + time type (default)' },
  { value: 'timecard', label: 'Per timecard (finest, most lines)' },
  { value: 'ticket_type', label: 'Per ticket + time type' },
  { value: 'type', label: 'Per time type (whole selection)' },
  { value: 'total', label: 'One line total (blended rate)' }
];

const TOTAL_GROUPING_DISCLAIMER =
  "This mode puts every hour on ONE line at a single averaged rate — Regular, " +
  "Overtime, and Double Time all get blended together. You lose the breakdown " +
  "of which hours were paid at which rate; the invoice line just shows a " +
  "blended $/hr. Use a finer grouping if that breakdown needs to survive onto the CO.";

// Direct-cost grouping (Ben's ask 2026-09-17) — mirrors T&M's GROUP_BY_OPTIONS.
// 'per_line_item' bills each of a direct cost's own real line items under its
// own cost code instead of collapsing them under just the first one's.
const DC_GROUP_BY_OPTIONS = [
  { value: 'per_dc', label: 'Per direct cost (default)' },
  { value: 'per_line_item', label: "Per direct cost's own line items" },
  { value: 'total', label: 'One line total (blended cost code)' }
];

const CM_GROUP_BY_OPTIONS = [
  { value: 'per_commitment', label: 'Per commitment (default)' },
  { value: 'per_line_item', label: "Per commitment's own line items" },
  { value: 'total', label: 'One line total (blended budget code)' }
];

const LABOUR_WARNING_TEXT =
  'This is the least secure way to bill this line. If this is really a billable line, please convert the ' +
  'corresponding timecard to a T&M ticket and bill that way instead.';

// Projects created before 2026-10-11 (Ben's ask 2026-09-24) — see the
// Worker's LEGACY_PROJECT_CUTOFF for why.
const LEGACY_WARNING_TEXT =
  'This project was created before October 11, 2026. LEDGER has no automation on projects this old to prevent ' +
  'double billing from commitments. Review this project and mark everything you can as budgeted, already billed, ' +
  'or written off before billing commitments here.';

const DC_TOTAL_GROUPING_DISCLAIMER =
  "This mode sums every selected direct cost onto ONE line, under the FIRST " +
  "one's cost code — you lose each direct cost's own real code on the CO/invoice.";

// db/schema.sql's write_offs.reason_category check constraint — kept in sync
// by hand since there's no shared source of truth between the DB and the UI.
const WRITE_OFF_REASON_OPTIONS = [
  { value: 'warranty', label: 'Warranty' },
  { value: 'service_call', label: 'Service Call' },
  { value: 'goodwill', label: 'Goodwill' },
  { value: 'pm_decision', label: 'PM Decision' },
  { value: 'other', label: 'Other' }
];

const TENANT_ID = import.meta.env.VITE_TENANT_ID;
const DEFAULT_PROJECT_ID = import.meta.env.VITE_DEFAULT_PROJECT_ID;
const DEFAULT_USER_ID = import.meta.env.VITE_DEFAULT_USER_ID;
const EMBEDDED = isEmbedded();
const FALLBACK_PROCORE_ORIGIN = 'https://us02.procore.com';

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// markup% -> margin% and back, both as plain percentages (20 means 20%, not
// 0.2) — Ben's ask 2026-09-15: a Procore-estimating-tool-style toggle where
// either field can be typed and the other recomputes. markupPercent is kept
// as the single source of truth (also what the Worker actually bills off);
// margin is only ever a derived display/input, converted back to markup
// immediately on edit, so the two can never drift out of sync.
function markupToMargin(markupPct) {
  if (markupPct === '' || markupPct == null) return '';
  const m = Number(markupPct);
  if (!Number.isFinite(m)) return '';
  return String(Math.round((m / (1 + m / 100)) * 1000) / 1000);
}
function marginToMarkup(marginPct) {
  if (marginPct === '' || marginPct == null) return '';
  const g = Number(marginPct);
  if (!Number.isFinite(g) || g >= 100) return '';
  return String(Math.round((g / (1 - g / 100)) * 1000) / 1000);
}

// Markup % and its margin % equivalent, kept in sync — same pair the
// Configure screen always had, reused for Project Settings (2026-09-24).
// A direct cost or commitment with only some lines dispositioned stays in
// Unbilled; history tabs list it too (at that status's own amount) so its
// undo is reachable.
function withPartials(full, unbilled, countKey, toHistoryRow) {
  return [...(full || []), ...unbilled.filter(x => x.partialBilled && x[countKey] > 0).map(toHistoryRow)];
}

function MarkupFields({ label, value, onChange, placeholder }) {
  return (
    <div className="rate-overrides">
      <span className="rate-overrides-label">{label}</span>
      <div className="rate-overrides-row">
        <label className="rate-override-field">
          <span>Markup %</span>
          <input
            type="number" min="0" step="0.01"
            placeholder={placeholder != null ? String(placeholder) : undefined}
            value={value}
            onChange={e => onChange(e.target.value)}
          />
        </label>
        <label className="rate-override-field">
          <span>Margin %</span>
          <input
            type="number" min="0" max="99.999" step="0.01"
            placeholder={placeholder != null ? markupToMargin(placeholder) : undefined}
            value={markupToMargin(value)}
            onChange={e => onChange(marginToMarkup(e.target.value))}
          />
        </label>
      </div>
    </div>
  );
}

// Context source of truth:
//  - Embedded in Procore  → the postMessage handshake in ./procore.js supplies
//    project / resource (Prime Contract) / view / origin; see connectProcoreSidePanel.
//  - Standalone (local dev, direct browser) → URL query params, else the .env
//    default so the app is still usable on its own.
function resolveProjectId(params) {
  return (
    params.get('project_id') ||
    params.get('projectId') ||
    (EMBEDDED ? '' : DEFAULT_PROJECT_ID)
  );
}

function resolveContractId(params) {
  return params.get('contract_id') || params.get('prime_contract_id') || null;
}

// Real Procore user who opened the panel, for the billing_records audit trail
// ("who billed this"). Not in the side-panel handshake context — only available
// via URL param today; falls back to the .env default otherwise.
function resolveUserId(params) {
  return params.get('user_id') || DEFAULT_USER_ID;
}

export default function App() {
  const params = new URLSearchParams(window.location.search);

  const [projectId, setProjectId] = useState(resolveProjectId(params));
  const [contractId, setContractId] = useState(resolveContractId(params));
  const [contractFromProcore, setContractFromProcore] = useState(resolveContractId(params) != null);
  const [contracts, setContracts] = useState([]);
  const [procoreView, setProcoreView] = useState(null);
  const [procoreOrigin, setProcoreOrigin] = useState(FALLBACK_PROCORE_ORIGIN);
  const userId = resolveUserId(params);

  // Action-first flow (Ben's ask 2026-09-16, replacing the old per-source-tab
  // flow): pick what you're doing BEFORE picking any items. `view` toggles
  // away to a read-only history browser; `action` is null on the landing
  // screen, then 'invoice' | 'draft' for the rest of the flow.
  const [action, setAction] = useState(null); // null | 'invoice' | 'draft' | 'writeoff' | 'budgeted'
  // Sub-tab within the History view (Ben's ask 2026-09-17/21) — 'Unbilled'
  // isn't one of these since that's the action-first picker itself, not history.
  // Review Project tabs (2026-09-24): 'unbilled' is the picker in
  // disposition-only mode; the other three are the billing history.
  const [reviewTab, setReviewTab] = useState('unbilled'); // 'unbilled' | 'billed' | 'writtenoff' | 'budgeted'

  const [tickets, setTickets] = useState(null);
  const [directCosts, setDirectCosts] = useState(null); // { unbilled, billed }
  const [loading, setLoading] = useState(false);
  // True when the last load failed — screens show the error and a retry
  // prompt instead of empty lists / $0 totals that look like real data.
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState(null);
  const [expandedTmId, setExpandedTmId] = useState(null);
  const [expandedDcId, setExpandedDcId] = useState(null);
  const [checkedIds, setCheckedIds] = useState(() => new Set());   // T&M tickets
  const [checkedDcIds, setCheckedDcIds] = useState(() => new Set()); // whole direct costs — "bill everything still unbilled here"
  // Per-line DC billing (Ben's ask 2026-09-22) — explicit "dcId:lineItemId"
  // picks, distinct from checkedDcIds' "bill the whole thing" convenience.
  // dcLineDetailCache is lazy-fetched per DC only once its card is expanded —
  // direct costs have no bulk line-item endpoint, so the picker list itself
  // never fetches real line items just to render a checkbox.
  const [checkedDcLineIds, setCheckedDcLineIds] = useState(() => new Set());
  const [dcLineDetailCache, setDcLineDetailCache] = useState(() => new Map()); // dcId -> detail (with .lines)
  const [dcLineDetailLoading, setDcLineDetailLoading] = useState(null); // dcId currently being fetched, or null
  // Commitments (Ben's ask 2026-09-24). Always selected per-line: ticking a
  // whole commitment expands into its eligible lines (see toggleCommitment),
  // so hours already billed through T&M are never swept in by accident.
  const [commitments, setCommitments] = useState(null);
  const [expandedCmId, setExpandedCmId] = useState(null);
  const [checkedCmLineIds, setCheckedCmLineIds] = useState(() => new Set()); // "cmId:lineId"
  const [cmLineDetailCache, setCmLineDetailCache] = useState(() => new Map()); // cmId -> detail (with .lines)
  const [cmLineDetailLoading, setCmLineDetailLoading] = useState(null);
  // Labour-from-a-subcontract warning pop-up: { lines, onProceed } while open.
  const [labourWarning, setLabourWarning] = useState(null); // { title, text, lines, onProceed }
  const [cmLegacy, setCmLegacy] = useState(false);
  // Legacy-project warning is acknowledged once per session, not per line.
  const [legacyAck, setLegacyAck] = useState(false);
  // Write Off / Mark as Budgeted opened from inside Create Invoice / Push to
  // CO: which billing action to return to afterward, and an optional scope
  // (one commitment's lines) instead of the whole current selection.
  const [dispositionReturn, setDispositionReturn] = useState(null);
  const [dispositionScope, setDispositionScope] = useState(null); // { label, commitmentLineIds, amount }
  // Sub-tab within the picker (Ben's ask 2026-09-16) — purely a display
  // switch, never touches which items are checked.
  const [pickerTab, setPickerTab] = useState('tm'); // 'tm' | 'dc' | 'cm'
  const [generating, setGenerating] = useState(false);
  const [progressLog, setProgressLog] = useState([]);
  const [result, setResult] = useState(null);
  const [revertingId, setRevertingId] = useState(null); // ticket entry id currently being undone
  // Once items are picked, "Configure →" opens the settings/preview overlay
  // for whichever `action` was already chosen on the landing screen.
  const [configuring, setConfiguring] = useState(false);

  const [groupBy, setGroupBy] = useState('worker_type');
  const [rateOverrides, setRateOverrides] = useState({});
  const [markupPercent, setMarkupPercent] = useState('20'); // direct costs — pre-filled from Project Settings
  const [cmMarkupPercent, setCmMarkupPercent] = useState('20'); // commitments — pre-filled from Project Settings
  const [dcGroupBy, setDcGroupBy] = useState('per_dc');
  const [cmGroupBy, setCmGroupBy] = useState('per_commitment');

  // CO / Invoice name override (Ben's ask 2026-09-22) — replaces the
  // auto-generated label ("T&M #5 + 2 Direct Costs") as the actual title on
  // both the Change Event and Change Order. Empty means keep the default.
  const [coTitle, setCoTitle] = useState('');

  // Write-off settings (Ben's ask 2026-09-17) — no preview step, this is all
  // it needs before Confirm.
  const [writeOffReason, setWriteOffReason] = useState('');
  const [writeOffNotes, setWriteOffNotes] = useState('');
  // Only shown/used for reason 'already_billed' (Ben's ask 2026-09-23) — a
  // reference to which invoice it was actually billed on elsewhere, not
  // through LEDGER. Stored in the same billing_records.invoice_number column
  // a real LEDGER-billed row already uses.
  // "Already Billed" (Ben's ask 2026-09-25) — its own action now, not a write-off reason.
  const [alreadyBilledInvoice, setAlreadyBilledInvoice] = useState('');
  const [alreadyBilledNotes, setAlreadyBilledNotes] = useState('');

  // "Mark as Budgeted" settings (Ben's ask 2026-09-21) — same no-preview
  // shape as write-off, just a plain note, no reason category.
  const [budgetedNotes, setBudgetedNotes] = useState('');

  // Only generateInvoice ever touches a billing period (pushToDraftCO
  // doesn't create an invoice). billingPeriodId null + newPeriod fields
  // empty → Worker falls back to its old default (the open period, or one
  // dated today). Exposed here after a project with no billing periods at
  // all silently failed AFTER a real Change Order was already approved —
  // see api.js generateCombinedInvoice.
  const [billingPeriods, setBillingPeriods] = useState([]);
  const [billingPeriodId, setBillingPeriodId] = useState('');
  const [creatingPeriod, setCreatingPeriod] = useState(false);
  const [newPeriodStart, setNewPeriodStart] = useState('');
  const [newPeriodEnd, setNewPeriodEnd] = useState('');

  // Required, not defaulted (Ben's ask 2026-09-14) — was silently defaulting
  // to the billing period's own end date with no PM visibility into it.
  // Pre-filled from whichever period is selected/being created as a
  // starting point, but editable and enforced before submitting.
  const [billingDate, setBillingDate] = useState('');

  // Suggested next invoice number (biggest existing one on the project,
  // + 1) — Ben's ask 2026-09-14, replacing the old
  // "LEDGER-T5+6-1789368228392" scheme that stood out from every other
  // invoice. Fetched lazily only when actually opening Generate Invoice
  // (scans every contract's payment applications — not cheap enough to run
  // on every ticket-list load, and rate limits are already a live problem).
  // Editable — it's a suggestion, not a rule.
  const [invoiceNumberInput, setInvoiceNumberInput] = useState('');
  const [invoiceNumberLoading, setInvoiceNumberLoading] = useState(false);

  // Preview/edit step (Ben's ask 2026-09-15) — shown after group-lines/rate
  // override, before anything is actually created. T&M and direct-cost lines
  // are kept as two separate arrays (not merged) so edits round-trip back to
  // the right backend function's editedLines shape — null means "haven't
  // previewed yet, still on settings".
  const [previewTmLines, setPreviewTmLines] = useState(null);
  const [previewDcLines, setPreviewDcLines] = useState(null);
  const [previewCmLines, setPreviewCmLines] = useState(null);
  const [previewMeta, setPreviewMeta] = useState(null); // { totalAmount, unlinkedCount, label }
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewPopupRef = useRef(null); // the pop-out preview/edit window, if one's open

  const [billingMode, setBillingMode] = useState(null);         // 'tm' | 'fixed_price' | 'non_billable'
  const [billingModeSource, setBillingModeSource] = useState(null); // 'override' | 'project_type' | 'default'
  const [projectTypeName, setProjectTypeName] = useState(null); // raw Procore project_type.name
  // Project Settings (2026-09-24): saved per-project defaults, and the
  // editable form copy shown on the Settings screen.
  const [projectSettings, setProjectSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Handshake with Procore when embedded as a side panel. Fires on load and
  // again if the user navigates to a different record with the panel open.
  // ctx.resourceId is trusted here provisionally as a prime contract id, but
  // NOT acted on as one until the validation effect below confirms it's
  // actually in this project's contract list — confirmed live 2026-09-14
  // that Procore sometimes reports the PROJECT's own id here instead (at
  // least on a Prime Contract's "General" tab), which silently sent the
  // wrong id as prime_contract_id on every push and is the likely real cause
  // of a whole night of intermittent-looking 403s on Change Order creation.
  useEffect(() => {
    if (!EMBEDDED) return;
    return connectProcoreSidePanel({
      onContext: (ctx) => {
        if (ctx.projectId) setProjectId(ctx.projectId);
        setContractId(ctx.resourceId || null);
        setContractFromProcore(ctx.resourceId != null);
        setProcoreView(ctx.view || null);
        if (ctx.origin) setProcoreOrigin(ctx.origin);
      },
    });
  }, []);

  // `preserveResult` lets the post-action refresh reload the lists without
  // wiping the success banner it just set.
  const load = useCallback(async (pid, { preserveResult = false } = {}) => {
    setLoading(true);
    setError(null);
    if (!preserveResult) setResult(null);
    setExpandedTmId(null);
    setExpandedDcId(null);
    setCheckedIds(new Set());
    setCheckedDcIds(new Set());
    setCheckedDcLineIds(new Set());
    setDcLineDetailCache(new Map());
    setExpandedCmId(null);
    setCheckedCmLineIds(new Set());
    setCmLineDetailCache(new Map());
    try {
      const [data, dcData, cmData, contractList, periodList, settings] = await Promise.all([
        listPendingTickets({ tenantId: TENANT_ID, projectId: pid }),
        listPendingDirectCosts({ tenantId: TENANT_ID, projectId: pid }).catch(() => ({ unbilled: [], billed: [], failed: true })),
        listCommitments({ tenantId: TENANT_ID, projectId: pid }).catch(() => ({ unbilled: [], billed: [], writtenOff: [], budgeted: [], failed: true })),
        listPrimeContracts({ projectId: pid }).catch(() => []),
        listBillingPeriods({ projectId: pid }).catch(() => []),
        getProjectSettings({ tenantId: TENANT_ID, projectId: pid }).catch(() => null)
      ]);
      setTickets(data.tickets);
      setLoadFailed(false);
      setProjectSettings(settings);
      setDirectCosts(dcData);
      setCommitments(cmData);
      setCmLegacy(cmData.legacyProject === true);
      setBillingMode(data.billingMode);
      setBillingModeSource(data.billingModeSource);
      setProjectTypeName(data.projectTypeName);
      setContracts(contractList);
      setBillingPeriods(periodList);
      const open = periodList.find(p => p.status === 'open');
      setBillingPeriodId(open ? String(open.id) : '');
      setCreatingPeriod(periodList.length === 0);
    } catch (e) {
      setLoadFailed(true);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Once the contract list is in, default the picker: whatever Procore's
  // side-panel context gave us, else the single contract if there's only one,
  // else the first Approved one (matching what the Worker itself would pick).
  useEffect(() => {
    if (contractFromProcore || contracts.length === 0) return;
    if (!contractId) {
      const saved = projectSettings?.defaultPrimeContractId &&
        contracts.find(c => String(c.id) === String(projectSettings.defaultPrimeContractId));
      const approved = saved || contracts.find(c => c.status === 'Approved') || contracts[0];
      if (approved) setContractId(String(approved.id));
    }
  }, [contracts, contractFromProcore, contractId, projectSettings]);

  // Guards against the bug found live 2026-09-14: Procore's side-panel
  // context isn't reliably a real Prime Contract id (it reported the
  // project's own id at least once, from a Prime Contract's "General" tab),
  // and LEDGER was sending that straight through as prime_contract_id on
  // every push. Once the real contract list is in, if what Procore handed us
  // isn't actually one of this project's contracts, stop trusting it as a
  // lock — the effect above then picks a real one instead.
  useEffect(() => {
    if (!contractFromProcore || contracts.length === 0) return;
    if (!contracts.some(c => String(c.id) === String(contractId))) {
      setContractFromProcore(false);
      setContractId(null);
    }
  }, [contracts, contractFromProcore, contractId]);

  // Only fetch the suggested invoice number when actually configuring
  // Generate Invoice — see the state comment above for why this isn't part
  // of load().
  useEffect(() => {
    if (action !== 'invoice' || !configuring || !projectId) return;
    let alive = true;
    setInvoiceNumberLoading(true);
    nextInvoiceNumber({ projectId })
      .then(n => { if (alive) setInvoiceNumberInput(String(n)); })
      .catch(() => {})
      .finally(() => { if (alive) setInvoiceNumberLoading(false); });
    return () => { alive = false; };
  }, [action, configuring, projectId]);

  // Seed billing date to today (Ben's ask 2026-09-23 — was the billing
  // period's own end date; today() reflects when the invoice is actually
  // being generated, not when the period happened to close), once per time
  // the invoice screen opens — a starting point, not re-imposed every time
  // the PM tweaks the period afterward (that would stomp a manual edit).
  useEffect(() => {
    if (action !== 'invoice' || !configuring) return;
    setBillingDate(new Date().toISOString().slice(0, 10));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open only
  }, [action, configuring]);

  // Project Settings pre-fill the Configure screen once per open — a
  // starting point the PM can still change for this one invoice/CO.
  useEffect(() => {
    if (!configuring || (action !== 'invoice' && action !== 'draft')) return;
    const ps = projectSettings;
    const d = ps?.companyDefaults || {};
    setMarkupPercent(String(ps?.dcMarkupPercent ?? d.dcMarkupPercent ?? 20));
    setCmMarkupPercent(String(ps?.cmMarkupPercent ?? d.cmMarkupPercent ?? 20));
    setGroupBy(ps?.tmGroupBy || d.tmGroupBy || 'worker_type');
    setDcGroupBy(ps?.dcGroupBy || d.dcGroupBy || 'per_dc');
    setCmGroupBy(ps?.cmGroupBy || d.cmGroupBy || 'per_commitment');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once per open only
  }, [action, configuring]);

  function formFromSettings(ps) {
    return {
      billingMode: ps?.billingModeOverride || 'auto',
      rates: Object.fromEntries(Object.keys(TIME_TYPE_LABEL).map(tt => [tt, ps?.rates?.[tt]?.project ?? ''])),
      dcMarkupPercent: ps?.dcMarkupPercent ?? '',
      cmMarkupPercent: ps?.cmMarkupPercent ?? '',
      tmGroupBy: ps?.tmGroupBy || '',
      dcGroupBy: ps?.dcGroupBy || '',
      cmGroupBy: ps?.cmGroupBy || '',
      defaultPrimeContractId: ps?.defaultPrimeContractId || ''
    };
  }

  function openSettings() {
    setSettingsForm(formFromSettings(projectSettings));
    setResult(null);
    setAction('settings');
  }

  function updateSettingsForm(field, value) {
    setSettingsForm(prev => ({ ...prev, [field]: value }));
  }

  async function saveSettings() {
    setSavingSettings(true);
    setError(null);
    try {
      const res = await saveProjectSettings({ tenantId: TENANT_ID, projectId, userId, settings: settingsForm });
      setProjectSettings(res);
      setSettingsForm(formFromSettings(res));
      setResult({ kind: 'settings' });
      // Rate and billing-mode changes affect every list's totals — reload them.
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  useEffect(() => {
    if (projectId) load(projectId);
  }, [projectId, load]);

  // Full reload, not just a re-fetch. Re-posting `initialize` alone (tried
  // first, 2026-09-14) didn't clear a stale contract context live — Procore's
  // handshake looks like a one-time reply to the panel's first attach, not
  // something it re-answers on request. A real reload re-attaches the panel
  // from scratch, which is what correctly read context the first time, so
  // it's the only way found so far to pick up "I'm on a different Procore
  // page now" without Procore pushing that on its own.
  function refresh() {
    window.location.reload();
  }

  // Pop out to a full browser window (Ben's ask 2026-09-15) — the sidebar
  // iframe is narrow no matter what LEDGER does inside it (Procore controls
  // that width), and there's no Procore API to widen it. A popup opened from
  // a real click is a genuine user gesture, so it isn't blocked like an
  // unsolicited window.open would be. The popup can't receive Procore's
  // postMessage handshake (it isn't an iframe child of Procore's window —
  // window.opener isn't window.parent), so it carries context via the same
  // URL params App already supports for standalone use instead.
  function popOut() {
    const url = new URL(window.location.origin + window.location.pathname);
    if (projectId) url.searchParams.set('project_id', projectId);
    if (contractId) url.searchParams.set('contract_id', contractId);
    if (userId) url.searchParams.set('user_id', userId);
    window.open(url.toString(), '_blank', 'noopener,noreferrer,width=1100,height=850');
  }

  // T&M ticket URL — confirmed live 2026-09-14 (Ben pasted the real one from
  // his browser bar): NOT under /project/... like everything else, it's the
  // webclients/host app shell.
  const tandmTicketUrl = (entryId) =>
    `${procoreOrigin}/webclients/host/companies/${TENANT_ID}/projects/${projectId}/tools/timeandmaterials/${entryId}/show`;

  const directCostUrl = (id) => `${procoreOrigin}/${projectId}/project/direct_costs/${id}`;
  const commitmentUrl = (c) =>
    `${procoreOrigin}/${projectId}/project/commitments/${c.type === 'PurchaseOrderContract' ? 'purchase_order_contracts' : 'work_order_contracts'}/${c.id}`;

  // "Full details" popout (Ben's ask 2026-09-15, replacing the old in-sidebar
  // modal — same "smushed in a narrow panel" problem). Read-only, so it just
  // carries what it needs via URL params — no postMessage handshake needed,
  // unlike the preview/edit popout below.
  function popOutTicketDetail(t) {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('view', 'ticket_detail');
    url.searchParams.set('project_id', projectId);
    url.searchParams.set('entry_id', t.id);
    url.searchParams.set('ticket_number', t.number);
    url.searchParams.set('billing_mode', billingMode || '');
    url.searchParams.set('procore_origin', procoreOrigin);
    window.open(url.toString(), `ledger_ticket_${t.id}`, 'noopener,noreferrer,width=700,height=800');
  }

  // Direct cost's own "Full details" popout (Ben's ask 2026-09-22) — mirrors
  // popOutTicketDetail exactly, read-only, URL-param driven.
  function popOutDirectCostDetail(d) {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('view', 'direct_cost_detail');
    url.searchParams.set('project_id', projectId);
    url.searchParams.set('direct_cost_id', d.id);
    url.searchParams.set('vendor', d.vendor || '');
    url.searchParams.set('procore_origin', procoreOrigin);
    window.open(url.toString(), `ledger_dc_${d.id}`, 'noopener,noreferrer,width=700,height=800');
  }

  // Preview/edit popout (Ben's ask 2026-09-15: "pop out the summaries for a
  // review when the information is all smushed... edit it in that popout and
  // have the info save in the sidebar tool for submittal"). Deliberately NO
  // noopener here — the whole point is a live postMessage channel back to
  // this window (see PreviewEditPopout.jsx for the full handshake), which
  // noopener would sever. Safe: it's our own app, same origin, and every
  // message is origin-checked below regardless.
  function popOutPreview() {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('view', 'preview_edit');
    previewPopupRef.current = window.open(url.toString(), 'ledger_preview_edit', 'width=1000,height=800');
  }

  const unbilledTickets = tickets?.filter(t => t.unbilledCount > 0) || [];
  const billedTickets = tickets?.filter(t => t.billedCount > 0) || [];
  const writtenOffTickets = tickets?.filter(t => t.writtenOffCount > 0) || [];
  const budgetedTickets = tickets?.filter(t => t.budgetedCount > 0) || [];
  const unbilledDc = directCosts?.unbilled || [];
  const billedDc = withPartials(directCosts?.billed, unbilledDc, 'billedLineCount', d => ({ ...d, billedAmount: d.billedLineAmount }));
  const writtenOffDc = withPartials(directCosts?.writtenOff, unbilledDc, 'writtenOffLineCount', d => ({ ...d, writtenOffAmount: d.writtenOffLineAmount, reasonNotes: d.writeOffNotes }));
  const budgetedDc = withPartials(directCosts?.budgeted, unbilledDc, 'budgetedLineCount', d => ({ ...d, budgetedAmount: d.budgetedLineAmount, reasonNotes: d.budgetedNotes }));
  // Distinguishes "no direct costs on this project at all" from "they exist
  // but are all accounted for" (Ben's ask 2026-09-22) in the picker's empty
  // state — directCosts itself is null until loaded, so this stays 0 until
  // real data is in, same as the ticket-count check right below it uses.
  const totalDcCount = unbilledDc.length + billedDc.length + writtenOffDc.length + budgetedDc.length;

  const checkedTickets = unbilledTickets.filter(t => checkedIds.has(t.id));
  const checkedDcItems = unbilledDc.filter(d => checkedDcIds.has(d.id));
  // A partially-billed DC's own `amount` is its WHOLE header total (including
  // lines already billed elsewhere) — checking its top-level box means "bill
  // everything still remaining," so use remainingAmount for those, not the
  // header total (Ben's ask 2026-09-22, per-line DC billing).
  const checkedDcLineAmount = [...checkedDcLineIds].reduce((s, key) => {
    const sep = key.indexOf(':');
    const dcId = Number(key.slice(0, sep));
    const lineId = Number(key.slice(sep + 1));
    const line = dcLineDetailCache.get(dcId)?.lines?.find(l => l.id === lineId);
    return s + (line?.amount || 0);
  }, 0);
  const unbilledCm = commitments?.unbilled || [];
  const totalCmCount = unbilledCm.length + (commitments?.billed?.length || 0) +
    (commitments?.writtenOff?.length || 0) + (commitments?.budgeted?.length || 0);
  const isBillingAction = action === 'invoice' || action === 'draft';
  const cmLineFor = (key) => {
    const sep = key.indexOf(':');
    return cmLineDetailCache.get(key.slice(0, sep))?.lines?.find(l => String(l.id) === key.slice(sep + 1));
  };
  const checkedCmAmount = [...checkedCmLineIds].reduce((s, key) => s + (cmLineFor(key)?.amount || 0), 0);
  const checkedCmTouchedCount = new Set([...checkedCmLineIds].map(k => k.slice(0, k.indexOf(':')))).size;
  const checkedTotal = checkedTickets.reduce((s, t) => s + t.estimatedTotal, 0) +
    checkedDcItems.reduce((s, d) => s + (d.partialBilled ? d.remainingAmount : d.amount), 0) +
    checkedDcLineAmount + checkedCmAmount;
  const checkedCount = checkedIds.size + checkedDcIds.size + checkedDcLineIds.size + checkedCmLineIds.size;
  // Lines already billed through T&M (or with no budget code) can't be put on
  // an invoice/CO — the backend refuses them — but can still be budgeted or
  // written off.
  const cmLineSelectable = (l) => !l.billedStatus && (!isBillingAction || (l.hasBudgetCode && !l.tmBilled));
  // Distinct DCs with ANY selection (whole or per-line) — for the picker
  // tab's "N/M direct costs" count, which is about DCs touched, not raw
  // line-selection count.
  const checkedDcTouchedCount = new Set([
    ...checkedDcIds,
    ...[...checkedDcLineIds].map(k => Number(k.slice(0, k.indexOf(':'))))
  ]).size;

  // Which time types actually appear in the current selection — only offer a
  // rate override box for those, not every possible type.
  const presentTimeTypes = [...new Set(
    checkedTickets.flatMap(t => t.unbilledLines.map(l => l.timeType))
  )];
  // Actual default $/hr per time type in the current selection (from the
  // resolved rate table, before any override) — shown so the override field
  // isn't asking the user to guess what they're overriding away from.
  const defaultRateByType = {};
  for (const t of checkedTickets) {
    for (const l of t.unbilledLines) {
      if (l.rate != null && !(l.timeType in defaultRateByType)) defaultRateByType[l.timeType] = l.rate;
    }
  }

  // Closes the settings/preview overlay entirely — always clears the preview
  // too, since it's only ever valid for the exact selection/settings it was
  // computed from.
  function clearConfiguring() {
    setConfiguring(false);
    setPreviewTmLines(null);
    setPreviewDcLines(null);
    setPreviewCmLines(null);
    setPreviewMeta(null);
  }

  function backToLanding() {
    setAction(null);
    clearConfiguring();
    // Found 2026-09-23 while wiring per-line write-off/budgeted: this used to
    // leave checkedIds/checkedDcIds/checkedDcLineIds untouched, silently
    // harmless only because write-off/budgeted never read checkedDcLineIds
    // before today. Now that they do, a stray leftover selection from a
    // different action (e.g. lines checked under "Create Invoice") would
    // otherwise carry over silently into "Write Off" without a full reload.
    setCheckedIds(new Set());
    setCheckedDcIds(new Set());
    setCheckedDcLineIds(new Set());
    setCheckedCmLineIds(new Set());
    setDispositionReturn(null);
    setDispositionScope(null);
  }

  // Write Off / Mark as Budgeted from inside Create Invoice / Push to CO
  // (Ben's ask 2026-09-24) — reuses the existing disposition overlays, then
  // returns to the billing action rather than the landing screen.
  function startDisposition(kind, scope = null) {
    setDispositionReturn(action);
    setDispositionScope(scope);
    setAction(kind);
    setConfiguring(true);
  }

  function closeDispositionOverlay() {
    if (dispositionReturn) setAction(dispositionReturn);
    setDispositionReturn(null);
    setDispositionScope(null);
    clearConfiguring();
  }

  function finishDisposition() {
    if (dispositionReturn) {
      setAction(dispositionReturn);
      setDispositionReturn(null);
      setDispositionScope(null);
      clearConfiguring();
    } else {
      backToLanding();
    }
  }

  function toggleChecked(id) {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    clearConfiguring(); // selection changed — back to "pick items" stage
  }

  function toggleCheckedDc(id) {
    setCheckedDcIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Checking "bill the whole DC" supersedes any explicit per-line picks on
    // it (Ben's ask 2026-09-22) — clear them so the two selection modes
    // never both apply to the same DC. Harmless no-op if there were none.
    setCheckedDcLineIds(prev => {
      const next = new Set(prev);
      for (const key of next) {
        if (key.startsWith(`${id}:`)) next.delete(key);
      }
      return next;
    });
    clearConfiguring();
  }

  // Per-line DC billing (Ben's ask 2026-09-22). Clicking a line while the
  // whole DC is checked "splits" the selection: seeds explicit per-line picks
  // with every other currently-unbilled line on that DC, then unchecks just
  // the one clicked — matches how checking one box out of an "all selected"
  // group normally behaves. Reads state directly off the closure rather than
  // inside a setState updater (simpler here since dcLineDetailCache — needed
  // to know which lines are actually unbilled — isn't itself being updated
  // by this handler).
  function toggleCheckedDcLine(dcId, lineId) {
    const key = `${dcId}:${lineId}`;
    if (checkedDcIds.has(dcId)) {
      const detail = dcLineDetailCache.get(dcId);
      const unbilledIds = (detail?.lines || []).filter(l => !l.billedStatus).map(l => l.id);
      const nextLines = new Set(checkedDcLineIds);
      for (const id of unbilledIds) {
        if (id !== lineId) nextLines.add(`${dcId}:${id}`);
      }
      nextLines.delete(key);
      setCheckedDcLineIds(nextLines);
      setCheckedDcIds(prev => {
        const next = new Set(prev);
        next.delete(dcId);
        return next;
      });
    } else {
      setCheckedDcLineIds(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
    clearConfiguring();
  }

  // Lazy-fetches a DC's real line items + per-line billed status on first
  // expand — direct costs have no bulk line-item endpoint, so this never
  // runs for a DC the PM hasn't actually opened.
  async function loadDcLineDetail(dcId) {
    if (dcLineDetailCache.has(dcId) || dcLineDetailLoading === dcId) return;
    setDcLineDetailLoading(dcId);
    try {
      const detail = await directCostLineDetail({ tenantId: TENANT_ID, projectId, directCostId: dcId });
      setDcLineDetailCache(prev => new Map(prev).set(dcId, detail));
    } catch (e) {
      setDcLineDetailCache(prev => new Map(prev).set(dcId, { error: e.message, lines: [] }));
    } finally {
      setDcLineDetailLoading(null);
    }
  }

  function toggleExpandDc(d) {
    const next = expandedDcId === d.id ? null : d.id;
    setExpandedDcId(next);
    if (next) loadDcLineDetail(d.id);
  }

  async function loadCmLineDetail(cmId) {
    if (cmLineDetailCache.has(cmId)) return cmLineDetailCache.get(cmId);
    setCmLineDetailLoading(cmId);
    try {
      const detail = await commitmentLineDetail({ tenantId: TENANT_ID, projectId, commitmentId: cmId });
      setCmLineDetailCache(prev => new Map(prev).set(cmId, detail));
      return detail;
    } catch (e) {
      const failed = { error: e.message, lines: [] };
      setCmLineDetailCache(prev => new Map(prev).set(cmId, failed));
      return failed;
    } finally {
      setCmLineDetailLoading(null);
    }
  }

  function toggleExpandCm(c) {
    const id = String(c.id);
    const next = expandedCmId === id ? null : id;
    setExpandedCmId(next);
    if (next) loadCmLineDetail(id);
  }

  // Labour lines being ADDED to an invoice/CO go through the warning pop-up
  // first (Ben's ask 2026-09-24). Not for Write Off / Mark as Budgeted —
  // that's exactly what the warning steers people toward.
  // Older projects (cmLegacy) get one blanket review-first warning instead of
  // the labour check — Ben, 2026-09-24: their cost codes/types are too
  // inconsistent to key per-line guardrails on.
  function withLabourCheck(lines, apply) {
    if (!isBillingAction || lines.length === 0) { apply(); return; }
    if (cmLegacy) {
      if (legacyAck) { apply(); return; }
      setLabourWarning({
        title: 'Older project — review before billing commitments',
        text: LEGACY_WARNING_TEXT,
        lines: [],
        onProceed: () => { setLegacyAck(true); apply(); }
      });
      return;
    }
    const risky = lines.filter(l => l.isLabour);
    if (risky.length === 0) { apply(); return; }
    setLabourWarning({ title: 'Billing labour from a subcontract', text: LABOUR_WARNING_TEXT, lines: risky, onProceed: apply });
  }

  // Estimated-commitment reconciliation (2026-09-26): LEDGER proposes the
  // difference between the sub's real invoices and what was billed as an
  // estimate; the PM edits it and confirms. See reconcileCommitment (worker).
  const [recon, setRecon] = useState(null); // { c, loading, data, error, amount, description, contract, saving }

  async function openReconcile(c) {
    setRecon({ c, loading: true, data: null, error: null, amount: '', description: '', contract: contractId || '', saving: false });
    try {
      const data = await previewCommitmentReconciliation({ tenantId: TENANT_ID, projectId, commitmentId: c.id });
      setRecon(r => r && { ...r, loading: false, data, amount: String(data.proposedAmount), description: data.proposedDescription });
    } catch (e) {
      setRecon(r => r && { ...r, loading: false, error: e.message });
    }
  }

  async function confirmReconcile() {
    const amount = Number(recon.amount);
    if (recon.amount.trim() === '' || !Number.isFinite(amount)) {
      setRecon(r => ({ ...r, error: 'Enter an amount (0 if no adjustment is needed).' }));
      return;
    }
    setRecon(r => ({ ...r, saving: true, error: null }));
    try {
      await reconcileCommitment({
        tenantId: TENANT_ID, projectId, commitmentId: recon.c.id, amount, description: recon.description,
        primeContractId: recon.contract || undefined, userId
      });
      setRecon(null);
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setRecon(r => r && { ...r, saving: false, error: e.message });
    }
  }

  // Commitments' undo (2026-09-24) — same confirm wording as the DC undos.
  async function handleUndoCm(c, kind) {
    const label = `${c.number}${c.vendor ? ` (${c.vendor})` : ''}`;
    const messages = {
      draft: `Undo the draft push for ${label}? This only clears LEDGER's own tracking — if the Change Order still exists in Procore, delete it there too or the same cost could end up on two.`,
      invoice: `Undo the invoice for ${label}?\n\nOnly do this if you've ALREADY deleted the invoice (and its Change Order/Change Event, if still present) in Procore. This does not touch Procore — it only clears LEDGER's record that this was billed, so it can be billed again.`,
      writeoff: `Undo the write-off for ${label}? It'll go back to Unbilled.`,
      budgeted: `Undo the "Budgeted" mark for ${label}? It'll go back to Unbilled.`
    };
    if (!window.confirm(messages[kind])) return;
    setRevertingId(c.id);
    setError(null);
    try {
      await revertCommitment({
        tenantId: TENANT_ID, projectId, commitmentId: c.id,
        includeBilled: kind === 'invoice', includeWrittenOff: kind === 'writeoff', includeBudgeted: kind === 'budgeted'
      });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  function toggleCmLine(cmId, line) {
    const key = `${cmId}:${line.id}`;
    if (checkedCmLineIds.has(key)) {
      setCheckedCmLineIds(prev => { const next = new Set(prev); next.delete(key); return next; });
      clearConfiguring();
      return;
    }
    withLabourCheck([line], () => {
      setCheckedCmLineIds(prev => new Set(prev).add(key));
      clearConfiguring();
    });
  }

  async function toggleCommitment(c) {
    const cmId = String(c.id);
    const detail = await loadCmLineDetail(cmId);
    const selectable = (detail.lines || []).filter(cmLineSelectable);
    const keys = selectable.map(l => `${cmId}:${l.id}`);
    if (keys.length === 0) {
      setError(detail.error || 'Nothing on this commitment can be added — every line is already billed, or has no budget code in Procore.');
      return;
    }
    if (keys.every(k => checkedCmLineIds.has(k))) {
      setCheckedCmLineIds(prev => { const next = new Set(prev); keys.forEach(k => next.delete(k)); return next; });
      clearConfiguring();
      return;
    }
    const adding = selectable.filter(l => !checkedCmLineIds.has(`${cmId}:${l.id}`));
    withLabourCheck(adding, () => {
      setCheckedCmLineIds(prev => { const next = new Set(prev); keys.forEach(k => next.add(k)); return next; });
      clearConfiguring();
    });
  }

  // Select all / clear all of whatever's currently visible (Ben's ask
  // 2026-09-15). Toggles off if everything visible is already checked, on
  // otherwise — so it also works as a quick "clear" once everything's
  // selected, not just a one-way select-everything.
  function toggleSelectAll(visibleIds) {
    setCheckedIds(prev => {
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id));
      return allSelected ? new Set() : new Set(visibleIds);
    });
    clearConfiguring();
  }

  function toggleSelectAllDc(visibleIds) {
    setCheckedDcIds(prev => {
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id));
      return allSelected ? new Set() : new Set(visibleIds);
    });
    setCheckedDcLineIds(new Set()); // select-all/clear-all supersedes any explicit per-line picks
    clearConfiguring();
  }

  // Server refuses (409-equivalent stream error) a selection with unlinked-
  // timecard lines unless told to proceed. Ask the user once, then retry with
  // the confirm flag.
  async function submitWithUnlinkedConfirm(apiCall) {
    try {
      return await apiCall(false);
    } catch (e) {
      if (e.code !== 'UNLINKED_TIMECARDS') throw e;
      const proceed = window.confirm(
        `${e.message}\n\nThese hours won't be reconciled against a real timecard yet. Submit anyway?`
      );
      if (!proceed) return null;
      return await apiCall(true);
    }
  }

  async function runBilling(kind) {
    const entryIds = [...checkedIds];
    const directCostIds = [...checkedDcIds];
    const directCostLineIds = [...checkedDcLineIds];
    const commitmentLineIds = [...checkedCmLineIds];
    if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentLineIds.length === 0) return;
    // Only generateCombinedInvoice ever touches a billing period. Require an
    // actual choice when creating a new one — a project with no billing
    // periods used to fail silently AFTER a real Change Order was already
    // approved, so don't let this fall through to Procore's own "today"
    // default without the PM having actually looked at it.
    if (kind === 'invoice' && creatingPeriod && (!newPeriodStart || !newPeriodEnd)) {
      setError('Enter a start and end date for the new billing period before generating the invoice.');
      return;
    }
    // Required (Ben's ask 2026-09-14) — was silently defaulting to the
    // billing period's own end date with no PM visibility into it.
    if (kind === 'invoice' && !billingDate) {
      setError('Enter a billing date before generating the invoice.');
      return;
    }
    setGenerating(true);
    setError(null);
    setProgressLog([]);
    const onProgress = (evt) => setProgressLog(prev => [...prev, evt.message]);
    try {
      const fn = kind === 'invoice' ? generateCombinedInvoice : pushCombinedToDraftCO;
      const res = await submitWithUnlinkedConfirm(confirmUnlinked =>
        fn({
          tenantId: TENANT_ID, projectId, entryIds, directCostIds, directCostLineIds, commitmentLineIds, userId, confirmUnlinked,
          primeContractId: contractId, groupBy, rateOverrides, markupPercent, cmMarkupPercent, dcGroupBy, cmGroupBy, title: coTitle, onProgress,
          // Preview is mandatory (the settings screen's button only ever
          // leads to preview, never straight to this) — editedLines is
          // always the real, possibly-PM-edited lines by the time this runs.
          editedTmLines: previewTmLines?.map(l => ({ description: l.description, rate: l.rate })),
          editedDcLines: previewDcLines?.map(l => ({ description: l.description })),
          editedCmLines: previewCmLines?.map(l => ({ description: l.description })),
          ...(kind === 'invoice' && creatingPeriod
            ? { newBillingPeriod: { startDate: newPeriodStart, endDate: newPeriodEnd } }
            : kind === 'invoice' && billingPeriodId
            ? { billingPeriodId }
            : {}),
          ...(kind === 'invoice' && invoiceNumberInput ? { invoiceNumber: invoiceNumberInput } : {}),
          ...(kind === 'invoice' ? { billingDate } : {})
        })
      );
      if (!res) return; // user declined the unlinked-timecard confirm
      setResult({ kind, ...res });
      backToLanding();
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  // Preview/edit step (Ben's ask 2026-09-15) — computes exactly what
  // Confirm would create, using the real backend logic (not a frontend
  // approximation), so what's shown can't drift from reality. Editable
  // copies stored separately from the raw preview response so "Back to
  // settings" can re-preview cleanly without stale edits carrying over.
  async function loadPreview() {
    const entryIds = [...checkedIds];
    const directCostIds = [...checkedDcIds];
    const directCostLineIds = [...checkedDcLineIds];
    const commitmentLineIds = [...checkedCmLineIds];
    if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentLineIds.length === 0) return;
    setPreviewLoading(true);
    setError(null);
    try {
      const res = await previewCombinedBilling({
        tenantId: TENANT_ID, projectId, entryIds, directCostIds, directCostLineIds, commitmentLineIds,
        groupBy, rateOverrides, markupPercent, cmMarkupPercent, dcGroupBy, cmGroupBy, title: coTitle
      });
      setPreviewMeta({ totalAmount: res.totalAmount, unlinkedCount: res.unlinkedCount, label: res.label });
      setPreviewTmLines(res.tmLines.map(l => ({ ...l })));
      setPreviewDcLines(res.dcLines.map(l => ({ ...l })));
      setPreviewCmLines((res.cmLines || []).map(l => ({ ...l })));
    } catch (e) {
      setError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  function updatePreviewTmLine(index, field, value) {
    setPreviewTmLines(prev => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }
  function updatePreviewDcLine(index, field, value) {
    setPreviewDcLines(prev => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }
  function updatePreviewCmLine(index, field, value) {
    setPreviewCmLines(prev => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  // Other half of the preview/edit popout handshake (see popOutPreview above
  // and PreviewEditPopout.jsx) — replies to the popup's 'ledger:ready' ping
  // with the CURRENT preview lines/meta (so any edits already made in the
  // sidebar before popping out aren't lost, not a fresh server recompute),
  // and applies 'ledger:result' back onto the preview state when the popup
  // saves. Re-registers whenever the preview state changes so the reply is
  // never built from a stale closure.
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'ledger:ready') {
        if (!previewTmLines && !previewDcLines) return; // no preview open — nothing to hand it
        event.source?.postMessage(
          { type: 'ledger:init', tmLines: previewTmLines, dcLines: previewDcLines, meta: previewMeta, kind: action },
          window.location.origin
        );
      } else if (event.data?.type === 'ledger:result') {
        setPreviewTmLines(event.data.tmLines);
        setPreviewDcLines(event.data.dcLines);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewTmLines, previewDcLines, previewMeta, action]);

  // Undo a draft-CO push — e.g. the PM deleted the Change Order in Procore
  // (LEDGER also self-heals this on the next load automatically, but not for
  // rows written before that tracking existed) or just wants to redo it.
  async function handleUndoDraft(t) {
    const proceed = window.confirm(
      `Undo the draft push for T&M #${t.number}? This only clears LEDGER's own tracking — ` +
      `if the Change Order still exists in Procore, delete it there too or the same hours could end up on two.`
    );
    if (!proceed) return;
    setRevertingId(t.id);
    setError(null);
    try {
      await revertToUnbilled({ tenantId: TENANT_ID, projectId, entryId: t.id });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  // Undo an already-invoiced ticket — only for when the invoice/CO was
  // actually deleted in Procore already. Deliberately a separate, harsher
  // confirm than handleUndoDraft: this is billing_records' anti-double-
  // billing enforcement, not a draft awaiting review. Executed COs can't be
  // auto-detected as deleted (see reconcileStaleDraftCOs) so this has no
  // self-heal fallback — manual is the only path.
  async function handleUndoInvoice(t) {
    const proceed = window.confirm(
      `Undo the invoice for T&M #${t.number}?\n\nOnly do this if you've ALREADY deleted the invoice ` +
      `(and its Change Order/Change Event, if still present) in Procore. This does not touch Procore — ` +
      `it only clears LEDGER's record that these hours were billed, so they can be billed again.`
    );
    if (!proceed) return;
    setRevertingId(t.id);
    setError(null);
    try {
      await revertToUnbilled({ tenantId: TENANT_ID, projectId, entryId: t.id, includeBilled: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  // Checking a whole DC's box for Write Off / Mark as Budgeted, when that DC
  // already has some lines covered elsewhere (billed, or a different
  // disposition), only acts on whatever's still open — same convenience
  // billing's own whole-DC checkbox already has. Confirmed with Ben
  // 2026-09-23 that write-off/budgeted should ask once before doing that
  // silently, since they're more consequential than billing. Same
  // window.confirm pattern already used throughout this file for undo/
  // unlinked-timecard confirms.
  function confirmPartialDcDisposition(verb) {
    if (dispositionScope) return true;
    const partialDcs = checkedDcItems.filter(d => d.partialBilled);
    if (partialDcs.length === 0) return true;
    const names = partialDcs.map(d => {
      const covered = (d.billedLineCount || 0) + (d.writtenOffLineCount || 0) + (d.budgetedLineCount || 0);
      const openCount = (d.totalLineCount || 0) - covered;
      return `"${d.vendor || d.description}" (${openCount} of ${d.totalLineCount} line(s) still open)`;
    }).join(', ');
    return window.confirm(
      `${partialDcs.length === 1 ? 'This direct cost has' : 'These direct costs have'} some line items already ` +
      `accounted for — only the remaining open line(s) will be ${verb}: ${names}. Continue?`
    );
  }

  // Write-off (Ben's ask 2026-09-17) — pure LEDGER bookkeeping, no Procore
  // writes, so no progress log/unlinked-timecard gate the way billing needs.
  async function runWriteOff() {
    const scoped = dispositionScope;
    const entryIds = scoped ? [] : [...checkedIds];
    const directCostIds = scoped ? [] : [...checkedDcIds];
    const directCostLineIds = scoped ? [] : [...checkedDcLineIds];
    const commitmentLineIds = scoped ? scoped.commitmentLineIds : [...checkedCmLineIds];
    if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentLineIds.length === 0) return;
    if (!writeOffReason) {
      setError('Choose a reason before writing off.');
      return;
    }
    if (!confirmPartialDcDisposition('written off')) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await writeOffRecords({
        tenantId: TENANT_ID, projectId, entryIds, directCostIds, directCostLineIds, commitmentLineIds, userId,
        reasonCategory: writeOffReason, reasonNotes: writeOffNotes,
      });
      setResult({ kind: 'writeoff', ...res });
      finishDisposition();
      setWriteOffReason('');
      setWriteOffNotes('');
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  // Direct costs' own undo (Ben's ask 2026-09-17 — they never had one
  // before). Mirrors handleUndoDraft/handleUndoInvoice's T&M pattern exactly.
  async function handleUndoDcDraft(d) {
    const proceed = window.confirm(
      `Undo the draft push for "${d.vendor || d.description}"? This only clears LEDGER's own tracking — ` +
      `if the Change Order still exists in Procore, delete it there too or the same cost could end up on two.`
    );
    if (!proceed) return;
    setRevertingId(d.id);
    setError(null);
    try {
      await revertDirectCost({ tenantId: TENANT_ID, projectId, directCostId: d.id });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  async function handleUndoDcInvoice(d) {
    const proceed = window.confirm(
      `Undo the invoice for "${d.vendor || d.description}"?\n\nOnly do this if you've ALREADY deleted the invoice ` +
      `(and its Change Order/Change Event, if still present) in Procore. This does not touch Procore — ` +
      `it only clears LEDGER's record that this was billed, so it can be billed again.`
    );
    if (!proceed) return;
    setRevertingId(d.id);
    setError(null);
    try {
      await revertDirectCost({ tenantId: TENANT_ID, projectId, directCostId: d.id, includeBilled: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  // Undo a write-off — same "back to unbilled" idea as the draft/invoice
  // undos above, just for the written_off status. Full reversal (both the
  // billing_records row and its write_offs audit row get deleted — confirmed
  // with Ben 2026-09-17, not a soft-delete that keeps the audit row around).
  async function handleUndoWriteOff(t) {
    const proceed = window.confirm(`Undo the write-off for T&M #${t.number}? It'll go back to Unbilled.`);
    if (!proceed) return;
    setRevertingId(t.id);
    setError(null);
    try {
      await revertToUnbilled({ tenantId: TENANT_ID, projectId, entryId: t.id, includeWrittenOff: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  async function handleUndoDcWriteOff(d) {
    const proceed = window.confirm(`Undo the write-off for "${d.vendor || d.description}"? It'll go back to Unbilled.`);
    if (!proceed) return;
    setRevertingId(d.id);
    setError(null);
    try {
      await revertDirectCost({ tenantId: TENANT_ID, projectId, directCostId: d.id, includeWrittenOff: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  // "Mark as Budgeted" (Ben's ask 2026-09-21) — mirrors runWriteOff exactly,
  // just a plain note instead of a required reason category.
  async function runMarkAsBudgeted() {
    const scoped = dispositionScope;
    const entryIds = scoped ? [] : [...checkedIds];
    const directCostIds = scoped ? [] : [...checkedDcIds];
    const directCostLineIds = scoped ? [] : [...checkedDcLineIds];
    const commitmentLineIds = scoped ? scoped.commitmentLineIds : [...checkedCmLineIds];
    if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentLineIds.length === 0) return;
    if (!confirmPartialDcDisposition('marked as budgeted')) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await markAsBudgeted({ tenantId: TENANT_ID, projectId, entryIds, directCostIds, directCostLineIds, commitmentLineIds, userId, notes: budgetedNotes });
      setResult({ kind: 'budgeted', ...res });
      finishDisposition();
      setBudgetedNotes('');
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function runAlreadyBilled() {
    const scoped = dispositionScope;
    const entryIds = scoped ? [] : [...checkedIds];
    const directCostIds = scoped ? [] : [...checkedDcIds];
    const directCostLineIds = scoped ? [] : [...checkedDcLineIds];
    const commitmentLineIds = scoped ? scoped.commitmentLineIds : [...checkedCmLineIds];
    if (entryIds.length === 0 && directCostIds.length === 0 && directCostLineIds.length === 0 && commitmentLineIds.length === 0) return;
    if (!confirmPartialDcDisposition('marked as already billed')) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await markAlreadyBilled({
        tenantId: TENANT_ID, projectId, entryIds, directCostIds, directCostLineIds, commitmentLineIds, userId,
        invoiceNumber: alreadyBilledInvoice, notes: alreadyBilledNotes
      });
      setResult({ kind: 'already_billed', ...res });
      finishDisposition();
      setAlreadyBilledInvoice('');
      setAlreadyBilledNotes('');
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  // Undo only the "Already Billed" rows on a ticket/DC/commitment — never a
  // real LEDGER invoice (that keeps its own, harsher undo).
  async function handleUndoOutsideBilled(kind, item, label) {
    if (!window.confirm(`Undo "Already Billed" for ${label}? Those lines go back to Unbilled. Nothing in Procore changes.`)) return;
    setRevertingId(item.id);
    setError(null);
    try {
      if (kind === 'tm') await revertToUnbilled({ tenantId: TENANT_ID, projectId, entryId: item.id, includeBilledOutside: true });
      if (kind === 'dc') await revertDirectCost({ tenantId: TENANT_ID, projectId, directCostId: item.id, includeBilledOutside: true });
      if (kind === 'cm') await revertCommitment({ tenantId: TENANT_ID, projectId, commitmentId: item.id, includeBilledOutside: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  async function handleUndoBudgeted(t) {
    const proceed = window.confirm(`Undo the "Budgeted" mark for T&M #${t.number}? It'll go back to Unbilled.`);
    if (!proceed) return;
    setRevertingId(t.id);
    setError(null);
    try {
      await revertToUnbilled({ tenantId: TENANT_ID, projectId, entryId: t.id, includeBudgeted: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  async function handleUndoDcBudgeted(d) {
    const proceed = window.confirm(`Undo the "Budgeted" mark for "${d.vendor || d.description}"? It'll go back to Unbilled.`);
    if (!proceed) return;
    setRevertingId(d.id);
    setError(null);
    try {
      await revertDirectCost({ tenantId: TENANT_ID, projectId, directCostId: d.id, includeBudgeted: true });
      await load(projectId, { preserveResult: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setRevertingId(null);
    }
  }

  const overlayOpen = action !== null && (configuring || generating);
  const isReviewHistory = action === 'review' && reviewTab !== 'unbilled';

  // Review Project rollup (2026-09-24): dollars per source per status. DC and
  // commitment records carry exact per-status line amounts (billedLineAmount
  // etc.) whenever they've been partly dispositioned, so a partly-billed item
  // counts correctly in every column, not just the bucket it's listed under.
  function rollupFor(data) {
    const out = { unbilled: 0, billed: 0, writtenOff: 0, budgeted: 0 };
    for (const [bucket, list] of Object.entries(data || {})) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (bucket === 'unbilled') out.unbilled += (r.partialBilled ? r.remainingAmount : r.amount) || 0;
        out.billed += r.billedLineAmount ?? (bucket === 'billed' ? r.billedAmount || 0 : 0);
        out.writtenOff += r.writtenOffLineAmount ?? (bucket === 'writtenOff' ? r.writtenOffAmount || 0 : 0);
        out.budgeted += r.budgetedLineAmount ?? (bucket === 'budgeted' ? r.budgetedAmount || 0 : 0);
      }
    }
    return out;
  }
  const rollupRows = [
    billingMode !== 'non_billable' && {
      label: 'T&M',
      ...(tickets || []).reduce((o, t) => ({
        unbilled: o.unbilled + (t.estimatedTotal || 0), billed: o.billed + (t.billedAmount || 0),
        writtenOff: o.writtenOff + (t.writtenOffAmount || 0), budgeted: o.budgeted + (t.budgetedAmount || 0)
      }), { unbilled: 0, billed: 0, writtenOff: 0, budgeted: 0 })
    },
    { label: 'Direct Costs', ...rollupFor(directCosts) },
    { label: 'Commitments', ...rollupFor(commitments) }
  ].filter(Boolean);
  const rollupTotal = rollupRows.reduce((o, r) => ({
    unbilled: o.unbilled + r.unbilled, billed: o.billed + r.billed,
    writtenOff: o.writtenOff + r.writtenOff, budgeted: o.budgeted + r.budgeted
  }), { unbilled: 0, billed: 0, writtenOff: 0, budgeted: 0 });
  const estimatedCmCount = ['unbilled', 'billed', 'writtenOff', 'budgeted']
    .flatMap(b => commitments?.[b] || []).filter(c => c.estimatedLineCount > 0).length;

  const billedCm = withPartials(commitments?.billed, unbilledCm, 'billedLineCount', c => ({ ...c, billedAmount: c.billedLineAmount }));
  const writtenOffCm = withPartials(commitments?.writtenOff, unbilledCm, 'writtenOffLineCount', c => ({ ...c, writtenOffAmount: c.writtenOffLineAmount, reasonNotes: c.writeOffNotes }));
  const budgetedCm = withPartials(commitments?.budgeted, unbilledCm, 'budgetedLineCount', c => ({ ...c, budgetedAmount: c.budgetedLineAmount, reasonNotes: c.budgetedNotes }));

  // Keep the company portfolio's record counts current. Skipped when a list
  // failed to load, so a hiccup never overwrites real counts with zeros.
  useEffect(() => {
    if (!projectId || !tickets || !directCosts || !commitments || directCosts.failed || commitments.failed) return;
    saveProjectCounts({
      tenantId: TENANT_ID, projectId,
      counts: {
        unbilled: unbilledTickets.length + unbilledDc.length + unbilledCm.length,
        billed: billedTickets.length + billedDc.length + billedCm.length,
        budgeted: budgetedTickets.length + budgetedDc.length + budgetedCm.length,
        writtenOff: writtenOffTickets.length + writtenOffDc.length + writtenOffCm.length
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per data load
  }, [tickets, directCosts, commitments]);

  const reviewHeader = (
    <>
      <div className="list-hint list-hint-nav">
        <button type="button" className="nav-btn" onClick={backToLanding}>‹ Back</button>
        <span>Review Project</span>
      </div>

      {!loading && (
        <div className="rollup">
          <table>
            <thead>
              <tr><th></th><th>Unbilled</th><th>Billed</th><th>Written off</th><th>Budgeted</th></tr>
            </thead>
            <tbody>
              {rollupRows.map(r => (
                <tr key={r.label}>
                  <th>{r.label}</th>
                  <td>{money(r.unbilled)}</td><td>{money(r.billed)}</td><td>{money(r.writtenOff)}</td><td>{money(r.budgeted)}</td>
                </tr>
              ))}
              <tr className="rollup-total">
                <th>Total</th>
                <td>{money(rollupTotal.unbilled)}</td><td>{money(rollupTotal.billed)}</td>
                <td>{money(rollupTotal.writtenOff)}</td><td>{money(rollupTotal.budgeted)}</td>
              </tr>
            </tbody>
          </table>
          <div className="rollup-note">
            Billed includes draft Change Orders, with markup. Unbilled is at cost for direct costs and commitments.
            {estimatedCmCount > 0 && ` ${estimatedCmCount} commitment${estimatedCmCount === 1 ? ' was' : 's were'} billed as estimates — not yet invoiced by the sub.`}
          </div>
        </div>
      )}

      <div className="tabs">
        {[
          ['unbilled', 'Unbilled', unbilledTickets.length + unbilledDc.length + unbilledCm.length],
          ['billed', 'Billed', billedTickets.length + billedDc.length + billedCm.length],
          ['writtenoff', 'Written off', writtenOffTickets.length + writtenOffDc.length + writtenOffCm.length],
          ['budgeted', 'Budgeted', budgetedTickets.length + budgetedDc.length + budgetedCm.length]
        ].map(([key, label, count]) => (
          <button
            key={key}
            className={`tab ${reviewTab === key ? 'active' : ''}`}
            onClick={() => { setReviewTab(key); clearConfiguring(); }}
          >
            {label} <span className="tab-count">{count}</span>
          </button>
        ))}
      </div>
    </>
  );
  const showPickerFooter = action !== null && !overlayOpen && checkedCount > 0;

  return (
    // .ledger-wide only when standalone (popped out / direct browser) — the
    // embedded sidebar view stays narrow on purpose (Procore controls that
    // width, not LEDGER), but the same fixed 480px cap left a popped-out
    // window mostly empty margin either side (Ben's ask 2026-09-15).
    <div className={`ledger ${showPickerFooter ? 'has-actionbar' : ''} ${!EMBEDDED ? 'ledger-wide' : ''}`}>
      <header className="ledger-header">
        <div className="ledger-logo">LEDGER</div>
        <div className="ledger-subtitle">Project Billing Reconciliation</div>
        {billingMode && (
          <span className={`mode-badge mode-${billingMode}`}>{MODE_LABEL[billingMode]}</span>
        )}
        <button
          className="refresh-btn"
          onClick={refresh}
          disabled={loading}
          title="Reload and re-check which Procore page you're on"
          aria-label="Refresh"
        >
          ⟳
        </button>
        {EMBEDDED && (
          <button
            className="refresh-btn"
            onClick={popOut}
            title="Open LEDGER in a full browser window"
            aria-label="Pop out"
          >
            ⧉
          </button>
        )}
      </header>
      <div className="ledger-tagline">An Einbau Product</div>

      {!EMBEDDED && (
        <div className="project-row">
          <label>Project ID</label>
          <input
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            onBlur={e => load(e.target.value)}
          />
        </div>
      )}

      {contracts.length > 1 && contractFromProcore ? (
        <div className="context-note">
          Billing to <strong>{contracts.find(c => String(c.id) === String(contractId))?.title || `#${contractId}`}</strong>{' '}
          — the Prime Contract page you're on in Procore. Not the right one? Open the correct contract's page in
          Procore and hit refresh.
        </div>
      ) : contracts.length > 1 ? (
        <div className="context-note">
          This project has <strong>{contracts.length} Prime Contracts</strong> — you'll pick one when you bill.
        </div>
      ) : contracts.length === 1 ? (
        <div className="context-note">
          Billing to Prime Contract <strong>{contracts[0].title || `#${contracts[0].number}`}</strong>.
        </div>
      ) : tickets && (
        <div className="banner banner-warning">No Prime Contract found on this project — billing will fail.</div>
      )}

      {EMBEDDED && !projectId && !error && (
        <div className="loading">Connecting to Procore…</div>
      )}

      {error && !overlayOpen && <div className="banner banner-error">{error}</div>}

      {!loading && billingMode === 'non_billable' && (
        <div className="banner banner-warning">
          This project is type <strong>{projectTypeName || 'unknown'}</strong> — not billed to a client.
          LEDGER won't create billing here. If that's wrong, override the mode in Details below.
        </div>
      )}

      {result && result.kind === 'invoice' && (
        <div className={`banner ${result.unclaimedLines?.length > 0 ? 'banner-warning' : 'banner-success'}`}>
          Invoice <strong>{result.invoiceNumber}</strong> created for {result.label}{' '}
          ({money(result.totalAmount)}, {result.linesbilled} line{result.linesbilled === 1 ? '' : 's'}).
          {result.unclaimedLines?.length > 0 ? (
            <>
              {' '}Only <strong>{result.claimedCount} of {result.totalCoLines}</strong> Change Order line(s) got claimed to 100%
              — the rest need it done by hand in Procore (likely rate-limited): {result.unclaimedLines.join('; ')}.
            </>
          ) : (
            <> Every line is claimed at 100%, but it's still a <strong>draft</strong> in Procore — submit it there when ready.</>
          )}
          <br />
          <a
            href={`${procoreOrigin}/${projectId}/project/prime_contracts/${result.contractId}/payment_applications/${result.invoiceId}?subtab=general_settings`}
            target="_blank" rel="noreferrer"
          >
            Open draft invoice in Procore →
          </a>
        </div>
      )}

      {result && result.kind === 'draft' && (
        <div className="banner banner-success">
          {result.label} pushed to a <strong>draft</strong> Change Order{' '}
          ({money(result.totalAmount)}, {result.linesPushed} line{result.linesPushed === 1 ? '' : 's'}).
          Nothing invoiced yet — review and approve it in Procore when ready.
          <br />
          <a
            href={`${procoreOrigin}/webclients/host/companies/${TENANT_ID}/projects/${projectId}/tools/contracts/prime_contracts/${result.contractId}/change_orders/prime-change-orders/${result.changeOrderId}`}
            target="_blank" rel="noreferrer"
          >
            Open draft Change Order in Procore →
          </a>
        </div>
      )}

      {result && result.kind === 'writeoff' && (
        <div className="banner banner-success">
          {result.count} item{result.count === 1 ? '' : 's'} written off — {money(result.totalAmount)} total.
          Nothing was created in Procore.
        </div>
      )}

      {result && result.kind === 'settings' && (
        <div className="banner banner-success">Project settings saved.</div>
      )}

      {result && result.kind === 'already_billed' && (
        <div className="banner banner-success">
          {result.count} item{result.count === 1 ? '' : 's'} marked as already billed — {money(result.totalAmount)} at cost.
          They now show under Billed. Nothing was created in Procore.
        </div>
      )}

      {result && result.kind === 'budgeted' && (
        <div className="banner banner-success">
          {result.count} item{result.count === 1 ? '' : 's'} marked as budgeted — {money(result.totalAmount)} total.
          Nothing was created in Procore.
        </div>
      )}

      {loadFailed && action !== null && !loading ? (
        <>
          <div className="list-hint list-hint-nav">
            <button type="button" className="nav-btn" onClick={backToLanding}>‹ Back</button>
            <span>{ACTION_LABEL[action]}</span>
          </div>
          <div className="empty">
            Couldn't load this project's billing data (see the error above). Wait a minute, then press ⟳ to try again.
          </div>
        </>
      ) : isReviewHistory ? (
        <>
          {reviewHeader}

          {loading && <div className="loading">Loading billing history…</div>}

          {!loading && reviewTab === 'billed' && billedTickets.length === 0 && billedDc.length === 0 && billedCm.length === 0 && (
            <div className="empty">Nothing billed from this project yet.</div>
          )}

          {!loading && reviewTab === 'billed' && billedTickets.length > 0 && (
            <>
              <div className="list-hint">T&amp;M Tickets</div>
              <div className="ticket-list">
                {billedTickets.map(t => (
                  <div
                    key={t.id}
                    className="ticket-card readonly"
                    onClick={() => setExpandedTmId(expandedTmId === t.id ? null : t.id)}
                  >
                    <div className="ticket-card-header">
                      <span className="ticket-number">T&amp;M #{t.number}</span>
                      <span className="ticket-amount">{money(t.billedAmount)}</span>
                    </div>
                    <div className="ticket-description">{t.description || '(no description)'}</div>
                    <div className="ticket-meta">
                      {t.hasDraftCO && <span className="tag tag-draft">In draft CO</span>}
                      {t.invoiceNumbers.map(n => <span className="tag tag-billed" key={n}>{n}</span>)}
                      {t.billedOutsideLedgerCount > 0 && <span className="tag tag-outside">Billed outside LEDGER</span>}
                      {t.unbilledCount > 0 && ` · ${t.unbilledCount} still unbilled`}
                    </div>

                    {expandedTmId === t.id && (
                      <div className="line-items">
                        {t.billedLines.map(l => (
                          <div className="line-item" key={l.timecardEntryId}>
                            <span>{l.workerName}</span>
                            <span className="line-item-detail">
                              {l.timeType} · {l.hours}h ·{' '}
                              {l.billedStatus === 'draft_co' ? 'draft CO' : (l.invoiceNumber || 'invoiced')}
                            </span>
                            <span className="line-item-amount">{l.amount != null ? money(l.amount) : '—'}</span>
                          </div>
                        ))}
                        <div className="ticket-links">
                          <button onClick={e => { e.stopPropagation(); popOutTicketDetail(t); }}>
                            Full details
                          </button>
                          {projectId && (
                            <a
                              href={tandmTicketUrl(t.id)}
                              target="_blank" rel="noreferrer"
                              onClick={e => e.stopPropagation()}
                            >
                              Open in Procore ↗
                            </a>
                          )}
                          {t.hasDraftCO && (
                            <button
                              className="undo-link"
                              disabled={revertingId === t.id}
                              onClick={e => { e.stopPropagation(); handleUndoDraft(t); }}
                            >
                              {revertingId === t.id ? 'Undoing…' : 'Undo draft push'}
                            </button>
                          )}
                          {t.billedOutsideLedgerCount > 0 && (
                            <button
                              className="undo-link"
                              disabled={revertingId === t.id}
                              onClick={e => { e.stopPropagation(); handleUndoOutsideBilled('tm', t, `T&M #${t.number}`); }}
                            >
                              {revertingId === t.id ? 'Undoing…' : 'Undo "Already Billed"'}
                            </button>
                          )}
                          {t.billedCount > (t.billedOutsideLedgerCount || 0) && (
                            <button
                              className="undo-link undo-link-danger"
                              disabled={revertingId === t.id}
                              onClick={e => { e.stopPropagation(); handleUndoInvoice(t); }}
                              title="Only if the invoice was already deleted in Procore"
                            >
                              {revertingId === t.id ? 'Undoing…' : 'Undo invoice (deleted in Procore)'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'billed' && billedDc.length > 0 && (
            <>
              <div className="list-hint">Direct Costs</div>
              <div className="ticket-list">
                {billedDc.map(d => (
                  <div
                    key={d.id}
                    className="ticket-card readonly"
                    onClick={() => setExpandedDcId(expandedDcId === d.id ? null : d.id)}
                  >
                    <div className="ticket-card-header">
                      <span className="ticket-number">{d.vendor || 'Unknown vendor'}</span>
                      <span className="ticket-amount">{money(d.billedAmount)}</span>
                    </div>
                    <div className="ticket-description">{d.description || '(no description)'}</div>
                    <div className="ticket-meta">
                      {d.billedStatus === 'draft_co' && <span className="tag tag-draft">In draft CO</span>}
                      {d.invoiceNumber && <span className="tag tag-billed">{d.invoiceNumber}</span>}
                      {d.outsideLedgerLineCount > 0 && <span className="tag tag-outside">Billed outside LEDGER</span>}
                      {d.partialBilled && <span className="tag tag-open">Some lines still unbilled</span>}
                      {/* A DC lands here on ANY billed line, even if others were written
                          off/budgeted (Ben's ask 2026-09-23, mixed per-line dispositions) —
                          say so, rather than implying the whole DC was simply billed. */}
                      {(d.writtenOffLineCount > 0 || d.budgetedLineCount > 0) && (
                        <span>
                          {' '}· {d.billedLineCount} of {d.totalLineCount} line(s) billed
                          {d.writtenOffLineCount > 0 ? `, ${d.writtenOffLineCount} written off` : ''}
                          {d.budgetedLineCount > 0 ? `, ${d.budgetedLineCount} budgeted` : ''}
                        </span>
                      )}
                    </div>

                    {expandedDcId === d.id && (
                      <div className="ticket-links">
                        {d.billedStatus === 'draft_co' && (
                          <button
                            className="undo-link"
                            disabled={revertingId === d.id}
                            onClick={e => { e.stopPropagation(); handleUndoDcDraft(d); }}
                          >
                            {revertingId === d.id ? 'Undoing…' : 'Undo draft push'}
                          </button>
                        )}
                        <a href={directCostUrl(d.id)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Open in Procore ↗</a>
                        {d.outsideLedgerLineCount > 0 && (
                          <button
                            className="undo-link"
                            disabled={revertingId === d.id}
                            onClick={e => { e.stopPropagation(); handleUndoOutsideBilled('dc', d, `"${d.vendor || d.description}"`); }}
                          >
                            {revertingId === d.id ? 'Undoing…' : 'Undo "Already Billed"'}
                          </button>
                        )}
                        {d.invoiceNumber && (d.billedLineCount == null ? !d.outsideLedgerLineCount : d.billedLineCount > (d.outsideLedgerLineCount || 0)) && (
                          <button
                            className="undo-link undo-link-danger"
                            disabled={revertingId === d.id}
                            onClick={e => { e.stopPropagation(); handleUndoDcInvoice(d); }}
                            title="Only if the invoice was already deleted in Procore"
                          >
                            {revertingId === d.id ? 'Undoing…' : 'Undo invoice (deleted in Procore)'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'writtenoff' && writtenOffTickets.length === 0 && writtenOffDc.length === 0 && writtenOffCm.length === 0 && (
            <div className="empty">Nothing written off on this project yet.</div>
          )}

          {!loading && reviewTab === 'writtenoff' && writtenOffTickets.length > 0 && (
            <>
              <div className="list-hint">T&amp;M Tickets</div>
              <div className="ticket-list">
                {writtenOffTickets.map(t => (
                  <div key={t.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">T&amp;M #{t.number}</span>
                      <span className="ticket-amount">{money(t.writtenOffAmount)}</span>
                    </div>
                    <div className="ticket-description">{t.description || '(no description)'}</div>
                    <div className="ticket-meta">
                      {[...new Set(t.writtenOffLines.map(l => WRITE_OFF_REASON_OPTIONS.find(o => o.value === l.reasonCategory)?.label || l.reasonCategory))].join(', ')}
                      {[...new Set(t.writtenOffLines.map(l => l.invoiceNumber).filter(Boolean))].map(n => ` · Invoiced on #${n}`).join('')}
                    </div>
                    <div className="ticket-links">
                      <button
                        className="undo-link"
                        disabled={revertingId === t.id}
                        onClick={e => { e.stopPropagation(); handleUndoWriteOff(t); }}
                      >
                        {revertingId === t.id ? 'Undoing…' : 'Undo write-off'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'writtenoff' && writtenOffDc.length > 0 && (
            <>
              <div className="list-hint">Direct Costs</div>
              <div className="ticket-list">
                {writtenOffDc.map(d => (
                  <div key={d.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">{d.vendor || 'Unknown vendor'}</span>
                      <span className="ticket-amount">{money(d.writtenOffAmount)}</span>
                    </div>
                    <div className="ticket-description">{d.description || '(no description)'}</div>
                    <div className="ticket-meta">
                      {WRITE_OFF_REASON_OPTIONS.find(o => o.value === d.reasonCategory)?.label || d.reasonCategory}
                      {d.invoiceNumber ? ` · Invoiced on #${d.invoiceNumber}` : ''}
                      {d.reasonNotes ? ` — ${d.reasonNotes}` : ''}
                      {/* Lands here only when written-off lines outrank billed ones (none
                          billed) but budgeted lines can still coexist — Ben's ask
                          2026-09-23, mixed per-line dispositions. */}
                      {d.budgetedLineCount > 0 && ` · ${d.writtenOffLineCount} of ${d.totalLineCount} line(s) written off, ${d.budgetedLineCount} budgeted`}
                    </div>
                    <div className="ticket-links">
                      <button
                        className="undo-link"
                        disabled={revertingId === d.id}
                        onClick={e => { e.stopPropagation(); handleUndoDcWriteOff(d); }}
                      >
                        {revertingId === d.id ? 'Undoing…' : 'Undo write-off'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'budgeted' && budgetedTickets.length === 0 && budgetedDc.length === 0 && budgetedCm.length === 0 && (
            <div className="empty">Nothing marked as budgeted on this project yet.</div>
          )}

          {!loading && reviewTab === 'budgeted' && budgetedTickets.length > 0 && (
            <>
              <div className="list-hint">T&amp;M Tickets</div>
              <div className="ticket-list">
                {budgetedTickets.map(t => (
                  <div key={t.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">T&amp;M #{t.number}</span>
                      <span className="ticket-amount">{money(t.budgetedAmount)}</span>
                    </div>
                    <div className="ticket-description">{t.description || '(no description)'}</div>
                    {t.budgetedLines.some(l => l.reasonNotes) && (
                      <div className="ticket-meta">
                        {[...new Set(t.budgetedLines.map(l => l.reasonNotes).filter(Boolean))].join(', ')}
                      </div>
                    )}
                    <div className="ticket-links">
                      <button
                        className="undo-link"
                        disabled={revertingId === t.id}
                        onClick={e => { e.stopPropagation(); handleUndoBudgeted(t); }}
                      >
                        {revertingId === t.id ? 'Undoing…' : 'Undo'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'budgeted' && budgetedDc.length > 0 && (
            <>
              <div className="list-hint">Direct Costs</div>
              <div className="ticket-list">
                {budgetedDc.map(d => (
                  <div key={d.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">{d.vendor || 'Unknown vendor'}</span>
                      <span className="ticket-amount">{money(d.budgetedAmount)}</span>
                    </div>
                    <div className="ticket-description">{d.description || '(no description)'}</div>
                    {d.reasonNotes && <div className="ticket-meta">{d.reasonNotes}</div>}
                    <div className="ticket-links">
                      <button
                        className="undo-link"
                        disabled={revertingId === d.id}
                        onClick={e => { e.stopPropagation(); handleUndoDcBudgeted(d); }}
                      >
                        {revertingId === d.id ? 'Undoing…' : 'Undo'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'billed' && billedCm.length > 0 && (
            <>
              <div className="list-hint">Commitments</div>
              <div className="ticket-list">
                {billedCm.map(c => (
                  <div key={c.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">{c.number}</span>
                      <span className="ticket-amount">{money(c.billedAmount)}</span>
                    </div>
                    <div className="ticket-description">{c.vendor || c.title || 'Unknown vendor'}</div>
                    <div className="ticket-meta">
                      {c.billedStatus === 'draft_co' && <span className="tag tag-draft">In draft CO</span>}
                      {c.invoiceNumber && <span className="tag tag-billed">{c.invoiceNumber}</span>}
                      {c.outsideLedgerLineCount > 0 && <span className="tag tag-outside">Billed outside LEDGER</span>}
                      {c.partialBilled && <span className="tag tag-open">Some lines still unbilled</span>}
                      {c.estimatedLineCount > 0 && (c.reconciled
                        ? <span className="tag tag-billed">Reconciled</span>
                        : <span className="tag tag-draft">Estimated — needs reconciling</span>)}
                      {c.adjustmentAmount ? <span> · includes {money(c.adjustmentAmount)} adjustment{c.adjustmentDraft ? ' (draft CO)' : ''}</span> : null}
                      {(c.writtenOffLineCount > 0 || c.budgetedLineCount > 0) && (
                        <span>
                          {' '}· {c.billedLineCount} of {c.totalLineCount} line(s) billed
                          {c.writtenOffLineCount > 0 ? `, ${c.writtenOffLineCount} written off` : ''}
                          {c.budgetedLineCount > 0 ? `, ${c.budgetedLineCount} budgeted` : ''}
                        </span>
                      )}
                    </div>
                    <div className="ticket-links">
                      {c.billedStatus === 'draft_co' && (
                        <button className="undo-link" disabled={revertingId === c.id} onClick={() => handleUndoCm(c, 'draft')}>
                          {revertingId === c.id ? 'Undoing…' : 'Undo draft push'}
                        </button>
                      )}
                      <a href={commitmentUrl(c)} target="_blank" rel="noreferrer">Open in Procore ↗</a>
                      {c.estimatedLineCount > 0 && (
                        <button className="undo-link" onClick={() => openReconcile(c)}>
                          {c.reconciled ? 'Reconcile again' : 'Reconcile with sub invoice'}
                        </button>
                      )}
                      {c.outsideLedgerLineCount > 0 && (
                        <button className="undo-link" disabled={revertingId === c.id} onClick={() => handleUndoOutsideBilled('cm', c, c.number)}>
                          {revertingId === c.id ? 'Undoing…' : 'Undo "Already Billed"'}
                        </button>
                      )}
                      {c.invoiceNumber && c.billedLineCount > (c.outsideLedgerLineCount || 0) && (
                        <button
                          className="undo-link undo-link-danger"
                          disabled={revertingId === c.id}
                          onClick={() => handleUndoCm(c, 'invoice')}
                          title="Only if the invoice was already deleted in Procore"
                        >
                          {revertingId === c.id ? 'Undoing…' : 'Undo invoice (deleted in Procore)'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'writtenoff' && writtenOffCm.length > 0 && (
            <>
              <div className="list-hint">Commitments</div>
              <div className="ticket-list">
                {writtenOffCm.map(c => (
                  <div key={c.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">{c.number}</span>
                      <span className="ticket-amount">{money(c.writtenOffAmount)}</span>
                    </div>
                    <div className="ticket-description">{c.vendor || c.title || 'Unknown vendor'}</div>
                    <div className="ticket-meta">
                      {WRITE_OFF_REASON_OPTIONS.find(o => o.value === c.reasonCategory)?.label || c.reasonCategory}
                      {c.invoiceNumber ? ` · Invoiced on #${c.invoiceNumber}` : ''}
                      {c.reasonNotes ? ` — ${c.reasonNotes}` : ''}
                    </div>
                    <div className="ticket-links">
                      <button className="undo-link" disabled={revertingId === c.id} onClick={() => handleUndoCm(c, 'writeoff')}>
                        {revertingId === c.id ? 'Undoing…' : 'Undo write-off'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {!loading && reviewTab === 'budgeted' && budgetedCm.length > 0 && (
            <>
              <div className="list-hint">Commitments</div>
              <div className="ticket-list">
                {budgetedCm.map(c => (
                  <div key={c.id} className="ticket-card readonly">
                    <div className="ticket-card-header">
                      <span className="ticket-number">{c.number}</span>
                      <span className="ticket-amount">{money(c.budgetedAmount)}</span>
                    </div>
                    <div className="ticket-description">{c.vendor || c.title || 'Unknown vendor'}</div>
                    {c.reasonNotes && <div className="ticket-meta">{c.reasonNotes}</div>}
                    <div className="ticket-links">
                      <button className="undo-link" disabled={revertingId === c.id} onClick={() => handleUndoCm(c, 'budgeted')}>
                        {revertingId === c.id ? 'Undoing…' : 'Undo'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : action === null ? (
        <div className="landing">
          <div className="list-hint">What would you like to do?</div>
          {/* Ben's ask 2026-09-24: two rows of wide buttons — billing on top,
              everything else below. Write Off / Mark as Budgeted / history
              all live inside Review Project now. */}
          <div className="landing-grid">
            <button className="generate-btn landing-btn" onClick={() => setAction('invoice')}>Create Invoice</button>
            <button className="draft-btn landing-btn" onClick={() => setAction('draft')}>Push to CO (draft)</button>
            <button className="draft-btn landing-btn" onClick={() => { setReviewTab('unbilled'); setAction('review'); }}>Review Project</button>
            <button className="draft-btn landing-btn" onClick={openSettings}>Project Settings</button>
          </div>
        </div>
      ) : action === 'settings' ? (
        <>
          <div className="list-hint list-hint-nav">
            <button type="button" className="nav-btn" onClick={backToLanding}>‹ Back</button>
            <span>Project Settings</span>
          </div>
          {error && <div className="banner banner-error">{error}</div>}
          {(!settingsForm || loading) ? <div className="loading">Loading settings…</div> : (
            <div className="settings-form">
              <div className="settings-hint">
                Defaults for new invoices and Change Orders on this project — each one can still be changed per invoice.
                Leave a field blank to use the company default.
              </div>

              <div className="settings-section-header">Billing mode</div>
              <label className="action-bar-field">
                <span>Billing mode</span>
                <select value={settingsForm.billingMode} onChange={e => updateSettingsForm('billingMode', e.target.value)}>
                  <option value="auto">Auto — from Procore ({projectSettings?.projectTypeName || 'no type set'})</option>
                  <option value="tm">T&amp;M</option>
                  <option value="fixed_price">Fixed-Price</option>
                  <option value="non_billable">Not Billable</option>
                </select>
              </label>

              <div className="settings-section-header">Labour rates ($/hr)</div>
              <div className="rate-overrides-row">
                {Object.entries(TIME_TYPE_LABEL).map(([tt, label]) => {
                  const company = projectSettings?.rates?.[tt]?.company;
                  return (
                    <label key={tt} className="rate-override-field">
                      <span>
                        {label}
                        {company != null && <span className="rate-override-default"> (company {money(company)})</span>}
                      </span>
                      <input
                        type="number" min="0" step="0.01"
                        placeholder={company != null ? company.toFixed(2) : 'company rate'}
                        value={settingsForm.rates[tt]}
                        onChange={e => updateSettingsForm('rates', { ...settingsForm.rates, [tt]: e.target.value })}
                      />
                    </label>
                  );
                })}
              </div>

              <div className="settings-section-header">Markup</div>
              <MarkupFields
                label="Direct costs"
                value={settingsForm.dcMarkupPercent}
                placeholder={projectSettings?.companyDefaults?.dcMarkupPercent}
                onChange={v => updateSettingsForm('dcMarkupPercent', v)}
              />
              <MarkupFields
                label="Commitments"
                value={settingsForm.cmMarkupPercent}
                placeholder={projectSettings?.companyDefaults?.cmMarkupPercent}
                onChange={v => updateSettingsForm('cmMarkupPercent', v)}
              />

              <div className="settings-section-header">Line grouping</div>
              {[
                ['tmGroupBy', 'T&M tickets', GROUP_BY_OPTIONS],
                ['dcGroupBy', 'Direct costs', DC_GROUP_BY_OPTIONS],
                ['cmGroupBy', 'Commitments', CM_GROUP_BY_OPTIONS]
              ].map(([field, label, options]) => {
                const companyValue = projectSettings?.companyDefaults?.[field];
                const companyLabel = options.find(o => o.value === companyValue)?.label.replace(' (default)', '') || companyValue;
                return (
                  <label key={field} className="action-bar-field">
                    <span>{label}</span>
                    <select value={settingsForm[field]} onChange={e => updateSettingsForm(field, e.target.value)}>
                      <option value="">Company default — {companyLabel}</option>
                      {options.map(o => <option key={o.value} value={o.value}>{o.label.replace(' (default)', '')}</option>)}
                    </select>
                  </label>
                );
              })}

              <div className="settings-section-header">Prime Contract</div>
              <label className="action-bar-field">
                <span>Default contract to bill against</span>
                <select
                  value={settingsForm.defaultPrimeContractId}
                  onChange={e => updateSettingsForm('defaultPrimeContractId', e.target.value)}
                >
                  <option value="">No default — LEDGER picks the approved one</option>
                  {contracts.map(c => (
                    <option key={c.id} value={c.id}>#{c.number ?? c.id} — {c.title || '(untitled)'} ({c.status})</option>
                  ))}
                </select>
              </label>
              <div className="settings-hint">Opening LEDGER from a Prime Contract page in Procore still uses that contract.</div>

              {projectSettings?.updatedAt && (
                <div className="settings-hint">
                  Last saved {new Date(projectSettings.updatedAt).toLocaleString()} by user {projectSettings.updatedBy}.
                </div>
              )}

              <div className="action-bar-buttons settings-buttons">
                <button className="generate-btn" onClick={saveSettings} disabled={savingSettings}>
                  {savingSettings ? 'Saving…' : 'Save settings'}
                </button>
                <button className="cancel-btn" onClick={() => setSettingsForm(formFromSettings(projectSettings))} disabled={savingSettings}>
                  Discard changes
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {loading && <div className="loading">Loading billing data…</div>}

          {!loading && !overlayOpen && (
            <>
              {action === 'review' ? reviewHeader : (
                <div className="list-hint list-hint-nav">
                  <button type="button" className="nav-btn" onClick={backToLanding}>‹ Change action</button>
                  <span>{ACTION_LABEL[action]} — pick items to bill</span>
                </div>
              )}

              {/* Sub-tabs within the picker (Ben's ask 2026-09-16: "not just a
                  gigantic list of records to sift through") — ALWAYS shown
                  now (Ben's ask 2026-09-22: no indication before when a
                  source had nothing left to bill), each with a
                  checked/unbilled count so "0/0" is visible rather than the
                  section just silently disappearing. Selection state itself
                  (checkedIds/checkedDcIds) is untouched by the tab switch —
                  only which section is currently rendered changes. */}
              <div className="tabs">
                <button className={`tab ${pickerTab === 'tm' ? 'active' : ''}`} onClick={() => setPickerTab('tm')}>
                  T&amp;M Tickets <span className="tab-count">{checkedIds.size}/{unbilledTickets.length}</span>
                </button>
                <button className={`tab ${pickerTab === 'dc' ? 'active' : ''}`} onClick={() => setPickerTab('dc')}>
                  Direct Costs <span className="tab-count">{checkedDcTouchedCount}/{unbilledDc.length}</span>
                </button>
                <button className={`tab ${pickerTab === 'cm' ? 'active' : ''}`} onClick={() => setPickerTab('cm')}>
                  Commitments <span className="tab-count">{checkedCmTouchedCount}/{unbilledCm.length}</span>
                </button>
              </div>

              {pickerTab === 'tm' && billingMode === 'non_billable' && (
                <div className="empty">
                  This project isn't billed to a client, so T&amp;M tickets aren't tracked here. Switch to Direct
                  Costs, or override the billing mode in Details below if that's wrong.
                </div>
              )}

              {/* Empty state distinguishes "nothing of this type exists yet"
                  from "everything that existed has already been accounted
                  for" (billed, written off, or marked as budgeted) — Ben's
                  ask 2026-09-22, phrased for a PM audience rather than a
                  blunt "0 items". */}
              {pickerTab === 'tm' && billingMode !== 'non_billable' && unbilledTickets.length === 0 && (
                <div className="empty">
                  {(tickets?.length || 0) === 0
                    ? 'This project has no T&M tickets yet.'
                    : 'Every T&M ticket on this project is already accounted for — billed, written off, or marked as budgeted.'}
                </div>
              )}

              {pickerTab === 'dc' && unbilledDc.length === 0 && (
                <div className="empty">
                  {totalDcCount === 0
                    ? 'This project has no direct costs yet.'
                    : 'Every direct cost on this project is already accounted for — billed, written off, or marked as budgeted.'}
                </div>
              )}

              {billingMode !== 'non_billable' && unbilledTickets.length > 0 && pickerTab === 'tm' && (
                <>
                  <div className="list-hint select-all-row">
                    <label className="select-all-label">
                      <input
                        type="checkbox"
                        checked={unbilledTickets.every(t => checkedIds.has(t.id))}
                        onChange={() => toggleSelectAll(unbilledTickets.map(t => t.id))}
                      />
                      Select all T&amp;M tickets
                    </label>
                  </div>
                  <div className="ticket-list">
                    {unbilledTickets.map(t => (
                      <div
                        key={t.id}
                        className={`ticket-card ${checkedIds.has(t.id) ? 'checked' : ''}`}
                        onClick={() => setExpandedTmId(expandedTmId === t.id ? null : t.id)}
                      >
                        <div className="ticket-card-header">
                          <label className="ticket-check" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checkedIds.has(t.id)}
                              onChange={() => toggleChecked(t.id)}
                            />
                          </label>
                          <span className="ticket-number">T&amp;M #{t.number}</span>
                          <span className="ticket-amount">{money(t.estimatedTotal)}</span>
                        </div>
                        <div className="ticket-description">{t.description || '(no description)'}</div>
                        <div className="ticket-meta">
                          {t.unbilledCount} unbilled line{t.unbilledCount === 1 ? '' : 's'}
                          {t.billedCount > 0 && ` (${t.billedCount} already billed)`}
                        </div>

                        {t.unlinkedCount > 0 && billingMode !== 'fixed_price' && (
                          <div className="unlinked-warning">
                            ⚠ {t.unlinkedCount} of {t.unbilledCount} unbilled line{t.unbilledCount === 1 ? '' : 's'} {t.unlinkedCount === 1 ? 'has' : 'have'} no timecard
                            linked in Procore. Apply a timecard before billing, or you'll be asked to confirm submitting without one.
                          </div>
                        )}

                        {expandedTmId === t.id && (
                          <div className="line-items">
                            {t.unbilledLines.map(l => (
                              <div className="line-item" key={l.timecardEntryId}>
                                <span>
                                  {l.workerName}
                                  {!l.hasTimecard && billingMode !== 'fixed_price' && <span className="no-timecard-tag"> ⚠ no timecard</span>}
                                </span>
                                <span className="line-item-detail">{l.timeType} · {l.hours}h @ {l.rate != null ? money(l.rate) : '—'}</span>
                                <span className="line-item-amount">{l.amount != null ? money(l.amount) : '—'}</span>
                              </div>
                            ))}
                            <div className="ticket-links">
                              <button onClick={e => { e.stopPropagation(); popOutTicketDetail(t); }}>
                                Full details
                              </button>
                              {projectId && (
                                <a
                                  href={tandmTicketUrl(t.id)}
                                  target="_blank" rel="noreferrer"
                                  onClick={e => e.stopPropagation()}
                                >
                                  Open in Procore ↗
                                </a>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {unbilledDc.length > 0 && pickerTab === 'dc' && (
                <>
                  <div className="list-hint select-all-row">
                    <label className="select-all-label">
                      <input
                        type="checkbox"
                        checked={unbilledDc.every(d => checkedDcIds.has(d.id))}
                        onChange={() => toggleSelectAllDc(unbilledDc.map(d => d.id))}
                      />
                      Select all direct costs
                    </label>
                  </div>
                  <div className="ticket-list">
                    {unbilledDc.map(d => {
                      const detail = dcLineDetailCache.get(d.id);
                      // Indeterminate when this DC has some-but-not-all lines
                      // checked via checkedDcLineIds (Ben's ask 2026-09-22) —
                      // distinct from the plain checked state, which means
                      // "the whole DC (via the 'ALL' convenience)".
                      const someLinesChecked = !checkedDcIds.has(d.id) &&
                        [...checkedDcLineIds].some(k => k.startsWith(`${d.id}:`));
                      return (
                      <div
                        key={d.id}
                        className={`ticket-card ${checkedDcIds.has(d.id) || someLinesChecked ? 'checked' : ''}`}
                        onClick={() => toggleExpandDc(d)}
                      >
                        <div className="ticket-card-header">
                          <label className="ticket-check" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={checkedDcIds.has(d.id)}
                              ref={el => { if (el) el.indeterminate = someLinesChecked; }}
                              onChange={() => toggleCheckedDc(d.id)}
                            />
                          </label>
                          <span className="ticket-number">{d.vendor || 'Unknown vendor'}</span>
                          <span className="ticket-amount">{money(d.partialBilled ? d.remainingAmount : d.amount)}</span>
                        </div>
                        <div className="ticket-description">{d.description || '(no description)'}{d.date ? ` — ${d.date}` : ''}</div>
                        <div className="ticket-meta">
                          {d.type}
                          {d.partialBilled && ` · ${d.billedLineCount} of ${d.totalLineCount} line items already billed`}
                        </div>

                        {expandedDcId === d.id && (
                          <div className="line-items">
                            {dcLineDetailLoading === d.id && <div className="loading">Loading line items…</div>}
                            {detail?.error && <div className="banner banner-error">{detail.error}</div>}
                            {detail?.lines?.map(l => (
                              <div className="line-item-check" key={l.id}>
                                {/* Per-line picking now applies to all four action-first
                                    actions (Ben's ask 2026-09-23 extended write-off/budgeted
                                    to per-line too) — action is never anything else inside
                                    this picker view, so this always renders a real checkbox. */}
                                <label className="ticket-check" onClick={e => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    disabled={!!l.billedStatus}
                                    checked={checkedDcIds.has(d.id) || checkedDcLineIds.has(`${d.id}:${l.id}`)}
                                    onChange={() => toggleCheckedDcLine(d.id, l.id)}
                                  />
                                </label>
                                <span>
                                  {l.description || l.costCode || 'Line item'}
                                  {l.billedStatus === 'billed' && <span className="tag tag-billed"> {l.invoiceNumber || 'Billed'}</span>}
                                  {l.billedStatus === 'draft_co' && <span className="tag tag-draft"> In draft CO</span>}
                                  {l.billedStatus === 'written_off' && <span className="tag tag-written-off"> Written off</span>}
                                  {l.billedStatus === 'reconciled_to_period' && <span className="tag tag-budgeted"> Budgeted</span>}
                                </span>
                                <span className="line-item-detail">{l.costCode || '—'}</span>
                                <span className="line-item-amount">{money(l.amount)}</span>
                              </div>
                            ))}
                            <div className="ticket-links">
                              <button onClick={e => { e.stopPropagation(); popOutDirectCostDetail(d); }}>
                                Full details
                              </button>
                              <a href={directCostUrl(d.id)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                                Open in Procore ↗
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                </>
              )}

              {pickerTab === 'cm' && isBillingAction && cmLegacy && unbilledCm.length > 0 && (
                <div className="banner banner-error">{LEGACY_WARNING_TEXT}</div>
              )}

              {pickerTab === 'cm' && unbilledCm.length === 0 && (
                <div className="empty">
                  {totalCmCount === 0
                    ? 'This project has no commitments yet.'
                    : 'Every commitment on this project is already accounted for — billed, written off, or marked as budgeted.'}
                </div>
              )}

              {pickerTab === 'cm' && unbilledCm.length > 0 && (
                <div className="ticket-list">
                  {unbilledCm.map(c => {
                    const cmId = String(c.id);
                    const detail = cmLineDetailCache.get(cmId);
                    const selectable = (detail?.lines || []).filter(cmLineSelectable);
                    const checkedHere = [...checkedCmLineIds].filter(k => k.startsWith(`${cmId}:`)).length;
                    const allChecked = selectable.length > 0 && checkedHere === selectable.length;
                    const labourCount = (detail?.lines || []).filter(l => l.isLabour && !l.billedStatus).length;
                    const tmBilledCount = (detail?.lines || []).filter(l => l.tmBilled && !l.billedStatus).length;
                    const openLines = (detail?.lines || []).filter(l => !l.billedStatus);
                    // Card buttons act on the lines ticked here, or on every open
                    // line when none are (Ben hit this 2026-09-25: one ticked line,
                    // the whole commitment got budgeted).
                    const tickedHere = openLines.filter(l => checkedCmLineIds.has(`${cmId}:${l.id}`));
                    const targetLines = tickedHere.length > 0 ? tickedHere : openLines;
                    const cardScope = {
                      label: c.number,
                      commitmentLineIds: targetLines.map(l => `${cmId}:${l.id}`),
                      amount: targetLines.reduce((sum, l) => sum + l.amount, 0)
                    };
                    return (
                      <div
                        key={cmId}
                        className={`ticket-card ${checkedHere > 0 ? 'checked' : ''}`}
                        onClick={() => toggleExpandCm(c)}
                      >
                        <div className="ticket-card-header">
                          <label className="ticket-check" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={el => { if (el) el.indeterminate = checkedHere > 0 && !allChecked; }}
                              disabled={cmLineDetailLoading === cmId}
                              onChange={() => toggleCommitment(c)}
                            />
                          </label>
                          <span className="ticket-number">{c.number}</span>
                          <span className="ticket-amount">{money(c.partialBilled ? c.remainingAmount : c.amount)}</span>
                        </div>
                        <div className="ticket-description">{c.vendor || c.title || 'Unknown vendor'}</div>
                        <div className="ticket-meta">
                          {c.type === 'WorkOrderContract' ? 'Subcontract' : c.type === 'PurchaseOrderContract' ? 'Purchase order' : c.type}
                          {c.status && ` · ${c.status}`}
                          {c.partialBilled && ` · ${c.billedLineCount} of ${c.totalLineCount} line items already accounted for`}
                        </div>

                        {expandedCmId === cmId && (
                          <div className="line-items">
                            {cmLineDetailLoading === cmId && <div className="loading">Loading line items…</div>}
                            {detail?.error && <div className="banner banner-error">{detail.error}</div>}

                            {/* Budget / Write Off up front (Ben's ask 2026-09-24):
                                for labour on a subcontract, that's the expected
                                path — billing it is the exception. */}
                            {(isBillingAction || action === 'review') && openLines.length > 0 && (
                              <div className="cm-disposition-row" onClick={e => e.stopPropagation()}>
                                {isBillingAction && !cmLegacy && labourCount > 0 && (
                                  <div className="labour-flag">
                                    Labour on a subcontract — bill it from a T&amp;M ticket, or mark it as budgeted.
                                  </div>
                                )}
                                <div className="cm-disposition-scope">
                                  {tickedHere.length > 0
                                    ? `Applies to the ${tickedHere.length} ticked line${tickedHere.length === 1 ? '' : 's'}`
                                    : `Applies to all ${openLines.length} open line${openLines.length === 1 ? '' : 's'} — tick lines to narrow it`}
                                </div>
                                <div className="cm-disposition-buttons">
                                  <button className={action === 'review' ? 'billed-btn' : 'draft-btn'} onClick={() => startDisposition('already_billed', cardScope)}>
                                    Already Billed
                                  </button>
                                  <button className="draft-btn" onClick={() => startDisposition('budgeted', cardScope)}>
                                    Mark as Budgeted
                                  </button>
                                  <button className="draft-btn" onClick={() => startDisposition('writeoff', cardScope)}>
                                    Write Off
                                  </button>
                                </div>
                              </div>
                            )}

                            {isBillingAction && tmBilledCount > 0 && (
                              <div className="ticket-meta">
                                {tmBilledCount} line{tmBilledCount === 1 ? ' is' : 's are'} hours already billed through T&amp;M — can't be billed again here.
                              </div>
                            )}

                            {detail?.lines?.map(l => (
                              <div className="line-item-check" key={l.id}>
                                <label className="ticket-check" onClick={e => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    disabled={!cmLineSelectable(l)}
                                    checked={checkedCmLineIds.has(`${cmId}:${l.id}`)}
                                    onChange={() => toggleCmLine(cmId, l)}
                                  />
                                </label>
                                <span>
                                  {l.description || 'Line item'}
                                  {l.isLabour && !l.billedStatus && !l.tmBilled && <span className="no-timecard-tag"> LABOUR</span>}
                                  {l.billedStatus === 'billed' && <span className="tag tag-billed"> {l.invoiceNumber || 'Billed'}</span>}
                                  {l.billedStatus === 'draft_co' && <span className="tag tag-draft"> In draft CO</span>}
                                  {l.billedStatus === 'written_off' && <span className="tag tag-written-off"> Written off</span>}
                                  {l.billedStatus === 'reconciled_to_period' && <span className="tag tag-budgeted"> Budgeted</span>}
                                  {l.isEstimated && <span className="tag tag-draft"> Estimated</span>}
                                  {l.tmBilled && (
                                    <span className="tag tag-billed">
                                      {' '}Billed via {l.tmBilled.viaCommitment ? 'another commitment' : 'T&M'}
                                      {l.tmBilled.invoiceNumber ? ` (${l.tmBilled.invoiceNumber})` : l.tmBilled.status === 'draft_co' ? ' (draft CO)' : ''}
                                    </span>
                                  )}
                                  {!l.tmBilled && l.tmTicketNumbers?.length > 0 && !l.billedStatus && (
                                    <span className="tag tag-draft"> On T&amp;M #{l.tmTicketNumbers.join(', #')}</span>
                                  )}
                                  {!l.hasBudgetCode && !l.billedStatus && <span className="tag tag-written-off"> No budget code</span>}
                                </span>
                                <span className="line-item-detail">{l.budgetCode || '—'}</span>
                                <span className="line-item-amount">{money(l.amount)}</span>
                              </div>
                            ))}
                            <div className="ticket-links">
                              <a href={commitmentUrl(c)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                                Open in Procore ↗
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {(projectId || contractId) && !overlayOpen && (
            <details className="details">
              <summary>Details</summary>
              <dl className="details-grid">
                <dt>Project</dt><dd>{projectId || '—'}</dd>
                <dt>Prime Contract</dt><dd>{contractId || '(none — LEDGER picks the approved one)'}</dd>
                {procoreView && <><dt>Procore view</dt><dd>{procoreView}</dd></>}
                <dt>Company</dt><dd>{TENANT_ID}</dd>
                <dt>Acting user</dt><dd>{userId}</dd>
                <dt>Runtime</dt><dd>{EMBEDDED ? 'embedded (Procore side panel)' : 'standalone'}</dd>
                <dt>Procore project type</dt><dd>{projectTypeName || '(not set)'}</dd>
                <dt>Billing mode</dt>
                <dd>
                  {MODE_LABEL[billingMode] || '—'}
                  {billingModeSource === 'override' ? ' (set in Project Settings)' : ' (from Procore project type)'}
                </dd>
              </dl>
            </details>
          )}

          {/* Picker footer: items already picked, action already chosen —
              just one button into settings. Ben's ask 2026-09-16: the old
              two-button choice belongs on the landing screen now, not here. */}
          {showPickerFooter && (
            <div className="action-bar">
              <div className="action-bar-summary">
                <strong>{checkedCount}</strong> item{checkedCount === 1 ? '' : 's'} · {money(checkedTotal)}
              </div>
              <div className="action-bar-buttons">
                {/* Billing flows lead with Configure; the dispositions are
                    secondary there. Review Project has no billing, so
                    Already Billed leads (green) instead — Ben, 2026-09-25. */}
                {action !== 'review' && (
                  <button className={action === 'invoice' ? 'generate-btn' : 'draft-btn'} onClick={() => setConfiguring(true)}>
                    Configure →
                  </button>
                )}
                {(isBillingAction || action === 'review') && (
                  <>
                    <button className={action === 'review' ? 'billed-btn' : 'cancel-btn'} onClick={() => startDisposition('already_billed')}>Already Billed</button>
                    <button className={action === 'review' ? 'draft-btn' : 'cancel-btn'} onClick={() => startDisposition('budgeted')}>Mark as Budgeted</button>
                    <button className={action === 'review' ? 'draft-btn' : 'cancel-btn'} onClick={() => startDisposition('writeoff')}>Write Off</button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Settings and preview/running both take over the whole panel —
              there's real content here (a contract picker, rate overrides, a
              progress log) and the panel is too narrow to show it docked in a
              corner alongside the item lists. Ben's ask 2026-09-14. */}
          {overlayOpen && action !== 'writeoff' && action !== 'budgeted' && action !== 'already_billed' && (
            <div className="billing-overlay">
              <div className="billing-overlay-header">
                <span>
                  {generating
                    ? 'Working…'
                    : (previewTmLines || previewDcLines || previewCmLines)
                    ? `Preview — ${ACTION_LABEL[action]}`
                    : ACTION_LABEL[action]}
                </span>
                {!generating && (
                  <button className="overlay-close" onClick={clearConfiguring} aria-label="Cancel">✕</button>
                )}
              </div>

              <div className="billing-overlay-body">
                <div className="action-bar-summary">
                  <strong>{checkedCount}</strong> item{checkedCount === 1 ? '' : 's'} · {money(checkedTotal)}
                </div>

                {/* The overlay covers the whole screen, so the error banner
                    further up the page (behind it) would be invisible without
                    this — confirmed live 2026-09-14: a failed Confirm looked
                    like it did nothing because the error was rendering behind
                    the overlay. */}
                {error && <div className="banner banner-error">{error}</div>}

                {/* Bolded, orange-underlined section headers (Ben's ask
                    2026-09-22) — General fields apply to the whole CO/invoice
                    regardless of source; T&M and Direct Cost sections only
                    show when that source is actually part of the selection.
                    Commitments get their own section too (2026-09-24). */}
                {!generating && !previewTmLines && !previewDcLines && !previewCmLines && (
                  <>
                    <div className="settings-section-header">General</div>

                    {contracts.length > 1 && contractFromProcore ? (
                      <div className="action-bar-field">
                        <span>Prime Contract</span>
                        <div className="locked-contract">
                          {contracts.find(c => String(c.id) === String(contractId))?.title || `#${contractId}`}{' '}
                          <span className="locked-contract-hint">(from the Procore page you're on)</span>
                        </div>
                      </div>
                    ) : contracts.length > 1 && (
                      <label className="action-bar-field">
                        <span>Prime Contract</span>
                        <select
                          value={contractId || ''}
                          onChange={e => setContractId(e.target.value)}
                        >
                          {contracts.map(c => (
                            <option key={c.id} value={c.id}>
                              #{c.number ?? c.id} — {c.title || '(untitled)'} ({c.status})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    {/* Ben's ask 2026-09-22: override the auto-generated
                        CO/Change Event name (e.g. "T&M #5 + 2 Direct Costs")
                        with something real. Left blank keeps the default. */}
                    <label className="action-bar-field">
                      <span>CO / CE name (optional)</span>
                      <input
                        type="text"
                        placeholder="e.g. Kitchen Equipment Change Order"
                        value={coTitle}
                        onChange={e => setCoTitle(e.target.value)}
                      />
                    </label>

                    {/* Only Generate Invoice creates an invoice number — Push to
                        CO doesn't touch one. Suggested value is the biggest
                        existing invoice number on the project + 1 (Ben's ask
                        2026-09-14) — editable, not a hard rule. */}
                    {action === 'invoice' && (
                      <label className="action-bar-field">
                        <span>Invoice number</span>
                        <input
                          type="text"
                          value={invoiceNumberLoading ? 'Loading…' : invoiceNumberInput}
                          disabled={invoiceNumberLoading}
                          onChange={e => setInvoiceNumberInput(e.target.value)}
                        />
                      </label>
                    )}

                    {/* Required (Ben's ask 2026-09-14) — was silently defaulting
                        to the billing period's own end date with no PM
                        visibility into it. Pre-filled from the resolved period
                        as a starting point, not a hard rule. */}
                    {action === 'invoice' && (
                      <label className="action-bar-field">
                        <span>Billing date</span>
                        <input
                          type="date"
                          value={billingDate}
                          onChange={e => setBillingDate(e.target.value)}
                        />
                      </label>
                    )}

                    {/* Only Generate Invoice touches a billing period — Push to CO
                        never creates an invoice. A project with none at all used
                        to fail silently after a real CO was already approved
                        (2026-09-14), so this is explicit rather than left to the
                        Worker's own fallback. */}
                    {action === 'invoice' && (
                      <div className="action-bar-field billing-period-field">
                        <span>Billing period</span>
                        {billingPeriods.length > 0 && !creatingPeriod ? (
                          <select
                            value={billingPeriodId}
                            onChange={e => {
                              if (e.target.value === '__new__') { setCreatingPeriod(true); return; }
                              setBillingPeriodId(e.target.value);
                            }}
                          >
                            <option value="" disabled>Choose a period…</option>
                            {billingPeriods.map(p => (
                              <option key={p.id} value={p.id}>
                                {p.startDate} – {p.endDate} ({p.status})
                              </option>
                            ))}
                            <option value="__new__">+ Create new period…</option>
                          </select>
                        ) : (
                          <div className="new-period-inputs">
                            <input
                              type="date" value={newPeriodStart}
                              onChange={e => setNewPeriodStart(e.target.value)}
                            />
                            <span>to</span>
                            <input
                              type="date" value={newPeriodEnd}
                              onChange={e => setNewPeriodEnd(e.target.value)}
                            />
                            {billingPeriods.length > 0 && (
                              <button type="button" className="link-btn" onClick={() => setCreatingPeriod(false)}>
                                Use an existing period instead
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {checkedIds.size > 0 && (
                      <>
                        <div className="settings-section-header">T&amp;M Tickets</div>

                        <label className="action-bar-field">
                          <span>Group lines</span>
                          <select value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                            {GROUP_BY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>

                        {groupBy === 'total' && (
                          <div className="banner banner-warning grouping-disclaimer">{TOTAL_GROUPING_DISCLAIMER}</div>
                        )}

                        {presentTimeTypes.length > 0 && (
                          <div className="rate-overrides">
                            <span className="rate-overrides-label">Rate override (optional)</span>
                            <div className="rate-overrides-row">
                              {presentTimeTypes.map(tt => (
                                <label key={tt} className="rate-override-field">
                                  <span>
                                    {TIME_TYPE_LABEL[tt] || tt}
                                    {defaultRateByType[tt] != null && (
                                      <span className="rate-override-default"> (default {money(defaultRateByType[tt])}/hr)</span>
                                    )}
                                  </span>
                                  <input
                                    type="number" min="0" step="0.01"
                                    placeholder={defaultRateByType[tt] != null ? defaultRateByType[tt].toFixed(2) : 'default'}
                                    value={rateOverrides[tt] ?? ''}
                                    onChange={e => setRateOverrides(prev => ({ ...prev, [tt]: e.target.value }))}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {(checkedDcIds.size > 0 || checkedDcLineIds.size > 0) && (
                      <>
                        <div className="settings-section-header">Direct Costs</div>

                        <label className="action-bar-field">
                          <span>Group direct costs</span>
                          <select value={dcGroupBy} onChange={e => setDcGroupBy(e.target.value)}>
                            {DC_GROUP_BY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>

                        {dcGroupBy === 'total' && (
                          <div className="banner banner-warning grouping-disclaimer">{DC_TOTAL_GROUPING_DISCLAIMER}</div>
                        )}
                      </>
                    )}

                    {checkedCmLineIds.size > 0 && (
                      <>
                        <div className="settings-section-header">Commitments</div>

                        <label className="action-bar-field">
                          <span>Group commitments</span>
                          <select value={cmGroupBy} onChange={e => setCmGroupBy(e.target.value)}>
                            {CM_GROUP_BY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </label>
                      </>
                    )}

                    {(checkedDcIds.size > 0 || checkedDcLineIds.size > 0) && (
                      <MarkupFields label="Direct cost markup / margin" value={markupPercent} onChange={setMarkupPercent} />
                    )}
                    {checkedCmLineIds.size > 0 && (
                      <MarkupFields label="Commitment markup / margin" value={cmMarkupPercent} onChange={setCmMarkupPercent} />
                    )}
                  </>
                )}

                {/* Preview/edit step (Ben's ask 2026-09-15) — exactly what
                    Confirm will create (same backend logic, not a frontend
                    approximation). T&M lines get description + rate editing;
                    direct-cost lines get description only (markup stays
                    baked into the one line, never its own adjustable field —
                    Ben was explicit about that 2026-09-16). */}
                {!generating && (previewTmLines || previewDcLines || previewCmLines) && (
                  <>
                    {previewMeta?.label && (
                      <div className="rate-overrides-label">Will be named: {previewMeta.label}</div>
                    )}

                    {previewMeta?.unlinkedCount > 0 && (
                      <div className="banner banner-warning">
                        {previewMeta.unlinkedCount} line(s) have no timecard linked in Procore — you'll be asked to
                        confirm submitting without one.
                      </div>
                    )}

                    {previewTmLines?.length > 0 && (
                      <>
                        <div className="rate-overrides-label">T&amp;M lines</div>
                        <div className="preview-lines">
                          {previewTmLines.map((line, i) => (
                            <div className="preview-line" key={i}>
                              <input
                                className="preview-line-desc"
                                type="text"
                                value={line.description}
                                onChange={e => updatePreviewTmLine(i, 'description', e.target.value)}
                              />
                              <div className="preview-line-nums">
                                <span>{line.hours} hrs @</span>
                                <input
                                  type="number" min="0" step="0.01"
                                  value={line.rate}
                                  onChange={e => updatePreviewTmLine(i, 'rate', e.target.value)}
                                />
                                <span className="preview-line-amount">
                                  {money(line.hours * (Number(line.rate) || 0))}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {previewDcLines?.length > 0 && (
                      <>
                        <div className="rate-overrides-label">Direct cost lines</div>
                        <div className="preview-lines">
                          {previewDcLines.map((line, i) => (
                            <div className="preview-line" key={i}>
                              <input
                                className="preview-line-desc"
                                type="text"
                                value={line.description}
                                onChange={e => updatePreviewDcLine(i, 'description', e.target.value)}
                              />
                              <div className="preview-line-nums">
                                <span>cost {money(line.cost)} @ {line.markupPercent}% markup</span>
                                <span className="preview-line-amount">{money(line.amount)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {previewCmLines?.length > 0 && (
                      <>
                        <div className="rate-overrides-label">Commitment lines</div>
                        {previewCmLines.some(l => l.isEstimated) && (
                          <div className="banner banner-warning">
                            Some of these commitments haven't been invoiced by the subcontractor yet — they'll be billed as
                            estimates, and LEDGER will block any further billing on them until that's reconciled.
                          </div>
                        )}
                        <div className="preview-lines">
                          {previewCmLines.map((line, i) => (
                            <div className="preview-line" key={i}>
                              <input
                                className="preview-line-desc"
                                type="text"
                                value={line.description}
                                onChange={e => updatePreviewCmLine(i, 'description', e.target.value)}
                              />
                              <div className="preview-line-nums">
                                <span>
                                  cost {money(line.cost)} @ {line.markupPercent}% markup
                                  {line.isEstimated && <span className="tag tag-draft"> Estimated</span>}
                                </span>
                                <span className="preview-line-amount">{money(line.amount)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    <div className="preview-total">
                      <span>Total</span>
                      <strong>{money(previewMeta?.totalAmount ?? 0)}</strong>
                    </div>
                  </>
                )}

                {generating && progressLog.length > 0 && (
                  <div className="progress-log">
                    {progressLog.map((line, i) => <div key={i} className="progress-line">{line}</div>)}
                  </div>
                )}
              </div>

              <div className="billing-overlay-footer">
                {generating ? (
                  <div className="action-bar-buttons">
                    <button className="generate-btn" disabled>Working…</button>
                  </div>
                ) : (previewTmLines || previewDcLines || previewCmLines) ? (
                  <div className="action-bar-buttons">
                    <button
                      className={action === 'invoice' ? 'generate-btn' : 'draft-btn'}
                      onClick={() => runBilling(action)}
                    >
                      Confirm — {ACTION_LABEL[action]}
                    </button>
                    <button className="cancel-btn" onClick={popOutPreview} title="Open this preview in a full window to edit, then it saves back here">
                      ⧉ Pop out for review
                    </button>
                    <button className="cancel-btn" onClick={() => { setPreviewTmLines(null); setPreviewDcLines(null); setPreviewCmLines(null); }}>← Back to settings</button>
                  </div>
                ) : (
                  <div className="action-bar-buttons">
                    <button className="generate-btn" onClick={loadPreview} disabled={previewLoading}>
                      {previewLoading ? 'Loading preview…' : 'Preview →'}
                    </button>
                    <button className="cancel-btn" onClick={clearConfiguring}>Cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Write-off has no preview stage — nothing gets built in Procore,
              so there's nothing to show a preview of. Reason + notes, then
              straight to Confirm. Ben's ask 2026-09-17. */}
          {overlayOpen && action === 'writeoff' && (
            <div className="billing-overlay">
              <div className="billing-overlay-header">
                <span>{generating ? 'Working…' : 'Write Off'}</span>
                {!generating && (
                  <button className="overlay-close" onClick={closeDispositionOverlay} aria-label="Cancel">✕</button>
                )}
              </div>

              <div className="billing-overlay-body">
                <div className="action-bar-summary">
                  {dispositionScope ? (
                    <><strong>{dispositionScope.label}</strong> · {dispositionScope.commitmentLineIds.length} line{dispositionScope.commitmentLineIds.length === 1 ? '' : 's'} · {money(dispositionScope.amount)}</>
                  ) : (
                    <><strong>{checkedCount}</strong> item{checkedCount === 1 ? '' : 's'} · {money(checkedTotal)}</>
                  )}
                </div>

                {error && <div className="banner banner-error">{error}</div>}

                {!generating && (
                  <>
                    <label className="action-bar-field">
                      <span>Reason</span>
                      <select value={writeOffReason} onChange={e => setWriteOffReason(e.target.value)}>
                        <option value="" disabled>Choose a reason…</option>
                        {WRITE_OFF_REASON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="action-bar-field">
                      <span>Notes (optional)</span>
                      <textarea
                        rows={3}
                        value={writeOffNotes}
                        onChange={e => setWriteOffNotes(e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>

              <div className="billing-overlay-footer">
                {generating ? (
                  <div className="action-bar-buttons">
                    <button className="draft-btn" disabled>Working…</button>
                  </div>
                ) : (
                  <div className="action-bar-buttons">
                    <button className="draft-btn" onClick={runWriteOff} disabled={!writeOffReason}>
                      Confirm — Write Off
                    </button>
                    <button className="cancel-btn" onClick={closeDispositionOverlay}>Cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* "Already Billed" (Ben's ask 2026-09-25) — billed on an invoice
              LEDGER didn't create. Lands in Billed, not Written off. */}
          {overlayOpen && action === 'already_billed' && (
            <div className="billing-overlay">
              <div className="billing-overlay-header">
                <span>{generating ? 'Working…' : 'Already Billed'}</span>
                {!generating && (
                  <button className="overlay-close" onClick={closeDispositionOverlay} aria-label="Cancel">✕</button>
                )}
              </div>

              <div className="billing-overlay-body">
                <div className="action-bar-summary">
                  {dispositionScope ? (
                    <><strong>{dispositionScope.label}</strong> · {dispositionScope.commitmentLineIds.length} line{dispositionScope.commitmentLineIds.length === 1 ? '' : 's'} · {money(dispositionScope.amount)}</>
                  ) : (
                    <><strong>{checkedCount}</strong> item{checkedCount === 1 ? '' : 's'} · {money(checkedTotal)}</>
                  )}
                </div>

                {error && <div className="banner banner-error">{error}</div>}

                {!generating && (
                  <>
                    <div className="settings-hint">
                      For items already billed to the client on an invoice LEDGER didn't create. They'll show under
                      Billed and can't be billed again.
                    </div>
                    <label className="action-bar-field">
                      <span>Invoice number it was billed on</span>
                      <input
                        type="text"
                        value={alreadyBilledInvoice}
                        onChange={e => setAlreadyBilledInvoice(e.target.value)}
                        placeholder="e.g. 10"
                      />
                    </label>
                    <label className="action-bar-field">
                      <span>Notes (optional)</span>
                      <textarea rows={3} value={alreadyBilledNotes} onChange={e => setAlreadyBilledNotes(e.target.value)} />
                    </label>
                  </>
                )}
              </div>

              <div className="billing-overlay-footer">
                {generating ? (
                  <div className="action-bar-buttons">
                    <button className="billed-btn" disabled>Working…</button>
                  </div>
                ) : (
                  <div className="action-bar-buttons">
                    <button className="billed-btn" onClick={runAlreadyBilled}>Confirm — Already Billed</button>
                    <button className="cancel-btn" onClick={closeDispositionOverlay}>Cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* "Mark as Budgeted" (Ben's ask 2026-09-21) — same no-preview shape
              as Write Off, just a plain optional note instead of a required
              reason category ("already accounted for" doesn't split into
              sub-reasons the way a write-off does). */}
          {overlayOpen && action === 'budgeted' && (
            <div className="billing-overlay">
              <div className="billing-overlay-header">
                <span>{generating ? 'Working…' : 'Mark as Budgeted'}</span>
                {!generating && (
                  <button className="overlay-close" onClick={closeDispositionOverlay} aria-label="Cancel">✕</button>
                )}
              </div>

              <div className="billing-overlay-body">
                <div className="action-bar-summary">
                  {dispositionScope ? (
                    <><strong>{dispositionScope.label}</strong> · {dispositionScope.commitmentLineIds.length} line{dispositionScope.commitmentLineIds.length === 1 ? '' : 's'} · {money(dispositionScope.amount)}</>
                  ) : (
                    <><strong>{checkedCount}</strong> item{checkedCount === 1 ? '' : 's'} · {money(checkedTotal)}</>
                  )}
                </div>

                {error && <div className="banner banner-error">{error}</div>}

                {!generating && (
                  <label className="action-bar-field">
                    <span>Notes (optional)</span>
                    <textarea
                      rows={3}
                      value={budgetedNotes}
                      onChange={e => setBudgetedNotes(e.target.value)}
                    />
                  </label>
                )}
              </div>

              <div className="billing-overlay-footer">
                {generating ? (
                  <div className="action-bar-buttons">
                    <button className="draft-btn" disabled>Working…</button>
                  </div>
                ) : (
                  <div className="action-bar-buttons">
                    <button className="draft-btn" onClick={runMarkAsBudgeted}>
                      Confirm — Mark as Budgeted
                    </button>
                    <button className="cancel-btn" onClick={closeDispositionOverlay}>Cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {recon && (
        <div className="warn-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="recon-title">
          <div className="warn-modal">
            <div className="warn-modal-title" id="recon-title">
              Reconcile {recon.c.number}{recon.c.vendor ? ` (${recon.c.vendor})` : ''}
            </div>
            {recon.loading && <p className="warn-modal-text">Checking the sub's invoices in Procore…</p>}
            {recon.data && (
              <>
                <p className="warn-modal-text">
                  This was billed to the client before the sub invoiced it. Here's how the sub's real invoices compare.
                  Edit the adjustment if you need to, then confirm.
                </p>
                <dl className="recon-grid">
                  <dt>Sub invoiced to date ({recon.data.requisitionCount} invoice{recon.data.requisitionCount === 1 ? '' : 's'})</dt>
                  <dd>{money(recon.data.subInvoiced)}</dd>
                  <dt>Cost LEDGER billed the client for</dt><dd>{money(recon.data.billedCost)}</dd>
                  {recon.data.otherCost > 0 && <><dt>Written off / budgeted lines</dt><dd>{money(recon.data.otherCost)}</dd></>}
                  {recon.data.priorAdjustments !== 0 && <><dt>Earlier adjustments (billed)</dt><dd>{money(recon.data.priorAdjustments)}</dd></>}
                  <dt>Markup</dt><dd>{recon.data.markupPercent}%</dd>
                  <dt>Proposed adjustment</dt><dd><strong>{money(recon.data.proposedAmount)}</strong></dd>
                </dl>
                {recon.data.unbilledLineCount > 0 && (
                  <p className="warn-modal-text">
                    {recon.data.unbilledLineCount} line{recon.data.unbilledLineCount === 1 ? '' : 's'} ({money(recon.data.unbilledCost)}) on this
                    commitment {recon.data.unbilledLineCount === 1 ? "isn't" : "aren't"} billed yet and will be billable normally after this.
                    If the sub's invoices already include {recon.data.unbilledLineCount === 1 ? 'it' : 'them'}, take that off the adjustment.
                  </p>
                )}
                <label className="recon-field">
                  <span>Adjustment (incl. markup; negative = credit to the client; 0 = no adjustment)</span>
                  <input type="number" step="0.01" value={recon.amount} onChange={e => setRecon(r => ({ ...r, amount: e.target.value }))} />
                </label>
                {Number(recon.amount) !== 0 && (
                  <>
                    <label className="recon-field">
                      <span>Change Order line description</span>
                      <input type="text" value={recon.description} onChange={e => setRecon(r => ({ ...r, description: e.target.value }))} />
                    </label>
                    {contracts.length > 1 && (
                      <label className="recon-field">
                        <span>Prime Contract</span>
                        <select value={recon.contract} onChange={e => setRecon(r => ({ ...r, contract: e.target.value }))}>
                          <option value="">Pick one…</option>
                          {contracts.map(k => <option key={k.id} value={k.id}>#{k.number ?? k.id} — {k.title || '(untitled)'}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                )}
              </>
            )}
            {recon.error && <p className="warn-modal-text recon-error">{recon.error}</p>}
            <div className="warn-modal-buttons">
              <button className="cancel-btn" onClick={() => setRecon(null)} disabled={recon.saving}>Cancel</button>
              {recon.data && (
                <button
                  className="warn-btn-ok"
                  onClick={confirmReconcile}
                  disabled={recon.saving || (Number(recon.amount) !== 0 && contracts.length > 1 && !recon.contract)}
                >
                  {recon.saving ? 'Working…' : Number(recon.amount) === 0 ? 'Confirm — no adjustment' : 'Create draft Change Order'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {labourWarning && (
        <div className="warn-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="labour-warn-title">
          <div className="warn-modal">
            <div className="warn-modal-title" id="labour-warn-title">{labourWarning.title}</div>
            <p className="warn-modal-text">{labourWarning.text}</p>
            {labourWarning.lines.length > 0 && <ul className="warn-modal-lines">
              {labourWarning.lines.map(l => (
                <li key={l.id}>
                  <span>{l.description || 'Line item'}</span>
                  <span className="warn-modal-amount">{money(l.amount)}</span>
                  {l.tmTicketNumbers?.length > 0 && (
                    <span className="warn-modal-hint">Already on T&amp;M #{l.tmTicketNumbers.join(', #')} — bill it from there.</span>
                  )}
                </li>
              ))}
            </ul>}
            <div className="warn-modal-buttons">
              <button className="warn-btn-ok" autoFocus onClick={() => setLabourWarning(null)}>Okay</button>
              <button
                className="warn-btn-proceed"
                onClick={() => { const { onProceed } = labourWarning; setLabourWarning(null); onProceed(); }}
              >
                Proceed anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
