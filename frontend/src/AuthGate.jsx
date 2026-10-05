import { useCallback, useEffect, useState } from 'react';
import { adoptTokenFromHash, authErrorMessage, clearToken, getToken, login, verify } from './auth';
import { applyAccentPreset } from './accentPresets';

// Wraps the sidebar and its API-calling popouts: nothing renders until an
// Einbau ID with LEDGER access is signed in. The worker enforces the same
// rule on every call (this screen is just the front door).
// Access = a LEDGER level in user.appRoles (Einbau ID role matrix, 2026-09-30);
// 'access' means LEDGER's Live switch in HELM is still off. Mirrors worker/src/roles.js.
const LEDGER_LEVELS = ['admin', 'accounting', 'pm', 'viewer', 'access'];
const hasLedger = (user) => LEDGER_LEVELS.includes(String(user?.appRoles?.LEDGER ?? '').toLowerCase());

export default function AuthGate({ children }) {
  const [state, setState] = useState('checking'); // checking | out | in
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(null);

  // The ONLY way a session ends (sign-out button, or any API call coming
  // back 401) — so the personal accent is always reset with it.
  const signOut = useCallback((message = null) => {
    clearToken();
    applyAccentPreset(null);
    setUser(null);
    setNotice(message);
    setState('out');
  }, []);

  const signIn = useCallback((u) => {
    if (!hasLedger(u)) {
      signOut(authErrorMessage('no_ledger_access'));
      return;
    }
    applyAccentPreset(u.themeAccent?.LEDGER || null);
    setUser(u);
    setNotice(null);
    setState('in');
  }, [signOut]);

  useEffect(() => {
    adoptTokenFromHash();
    const token = getToken();
    if (!token) {
      setState('out');
      return;
    }
    verify(token).then((data) => {
      if (data.valid) signIn(data.user);
      else signOut(data.error === 'no_ledger_access' ? authErrorMessage('no_ledger_access') : null);
    });
  }, [signIn, signOut]);

  useEffect(() => {
    const onUnauthorized = () => signOut('Your session ended — sign in again.');
    window.addEventListener('ledger:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ledger:unauthorized', onUnauthorized);
  }, [signOut]);

  if (state === 'checking') {
    return <div className="ledger"><div className="loading">Checking sign-in…</div></div>;
  }
  if (state === 'out') return <SignIn notice={notice} onSignedIn={signIn} />;
  return children(user, () => signOut());
}

function SignIn({ notice, onSignedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await login(username.trim(), password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ledger">
      <header className="ledger-header">
        <div className="ledger-logo">LEDGER</div>
        <div className="ledger-subtitle">Project Billing Reconciliation</div>
      </header>
      <div className="ledger-tagline">An Einbau Product</div>
      <form className="signin" onSubmit={submit}>
        {notice && <div className="banner banner-warning">{notice}</div>}
        <label className="signin-field">
          <span>Username</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="signin-field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="banner banner-error">{error}</div>}
        <button className="generate-btn signin-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="signin-help">Use your Einbau ID — the same login as the other Einbau apps.</div>
      </form>
    </div>
  );
}
