// Saved dashboard views (Ben, 2026-10-21): personal views anyone can make, and
// shared ("standard") views LEDGER admins publish for everyone — e.g. the one
// used in leadership meetings. A view is { columns, filters, sort }.
//
// value: "" (My default) | "p:<id>" (personal) | "s:<id>" (shared)
export default function ViewBar({
  personalViews, sharedViews, value, onSelect, dirty, isAdmin,
  onSave, onSaveAsNew, onShareAsNew, onDelete, busy,
}) {
  const active = value.startsWith("s:")
    ? sharedViews.find((v) => `s:${v.id}` === value)
    : value.startsWith("p:")
    ? personalViews.find((v) => `p:${v.id}` === value)
    : null;
  const isShared = value.startsWith("s:");
  const canSave = active && dirty && (!isShared || isAdmin);
  const canDelete = active && (!isShared || isAdmin);

  return (
    <div className="view-bar">
      <label className="view-picker">
        <span>View</span>
        <select value={value} onChange={(e) => onSelect(e.target.value)} disabled={busy}>
          <option value="">My default</option>
          {sharedViews.length > 0 && (
            <optgroup label="Shared">
              {sharedViews.map((v) => <option key={v.id} value={`s:${v.id}`}>★ {v.name}</option>)}
            </optgroup>
          )}
          {personalViews.length > 0 && (
            <optgroup label="My views">
              {personalViews.map((v) => <option key={v.id} value={`p:${v.id}`}>{v.name}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      {active && dirty && <span className="view-dirty">Unsaved changes</span>}
      {canSave && (
        <button type="button" className="btn btn-accent btn-sm" onClick={onSave} disabled={busy}>
          Save{isShared ? " for everyone" : ""}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onSaveAsNew} disabled={busy}>
        Save as my view…
      </button>
      {isAdmin && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onShareAsNew} disabled={busy}
          title="Publish the current setup as a standard view everyone can pick">
          Share as standard view…
        </button>
      )}
      {canDelete && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} disabled={busy}>
          Delete view
        </button>
      )}
      {isShared && active && (
        <span className="cell-sub">
          Standard view{active.updated_by ? ` · last saved by ${active.updated_by}` : ""}
          {!isAdmin && dirty ? " · your changes aren't saved — use “Save as my view”" : ""}
        </span>
      )}
    </div>
  );
}
