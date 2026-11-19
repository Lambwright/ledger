import { useEffect, useState } from "react";
import { api } from "../api.js";

// Overnight reconciling digest (Ben, 2026-11-19) — LEDGER admins only. People
// queue Budgeted / Written off / Already Billed in the sidebar during the day;
// the overnight run does them. Anything that couldn't be done (record deleted
// or changed since it was queued, already marked by someone else…) is listed
// here with who queued it, when, and why, until an admin marks it reviewed.
// The person who queued it also sees the reason on the item in the sidebar,
// and can mark it again once they've checked it.
const ACTION = { budgeted: "Mark as budgeted", written_off: "Write off", already_billed: "Already billed" };
const KIND = { tm: "T&M ticket", mat: "T&M material", dc: "Direct cost", dcl: "Direct cost line", cml: "Commitment line" };

const money = (v) => (v == null ? "—" : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" }));
const when = (t) => (t ? new Date(t).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function ReconcileDigest({ onUnauthorized }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.reconcileDigest()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => (e.unauthorized ? onUnauthorized?.() : setError(e.message)));

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function reviewed(items) {
    setBusy(true);
    try {
      await api.reconcileDigestReviewed(items.map((f) => ({ queue_id: f.queue_id, kind: f.kind, key: f.key })));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="banner-error digest-banner">Overnight reconciling: {error}</div>;
  if (!data) return null;
  const failed = data.failed || [];
  const { queued, last24h } = data;
  if (failed.length === 0 && !queued.items && !last24h.done) return null;

  return (
    <div className={`card digest${failed.length ? " digest-has-failed" : ""}`}>
      <div className="digest-head">
        <span className="stat-label">Overnight reconciling</span>
        <span className="digest-sub">
          {queued.items ? `${queued.items} item${queued.items === 1 ? "" : "s"} queued for tonight on ${queued.projects} project${queued.projects === 1 ? "" : "s"}` : "Nothing queued"}
          {" · "}last 24 h: {last24h.done} done, {last24h.failed} failed
        </span>
        {failed.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
            {open ? "Hide" : `Show ${failed.length} to review`}
          </button>
        )}
      </div>
      {failed.length > 0 && open && (
        <>
          <p className="digest-note">
            These couldn&apos;t be reconciled overnight, so nothing was recorded for them. The person who queued each one sees the
            reason on the item in LEDGER and can mark it again after checking it. Mark a row reviewed to clear it from this list.
          </p>
          <div className="table-wrap">
            <table className="table digest-table">
              <thead>
                <tr>
                  <th>Project</th><th>Item</th><th>Action</th><th className="num">Queued at</th><th className="num">Now</th>
                  <th>Why it failed</th><th>Queued by</th><th>Queued</th><th>Tried</th><th></th>
                </tr>
              </thead>
              <tbody>
                {failed.map((f) => (
                  <tr key={`${f.queue_id}|${f.kind}|${f.key}`}>
                    <td>{[f.project_number, f.project_name].filter(Boolean).join(" ") || f.project_id}</td>
                    <td><span className="cell-sub">{KIND[f.kind] || f.kind}</span><div>{f.label || f.key}</div></td>
                    <td>{ACTION[f.action] || f.action}</td>
                    <td className="num">{money(f.expected)}</td>
                    <td className="num">{f.actual == null ? "—" : money(f.actual)}</td>
                    <td className="digest-why">{f.error}</td>
                    <td>{f.requested_by}</td>
                    <td>{when(f.requested_at)}</td>
                    <td>{when(f.tried_at)}</td>
                    <td><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reviewed([f])}>Reviewed</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {failed.length > 1 && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reviewed(failed)}>
              Mark all {failed.length} reviewed
            </button>
          )}
        </>
      )}
    </div>
  );
}
