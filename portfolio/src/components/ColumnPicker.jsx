import { useEffect, useRef, useState } from "react";

// Each person's own table setup (Ben, 2026-10-06): tick columns on or off and
// move them up or down. "Project" is pinned first. Saved per Einbau ID by the
// worker (save_prefs), so it follows the person to any device.
export default function ColumnPicker({ catalog, setup, onChange, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Saved order first (known columns only), then anything newer in catalogue order.
  const known = new Set(catalog.map((c) => c.key));
  const saved = (setup.order || []).filter((k) => known.has(k) && k !== "name");
  const order = [...saved, ...catalog.map((c) => c.key).filter((k) => k !== "name" && !saved.includes(k))];
  const hidden = new Set(setup.hidden || []);
  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const shownCount = order.filter((k) => !hidden.has(k)).length + 1;

  const save = (nextOrder, nextHidden) => onChange({ order: ["name", ...nextOrder], hidden: [...nextHidden] });

  function toggle(key) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    save(order, next);
  }

  function move(key, delta) {
    const i = order.indexOf(key);
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    save(next, hidden);
  }

  return (
    <div className="column-picker" ref={ref}>
      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Columns ({shownCount})
      </button>
      {open && (
        <div className="column-picker-menu" role="group" aria-label="Table columns">
          <div className="column-picker-row is-locked">
            <input type="checkbox" checked disabled aria-label="Project (always shown)" />
            <span className="column-picker-label">Project</span>
            <span className="cell-sub">always first</span>
          </div>
          {order.map((key, i) => {
            const c = byKey.get(key);
            return (
              <div key={key} className={`column-picker-row${hidden.has(key) ? " is-off" : ""}`}>
                <input type="checkbox" checked={!hidden.has(key)} onChange={() => toggle(key)} aria-label={`Show ${c.label}`} />
                <span className="column-picker-label">{c.label}</span>
                <button type="button" className="column-move" onClick={() => move(key, -1)} disabled={i === 0} aria-label={`Move ${c.label} left`}>↑</button>
                <button type="button" className="column-move" onClick={() => move(key, 1)} disabled={i === order.length - 1} aria-label={`Move ${c.label} right`}>↓</button>
              </div>
            );
          })}
          <div className="column-picker-footer">
            <span className="cell-sub">Saved to your Einbau ID · ↑ moves a column left</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Reset to default</button>
          </div>
        </div>
      )}
    </div>
  );
}
