// Einbau ID — same pattern as every other suite app (copied from HELM's
// auth.js): own login screen, calls auth-worker directly, keeps the shared
// token in localStorage under the suite-wide key.

const TOKEN_KEY = "einbau_id_token";

const AUTH_BASE = import.meta.env.DEV
  ? ""
  : import.meta.env.VITE_AUTH_API || "https://auth.ben-a90.workers.dev";

export function getStoredToken() {
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
    // Private browsing / storage blocked — session just won't persist across reloads.
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

const LOGIN_ERROR_MESSAGES = {
  invalid_credentials: "Incorrect username or password.",
  rate_limited: "Too many attempts — try again in a few minutes.",
  invalid_request: "Enter a username and password.",
  no_app_access: "Your account doesn't have access to any apps yet. Ask an admin to grant you access in HELM.",
};

export async function login(username, password) {
  const res = await fetch(`${AUTH_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(LOGIN_ERROR_MESSAGES[data.error] || data.error || "Login failed.");
  }
  storeToken(data.token);
  return data.user;
}

// Returns { valid, user?, reason? } — never throws.
export async function verify(token) {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    });
    const data = await res.json().catch(() => ({ valid: false }));
    if (data.valid && data.refreshedToken) storeToken(data.refreshedToken);
    return data;
  } catch (e) {
    return { valid: false, reason: `Couldn't reach the login service: ${e.message}` };
  }
}

// Access = a LEDGER level in user.appRoles (Einbau ID role matrix, 2026-09-30);
// 'access' means LEDGER's Live switch in HELM is still off. Mirrors worker/src/roles.js.
const LEDGER_LEVELS = ["admin", "accounting", "pm", "viewer", "access"];
export function hasLedgerAccess(user) {
  return LEDGER_LEVELS.includes(String(user?.appRoles?.LEDGER ?? "").toLowerCase());
}

export function logout() {
  clearToken();
}
