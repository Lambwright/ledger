import { useEffect, useRef, useState } from "react";

// Suite app switcher — same list every Einbau app carries (from HELM's
// Header.jsx), with LEDGER marked current.
const APP_LINKS = [
  { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
  { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
  { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
  { name: "TALLY", url: "https://lambwright.github.io/tally/" },
  { name: "HANDOFF", url: "https://lambwright.github.io/handoff/" },
  { name: "LEDGER", url: "https://lambwright.github.io/ledger/", current: true },
  { name: "HELM", url: "https://lambwright.github.io/helm/" },
  { name: "CRM", url: "https://lambwright.github.io/crm/" },
];

export default function Header({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="header">
      <div className="header-badge app-switcher" ref={ref}>
        <button
          type="button"
          className="header-badge-name app-switcher-toggle"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          LEDGER<span className="app-switcher-caret">▾</span>
        </button>
        <span className="header-badge-sub">Project Billing Portfolio</span>
        <span className="header-brand-tag">An Einbau Product</span>
        {open && (
          <div className="app-switcher-menu">
            {APP_LINKS.map((app) => (
              <a className={`app-switcher-item${app.current ? " current" : ""}`} href={app.url} key={app.name}>
                {app.name}
              </a>
            ))}
          </div>
        )}
      </div>
      {user && (
        <div className="header-user">
          <span className="header-username">{user.displayName || user.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
        </div>
      )}
    </div>
  );
}
