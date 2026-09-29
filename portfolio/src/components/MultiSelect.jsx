import { useEffect, useRef, useState } from "react";

// Checkbox dropdown for filters where more than one value can apply (stages,
// Ben's ask 2026-09-29). An empty selection means "all".
export default function MultiSelect({ label, allLabel, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(value) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  const summary =
    selected.size === 0 ? allLabel
      : selected.size === 1 ? [...selected][0]
      : `${selected.size} ${label.toLowerCase()}s`;

  return (
    <div className="multi-select" ref={ref}>
      <button
        type="button"
        className={`multi-select-toggle${selected.size ? " is-filtered" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="multi-select-summary">{summary}</span>
        <span className="multi-select-caret">▾</span>
      </button>
      {open && (
        <div className="multi-select-menu" role="group" aria-label={label}>
          {options.map((o) => (
            <label key={o} className="multi-select-option">
              <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
              <span>{o}</span>
            </label>
          ))}
          <div className="multi-select-footer">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(new Set())} disabled={selected.size === 0}>
              Clear
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
