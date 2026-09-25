import { useState, useEffect } from 'react';
import { directCostLineDetail } from './api';

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const TENANT_ID = import.meta.env.VITE_TENANT_ID;

// Full-window popout for a direct cost's "Full details" (Ben's ask
// 2026-09-22, mirrors TicketDetailPopout.jsx exactly) — read-only, so no
// postMessage handshake needed, just URL params and one API call.
export default function DirectCostDetailPopout() {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get('project_id');
  const directCostId = params.get('direct_cost_id');
  const vendor = params.get('vendor');

  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectId || !directCostId) return;
    directCostLineDetail({ tenantId: TENANT_ID, projectId, directCostId })
      .then(setDetail)
      .catch(e => setError(e.message));
  }, [projectId, directCostId]);

  return (
    <div className="ledger ledger-wide">
      <header className="ledger-header">
        <div className="ledger-logo">LEDGER</div>
        <div className="ledger-subtitle">{vendor || 'Direct Cost'}</div>
      </header>
      <div className="ledger-tagline">An Einbau Product</div>

      {!projectId || !directCostId ? (
        <div className="banner banner-error">Missing project/direct cost — this window needs to be opened from a direct cost's "Full details" button.</div>
      ) : error ? (
        <div className="banner banner-error">{error}</div>
      ) : !detail ? (
        <div className="loading">Loading direct cost…</div>
      ) : (
        <div className="modal-body">
          <div className="modal-meta">
            {detail.status && <span className="chip">{String(detail.status).replace(/_/g, ' ')}</span>}
            {detail.date && <span>{detail.date}</span>}
            {detail.type && <span>{detail.type}</span>}
          </div>

          {detail.description && <p className="modal-desc">{detail.description}</p>}

          <div className="modal-lines">
            {detail.lines.map(l => (
              <div className={`modal-line ${l.billedStatus ? 'is-billed' : ''}`} key={l.id}>
                <div className="modal-line-main">
                  <span className="modal-line-worker">{l.description || l.costCode || 'Line item'}</span>
                  <span className="modal-line-amount">{money(l.amount)}</span>
                </div>
                <div className="modal-line-sub">
                  <span>{l.costCode || '—'} · qty {l.quantity ?? 1} @ {l.unitCost != null ? money(l.unitCost) : '—'}</span>
                  {l.billedStatus === 'billed' && <span className="tag tag-billed">Billed · {l.invoiceNumber || 'invoice'}</span>}
                  {l.billedStatus === 'draft_co' && <span className="tag tag-draft">In draft CO</span>}
                  {l.billedStatus === 'written_off' && <span className="tag tag-written-off">Written off</span>}
                  {l.billedStatus === 'reconciled_to_period' && <span className="tag tag-budgeted">Budgeted</span>}
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
            <div className="modal-total-grand">
              <span>Total ({detail.lines.length} line{detail.lines.length === 1 ? '' : 's'})</span>
              <strong>{money(detail.lines.reduce((s, l) => s + l.amount, 0))}</strong>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
