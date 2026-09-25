import { useState, useEffect } from 'react';
import { ticketDetail } from './api';

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const TENANT_ID = import.meta.env.VITE_TENANT_ID;
const FALLBACK_PROCORE_ORIGIN = 'https://us02.procore.com';

// Full-window popout for "Full details" (Ben's ask 2026-09-15: "any future
// record" gets a popout with all its information, not a modal squeezed into
// the sidebar). Same content and same ticketDetail() call as the old
// TicketModal dialog, just laid out as a plain page instead of a
// backdrop+dialog, and fed by URL params (opened via App.jsx popOutTicketDetail
// as a fresh window.open, not an in-sidebar overlay) instead of props —
// this window is read-only, so it doesn't need the postMessage handshake
// PreviewEditPopout does.
export default function TicketDetailPopout() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project_id');
  const entryId = params.get('entry_id');
  const ticketNumber = params.get('ticket_number');
  const flagUnlinked = params.get('billing_mode') !== 'fixed_price';
  const procoreOrigin = params.get('procore_origin') || FALLBACK_PROCORE_ORIGIN;
  const procoreHref = projectId
    ? `${procoreOrigin}/webclients/host/companies/${TENANT_ID}/projects/${projectId}/tools/timeandmaterials/${entryId}/show`
    : null;

  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectId || !entryId) return;
    ticketDetail({ tenantId: TENANT_ID, projectId, entryId })
      .then(setDetail)
      .catch(e => setError(e.message));
  }, [projectId, entryId]);

  return (
    <div className="ledger ledger-wide">
      <header className="ledger-header">
        <div className="ledger-logo">LEDGER</div>
        <div className="ledger-subtitle">T&amp;M #{ticketNumber}</div>
      </header>
      <div className="ledger-tagline">An Einbau Product</div>

      {!projectId || !entryId ? (
        <div className="banner banner-error">Missing project/ticket — this window needs to be opened from a ticket's "Full details" button.</div>
      ) : error ? (
        <div className="banner banner-error">{error}</div>
      ) : !detail ? (
        <div className="loading">Loading ticket…</div>
      ) : (
        <div className="modal-body">
          <div className="modal-meta">
            {detail.status && <span className="chip">{String(detail.status).replace(/_/g, ' ')}</span>}
            {detail.workPerformedOnDate && <span>{detail.workPerformedOnDate}</span>}
            {detail.changeEventId && <span>CE #{detail.changeEventId}</span>}
          </div>

          {detail.description && <p className="modal-desc">{detail.description}</p>}

          <div className="modal-lines">
            {detail.lines.map(l => (
              <div className={`modal-line ${l.billedStatus ? 'is-billed' : ''}`} key={l.timecardEntryId}>
                <div className="modal-line-main">
                  <span className="modal-line-worker">
                    {l.workerName}
                    {!l.hasTimecard && flagUnlinked && <span className="no-timecard-tag"> ⚠ no timecard</span>}
                  </span>
                  <span className="modal-line-amount">{money(l.amount)}</span>
                </div>
                <div className="modal-line-sub">
                  {l.classification && <span className="modal-line-class">{l.classification}</span>}
                  <span>{l.timeTypeLabel} · {l.hours}h @ {l.rate != null ? money(l.rate) : '—'}</span>
                  {l.billedStatus === 'billed' && <span className="tag tag-billed">Billed · {l.invoiceNumber || 'invoice'}</span>}
                  {l.billedStatus === 'draft_co' && <span className="tag tag-draft">In draft CO</span>}
                  {!l.billedStatus && <span className="tag tag-open">Unbilled</span>}
                </div>
              </div>
            ))}
          </div>

          {detail.attachments.length > 0 && (
            <div className="modal-attachments">
              <div className="modal-section-label">Attachments</div>
              {detail.attachments.map((a, i) => (
                <a key={i} href={a.url} target="_blank" rel="noreferrer">{a.filename} ↗</a>
              ))}
            </div>
          )}

          <div className="modal-totals">
            <div><span>Unbilled</span><strong>{money(detail.totals.unbilled)}</strong></div>
            {detail.totals.draft > 0 && <div><span>In draft CO</span><strong>{money(detail.totals.draft)}</strong></div>}
            {detail.totals.billed > 0 && <div><span>Billed</span><strong>{money(detail.totals.billed)}</strong></div>}
            <div className="modal-total-grand"><span>Total</span><strong>{money(detail.totals.total)}</strong></div>
          </div>

          {procoreHref && (
            <a className="modal-procore-link" href={procoreHref} target="_blank" rel="noreferrer">
              Open T&amp;M ticket in Procore ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
