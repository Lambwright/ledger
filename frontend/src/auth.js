// Einbau ID for the Procore sidebar (Ben's ask 2026-09-28): only people with
// LEDGER ticked in HELM can use it. The sidebar is on ledger-sidebar.pages.dev,
// which auth-worker's CORS doesn't allow, so login/verify go through LEDGER's
// own worker (it proxies them to auth-worker). Every API call then sends the
// token, and the worker checks it — see worker/src/index.js.
//
// Storage note: inside Procore's iframe the browser keeps this token separate
// from the same site opened on its own (storage partitioning), so the popout
// windows can't read it. They ask the window that opened them for it by
// postMessage (requestTokenFromOpener / serveTokenToPopouts), same origin only
// both ways. Until 2026-11-24 it rode in the URL as #t=<token>, so a copied or
// forwarded pop-out link carried a working session (HELM security review).

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

// Authorization header for the signed-in person; none at all when signed out
// (never "Bearer null").
export function authHeader(token = getToken()) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// An old pop-out link may still carry #t=<token>. It's never used; it's just
// wiped from the address bar.
export function dropTokenFromHash() {
  if (/[#&]t=/.test(window.location.hash)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

// Every LEDGER window answers its own pop-outs' token requests. Only a window
// on this same origin gets an answer, and only sent to that origin.
export function serveTokenToPopouts() {
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin || e.data?.type !== 'ledger:token-request' || !e.source) return;
    const token = getToken();
    if (token) e.source.postMessage({ type: 'ledger:token', token }, window.location.origin);
  });
}

// A pop-out asks its opener for the session. Resolves the token, or null if
// there's no opener on this origin or it doesn't answer within ~2 seconds.
export function requestTokenFromOpener() {
  return new Promise((resolve) => {
    const opener = window.opener;
    if (!opener || opener === window) return resolve(null);
    let done = false;
    const finish = (token) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(giveUp);
      window.removeEventListener('message', onMessage);
      resolve(token);
    };
    const onMessage = (e) => {
      if (e.origin !== window.location.origin || e.source !== opener || e.data?.type !== 'ledger:token') return;
      finish(typeof e.data.token === 'string' && e.data.token ? e.data.token : null);
    };
    const ask = () => {
      try { opener.postMessage({ type: 'ledger:token-request' }, window.location.origin); } catch { finish(null); }
    };
    window.addEventListener('message', onMessage);
    const timer = setInterval(ask, 250);
    const giveUp = setTimeout(() => finish(null), 2000);
    ask();
  });
}

const LOGIN_ERROR_MESSAGES = {
  invalid_credentials: 'Incorrect username or password.',
  rate_limited: 'Too many attempts — try again in a few minutes.',
  invalid_request: 'Enter a username and password.',
  no_app_access: "Your account doesn't have access to any apps yet. Ask your admin to grant you access.",
  no_ledger_access: "You don't have access to LEDGER — ask your admin to grant it.",
  // auth-worker blocks an address that keeps sending bad tokens (429, 2026-11-24).
  blocked: 'Too many failed attempts from this network — try again later.',
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
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: '{}',
    });
    const data = await res.json().catch(() => ({ valid: false }));
    if (data.valid && data.refreshedToken) storeToken(data.refreshedToken);
    return data;
  } catch (e) {
    return { valid: false, error: `Couldn't reach the login service: ${e.message}` };
  }
}
