import Loading from './Loading.jsx';
import { useState, useEffect, useRef } from 'react';
import { materialLineAmount } from './materials';

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Full-window popout for the preview/edit step (Ben's ask 2026-09-15): "pop
// out the summaries for a review when the information is all smushed...
// edit it in that popout and have the info save in the sidebar tool for
// submittal." Opened via window.open from the sidebar WITHOUT noopener (see
// App.jsx popOutPreview) so window.opener is real — that's the only channel
// available, since this window can't use Procore's postMessage handshake
// (it isn't an iframe child of Procore's window) and doesn't call the
// Worker's API itself; the sidebar already has the live preview data and
// remains the only place that actually submits anything.
//
// Handshake: this window posts 'ledger:ready' until the opener answers with
// 'ledger:init' (opener might not have its listener mounted on the very
// first postMessage — same reasoning as the Procore ping in procore.js).
// On save, posts 'ledger:result' back and closes itself; the opener applies
// those lines to its own preview state, which is what Confirm actually
// submits.
//
// Carries all four line types in the sidebar's invoice order (2026-11-20 —
// it used to carry only T&M and direct costs, so T&M materials and
// commitments were missing here and from the total), each with the same
// editable fields as the sidebar: T&M description + rate; direct cost and
// commitment description + revenue code; material description, unit price
// (× the ticket's quantity) + revenue code. Reordering stays in the sidebar.
const SOURCE_LABEL = { tm: 'T&M', mt: 'T&M material', dc: 'Direct cost', cm: 'Commitment' };
const LIST_KEY = { tm: 'tmLines', mt: 'mtLines', dc: 'dcLines', cm: 'cmLines' };

export default function PreviewEditPopout() {
  const [data, setData] = useState(null); // { tmLines, mtLines, dcLines, cmLines, order, codes, meta, kind }
  const [saved, setSaved] = useState(false);
  const originRef = useRef(window.location.origin);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== originRef.current) return;
      if (event.data?.type === 'ledger:init') {
        const d = event.data;
        const copy = (list) => (list || []).map(l => ({ ...l }));
        const lists = { tmLines: copy(d.tmLines), mtLines: copy(d.mtLines), dcLines: copy(d.dcLines), cmLines: copy(d.cmLines) };
        // Older sidebars sent no order: fall back to source order.
        const order = Array.isArray(d.order) && d.order.length > 0 ? d.order
          : Object.entries(LIST_KEY).flatMap(([src, key]) => lists[key].map((_, i) => `${src}:${i}`));
        setData({ ...lists, order, codes: d.codes || null, meta: d.meta, kind: d.kind });
      }
    }
    window.addEventListener('message', onMessage);

    if (!window.opener) return () => window.removeEventListener('message', onMessage);
    let tries = 0;
    const ping = () => {
      try { window.opener.postMessage({ type: 'ledger:ready' }, originRef.current); } catch { /* ignore */ }
      if (++tries < 10) setTimeout(ping, 300);
    };
    ping();

    return () => window.removeEventListener('message', onMessage);
  }, []);

  function updateLine(src, index, field, value) {
    const key = LIST_KEY[src];
    setData(prev => ({ ...prev, [key]: prev[key].map((l, i) => (i === index ? { ...l, [field]: value } : l)) }));
  }

  function saveAndClose() {
    if (!window.opener) return;
    window.opener.postMessage(
      { type: 'ledger:result', tmLines: data.tmLines, mtLines: data.mtLines, dcLines: data.dcLines, cmLines: data.cmLines },
      originRef.current
    );
    setSaved(true);
    setTimeout(() => window.close(), 400);
  }

  if (!window.opener) {
    return (
      <div className="ledger ledger-wide">
        <div className="banner banner-error">
          This window has no connection back to LEDGER — it needs to be opened from the sidebar's preview
          screen, not loaded directly.
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="ledger ledger-wide">
        <Loading />
      </div>
    );
  }

  const tmTotal = data.tmLines.reduce((s, l) => s + (Number(l.hours) || 0) * (Number(l.rate) || 0), 0);
  const otherTotal = data.mtLines.reduce((s, l) => s + materialLineAmount(l), 0) +
    [...data.dcLines, ...data.cmLines].reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const codes = data.codes || [];

  function codePicker(src, i, line) {
    return (
      <div className="preview-line-code">
        <select
          className={line.wbsCodeId ? '' : 'needs-code'}
          value={line.wbsCodeId ?? ''}
          aria-label={`Revenue cost code for ${line.description}`}
          onChange={e => updateLine(src, i, 'wbsCodeId', e.target.value)}
        >
          <option value="" disabled>{data.codes == null ? 'Codes still loading — pick it in the sidebar' : 'Pick a revenue cost code…'}</option>
          {line.wbsCodeId && !codes.some(c => c.id === String(line.wbsCodeId)) && (
            <option value={line.wbsCodeId}>{line.code || line.budgetCode || 'Current code'}</option>
          )}
          {codes.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>
      </div>
    );
  }

  return (
    <div className="ledger ledger-wide">
      <header className="ledger-header">
        <div className="ledger-logo">LEDGER</div>
        <div className="ledger-subtitle">
          Preview — {data.kind === 'invoice' ? 'Generate Invoice' : 'Push to CO (draft)'}
        </div>
      </header>
      <div className="ledger-tagline">{data.meta?.label}</div>

      {data.meta?.unlinkedCount > 0 && (
        <div className="banner banner-warning">
          {data.meta.unlinkedCount} line(s) have no timecard linked in Procore — you'll be asked to confirm
          submitting without one back in the sidebar.
        </div>
      )}

      {saved ? (
        <div className="banner banner-success">Saved — closing this window and returning to the sidebar…</div>
      ) : (
        <>
          <div className="rate-overrides-label">Lines, in invoice order (reorder them in the sidebar)</div>
          <div className="preview-lines preview-lines-popout">
            {data.order.map((key, pos) => {
              const [src, idx] = key.split(':');
              const i = Number(idx);
              const line = data[LIST_KEY[src]]?.[i];
              if (!line) return null;
              return (
                <div className="preview-line preview-line-numbered" key={key}>
                  <div className="preview-line-pos preview-line-pos-static">{pos + 1}</div>
                  <div className="preview-line-body">
                    <input
                      className="preview-line-desc"
                      type="text"
                      value={line.description}
                      onChange={e => updateLine(src, i, 'description', e.target.value)}
                    />
                    <div className="preview-line-nums">
                      <span className="preview-line-source">{SOURCE_LABEL[src]}</span>
                      {src === 'tm' && (
                        <>
                          <span>{line.hours} hrs @</span>
                          <input
                            type="number" min="0" step="0.01"
                            value={line.rate}
                            onChange={e => updateLine(src, i, 'rate', e.target.value)}
                          />
                          <span className="preview-line-amount">{money(line.hours * (Number(line.rate) || 0))}</span>
                        </>
                      )}
                      {(src === 'dc' || src === 'cm') && (
                        <>
                          <span>cost {money(line.cost)} @ {line.markupPercent}% markup</span>
                          <span className="preview-line-amount">{money(line.amount)}</span>
                        </>
                      )}
                      {src === 'mt' && (
                        <>
                          <span>{line.quantity != null ? `${line.quantity}${line.uom ? ` ${line.uom}` : ''} @ $` : 'lump sum $'}</span>
                          <input
                            type="number" min="0" step="0.01" placeholder="0.00"
                            className={Number(line.unitCost) > 0 ? '' : 'needs-code'}
                            value={line.unitCost ?? ''}
                            aria-label={`${line.quantity != null ? 'Unit price' : 'Amount'} for ${line.description}`}
                            onChange={e => updateLine(src, i, 'unitCost', e.target.value)}
                          />
                          <span className="preview-line-amount">{money(materialLineAmount(line))}</span>
                        </>
                      )}
                    </div>
                    {src !== 'tm' && codePicker(src, i, line)}
                  </div>
                </div>
              );
            })}
          </div>
          {data.mtLines.length > 0 && (
            <div className="materials-warning">
              ⚠ Check the T&amp;M materials aren't also on a direct cost or subcontractor invoice — LEDGER can't detect that.
            </div>
          )}

          <div className="preview-total">
            <span>Total</span>
            <strong>{money(tmTotal + otherTotal)}</strong>
          </div>
          <div className="action-bar-buttons popout-actions">
            <button className="generate-btn" onClick={saveAndClose}>Save & return to sidebar</button>
            <button className="cancel-btn" onClick={() => window.close()}>Discard & close</button>
          </div>
        </>
      )}
    </div>
  );
}
