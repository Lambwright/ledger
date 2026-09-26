import { useState } from "react";
import { api } from "../api.js";

// The Procore records behind a project's budget figures (Ben's ask 2026-09-26):
// direct costs, subcontractor invoices and owner invoices, each with LEDGER's
// billing status. Loaded on demand only — it costs ~4 Procore requests.

const PROCORE_ORIGIN = "https://us02.procore.com";

const money2 = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-CA", { style: "currency", currency: "CAD" });

function Section({ title, total, children, count }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="src-section">
      <button type="button" className="src-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {title} <span className="cell-sub">({count})</span>
        <span className="src-total">{money2(total)}</span>
      </button>
      {open && (count ? <div className="table-wrap src-table">{children}</div> : <div className="cell-sub">None.</div>)}
    </div>
  );
}

export default function SourceRecords({ projectId, onUnauthorized }) {
  const [state, setState] = useState({ loading: false, data: null, error: null });

  async function load() {
    setState({ loading: true, data: null, error: null });
    try {
      setState({ loading: false, data: await api.sourceRecords(projectId), error: null });
    } catch (e) {
      if (e.unauthorized) onUnauthorized();
      setState({ loading: false, data: null, error: e.message });
    }
  }

  const { loading, data, error } = state;
  if (!data) {
    return (
      <div className="detail-actions">
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={load}>
          {loading ? "Loading source records…" : "Show source records"}
        </button>
        {error && <span className="detail-note detail-error">{error}</span>}
      </div>
    );
  }

  const gap = data.costOutsideBudget;
  const dcUrl = (id) => `${PROCORE_ORIGIN}/${projectId}/project/direct_costs/${id}`;
  const cmUrl = (s) =>
    `${PROCORE_ORIGIN}/${projectId}/project/commitments/${s.commitmentType === "PurchaseOrderContract" ? "purchase_order_contracts" : "work_order_contracts"}/${s.commitmentId}`;

  return (
    <div className="src">
      {gap != null && Math.abs(gap) >= 0.01 ? (
        <div className="detail-note">
          {money2(Math.abs(gap))} of cost {gap > 0 ? "is recorded in Procore but missing from" : "in the budget isn't backed by"} the
          budget figures above. {gap > 0 ? "Usually a cost code that hasn't been added to the budget, so margin is overstated. " : ""}
          Refresh from Procore first if the figures above are old.
        </div>
      ) : gap != null ? (
        <div className="cell-sub">All direct costs and subcontractor invoices are counted in the budget figures.</div>
      ) : null}

      <Section title="Direct costs" total={data.totals.directCosts} count={data.directCosts.length}>
        <table className="table">
          <thead><tr><th>Date</th><th>Vendor</th><th>Description</th><th>Type</th><th>Status</th><th className="num">Amount</th><th>LEDGER</th><th></th></tr></thead>
          <tbody>
            {data.directCosts.map((d) => (
              <tr key={d.id}>
                <td>{d.date || "—"}</td>
                <td>{d.vendor || "—"}</td>
                <td className="src-desc">{d.description || "—"}</td>
                <td>{d.type || "—"}</td>
                <td>{d.status || "—"}</td>
                <td className="num">{money2(d.amount)}</td>
                <td>{d.ledgerStatus}</td>
                <td><a href={dcUrl(d.id)} target="_blank" rel="noreferrer">Procore ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Subcontractor invoices" total={data.totals.subInvoices} count={data.subInvoices.length}>
        <table className="table">
          <thead><tr><th>Billing date</th><th>Vendor</th><th>Invoice #</th><th>Status</th><th className="num">Amount</th><th>LEDGER (commitment)</th><th></th></tr></thead>
          <tbody>
            {data.subInvoices.map((s) => (
              <tr key={s.id}>
                <td>{s.billingDate || "—"}</td>
                <td>{s.vendor || "—"}</td>
                <td>{s.invoiceNumber || (s.number != null ? `#${s.number}` : "—")}</td>
                <td>{s.status || "—"}</td>
                <td className="num">{money2(s.amount)}</td>
                <td>{s.ledgerStatus}</td>
                <td><a href={cmUrl(s)} target="_blank" rel="noreferrer">Commitment ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Owner invoices" total={data.totals.ownerInvoices} count={data.ownerInvoices.length}>
        <table className="table">
          <thead><tr><th>Billing date</th><th>Contract</th><th>Invoice #</th><th>Period</th><th>Status</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {data.ownerInvoices.map((o) => (
              <tr key={o.id}>
                <td>{o.billingDate || "—"}</td>
                <td>{o.contractTitle}</td>
                <td>{o.invoiceNumber || "—"}</td>
                <td>{o.periodStart && o.periodEnd ? `${o.periodStart} – ${o.periodEnd}` : "—"}</td>
                <td>{o.status || "—"}</td>
                <td className="num">{money2(o.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
