import { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredToken, verify, hasLedgerAccess, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import { applyAccentPreset } from "./accentPresets.js";
import SourceRecords from "./components/SourceRecords.jsx";
import MultiSelect from "./components/MultiSelect.jsx";

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

// Ordered by importance (Ben, 2026-09-29): margin vs budget, LEDGER's record
// counts, then cost / invoicing / contract / what's left.
const COLUMNS = [
  { key: "name", label: "Project", sort: (p) => (p.name || "").toLowerCase() },
  { key: "stage", label: "Stage", sort: (p) => p.stage || "" },
  { key: "margin_to_date_pct", label: "Margin %", num: true },
  { key: "budgeted_margin_pct", label: "Budgeted %", num: true },
  { key: "unbilled_count", label: "Unbilled", num: true },
  { key: "billed_count", label: "Billed", num: true },
  { key: "written_off_count", label: "Written off", num: true },
  { key: "budgeted_count", label: "Budgeted", num: true },
  { key: "jtd_cost", label: "Cost", num: true },
  { key: "invoiced", label: "Invoiced", num: true },
  { key: "revised_contract", label: "Contract", num: true },
  { key: "invoicing_remaining", label: "Left to invoice", num: true },
  { key: "commitments_left", label: "Commitments left", num: true, sort: commitmentsLeft },
  { key: "refreshed_at", label: "Updated", sort: (p) => (p.refreshed_at ? new Date(p.refreshed_at).getTime() : 0) },
];

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

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | noaccess | in
  const [user, setUser] = useState(null);

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState(() => new Set()); // empty = all stages
  const [region, setRegion] = useState("");
  const [dept, setDept] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState(""); // "" | "open" | "done"
  const [sort, setSort] = useState({ key: "invoicing_remaining", dir: "desc" });

  const [openId, setOpenId] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);

  function signIn(u) {
    setUser(u);
    // Personal LEDGER colour from HELM (My Account → Appearance), if set.
    applyAccentPreset(u?.themeAccent?.LEDGER || null);
    setAuthState(hasLedgerAccess(u) ? "in" : "noaccess");
  }

  const handleLogout = useCallback(() => {
    doLogout();
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
      .then((data) => setProjects(data.projects || []))
      .catch((e) => (e.unauthorized ? handleLogout() : setError(e.message)))
      .finally(() => setLoading(false));
  }, [handleLogout]);

  useEffect(() => {
    if (authState === "in") load();
  }, [authState, load]);

  async function refreshProject(id) {
    setRefreshingId(id);
    setError(null);
    try {
      const { project } = await api.refreshProject(id);
      if (project) setProjects((prev) => prev.map((p) => (p.project_id === project.project_id ? project : p)));
    } catch (e) {
      if (e.unauthorized) handleLogout();
      else setError(e.message);
    } finally {
      setRefreshingId(null);
    }
  }

  const stages = useMemo(() => uniqueValues(projects, "stage"), [projects]);
  const regions = useMemo(() => uniqueValues(projects, "region"), [projects]);
  const depts = useMemo(() => uniqueValues(projects, "departments"), [projects]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const col = COLUMNS.find((c) => c.key === sort.key);
    const valueOf = col?.sort || ((p) => n(p[sort.key]));
    return projects
      .filter((p) => showAll || isReportable(p))
      .filter((p) => {
        if (!invoiceFilter) return true;
        const done = n(p.pct_invoiced) != null && n(p.pct_invoiced) >= 100;
        return invoiceFilter === "done" ? done : !done;
      })
      .filter((p) => stageFilter.size === 0 || stageFilter.has(p.stage))
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
  }, [projects, search, stageFilter, region, dept, showAll, invoiceFilter, sort]);

  // Headline figures always match the projects currently shown (Ben, 2026-09-29).
  const totals = useMemo(() => {
    const sumOf = (list, key) => list.reduce((s, p) => s + (n(typeof key === "function" ? key(p) : p[key]) || 0), 0);
    const contract = sumOf(visible, "revised_contract");
    const invoiced = sumOf(visible, "invoiced");
    const mtd = sumOf(visible, "margin_to_date");
    // Budgeted margin only from projects that actually have a budget — one
    // with no revised budget reports a meaningless 100%.
    const budgetedProjects = visible.filter((p) => p.budget_status === "ok");
    // Each project's budgeted margin is measured against its original quote
    // until its budget changes, then against the revised contract.
    const basisContract = (p) => (p.budget_basis === "original" ? p.original_contract : p.revised_contract);
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
    if (!fresh && refreshingId !== p.project_id) refreshProject(p.project_id);
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
            Your Einbau ID doesn't have LEDGER access yet. Ask an admin to grant it in HELM.
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

        <div className="filters">
          <input className="filter-search" placeholder="Search project name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
          <MultiSelect label="Stage" allLabel="All stages" options={stages} selected={stageFilter} onChange={setStageFilter} />
          <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
            <option value="">All regions</option>
            {regions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {depts.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={invoiceFilter} onChange={(e) => setInvoiceFilter(e.target.value)} aria-label="Invoicing">
            <option value="">All invoicing</option>
            <option value="open">Not fully invoiced</option>
            <option value="done">Fully invoiced</option>
          </select>
          <label className="filter-toggle" title="Overhead projects, projects without the Custom Reporting budget view, and projects not loaded yet">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show {hiddenCount} hidden (no budget view or not loaded yet)
          </label>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
        </div>

        <div className="freshness">
          {visible.length} project{visible.length === 1 ? "" : "s"} shown. Figures come from each project's budget
          (Custom Reporting View) as of the "Updated" time; open a project for a live refresh.
          {notLoaded > 0 && ` ${notLoaded} project${notLoaded === 1 ? " hasn't" : "s haven't"} been loaded yet.`}
          {" "}Budgeted % marked Q is the original quote (original contract vs original budget, pass-through contracts
          excluded), held until the project's budget changes.
        </div>

        {error && <div className="banner-error">{error}</div>}

        <div className="table-wrap">
          <table className="table portfolio-table">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.num ? "num" : ""} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
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
                    <td className="cell-name">
                      <div>{p.name}</div>
                      <div className="cell-sub">
                        {[p.project_number, p.region, p.departments].filter(Boolean).join(" · ")}
                        {noBudget && <span className="badge badge-warn">Budget not set up</span>}
                        {p.budget_status === "no_view" && <span className="badge badge-muted">No budget view</span>}
                        {!p.refreshed_at && <span className="badge badge-muted">Not loaded</span>}
                      </div>
                    </td>
                    <td>{p.stage || "—"}</td>
                    <td className={`num${marginClass(p)}`} title={p.margin_to_date != null ? `${money(p.margin_to_date)} margin to date` : undefined}>
                      {pct(p.margin_to_date_pct)}
                    </td>
                    <td
                      className="num cell-muted"
                      title={p.budget_basis === "original"
                        ? `Original quote: ${money(p.original_contract)} contract vs ${money(p.original_budget)} budget (no budget changes yet)`
                        : p.budget_basis === "live" ? "Live budget (budget changes have been made)" : undefined}
                    >
                      {noBudget ? "—" : pct(p.budgeted_margin_pct)}
                      {!noBudget && p.budget_basis === "original" && <span className="basis-mark">Q</span>}
                    </td>
                    <td className={`num${n(p.unbilled_count) > 0 ? " cell-key" : ""}`}>{p.unbilled_count ?? "—"}</td>
                    <td className="num cell-muted">{p.billed_count ?? "—"}</td>
                    <td className="num cell-muted">{p.written_off_count ?? "—"}</td>
                    <td className="num cell-muted">{p.budgeted_count ?? "—"}</td>
                    <td className="num">{money(p.jtd_cost)}</td>
                    <td className="num">{money(p.invoiced)}</td>
                    <td className="num">{money(p.revised_contract)}</td>
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
                    <td className="num">{money(commitmentsLeft(p))}</td>
                    <td className="cell-sub">{ago(p.refreshed_at)}</td>
                  </tr>,
                  isOpen && (
                    <tr key={`${p.project_id}-detail`} className="detail-row">
                      <td colSpan={COLUMNS.length}>
                        <div className="detail">
                          <dl className="detail-grid">
                            <dt>Direct costs</dt><dd>{money(p.direct_costs)}</dd>
                            <dt>Subcontractor invoices</dt><dd>{money(p.sub_invoices)}</dd>
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
                            {p.counts_at ? ` Counted ${ago(p.counts_at)}.` : " Not counted yet."}
                          </div>
                          {noBudget && (
                            <div className="detail-note">
                              This project's budget has no revised budget amount, so budgeted margin isn't meaningful yet. Costs on
                              cost codes that aren't added to the budget don't show up in these figures at all.
                            </div>
                          )}
                          {p.refresh_error && <div className="detail-note detail-error">{p.refresh_error}</div>}
                          <SourceRecords projectId={p.project_id} onUnauthorized={handleLogout} />
                          <div className="detail-actions">
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={refreshingId === p.project_id}
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
                <tr><td colSpan={COLUMNS.length} className="empty-state">No projects match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
