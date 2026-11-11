import { useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { invoiceDetail } from './api';

// LEDGER in the Procore side panel on an owner invoice (Ben, 2026-11-11): who billed it, when, which records
// built it, and each record's own files (signed links, fresh on every load), whether or not they were
// attached to the invoice. Read-only. Records marked "Already Billed" against the invoice show in their own
// section once that screen can pick a real invoice (they only hold a typed number today).
//
// Cards work like the rest of LEDGER's lists (ticket-card): click one to see its files and its Procore link.

const TENANT_ID = import.meta.env.VITE_TENANT_ID;
const KIND_LABEL = { tm: 'T&M ticket', dc: 'Direct Cost', cm: 'Commitment', other: 'Other' };

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function when(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}
// Before Einbau ID sign-ins (2026-09-28), LEDGER recorded a stand-in Procore user id, not the real person.
const who = (by) => (/^\d+$/.test(by) ? 'Unknown (before LEDGER sign-ins)' : by);

// Procore pages. T&M and Direct Cost addresses were taken from Ben's browser bar (2026-09-14, 2026-11-06).
function procoreUrl(item, origin, projectId) {
  if (!item.procoreId) return null;
  const host = `${origin}/webclients/host/companies/${TENANT_ID}/projects/${projectId}/tools`;
  if (item.kind === 'tm') return `${host}/timeandmaterials/${item.procoreId}/show`;
  if (item.kind === 'dc') return `${host}/direct-costs/details/${item.procoreId}`;
  if (item.kind === 'cm' && item.commitmentType) return `${origin}/${projectId}/project/commitments/${item.commitmentType}/${item.procoreId}`;
  return null;
}

function ItemCard({ item, origin, projectId }) {
  const [open, setOpen] = useState(false);
  const url = procoreUrl(item, origin, projectId);
  return (
    <div className="ticket-card readonly" onClick={() => setOpen(!open)} aria-expanded={open}>
      <div className="ticket-card-header">
        <span className="ticket-number">{item.title}</span>
        <span className="ticket-amount">{money(item.amount)}</span>
      </div>
      {item.subtitle && <div className="ticket-description">{item.subtitle}</div>}
      <div className="ticket-meta">
        {KIND_LABEL[item.kind] || item.kind} · {item.files.length} file{item.files.length === 1 ? '' : 's'}
      </div>
      {open && (
        <div className="line-items">
          {item.ticketPdfOnInvoice && <div className="invoice-panel-sub">The ticket PDF goes on the invoice automatically.</div>}
          {item.files.length === 0 && <div className="invoice-panel-sub">No files on this record.</div>}
          {item.files.map((f, j) => (
            <div className="line-item" key={j}>
              <a className="invoice-panel-file" href={f.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                {f.name}
              </a>
              <span className="line-item-detail">{f.source}</span>
            </div>
          ))}
          {url && (
            <div className="ticket-links">
              <a href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Open in Procore ↗</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, data, origin, projectId }) {
  if (!data) return null;
  return (
    <section className="invoice-panel-section">
      <h2 className="invoice-panel-heading">{title}</h2>
      <dl className="invoice-panel-facts">
        <dt>By</dt><dd>{data.by.map(who).join(', ') || '—'}</dd>
        <dt>When</dt><dd>{when(data.firstAt)}{data.lastAt !== data.firstAt ? ` – ${when(data.lastAt)}` : ''}</dd>
        <dt>Total</dt><dd>{money(data.total)} · {data.items.length} item{data.items.length === 1 ? '' : 's'}</dd>
      </dl>
      <div className="ticket-list">
        {data.items.map((item, i) => <ItemCard key={`${item.title}-${i}`} item={item} origin={origin} projectId={projectId} />)}
      </div>
    </section>
  );
}

export default function InvoicePanel({ projectId, invoiceId, procoreOrigin, onOpenLedger }) {
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
      <Section title="Built by LEDGER" data={detail.built} origin={procoreOrigin} projectId={projectId} />
      <Section title="Marked as already billed on this invoice" data={detail.alreadyBilled} origin={procoreOrigin} projectId={projectId} />
      {footer}
    </div>
  );
}
