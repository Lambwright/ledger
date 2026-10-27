import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredToken, verify, hasLedgerAccess, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import { applyAccentPreset } from "./accentPresets.js";
import SourceRecords from "./components/SourceRecords.jsx";
import MultiSelect from "./components/MultiSelect.jsx";
import ColumnPicker from "./components/ColumnPicker.jsx";
import ViewBar from "./components/ViewBar.jsx";
import { BulkBadge, BulkDetail, BulkDialog, hasActiveBatch, reopenMessage } from "./components/BulkReconcile.jsx";

const PROCORE_ORIGIN = "https://us02.procore.com";
// The full LEDGER app (same one as the Procore sidebar), opened standalone on a project.
const LEDGER_APP = "https://ledger-sidebar.pages.dev";

const money = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const pct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const n = (v) => (v == null ? null : Number(v));

function ago(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Projects with no budget reporting view (e.g. Overhead) or no budget set up
// are hidden by default — their margin numbers aren't meaningful.
const isReportable = (p) => p.budget_status === "ok" || p.budget_status === "no_budget";

// Budget-view "Committed costs" minus what subs have invoiced so far.
const commitmentsLeft = (p) =>
  p.committed_costs == null ? null : (n(p.committed_costs) || 0) - (n(p.sub_invoices) || 0);

// Every column the table can show (Ben, 2026-10-06: each person picks, hides
// and orders their own — see ColumnPicker; saved per Einbau ID on the worker).
// Catalogue order = the default order, by importance (Ben, 2026-09-29): margin
// vs budget, LEDGER's record counts, then cost / invoicing / contract / what's
// left. `hidden: true` = available but off until someone turns it on.
// "Project" is always first and can't be hidden.
const noBudgetFor = (p) => p.budget_status === "no_budget";
// Money on cost codes that aren't in the project's budget (2026-10-07): the
// figures shown come from the real records; the budget view only sees what's
// budgeted. Any gap means the budget needs codes added.
function outsideBudget(p) {
  if (p.budget_view_cost == null && p.budget_view_invoiced == null) return null;
  const cost = (n(p.jtd_cost) || 0) - (n(p.budget_view_cost) || 0);
  const invoiced = (n(p.invoiced) || 0) - (n(p.budget_view_invoiced) || 0);
  return Math.abs(cost) >= 1 || Math.abs(invoiced) >= 1 ? { cost, invoiced } : null;
}
const moneyCell = (key, extra = "") => (p) => (
  <td className={`num${extra}${n(p[key]) < 0 ? " neg" : ""}`}>{money(p[key])}</td>
);
const countCell = (key, muted = true) => (p) => (
  <td className={`num${muted ? " cell-muted" : ""}`}>{p[key] ?? "—"}</td>
);

// Estimated billing value (Ben, 2026-10-21), everything to date: T&M hours at
// the project's rates + 20% on non-payroll direct costs and non-labour sub
// invoices. null until all three parts are known (see worker portfolio.js).
const ESTIMATE_MARKUP = 0.2;
function estimatedBilling(p) {
  const tm = n(p.est_tm), dc = n(p.est_dc), sub = n(p.est_sub);
  if (tm == null || dc == null || sub == null) return null;
  return Math.round((tm + (dc + sub) * (1 + ESTIMATE_MARKUP)) * 100) / 100;
}

function stalenessClass(p) {
  const d = n(p.billing_staleness);
  if (d == null) return "";
  return d > 21 ? " neg" : d > 10 ? " warn" : ""; // Ben, 2026-10-21
}

const COLUMN_CATALOG = [
  {
    key: "name", label: "Project", locked: true, sort: (p) => (p.name || "").toLowerCase(),
    cell: (p, { isAdmin }) => (
      <td className="cell-name">
        <div>{p.name}</div>
        <div className="cell-sub">
          {[p.project_number, p.region, p.departments].filter(Boolean).join(" · ")}
          {noBudgetFor(p) && <span className="badge badge-warn">Budget not set up</span>}
          {p.budget_status === "no_view" && <span className="badge badge-muted">No budget view</span>}
          {!p.refreshed_at && <span className="badge badge-muted">Not loaded</span>}
          {outsideBudget(p) && (
            <span
              className="badge badge-warn"
              title={`Not in the budget: ${money(outsideBudget(p).cost)} of cost, ${money(outsideBudget(p).invoiced)} of invoicing. Add the cost codes to the project's budget in Procore.`}
            >
              Not all in budget
            </span>
          )}
          <BulkBadge project={p} isAdmin={isAdmin} />
        </div>
      </td>
    ),
  },
  {
    key: "billing_staleness", label: "Staleness", num: true,
    sort: (p) => n(p.billing_staleness) ?? -1,
    cell: (p) => <td className={`num${stalenessClass(p)}`}>{n(p.billing_staleness) == null ? "—" : `${Math.round(n(p.billing_staleness))} d`}</td>,
  },
  { key: "stage", label: "Stage", sort: (p) => p.stage || "", cell: (p) => <td>{p.stage || "—"}</td> },
  { key: "project_type", label: "Project type", hidden: true, sort: (p) => p.project_type || "", cell: (p) => <td>{p.project_type || "—"}</td> },
  { key: "fiscal_year", label: "Fiscal year", sort: (p) => p.fiscal_year || "", cell: (p) => <td>{p.fiscal_year || "—"}</td> },
  {
    key: "margin_to_date_pct", label: "Margin %", num: true,
    cell: (p) => (
      <td className={`num${marginClass(p)}`} title={p.margin_to_date != null ? `${money(p.margin_to_date)} margin to date` : undefined}>
        {pct(p.margin_to_date_pct)}
      </td>
    ),
  },
  {
    key: "margin_to_date", label: "Margin $", num: true,
    cell: (p) => <td className={`num${marginClass(p)}`}>{money(p.margin_to_date)}</td>,
  },
  {
    key: "budgeted_margin_pct", label: "Budgeted %", num: true,
    cell: (p) => (
      <td className="num cell-muted">
        {noBudgetFor(p) ? "—" : pct(p.budgeted_margin_pct)}
      </td>
    ),
  },
  {
    key: "budgeted_margin", label: "Budgeted margin $", num: true, hidden: true,
    cell: (p) => <td className="num cell-muted">{noBudgetFor(p) ? "—" : money(p.budgeted_margin)}</td>,
  },
  { key: "unbilled_count", label: "Unbilled", num: true, cell: (p) => <td className={`num${n(p.unbilled_count) > 0 ? " cell-key" : ""}`}>{p.unbilled_count ?? "—"}</td> },
  { key: "billed_count", label: "Billed", num: true, cell: countCell("billed_count") },
  { key: "written_off_count", label: "Written off", num: true, cell: countCell("written_off_count") },
  { key: "budgeted_count", label: "Budgeted", num: true, cell: countCell("budgeted_count") },
  { key: "jtd_cost", label: "Cost", num: true, cell: moneyCell("jtd_cost") },
  { key: "direct_costs", label: "Direct costs", num: true, hidden: true, cell: moneyCell("direct_costs") },
  { key: "sub_invoices", label: "Sub invoices", num: true, hidden: true, cell: moneyCell("sub_invoices") },
  { key: "committed_costs", label: "Committed", num: true, hidden: true, cell: moneyCell("committed_costs") },
  { key: "revised_budget", label: "Revised budget", num: true, hidden: true, cell: moneyCell("revised_budget") },
  { key: "invoiced", label: "Invoiced", num: true, cell: moneyCell("invoiced") },
  {
    key: "est_billing", label: "Est. billing value", num: true, sort: (p) => estimatedBilling(p) ?? -Infinity,
    cell: (p) => <td className="num">{money(estimatedBilling(p))}</td>,
  },
  { key: "pct_invoiced", label: "% Invoiced", num: true, hidden: true, cell: (p) => <td className="num">{pct(p.pct_invoiced)}</td> },
  { key: "revised_contract", label: "Contract", num: true, cell: moneyCell("revised_contract") },
  { key: "original_contract", label: "Original contract", num: true, hidden: true, cell: moneyCell("original_contract") },
  {
    key: "invoicing_remaining", label: "Left to invoice", num: true,
    cell: (p) => (
      <td className="num">
        <div className="pct-cell">
          <span>{money(p.invoicing_remaining)}</span>
          {n(p.pct_invoiced) != null && (
            <span className="pct-bar" title={`${pct(p.pct_invoiced)} invoiced`}>
              <span style={{ width: `${Math.min(100, Math.max(0, n(p.pct_invoiced)))}%` }} />
            </span>
          )}
        </div>
      </td>
    ),
  },
  { key: "commitments_left", label: "Commitments left", num: true, sort: commitmentsLeft, cell: (p) => <td className="num">{money(commitmentsLeft(p))}</td> },
  { key: "region", label: "Region", hidden: true, sort: (p) => p.region || "", cell: (p) => <td>{p.region || "—"}</td> },
  { key: "departments", label: "Department", hidden: true, sort: (p) => p.departments || "", cell: (p) => <td>{p.departments || "—"}</td> },
  { key: "refreshed_at", label: "Updated", sort: (p) => (p.refreshed_at ? new Date(p.refreshed_at).getTime() : 0), cell: (p) => <td className="cell-sub">{ago(p.refreshed_at)}</td> },
];
const CATALOG_BY_KEY = new Map(COLUMN_CATALOG.map((c) => [c.key, c]));

// Header tooltips: what each figure is and where it comes from.
const COLUMN_TIPS = {
  billing_staleness: "Billing Staleness (Days), calculated in Procore by Power Automate. Only calculated for projects in active stages, and resets when there's invoicing activity. Amber over 10 days, red over 21",
  stage: "The project's stage in Procore",
  project_type: "The project's type in Procore (e.g. Service Call, Time and Material)",
  fiscal_year: "The project's Fiscal Year field in Procore",
  margin_to_date_pct: "Margin to date: (invoiced − cost) ÷ invoiced. Red below zero, amber behind budgeted, green at or above it",
  margin_to_date: "Margin to date in dollars: invoiced − cost",
  budgeted_margin_pct: "Budgeted margin from the project's budget (its Budgeted Margin column). An approved change order raises it until a matching budget change is entered",
  budgeted_margin: "Planned margin in dollars (see Budgeted %)",
  unbilled_count: "T&M tickets, direct costs and commitments not yet billed, written off or marked budgeted in LEDGER",
  billed_count: "Records billed through LEDGER (or marked Already Billed)",
  written_off_count: "Records written off in LEDGER",
  budgeted_count: "Records marked as budgeted in LEDGER",
  jtd_cost: "Cost to date = direct costs + subcontractor invoices (drafts excluded)",
  direct_costs: "Direct costs in Procore, drafts excluded",
  sub_invoices: "Each commitment's latest subcontractor invoice to date, drafts excluded",
  committed_costs: "Total value of commitments, from the project's budget",
  revised_budget: "The project's budget after approved budget changes",
  invoiced: "Owner invoices to date, before retainage, drafts excluded",
  est_billing: "Estimated billing value to date: every T&M hour at the project's rates + 20% on non-payroll direct costs and on approved sub invoices without labour (no S or L cost-type lines). Blank until LEDGER has worked out all three parts",
  pct_invoiced: "Invoiced ÷ contract",
  revised_contract: "Approved prime contracts, including approved change orders",
  original_contract: "Approved prime contracts before change orders, pass-through contracts excluded",
  invoicing_remaining: "Contract − invoiced",
  commitments_left: "Committed − subcontractor invoices to date: what's still to be paid out on commitments",
  region: "The project's region in Procore",
  departments: "The project's department in Procore",
  refreshed_at: "When LEDGER last refreshed this project from Procore. Click a row to refresh it now",
};

// Default setup: catalogue order, catalogue defaults.
const defaultColumnSetup = () => ({
  order: COLUMN_CATALOG.map((c) => c.key),
  hidden: COLUMN_CATALOG.filter((c) => c.hidden).map((c) => c.key),
});

// A saved setup → the columns to draw. Unknown keys are dropped; columns added
// to the catalogue since someone saved show up in their default position and
// default visibility, so nobody misses a new column.
function resolveColumns(setup) {
  const saved = setup && Array.isArray(setup.order) ? setup.order.filter((k) => CATALOG_BY_KEY.has(k)) : null;
  if (!saved) return COLUMN_CATALOG.filter((c) => !c.hidden);
  const order = [...saved];
  COLUMN_CATALOG.forEach((c, i) => {
    if (!order.includes(c.key)) {
      const before = COLUMN_CATALOG.slice(0, i).map((x) => x.key).filter((k) => order.includes(k)).pop();
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, c.key);
    }
  });
  const known = new Set(saved);
  const hidden = new Set((setup.hidden || []).filter((k) => CATALOG_BY_KEY.has(k)));
  COLUMN_CATALOG.forEach((c) => { if (!known.has(c.key) && c.hidden) hidden.add(c.key); });
  const ordered = ["name", ...order.filter((k) => k !== "name")];
  return ordered.map((k) => CATALOG_BY_KEY.get(k)).filter((c) => c.locked || !hidden.has(c.key));
}

