import { useState } from "react";

// Bulk project reconciliation (Ben's ask 2026-09-30) — LEDGER admins mark
// everything still Unbilled on the picked projects as Already Billed,
// Budgeted or Written Off, in one go. The worker queues it and works through
// one project at a time (worker/src/bulk.js).

export const BULK_LABELS = { billed: "Already Billed", reconciled_to_period: "Budgeted", written_off: "Written Off" };

// A batch that's queued, running or done blocks another one on the project.
export const hasActiveBatch = (p) => ["queued", "running", "done"].includes(p.bulk_status);

const money = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const day = (ts) => (ts ? new Date(ts).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : "");

export function BulkBadge({ project: p, isAdmin }) {
  if (p.bulk_status === "queued" || p.bulk_status === "running") {
    return <span className="badge badge-muted">Reconciling…</span>;
  }
  if (p.bulk_status === "done") {
    return <span className="badge badge-ok">Reconciled · {BULK_LABELS[p.bulk_disposition]}</span>;
  }
  // Failures are admin business — only admins can retry or reopen.
  if (p.bulk_status === "failed" && isAdmin) return <span className="badge badge-warn">Reconcile failed</span>;
  return null;
}

export function BulkDetail({ project: p, isAdmin, onReopen, busy }) {
  if (!p.bulk_status || (p.bulk_status === "failed" && !isAdmin)) return null;
  const label = BULK_LABELS[p.bulk_disposition];
  return (
    <div className="bulk-detail">
      {p.bulk_status === "done" && (
        <div>
          <strong>Reconciled as {label}</strong> by {p.bulk_by} on {day(p.bulk_at)} — {p.bulk_record_count ?? 0} record
          {p.bulk_record_count === 1 ? "" : "s"} ({money(p.bulk_amount)} at cost).
          {p.bulk_notes && <> Note: {p.bulk_notes}</>} Records that came in after that show as Unbilled as usual.
        </div>
      )}
      {(p.bulk_status === "queued" || p.bulk_status === "running") && (
        <div>
          Queued by {p.bulk_by} to be reconciled as <strong>{label}</strong>. It's worked through in the background, one project
          at a time.
        </div>
      )}
      {p.bulk_status === "failed" && (
        <div className="detail-error">Bulk reconciliation as {label} failed: {p.bulk_error}</div>
      )}
      {p.bulk_status === "done" && p.bulk_error && <div className="cell-sub">Partly skipped: {p.bulk_error}</div>}
      {isAdmin && p.bulk_status !== "running" && (
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onReopen(p); }}>
          {busy ? "Working…" : p.bulk_status === "queued" ? "Cancel" : "Reopen project"}
        </button>
      )}
    </div>
  );
}

export function reopenMessage(p) {
  if (p.bulk_status === "queued") return `Cancel the queued bulk reconciliation for ${p.name}?`;
  const label = BULK_LABELS[p.bulk_disposition];
  return (
    `Reopen ${p.name}?\n\n` +
    `The ${p.bulk_record_count ?? 0} record(s) marked as ${label} in this bulk reconciliation go back to Unbilled, ` +
    `and the project will need a complete manual review.\n\n` +
    `Records reconciled by hand, before or after, are not affected.`
  );
}

export function BulkDialog({ projects, onCancel, onConfirm }) {
  const [disposition, setDisposition] = useState("billed");
  const [notes, setNotes] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unbilled = projects.reduce((s, p) => s + (Number(p.unbilled_count) || 0), 0);
  const uncounted = projects.filter((p) => p.unbilled_count == null).length;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ disposition, notes, invoiceNumber: disposition === "billed" ? invoiceNumber : "" });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bulk-title" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title" id="bulk-title">
          Reconcile {projects.length} project{projects.length === 1 ? "" : "s"}
        </div>
        <p className="modal-text">
          Every record still <strong>Unbilled</strong> on {projects.length === 1 ? "this project" : "these projects"} —
          about <strong>{unbilled.toLocaleString()}</strong> record{unbilled === 1 ? "" : "s"}
          {uncounted > 0 && ` (plus ${uncounted} project${uncounted === 1 ? "" : "s"} not counted yet)`} — will be marked as:
        </p>
        <div className="bulk-options">
          {Object.entries(BULK_LABELS).map(([value, label]) => (
            <label key={value} className={`bulk-option${disposition === value ? " is-picked" : ""}`}>
              <input type="radio" name="bulk-disposition" value={value} checked={disposition === value} onChange={() => setDisposition(value)} />
              <span>
                <strong>{label}</strong>
                <span className="cell-sub">
                  {value === "billed" && " — billed outside LEDGER; counts as billed and blocks billing it again"}
                  {value === "reconciled_to_period" && " — covered by the contract or budget; never billed separately"}
                  {value === "written_off" && " — not billed to the client; reason: Bulk reconciliation"}
                </span>
              </span>
            </label>
          ))}
        </div>
        {disposition === "billed" && (
          <label className="field">
            <span>Invoice reference (optional)</span>
            <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="e.g. Invoiced outside LEDGER before Oct 2026" />
          </label>
        )}
        <label className="field">
          <span>Note (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Historical project, closed out before LEDGER" />
        </label>
        <p className="modal-text cell-sub">
          Records that come in later still show as Unbilled. These records can't be changed one by one afterwards — only a
          LEDGER admin can reopen a whole project, which returns them all to Unbilled. Projects are processed in the
          background, one at a time.
        </p>
        {error && <div className="banner-error">{error}</div>}
        <div className="modal-buttons">
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn btn-accent btn-sm" onClick={confirm} disabled={busy}>
            {busy ? "Queueing…" : `Queue ${projects.length} project${projects.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
