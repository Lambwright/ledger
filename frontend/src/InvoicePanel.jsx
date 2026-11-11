import { useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { invoiceDetail } from './api';

// LEDGER in the Procore side panel on an owner invoice (Ben, 2026-11-11): who billed it, when, which records
// built it, and each record's own files (signed links, fresh on every load), whether or not they were
// attached to the invoice. Read-only. Records marked "Already Billed" against the invoice show in their own
// section once that screen can pick a real invoice (they only hold a typed number today).

const TENANT_ID = import.meta.env.VITE_TENANT_ID;
const KIND_LABEL = { tm: 'T&M ticket', dc: 'Direct Cost', cm: 'Commitment', other: 'Other' };

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

function Section({ title, data }) {
  if (!data) return null;
  return (
    <section className="invoice-panel-section">
      <h2 className="invoice-panel-heading">{title}</h2>
      <dl className="invoice-panel-facts">
        <dt>By</dt><dd>{data.by.join(', ') || '—'}</dd>
        <dt>When</dt><dd>{when(data.firstAt)}{data.lastAt !== data.firstAt ? ` – ${when(data.lastAt)}` : ''}</dd>
        <dt>Total</dt><dd>{money(data.total)} · {data.items.length} item{data.items.length === 1 ? '' : 's'}</dd>
      </dl>
      <ul className="invoice-panel-items">
        {data.items.map((item, i) => (
          <li key={`${item.title}-${i}`} className="invoice-panel-item">
            <div className="invoice-panel-item-top">
              <span className="invoice-panel-kind">{KIND_LABEL[item.kind] || item.kind}</span>
              <span className="invoice-panel-amount">{money(item.amount)}</span>
            </div>
            <div className="invoice-panel-title">{item.title}</div>
            {item.subtitle && <div className="invoice-panel-sub">{item.subtitle}</div>}
            {item.ticketPdfOnInvoice && <div className="invoice-panel-sub">The ticket PDF goes on the invoice automatically.</div>}
            {item.files.length > 0 ? (
              <ul className="invoice-panel-files">
                {item.files.map((f, j) => (
                  <li key={j}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer">{f.name}</a>
                    <span className="invoice-panel-file-source">{f.source}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="invoice-panel-sub">No files on this record.</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function InvoicePanel({ projectId, invoiceId, onOpenLedger }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    invoiceDetail({ tenantId: TENANT_ID, projectId, invoiceId })
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [projectId, invoiceId]);

  const footer = <button className="cancel-btn invoice-panel-open" onClick={onOpenLedger}>Open LEDGER</button>;

  if (error) return <div className="invoice-panel"><div className="banner banner-error">{error}</div>{footer}</div>;
  if (!detail) return <div className="invoice-panel"><Loading /></div>;
  if (!detail.found) {
    return (
      <div className="invoice-panel">
        <p className="invoice-panel-note">This page doesn't look like an owner invoice LEDGER can read.</p>
        {footer}
      </div>
    );
  }

  const inv = detail.invoice;
  const nothing = !detail.built && !detail.alreadyBilled;
  return (
    <div className="invoice-panel">
      <header className="invoice-panel-header">
        <div className="invoice-panel-label">Owner invoice</div>
        <div className="invoice-panel-number">Invoice {inv.number ?? `#${inv.id}`}</div>
        <div className="invoice-panel-sub">{[inv.contract, inv.status, inv.billingDate].filter(Boolean).join(' · ')}</div>
      </header>
      {nothing && <p className="invoice-panel-note">LEDGER didn't build this invoice, and nothing has been marked as billed against it.</p>}
      <Section title="Built by LEDGER" data={detail.built} />
      <Section title="Marked as already billed on this invoice" data={detail.alreadyBilled} />
      {footer}
    </div>
  );
}
