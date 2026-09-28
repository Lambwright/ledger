import { useEffect, useRef, useState } from "react";

// Suite app switcher — same list and rules as HELM/TALLY/HANDOFF/SCOUT/INTAKE.
const CURRENT_APP = "LEDGER";
const APP_LINKS = [
  { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
  { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
  { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
  { name: "TALLY", url: "https://lambwright.github.io/tally/" },
  { name: "HANDOFF", url: "https://lambwright.github.io/handoff/" },
  { name: "LEDGER", url: "https://lambwright.github.io/ledger/" },
  { name: "CRM", url: "https://lambwright.github.io/crm/" },
];
const HELM_LINK = { name: "HELM", url: "https://lambwright.github.io/helm/" };

// Only apps this user can open, then HELM always last (it's where settings
// live). No apps granted = nothing but this app and HELM (access fails
// closed — see auth-worker/README.md).
function appLinks(user) {
  const apps = (Array.isArray(user?.apps) ? user.apps : []).map((a) => String(a).toUpperCase());
  const allowed = (name) => apps.includes(name);
  return [...APP_LINKS.filter((a) => a.name === CURRENT_APP || allowed(a.name)), HELM_LINK].map((a) => ({
    ...a,
    current: a.name === CURRENT_APP,
  }));
}

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
            {appLinks(user).map((app) => (
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
