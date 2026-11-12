import { useEffect, useState } from 'react';
import Loading from './Loading.jsx';
import { planRunDeletion, deleteLedgerRun } from './api';

// Delete a LEDGER invoice (or draft Change Order) in one go (Ben, 2026-11-11): the invoice, the CO and CE
// LEDGER made for it (or its standalone Prime Contract), and every record on it back to Unbilled.
// The worker refuses anything synced to NetSuite and anything LEDGER didn't make. The plan is read first and
// shown; nothing changes until Delete is pressed, and the worker re-checks everything then.

const TENANT_ID = import.meta.env.VITE_TENANT_ID;

function money(n) {
  return (n ?? 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function DeleteRunDialog({ projectId, run, onClose, onDeleted }) {
  const [stage, setStage] = useState('loading'); // loading | confirm | deleting | done | error
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const ids = { tenantId: TENANT_ID, projectId, invoiceId: run.invoiceId, changeOrderId: run.changeOrderId };
  const what = run.invoiceId ? `Invoice ${run.invoiceNumber ?? ''}`.trim() : 'this draft Change Order';

  useEffect(() => {
    let live = true;
    planRunDeletion(ids)
      .then((p) => { if (live) { setPlan(p); setStage('confirm'); } })
      .catch((e) => { if (live) { setError(e.message); setStage('error'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.invoiceId, run.changeOrderId]);

  async function doDelete() {
    setStage('deleting');
    try {
      const r = await deleteLedgerRun(ids);
      setResult(r);
      setStage('done');
      onDeleted?.();
    } catch (e) {
      setError(e.message);
      setStage('error');
    }
  }

  const present = plan?.steps.filter((s) => s.exists && !s.keep) || [];
  const gone = plan?.steps.filter((s) => !s.exists) || [];
  const kept = plan?.steps.filter((s) => s.keep) || [];

  return (
    <div className="warn-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-run-title">
      <div className="warn-modal delete-run-modal">
        <div className="warn-modal-title" id="delete-run-title">Delete {what}?</div>

        {stage === 'loading' && <Loading size={70} text="Checking Procore…" />}
        {stage === 'deleting' && <Loading size={70} text="Deleting…" />}

        {stage === 'error' && (
          <>
            <div className="banner banner-error">{error}</div>
            <div className="warn-modal-buttons">
              <button className="warn-btn-ok" autoFocus onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {stage === 'confirm' && plan && (
          <>
            {plan.blocked.length > 0 ? (
              <>
                <p className="warn-modal-text">LEDGER can't delete this, because part of it is synced to NetSuite:</p>
                <ul className="warn-modal-lines">{plan.blocked.map((b) => <li key={b}><span>{b}</span></li>)}</ul>
                <p className="warn-modal-text">Unlink it from NetSuite first, or delete it in Procore yourself.</p>
              </>
            ) : (
              <>
                <p className="warn-modal-text">
                  {present.length ? 'This deletes these from Procore. It can\'t be undone:' : 'Nothing is left in Procore to delete.'}
                </p>
                {present.length > 0 && (
                  <ul className="warn-modal-lines">
                    {present.map((s) => <li key={`${s.key}:${s.id}`}><span>{s.label}</span>{s.status && <span className="warn-modal-hint">{s.status}</span>}</li>)}
                  </ul>
                )}
                {gone.length > 0 && <p className="warn-modal-text delete-run-note">Already gone from Procore: {gone.map((s) => s.label).join(', ')}.</p>}
                {kept.length > 0 && <p className="warn-modal-text delete-run-note">Kept: {kept.map((s) => `${s.label} (${s.keep})`).join(', ')}.</p>}
                <p className="warn-modal-text">
                  Then {plan.records} LEDGER record{plan.records === 1 ? '' : 's'} ({money(plan.amount)}) go back to Unbilled, ready to bill again.
                </p>
              </>
            )}
            <div className="warn-modal-buttons">
              <button className="warn-btn-ok" autoFocus onClick={onClose}>Cancel</button>
              {plan.blocked.length === 0 && <button className="warn-btn-proceed" onClick={doDelete}>Delete</button>}
            </div>
          </>
        )}

        {stage === 'done' && result && (
          <>
            <p className="warn-modal-text">
              {result.deleted.length ? `Deleted ${result.deleted.join(', ')}. ` : ''}
              {result.records} record{result.records === 1 ? '' : 's'} back to Unbilled.
            </p>
            {result.leftover.length > 0 && (
              <>
                <p className="warn-modal-text">Still in Procore. Delete these yourself:</p>
                <ul className="warn-modal-lines">{result.leftover.map((l) => <li key={l}><span>{l}</span></li>)}</ul>
              </>
            )}
            <div className="warn-modal-buttons">
              <button className="warn-btn-ok" autoFocus onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
