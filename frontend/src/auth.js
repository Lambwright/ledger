// Einbau ID for the Procore sidebar (Ben's ask 2026-09-28): only people with
// LEDGER ticked in HELM can use it. The sidebar is on ledger-sidebar.pages.dev,
// which auth-worker's CORS doesn't allow, so login/verify go through LEDGER's
// own worker (it proxies them to auth-worker). Every API call then sends the
// token, and the worker checks it — see worker/src/index.js.
//
// Storage note: inside Procore's iframe the browser keeps this token separate
// from the same site opened on its own (storage partitioning), so the popout
// windows can't read it. They're handed it in the URL hash instead
// (withTokenHash), which never reaches a server and is wiped on arrival.

const WORKER_URL = import.meta.env.VITE_WORKER_URL;
const TOKEN_KEY = 'einbau_id_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked — the session just won't survive a reload.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

// A popout opened with #t=<token> adopts it, then removes it from the address bar.
export function adoptTokenFromHash() {
  const match = window.location.hash.match(/[#&]t=([^&]+)/);
  if (!match) return;
  storeToken(decodeURIComponent(match[1]));
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function withTokenHash(url) {
  const token = getToken();
  if (token) url.hash = `t=${encodeURIComponent(token)}`;
  return url;
}

const LOGIN_ERROR_MESSAGES = {
  invalid_credentials: 'Incorrect username or password.',
  rate_limited: 'Too many attempts — try again in a few minutes.',
  invalid_request: 'Enter a username and password.',
  no_app_access: "Your account doesn't have access to any apps yet. Ask an admin to grant you access in HELM.",
  no_ledger_access: "You don't have access to LEDGER — ask Ben to grant it in HELM.",
};

export function authErrorMessage(code) {
  return LOGIN_ERROR_MESSAGES[code] || null;
}

export async function login(username, password) {
  const res = await fetch(`${WORKER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // remember: asks for a long-lived session (auth-worker, once supported)
    // so the sidebar doesn't need a fresh login every day.
    body: JSON.stringify({ username, password, remember: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(authErrorMessage(data.error) || data.error || 'Login failed.');
  }
  storeToken(data.token);
  return data.user;
}

// { valid, user?, error? } — never throws.
export async function verify(token) {
  try {
    const res = await fetch(`${WORKER_URL}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const data = await res.json().catch(() => ({ valid: false }));
    if (data.valid && data.refreshedToken) storeToken(data.refreshedToken);
    return data;
  } catch (e) {
    return { valid: false, error: `Couldn't reach the login service: ${e.message}` };
  }
}