// Margin % coloured against the project's own budget: red below zero,
// amber when trailing budget, green at or above it.
function marginClass(p) {
  const mtd = n(p.margin_to_date_pct);
  if (mtd == null) return "";
  if (mtd < 0) return " neg";
  const budgeted = p.budget_status === "ok" ? n(p.budgeted_margin_pct) : null;
  if (budgeted == null) return "";
  return mtd >= budgeted ? " pos" : " warn";
}

function uniqueValues(projects, key) {
  const set = new Set();
  for (const p of projects) {
    for (const v of String(p[key] || "").split(", ").filter(Boolean)) set.add(v);
  }
  return [...set].sort();
}

const DEFAULT_SORT = { key: "invoicing_remaining", dir: "desc" };

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | noaccess | in
  const [user, setUser] = useState(null);

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState(() => new Set()); // empty = all stages
  const [fiscalFilter, setFiscalFilter] = useState(() => new Set()); // empty = all fiscal years
  const [typeFilter, setTypeFilter] = useState(() => new Set()); // empty = all project types
  const [region, setRegion] = useState("");
  const [dept, setDept] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState(""); // "" | "open" | "done"
  const [sort, setSort] = useState(DEFAULT_SORT);

  // Keep --header-h = the sticky page header's height (see .portfolio-scroll).
  useEffect(() => {
    const header = document.querySelector(".header");
    if (!header) return undefined;
    const set = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(header);
    return () => observer.disconnect();
  }, [authState]); // the header only exists once signed in

  const [openId, setOpenId] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [countingIds, setCountingIds] = useState(() => new Set());

  // Bulk reconciliation (LEDGER admins only — the worker checks it too).
  const [isAdmin, setIsAdmin] = useState(false);
  const [canSourceRecords, setCanSourceRecords] = useState(false); // every LEDGER level (read-only)
  const [canPublishViews, setCanPublishViews] = useState(false); // admin or the publish_views tool
  // This person's column setup ({order, hidden}); null = the default.
  const [columnSetup, setColumnSetup] = useState(null);
  // Saved views (ViewBar). "My default" keeps the auto-saved column setup and
  // the department default; a picked view brings its own columns, filters, sort.
  const [personalViews, setPersonalViews] = useState([]);
  const [sharedViews, setSharedViews] = useState([]);
  const [activeView, setActiveView] = useState(""); // "" | "p:<id>" | "s:<id>"
  const [viewBusy, setViewBusy] = useState(false);
  const defaultColumns = useRef(null); // the "My default" column setup
  const viewRestored = useRef(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [reopeningId, setReopeningId] = useState(null);

  function signIn(u) {
    setUser(u);
    // Personal LEDGER colour from HELM (My Account → Appearance), if set.
    applyAccentPreset(u?.themeAccent?.LEDGER || null);
    setAuthState(hasLedgerAccess(u) ? "in" : "noaccess");
  }

  const handleLogout = useCallback(() => {
    doLogout();
    // The next person to sign in gets their own department default.
    deptDefaulted.current = false;
    viewRestored.current = false;
    setActiveView("");
    setDept("");
    applyAccentPreset(null);
    setUser(null);
    setProjects([]);
    setAuthState("out");
  }, []);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthState("out");
      return;
    }
    verify(token).then((data) => (data.valid ? signIn(data.user) : setAuthState("out")));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .list()
      .then((data) => {
        setProjects(data.projects || []);
        // Bulk reconcile is a HELM tool permission (admins always have it).
        setIsAdmin(data.canBulkReconcile === true || (data.canBulkReconcile === undefined && data.isLedgerAdmin === true));
        setCanPublishViews(data.canPublishViews === true || (data.canPublishViews === undefined && data.isLedgerAdmin === true));
        setCanSourceRecords(data.canSourceRecords === true);
        defaultColumns.current = data.prefs?.portfolio_columns || null;
        setPersonalViews(Array.isArray(data.prefs?.portfolio_views) ? data.prefs.portfolio_views : []);
        setSharedViews(Array.isArray(data.sharedViews) ? data.sharedViews : []);
        if (!viewRestored.current) {
          viewRestored.current = true;
          const last = typeof data.prefs?.portfolio_active_view === "string" ? data.prefs.portfolio_active_view : "";
          const found = last.startsWith("s:")
            ? (data.sharedViews || []).find((v) => `s:${v.id}` === last)
            : last.startsWith("p:")
            ? (data.prefs?.portfolio_views || []).find((v) => `p:${v.id}` === last)
            : null;
          if (found) {
            deptDefaulted.current = true; // the view's own filters win
            setActiveView(last);
            applyViewConfig(found.config);
          } else {
            setColumnSetup(defaultColumns.current);
          }
        }
      })
      .catch((e) => (e.unauthorized ? handleLogout() : setError(e.message)))
      .finally(() => setLoading(false));
  }, [handleLogout]);

  useEffect(() => {
    if (authState === "in") load();
  }, [authState, load]);

  const mergeProject = (project) =>
    project && setProjects((prev) => prev.map((p) => (p.project_id === project.project_id ? { ...p, ...project } : p)));

  // Money figures first (seconds), then the record recount (can take minutes
  // on a project with many billed commitments) — the row is usable meanwhile.
  async function refreshProject(id) {
    setRefreshingId(id);
    setError(null);
    try {
      mergeProject((await api.refreshProject(id)).project);
    } catch (e) {
      if (e.unauthorized) handleLogout();
      else setError(e.message);
      return;
    } finally {
      setRefreshingId(null);
    }
    setCountingIds((prev) => new Set(prev).add(id));
    try {
      mergeProject((await api.refreshCounts(id)).project);
    } catch (e) {
      if (e.unauthorized) handleLogout();
      else setError(e.message);
    } finally {
      setCountingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const stages = useMemo(() => uniqueValues(projects, "stage"), [projects]);
  const projectTypes = useMemo(() => {
    const shown = projects.filter((p) => showAll || isReportable(p));
    const values = uniqueValues(shown, "project_type");
    return shown.some((p) => !p.project_type) ? [...values, "(none)"] : values;
  }, [projects, showAll]);
  // Fiscal year options: the values on the projects shown, never a typed list.
  const fiscalYears = useMemo(() => {
    const shown = projects.filter((p) => showAll || isReportable(p));
    const values = uniqueValues(shown, "fiscal_year");
    return shown.some((p) => !p.fiscal_year) ? [...values, "(none)"] : values;
  }, [projects, showAll]);
  const regions = useMemo(() => uniqueValues(projects, "region"), [projects]);
  // Department options come from the projects actually shown (Ben, 2026-10-06):
  // never a hand-typed list, never a department that would filter to nothing.
  const depts = useMemo(
    () => uniqueValues(projects.filter((p) => showAll || isReportable(p)), "departments"),
    [projects, showAll]
  );
  // The signed-in person's Procore department (Einbau ID user.fields.department,
  // set in HELM). The page opens filtered to it — a default, not a restriction.
  const myDept = user?.fields?.department && !user.fields.department.missing ? user.fields.department.name : null;
  const myDeptOption = myDept ? depts.find((d) => d.trim().toLowerCase() === myDept.trim().toLowerCase()) || null : null;
  const deptDefaulted = useRef(false);
  useEffect(() => {
    if (deptDefaulted.current || projects.length === 0) return;
    deptDefaulted.current = true;
    if (myDeptOption) setDept(myDeptOption);
  }, [projects, myDeptOption]);
  // A picked department that no longer has shown projects is cleared.
  useEffect(() => {
    if (dept && !depts.includes(dept)) setDept("");
  }, [dept, depts]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const col = CATALOG_BY_KEY.get(sort.key);
    const valueOf = col?.sort || ((p) => n(p[sort.key]));
    return projects
      .filter((p) => showAll || isReportable(p))
      .filter((p) => {
        if (!invoiceFilter) return true;
        const done = n(p.pct_invoiced) != null && n(p.pct_invoiced) >= 100;
        return invoiceFilter === "done" ? done : !done;
      })
      .filter((p) => stageFilter.size === 0 || stageFilter.has(p.stage))
      .filter((p) => fiscalFilter.size === 0 || fiscalFilter.has(p.fiscal_year || "(none)"))
      .filter((p) => typeFilter.size === 0 || typeFilter.has(p.project_type || "(none)"))
      .filter((p) => !region || p.region === region)
      .filter((p) => !dept || String(p.departments || "").split(", ").includes(dept))
      .filter((p) => !q || `${p.name} ${p.project_number || ""}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const va = valueOf(a);
        const vb = valueOf(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // blanks always last
        if (vb == null) return -1;
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sort.dir === "asc" ? cmp : -cmp;
      });
  }, [projects, search, stageFilter, fiscalFilter, typeFilter, region, dept, showAll, invoiceFilter, sort]);

  // Headline figures always match the projects currently shown (Ben, 2026-09-29).
  const totals = useMemo(() => {
    const sumOf = (list, key) => list.reduce((s, p) => s + (n(typeof key === "function" ? key(p) : p[key]) || 0), 0);
    const contract = sumOf(visible, "revised_contract");
    const invoiced = sumOf(visible, "invoiced");
    const mtd = sumOf(visible, "margin_to_date");
    // Budgeted margin only from projects that actually have a budget — one
    // with no revised budget reports a meaningless 100%.
    const budgetedProjects = visible.filter((p) => p.budget_status === "ok");
    // Each project's budgeted margin is measured against the budget's own contract.
    const basisContract = (p) => p.budget_view_contract ?? p.revised_contract;
    const budgetedContract = sumOf(budgetedProjects, basisContract);
    const counted = visible.filter((p) => p.counts_at);
    return {
      contract, invoiced, mtd,
      mtdPct: invoiced ? (mtd / invoiced) * 100 : null,
      budgetedPct: budgetedContract ? (sumOf(budgetedProjects, "budgeted_margin") / budgetedContract) * 100 : null,
      remaining: sumOf(visible, "invoicing_remaining"),
      jtd: sumOf(visible, "jtd_cost"),
      commitmentsLeft: sumOf(visible, commitmentsLeft),
      pctInvoiced: contract ? (invoiced / contract) * 100 : null,
      unbilled: sumOf(counted, "unbilled_count"),
      billed: sumOf(counted, "billed_count"),
      writtenOff: sumOf(counted, "written_off_count"),
      budgeted: sumOf(counted, "budgeted_count"),
      countedProjects: counted.length,
    };
  }, [visible]);
  const marginGap = totals.mtdPct != null && totals.budgetedPct != null ? totals.mtdPct - totals.budgetedPct : null;

  const hiddenCount = projects.length - projects.filter(isReportable).length;
  const notLoaded = projects.filter((p) => !p.refreshed_at).length;

  // Opening a project refreshes it from Procore (Ben's ask 2026-09-25) —
  // skipped if it was refreshed in the last 2 minutes, to spare the rate limit.
  function toggleOpen(p) {
    if (openId === p.project_id) {
      setOpenId(null);
      return;
    }
    setOpenId(p.project_id);
    const fresh = p.refreshed_at && p.counts_at && Date.now() - new Date(p.refreshed_at).getTime() < 2 * 60 * 1000;
    if (!fresh && refreshingId !== p.project_id && !countingIds.has(p.project_id)) refreshProject(p.project_id);
  }

  const selectable = visible.filter((p) => !hasActiveBatch(p));
  const selectedProjects = projects.filter((p) => selected.has(p.project_id));
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.project_id));
  const visibleColumns = resolveColumns(columnSetup);
  const colCount = visibleColumns.length + (isAdmin ? 1 : 0);

  // Saved straight away; a failed save keeps the change on screen and says so.
  // On "My default" a column change saves straight away; inside a view it
  // stays on screen until the view is saved.
  function changeColumns(next) {
    setColumnSetup(next);
    if (activeView) return;
    defaultColumns.current = next;
    api.savePrefs("portfolio_columns", next).catch((e) => setError(`Couldn't save your columns: ${e.message}`));
  }

  // ---- Saved views ----
  const currentConfig = {
    columns: columnSetup || defaultColumnSetup(),
    filters: {
      stages: [...stageFilter].sort(), fiscal: [...fiscalFilter].sort(), types: [...typeFilter].sort(),
      region, dept, invoice: invoiceFilter, showAll,
    },
    sort,
  };
  function normalizedConfig(cfg) {
    const f = cfg?.filters || {};
    return JSON.stringify({
      columns: cfg?.columns || defaultColumnSetup(),
      filters: {
        stages: [...(f.stages || [])].sort(), fiscal: [...(f.fiscal || [])].sort(), types: [...(f.types || [])].sort(),
        region: f.region || "", dept: f.dept || "", invoice: f.invoice || "", showAll: !!f.showAll,
      },
      sort: cfg?.sort || DEFAULT_SORT,
    });
  }
  function applyViewConfig(cfg) {
    const f = cfg?.filters || {};
    setColumnSetup(cfg?.columns || null);
    setStageFilter(new Set(f.stages || []));
    setFiscalFilter(new Set(f.fiscal || []));
    setTypeFilter(new Set(f.types || []));
    setRegion(f.region || "");
    setDept(f.dept || "");
    setInvoiceFilter(f.invoice || "");
    setShowAll(!!f.showAll);
    setSort(cfg?.sort || DEFAULT_SORT);
  }
  const activeViewObj = activeView.startsWith("s:")
    ? sharedViews.find((v) => `s:${v.id}` === activeView)
    : activeView.startsWith("p:")
    ? personalViews.find((v) => `p:${v.id}` === activeView)
    : null;
  const viewDirty = !!activeViewObj && normalizedConfig(activeViewObj.config) !== normalizedConfig(currentConfig);

  function rememberActive(value) {
    api.savePrefs("portfolio_active_view", value).catch(() => {});
  }
  function selectView(value) {
    setActiveView(value);
    rememberActive(value);
    if (!value) {
      // My default: saved columns, no filters except your department.
      applyViewConfig({ columns: defaultColumns.current, filters: { dept: myDeptOption || "" }, sort: DEFAULT_SORT });
      return;
    }
    const v = value.startsWith("s:")
      ? sharedViews.find((x) => `s:${x.id}` === value)
      : personalViews.find((x) => `p:${x.id}` === value);
    if (v) applyViewConfig(v.config);
  }
  async function savePersonal(list) {
    setPersonalViews(list);
    await api.savePrefs("portfolio_views", list);
  }
  async function viewAction(fn) {
    setViewBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e.unauthorized) handleLogout();
      else setError(`Couldn't save the view: ${e.message}`);
    } finally {
      setViewBusy(false);
    }
  }
  function saveView() {
    viewAction(async () => {
      if (activeView.startsWith("s:")) {
        const v = activeViewObj;
        await api.saveSharedView({ id: v.id, name: v.name, config: currentConfig });
        setSharedViews((prev) => prev.map((x) => (x.id === v.id ? { ...x, config: currentConfig, updated_by: user?.username } : x)));
        setNotice(`Saved “${v.name}” for everyone.`);
      } else {
        await savePersonal(personalViews.map((x) => (`p:${x.id}` === activeView ? { ...x, config: currentConfig } : x)));
        setNotice("View saved.");
      }
    });
  }
  function saveAsNew() {
    const name = window.prompt("Name this view (only you will see it):", activeViewObj ? `${activeViewObj.name} (copy)` : "");
    if (!name || !name.trim()) return;
    viewAction(async () => {
      const id = crypto.randomUUID();
      await savePersonal([...personalViews, { id, name: name.trim().slice(0, 60), config: currentConfig }]);
      setActiveView(`p:${id}`);
      rememberActive(`p:${id}`);
      setNotice(`Saved “${name.trim()}” to your views.`);
    });
  }
  function shareAsNew() {
    const name = window.prompt("Name this standard view (everyone will see it):", "");
    if (!name || !name.trim()) return;
    viewAction(async () => {
      const res = await api.saveSharedView({ name: name.trim(), config: currentConfig });
      setSharedViews((prev) => [...prev, { id: res.id, name: res.name, config: currentConfig, updated_by: user?.username }]
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
      setActiveView(`s:${res.id}`);
      rememberActive(`s:${res.id}`);
      setNotice(`Published “${res.name}” as a standard view for everyone.`);
    });
  }
  function deleteView() {
    const v = activeViewObj;
    if (!v) return;
    const shared = activeView.startsWith("s:");
    if (!window.confirm(shared ? `Delete the standard view “${v.name}” for everyone?` : `Delete your view “${v.name}”?`)) return;
    viewAction(async () => {
      if (shared) {
        await api.deleteSharedView(v.id);
        setSharedViews((prev) => prev.filter((x) => x.id !== v.id));
      } else {
        await savePersonal(personalViews.filter((x) => x.id !== v.id));
      }
      selectView("");
    });
  }

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.project_id)));
  }

  async function queueBulk({ disposition, notes, invoiceNumber }) {
    const res = await api.bulkReconcile({ projectIds: selectedProjects.map((p) => p.project_id), disposition, notes, invoiceNumber });
    setBulkOpen(false);
    setSelected(new Set());
    setNotice(
      `Queued ${res.queued} project${res.queued === 1 ? "" : "s"}` +
      (res.skipped ? ` (${res.skipped} skipped — already reconciled or queued)` : "") +
      ". They're worked through in the background, one at a time, pausing whenever someone is using LEDGER."
    );
    load();
  }

  async function reopen(p) {
    if (!window.confirm(reopenMessage(p))) return;
    setReopeningId(p.project_id);
    setError(null);
    try {
      const res = await api.reopenProject(p.project_id);
      setNotice(res.cancelled ? `Cancelled the queued reconciliation for ${p.name}.` : `Reopened ${p.name} — ${res.reverted} record(s) back to Unbilled.`);
      load();
    } catch (e) {
      if (e.unauthorized) handleLogout();
      else setError(e.message);
    } finally {
      setReopeningId(null);
    }
  }

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  if (authState === "checking") {
    return <div className="login-screen"><span className="spinner-inline">Checking session…</span></div>;
  }
  if (authState === "out") return <LoginScreen onLoggedIn={signIn} />;
  if (authState === "noaccess") {
    return (
      <>
        <Header user={user} onLogout={handleLogout} />
        <div className="container">
          <div className="card empty-state">
            You don't have access to LEDGER — ask your admin to grant it.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header user={user} onLogout={handleLogout} />
      <div className="container container-wide">
        <div className="hero-row">
          <div className="stat stat-hero">
            <span className="stat-label">Margin to date vs budgeted</span>
            <div className="margin-compare">
              <div>
                <span className={`stat-big${n(totals.mtdPct) < 0 ? " neg" : ""}`}>{pct(totals.mtdPct)}</span>
                <span className="stat-caption">to date · {money(totals.mtd)}</span>
              </div>
              <span className="margin-vs">vs</span>
              <div>
                <span className="stat-big stat-big-muted">{pct(totals.budgetedPct)}</span>
                <span className="stat-caption">budgeted</span>
              </div>
              {marginGap != null && (
                <span className={`gap-chip ${marginGap >= 0 ? "gap-up" : "gap-down"}`}>
                  {marginGap >= 0 ? "▲" : "▼"} {Math.abs(marginGap).toFixed(1)} pts
                </span>
              )}
            </div>
          </div>
          <div className="stat stat-hero">
            <span className="stat-label">LEDGER records</span>
            <div className="record-counts">
              <div className="record-count record-count-key"><span className="stat-big">{totals.unbilled.toLocaleString()}</span><span className="stat-caption">unbilled</span></div>
              <div className="record-count"><span className="stat-big stat-big-muted">{totals.billed.toLocaleString()}</span><span className="stat-caption">billed</span></div>
              <div className="record-count"><span className="stat-big stat-big-muted">{totals.writtenOff.toLocaleString()}</span><span className="stat-caption">written off</span></div>
              <div className="record-count"><span className="stat-big stat-big-muted">{totals.budgeted.toLocaleString()}</span><span className="stat-caption">budgeted</span></div>
            </div>
            <span className="stat-caption">T&amp;M tickets, direct costs and commitments · counted on {totals.countedProjects} of {visible.length} projects</span>
          </div>
        </div>
        <div className="summary-row">
          <div className="stat"><span className="stat-label">Total costs</span><span className="stat-value">{money(totals.jtd)}</span></div>
          <div className="stat"><span className="stat-label">Total invoiced</span><span className="stat-value">{money(totals.invoiced)}</span><span className="stat-sub">{pct(totals.pctInvoiced)} of contract</span></div>
          <div className="stat"><span className="stat-label">Contract value</span><span className="stat-value">{money(totals.contract)}</span></div>
          <div className="stat"><span className="stat-label">Left to invoice</span><span className="stat-value">{money(totals.remaining)}</span></div>
          <div className="stat"><span className="stat-label">Commitments left to pay</span><span className="stat-value">{money(totals.commitmentsLeft)}</span></div>
        </div>

        <ViewBar
          personalViews={personalViews}
          sharedViews={sharedViews}
          value={activeView}
          onSelect={selectView}
          dirty={viewDirty}
          isAdmin={canPublishViews}
          busy={viewBusy}
          onSave={saveView}
          onSaveAsNew={saveAsNew}
          onShareAsNew={shareAsNew}
          onDelete={deleteView}
        />
        <div className="filters">
          <input className="filter-search" placeholder="Search project name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
          <MultiSelect label="Stage" allLabel="All stages" options={stages} selected={stageFilter} onChange={setStageFilter} />
          <MultiSelect label="Fiscal year" allLabel="All fiscal years" options={fiscalYears} selected={fiscalFilter} onChange={setFiscalFilter} />
          <MultiSelect label="Project type" allLabel="All project types" options={projectTypes} selected={typeFilter} onChange={setTypeFilter} />
          <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
            <option value="">All regions</option>
            {regions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {depts.map((s) => <option key={s} value={s}>{s === myDeptOption ? `${s} (yours)` : s}</option>)}
          </select>
          <select value={invoiceFilter} onChange={(e) => setInvoiceFilter(e.target.value)} aria-label="Invoicing">
            <option value="">All invoicing</option>
            <option value="open">Not fully invoiced</option>
            <option value="done">Fully invoiced</option>
          </select>
          <label className="filter-toggle" title="Overhead projects, projects without the Custom Reporting budget view, and projects not loaded yet">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show {hiddenCount} hidden (no budget view or not loaded yet)
          </label>
          <ColumnPicker
            catalog={COLUMN_CATALOG}
            setup={columnSetup || defaultColumnSetup()}
            onChange={changeColumns}
            onReset={() => changeColumns(defaultColumnSetup())}
          />
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
        </div>

        <div className="freshness">
          {visible.length} project{visible.length === 1 ? "" : "s"} shown. Contract, invoicing and cost come from
          Procore's records; budget and commitments from the project's budget (Custom Reporting View). All as of the
          "Updated" time; open a project for a live refresh. Hover a column heading for what it means.
          {notLoaded > 0 && ` ${notLoaded} project${notLoaded === 1 ? " hasn't" : "s haven't"} been loaded yet.`}
          {" "}Budgeted % is the budget's own Budgeted Margin.
        </div>

        {error && <div className="banner-error">{error}</div>}
        {notice && (
          <div className="banner-ok">
            {notice}
            <button type="button" className="banner-close" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
          </div>
        )}

        {isAdmin && selected.size > 0 && (
          <div className="selection-bar">
            <span>
              <strong>{selected.size}</strong> project{selected.size === 1 ? "" : "s"} selected ·{" "}
              {selectedProjects.reduce((s, p) => s + (n(p.unbilled_count) || 0), 0).toLocaleString()} unbilled records
            </span>
            <button className="btn btn-accent btn-sm" onClick={() => setBulkOpen(true)}>Mark reconciled…</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        {bulkOpen && (
          <BulkDialog projects={selectedProjects} onCancel={() => setBulkOpen(false)} onConfirm={queueBulk} />
        )}

        <div className="table-wrap portfolio-scroll">
          <table className="table portfolio-table">
            <thead>
              <tr>
                {isAdmin && (
                  <th className="cell-select">
                    <input type="checkbox" aria-label="Select all shown projects" checked={allSelected} onChange={toggleSelectAll} />
                  </th>
                )}
                {visibleColumns.map((c) => (
                  <th key={c.key} className={c.num ? "num" : ""} title={COLUMN_TIPS[c.key]} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className="th-sort" onClick={() => toggleSort(c.key)}>
                      {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const noBudget = p.budget_status === "no_budget";
                const isOpen = openId === p.project_id;
                return [
                  <tr key={p.project_id} className={`row-click${isOpen ? " row-open" : ""}`} onClick={() => toggleOpen(p)}>
                    {isAdmin && (
                      <td className="cell-select" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${p.name}`}
                          disabled={hasActiveBatch(p)}
                          title={hasActiveBatch(p) ? "Already reconciled or queued — reopen it first" : undefined}
                          checked={selected.has(p.project_id)}
                          onChange={() => toggleSelected(p.project_id)}
                        />
                      </td>
                    )}
                    {visibleColumns.map((c) => <Fragment key={c.key}>{c.cell(p, { isAdmin })}</Fragment>)}
                  </tr>,
                  isOpen && (
                    <tr key={`${p.project_id}-detail`} className="detail-row">
                      <td colSpan={colCount}>
                        <div className="detail">
                          <BulkDetail project={p} isAdmin={isAdmin} onReopen={reopen} busy={reopeningId === p.project_id} />
                          <dl className="detail-grid">
                            <dt>Direct costs</dt><dd>{money(p.direct_costs)}</dd>
                            <dt>+ Subcontractor invoices</dt><dd>{money(p.sub_invoices)}</dd>
                            <dt className="detail-total">= Cost to date</dt><dd className="detail-total">{money(p.jtd_cost)}</dd>
                            <dt>Committed costs</dt><dd>{money(p.committed_costs)}</dd>
                            <dt>Revised budget</dt><dd>{money(p.revised_budget)}</dd>
                          </dl>
                          <dl className="detail-grid">
                            <dt>Unbilled records</dt><dd>{p.unbilled_count ?? "—"}</dd>
                            <dt>Billed records</dt><dd>{p.billed_count ?? "—"}</dd>
                            <dt>Budgeted records</dt><dd>{p.budgeted_count ?? "—"}</dd>
                            <dt>Written off records</dt><dd>{p.written_off_count ?? "—"}</dd>
                          </dl>
                          <div className="cell-sub">
                            Records are T&amp;M tickets, direct costs and commitments; one partly billed counts in more than one column.
                            {countingIds.has(p.project_id)
                              ? " Recounting from Procore… (a minute or two on big projects)"
                              : p.counts_at ? ` Counted ${ago(p.counts_at)}.` : " Not counted yet."}
                          </div>
                          {noBudget && (
                            <div className="detail-note">
                              This project's budget has no revised budget amount, so budgeted margin isn't meaningful yet.
                            </div>
                          )}
                          {p.refresh_error && <div className="detail-note detail-error">{p.refresh_error}</div>}
                          {canSourceRecords && <SourceRecords projectId={p.project_id} onUnauthorized={handleLogout} />}
                          <div className="detail-actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={refreshingId === p.project_id || countingIds.has(p.project_id)}
                              onClick={(e) => { e.stopPropagation(); refreshProject(p.project_id); }}
                            >
                              {refreshingId === p.project_id ? "Refreshing…" : "Refresh from Procore"}
                            </button>
                            <a className="btn btn-accent btn-sm" href={`${LEDGER_APP}/?project_id=${p.project_id}`} target="_blank" rel="noreferrer">
                              Open in LEDGER ↗
                            </a>
                            <a className="btn btn-ghost btn-sm" href={`${PROCORE_ORIGIN}/${p.project_id}/project/home`} target="_blank" rel="noreferrer">
                              Open in Procore ↗
                            </a>
                            <span className="cell-sub">Updated {ago(p.refreshed_at)}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={colCount} className="empty-state">No projects match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
