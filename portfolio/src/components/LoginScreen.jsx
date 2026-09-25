import { useState } from "react";
import { login } from "../auth.js";

export default function LoginScreen({ onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await login(username.trim(), password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="card login-card" onSubmit={handleSubmit}>
        <div className="header-badge" style={{ marginBottom: 24 }}>
          <span className="header-badge-name">LEDGER</span>
          <span className="header-badge-sub">Project Billing Portfolio</span>
          <span className="header-brand-tag">An Einbau Product</span>
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label htmlFor="username">Username</label>
          <input id="username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field" style={{ marginBottom: 4 }}>
          <label htmlFor="password">Password</label>
          <input
            id="password" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-accent login-submit" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <div className="field-help login-help">Use your Einbau ID — the same login as the other Einbau apps.</div>
      </form>
    </div>
  );
}
