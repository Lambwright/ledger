import { useCallback, useEffect, useMemo, useState } from "react";
import { getStoredToken, verify, hasLedgerAccess, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import SourceRecords from "./components/SourceRecords.jsx";

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

const COLUMNS = [
  { key: "name", label: "Project", sort: (p) => (p.name || "").toLowerCase() },
  { key: "stage", label: "Stage", sort: (p) => p.stage || "" },
  { key: "region", label: "Region", sort: (p) => p.region || "" },
  { key: "departments", label: "Department", sort: (p) => p.departments || "" },
  { key: "unbilled_count", label: "Unbilled Records", num: true },
  { key: "revised_contract", label: "Contract", num: true },
  { key: "invoiced", label: "Invoiced", num: true },
  { key: "pct_invoiced", label: "% Invoiced", num: true },
  { key: "invoicing_remaining", label: "Remaining", num: true },
  { key: "jtd_cost", label: "JTD Cost", num: true },
  { key: "margin_to_date", label: "Margin to Date", num: true },
  { key: "margin_to_date_pct", label: "MTD %", num: true },
  { key: "budgeted_margin", label: "Budgeted Margin", num: true },
  { key: "budgeted_margin_pct", label: "Budgeted %", num: true },
  { key: "refreshed_at", label: "Updated", sort: (p) => (p.refreshed_at ? new Date(p.refreshed_at).getTime() : 0) },
];

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
  const [stage, setStage] = useState("");
  const [region, setRegion] = useState("");
  const [dept, setDept] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [invoiceFilter, setInvoiceFilter] = useState(""); // "" | "open" | "done"
  const [sort, setSort] = useState({ key: "invoicing_remaining", dir: "desc" });

  const [openId, setOpenId] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);

  function signIn(u) {
    setUser(u);
    setAuthState(hasLedgerAccess(u) ? "in" : "noaccess");
  }

  const handleLogout = useCallback(() => {
    doLogout();
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
      .filter((p) => !stage || p.stage === stage)
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
  }, [projects, search, stage, region, dept, showAll, invoiceFilter, sort]);

  const totals = useMemo(() => {
    const sum = (key) => visible.reduce((s, p) => s + (n(p[key]) || 0), 0);
    const contract = sum("revised_contract");
    const invoiced = sum("invoiced");
    const mtd = sum("margin_to_date");
    return {
      contract, invoiced, mtd,
      remaining: sum("invoicing_remaining"),
      jtd: sum("jtd_cost"),
      pctInvoiced: contract ? (invoiced / contract) * 100 : null,
      mtdPct: invoiced ? (mtd / invoiced) * 100 : null,
    };
  }, [visible]);

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
        <div className="summary-row">
          <div className="stat"><span className="stat-label">Contract</span><span className="stat-value">{money(totals.contract)}</span></div>
          <div className="stat"><span className="stat-label">Invoiced</span><span className="stat-value">{money(totals.invoiced)}</span><span className="stat-sub">{pct(totals.pctInvoiced)}</span></div>
          <div className="stat"><span className="stat-label">Left to invoice</span><span className="stat-value">{money(totals.remaining)}</span></div>
          <div className="stat"><span className="stat-label">JTD cost</span><span className="stat-value">{money(totals.jtd)}</span></div>
          <div className="stat"><span className="stat-label">Margin to date</span><span className="stat-value">{money(totals.mtd)}</span><span className="stat-sub">{pct(totals.mtdPct)}</span></div>
        </div>

        <div className="filters">
          <input className="filter-search" placeholder="Search project name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
            <option value="">All stages</option>
            {stages.map((s) => <option key={s}>{s}</option>)}
          </select>
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
                        {p.project_number}
                        {noBudget && <span className="badge badge-warn">Budget not set up</span>}
                        {p.budget_status === "no_view" && <span className="badge badge-muted">No budget view</span>}
                        {!p.refreshed_at && <span className="badge badge-muted">Not loaded</span>}
                      </div>
                    </td>
                    <td>{p.stage || "—"}</td>
                    <td>{p.region || "—"}</td>
                    <td>{p.departments || "—"}</td>
                    <td className="num">{p.unbilled_count ?? "—"}</td>
                    <td className="num">{money(p.revised_contract)}</td>
                    <td className="num">{money(p.invoiced)}</td>
                    <td className="num">
                      <div className="pct-cell">
                        <span>{pct(p.pct_invoiced)}</span>
                        {n(p.pct_invoiced) != null && (
                          <span className="pct-bar"><span style={{ width: `${Math.min(100, Math.max(0, n(p.pct_invoiced)))}%` }} /></span>
                        )}
                      </div>
                    </td>
                    <td className="num">{money(p.invoicing_remaining)}</td>
                    <td className="num">{money(p.jtd_cost)}</td>
                    <td className={`num${n(p.margin_to_date) < 0 ? " neg" : ""}`}>{money(p.margin_to_date)}</td>
                    <td className={`num${n(p.margin_to_date_pct) < 0 ? " neg" : ""}`}>{pct(p.margin_to_date_pct)}</td>
                    <td className="num">{noBudget ? "—" : money(p.budgeted_margin)}</td>
                    <td className="num">{noBudget ? "—" : pct(p.budgeted_margin_pct)}</td>
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
