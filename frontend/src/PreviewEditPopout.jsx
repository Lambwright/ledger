import { useState, useEffect, useRef } from 'react';

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
// Carries BOTH tmLines and dcLines (Ben's ask 2026-09-16: aggregate T&M +
// direct costs into one submission) rather than one merged array — keeps
// each source's own editable fields (T&M: description + rate; direct cost:
// description only) distinct, matching the sidebar's own preview overlay.
export default function PreviewEditPopout() {
  const [data, setData] = useState(null); // { tmLines, dcLines, meta, kind }
  const [saved, setSaved] = useState(false);
  const originRef = useRef(window.location.origin);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== originRef.current) return;
      if (event.data?.type === 'ledger:init') {
        setData({
          tmLines: (event.data.tmLines || []).map(l => ({ ...l })),
          dcLines: (event.data.dcLines || []).map(l => ({ ...l })),
          meta: event.data.meta,
          kind: event.data.kind
        });
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

  function updateTmLine(index, field, value) {
    setData(prev => ({ ...prev, tmLines: prev.tmLines.map((l, i) => (i === index ? { ...l, [field]: value } : l)) }));
  }
  function updateDcLine(index, field, value) {
    setData(prev => ({ ...prev, dcLines: prev.dcLines.map((l, i) => (i === index ? { ...l, [field]: value } : l)) }));
  }

  function saveAndClose() {
    if (!window.opener) return;
    window.opener.postMessage({ type: 'ledger:result', tmLines: data.tmLines, dcLines: data.dcLines }, originRef.current);
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
        <div className="loading">Connecting to the LEDGER panel…</div>
      </div>
    );
  }

  const tmTotal = data.tmLines.reduce((s, l) => s + l.hours * (Number(l.rate) || 0), 0);
  const dcTotal = data.dcLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

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
          {data.tmLines.length > 0 && (
            <>
              <div className="rate-overrides-label">T&amp;M lines</div>
              <div className="preview-lines preview-lines-popout">
                {data.tmLines.map((line, i) => (
                  <div className="preview-line" key={i}>
                    <input
                      className="preview-line-desc"
                      type="text"
                      value={line.description}
                      onChange={e => updateTmLine(i, 'description', e.target.value)}
                    />
                    <div className="preview-line-nums">
                      <span>{line.hours} hrs @</span>
                      <input
                        type="number" min="0" step="0.01"
                        value={line.rate}
                        onChange={e => updateTmLine(i, 'rate', e.target.value)}
                      />
                      <span className="preview-line-amount">{money(line.hours * (Number(line.rate) || 0))}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {data.dcLines.length > 0 && (
            <>
              <div className="rate-overrides-label">Direct cost lines</div>
              <div className="preview-lines preview-lines-popout">
                {data.dcLines.map((line, i) => (
                  <div className="preview-line" key={i}>
                    <input
                      className="preview-line-desc"
                      type="text"
                      value={line.description}
                      onChange={e => updateDcLine(i, 'description', e.target.value)}
                    />
                    <div className="preview-line-nums">
                      <span>cost {money(line.cost)} @ {line.markupPercent}% markup</span>
                      <span className="preview-line-amount">{money(line.amount)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="preview-total">
            <span>Total</span>
            <strong>{money(tmTotal + dcTotal)}</strong>
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
