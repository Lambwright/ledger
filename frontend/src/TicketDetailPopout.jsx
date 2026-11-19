import Loading from './Loading.jsx';
import { useState, useEffect } from 'react';
import { ticketDetail } from './api';

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const TENANT_ID = import.meta.env.VITE_TENANT_ID;
const FALLBACK_PROCORE_ORIGIN = 'https://us02.procore.com';

// This ticket's timecards are linked to the same Procore timesheet entries as
// another ticket's (Ben's ask 2026-11-19; see the worker's
// describeSharedTimesheet). LEDGER bills each timesheet entry once, so only one
// ticket's hours go out and the other ticket still shows as billed. Says which
// ticket looks wrongly linked and the order to fix it in.
function SharedTimesheetPanel({ shared, thisNumber }) {
  const others = shared.tickets.filter(t => !t.isThis);
  const ticketByNumber = new Map(shared.tickets.map(t => [t.number, t]));
  const otherList = others.map(t => `T&M #${t.number}`).join(', ');
  const billed = shared.entries.map(e => e.billed).filter(b => b && (b.status === 'billed' || b.status === 'draft_co'));
  const ledgerInvoices = [...new Set(billed.filter(b => b.status === 'billed' && !b.outside && !b.viaCommitment).map(b => b.invoiceNumber || '?'))];
  const inDraftCo = billed.some(b => b.status === 'draft_co');
  const elsewhere = billed.some(b => b.outside || b.viaCommitment);
  const otherDisposition = shared.entries.some(e => e.billed && e.billed.status !== 'billed' && e.billed.status !== 'draft_co');
  const wrong = shared.likelyWrong.map(n => ticketByNumber.get(n)).filter(Boolean);
  const tsDates = [...new Set(shared.entries.map(e => e.timesheetDate).filter(Boolean))];

  return (
    <div className="dup-panel">
      <div className="dup-panel-title">⚠ Same timesheet entries as {otherList}</div>
      <p>
        Each timesheet entry in Procore should be on one T&amp;M ticket. T&amp;M #{thisNumber} and {otherList} are
        linked to the same {shared.entries.length} entr{shared.entries.length === 1 ? 'y' : 'ies'}, so LEDGER can
        only bill those hours once: one ticket's hours go out and the other's are skipped, but both tickets show as billed.
        Until it's fixed, LEDGER won't let either ticket be billed, written off or marked.
      </p>

      <table className="dup-table">
        <thead>
          <tr><th>Worker</th><th>Timesheet date</th><th>Timesheet hrs</th><th>On tickets</th><th>Billing</th></tr>
        </thead>
        <tbody>
          {shared.entries.map(e => (
            <tr key={e.timesheetEntryId}>
              <td>{e.workerName}</td>
              <td>{e.timesheetDate || '—'}</td>
              <td>{e.timesheetHours ?? '—'}</td>
              <td>{e.onTickets.map(o => `#${o.number} (${o.hours}h)`).join(', ')}</td>
              <td>
                {!e.billed ? 'Unbilled'
                  : e.billed.status === 'draft_co' ? 'In draft CO'
                  : e.billed.status === 'billed' ? (e.billed.outside ? 'Billed outside LEDGER' : e.billed.viaCommitment ? 'Billed via commitment' : `Invoice #${e.billed.invoiceNumber || '?'}`)
                  : e.billed.status === 'written_off' ? 'Written off' : 'Budgeted'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {wrong.length > 0 && tsDates.length > 0 && (
        <p>
          <strong>{wrong.map(t => `T&M #${t.number}`).join(', ')}</strong> look{wrong.length === 1 ? 's' : ''} wrongly
          linked: {wrong.length === 1 ? 'its' : 'their'} work date ({wrong.map(t => t.date || '—').join(', ')}) doesn't
          match these timesheet entries ({tsDates.join(', ')}).
        </p>
      )}

      <div className="dup-panel-subtitle">How to fix</div>
      <ol className="dup-steps">
        {ledgerInvoices.length > 0 && (
          <li>
            In LEDGER, delete invoice {ledgerInvoices.map(n => `#${n}`).join(', ')} first (Billed tab → Delete invoice…). Its records are
            tied to these timesheet entries, so they have to be cleared before the links change. This only works while the
            invoice is a draft and hasn't gone to NetSuite. Otherwise, ask a LEDGER admin.
          </li>
        )}
        {inDraftCo && <li>In LEDGER, undo the draft Change Order push for these hours first (Billed tab → Undo draft push).</li>}
        {(elsewhere || otherDisposition) && (
          <li>Some of these hours are already marked billed outside LEDGER, written off or budgeted. Undo that in LEDGER first, or ask a LEDGER admin.</li>
        )}
        {wrong.length > 0 ? (
          <li>
            In Procore, open {wrong.map(t => `T&M #${t.number}`).join(', ')} and re-apply {wrong.length === 1 ? 'its' : 'their'} timecards
            to the timesheet entries for {wrong.length === 1 ? 'its own work date' : 'each ticket\'s own work date'}
            {wrong.length === 1 && wrong[0].date ? ` (${wrong[0].date})` : ''}.
          </li>
        ) : (
          <li>
            In Procore, decide which ticket each timesheet entry belongs to, and re-apply the other ticket's timecards to its own
            timesheet entries. If someone's day really was split across two tickets, split their timesheet entry so each ticket has its own.
          </li>
        )}
        <li>
          {ledgerInvoices.length > 0 || inDraftCo ? 'Rebuild the invoice with all the tickets. ' : 'Then bill as normal. '}
          This flag clears once every timesheet entry is on one ticket.
        </li>
      </ol>
    </div>
  );
}

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
  const sharedKeys = new Set((detail?.sharedTimesheet?.entries || []).map(e => String(e.timesheetEntryId)));

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
        <Loading />
      ) : (
        <div className="modal-body">
          <div className="modal-meta">
            {detail.status && <span className="chip">{String(detail.status).replace(/_/g, ' ')}</span>}
            {detail.workPerformedOnDate && <span>{detail.workPerformedOnDate}</span>}
            {detail.referenceNumber && <span>Ref {detail.referenceNumber}</span>}
            {detail.changeEventId && <span>CE #{detail.changeEventId}</span>}
          </div>

          {detail.description && <p className="modal-desc">{detail.description}</p>}

          {detail.sharedTimesheet && <SharedTimesheetPanel shared={detail.sharedTimesheet} thisNumber={detail.number} />}

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
                  {sharedKeys.has(String(l.timecardEntryId)) && <span className="tag tag-written-off">Shared timesheet</span>}
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
