// Refused requests → HELM's Security tab (Ben, 2026-10-25; contract in
// auth-worker/README.md "Apps reporting refused requests"). auth-worker only
// sees failures that reach it; anything LEDGER's worker turns away itself (no
// token, a session for someone without LEDGER, a missing permission, a wrong
// service key) is reported here — fire-and-forget, never delaying or failing
// the response. Never sends tokens, keys, passwords or request bodies: only
// the action name and an error code as the detail.

const APP = 'LEDGER';
const WINDOW_MS = 60 * 1000;
// Routes guarded by a shared key rather than a person's session.
const KEY_ONLY_ROUTES = new Set(['/procore-webhook', '/crm/project-financials/refresh']);
// auth-worker sees these itself (LEDGER only proxies them).
const SKIP_ROUTES = new Set(['/auth/login', '/auth/verify']);

// Who was signed in on a request, when known (set by verifyEinbauSession).
export const refusalUser = new WeakMap();

// Flood control: at most one event per ip+outcome+route per minute per
// isolate; repeats in between are counted into the next event.
const recent = new Map(); // key -> { sentAt, pending }

export const einbauAppHeader = { 'X-Einbau-App': APP };

// The browser visitor's details for auth-worker's /auth/login and /auth/verify
// (README "Forwarding the visitor's details", 2026-10-25). A service-binding
// call has no CF-Connecting-IP of its own, so without these every sidebar
// sign-in looked like one visitor — one shared lockout bucket. auth-worker
// only trusts them on service-binding calls. Empty ones are left out.
export function clientHeaders(request) {
  const cf = request.cf || {};
  const pairs = [
    ['X-Einbau-Client-IP', request.headers.get('CF-Connecting-IP')],
    ['X-Einbau-Client-Country', cf.country],
    ['X-Einbau-Client-City', cf.city],
    ['X-Einbau-Client-Org', cf.asOrganization],
    ['X-Einbau-Client-UA', (request.headers.get('User-Agent') || '').slice(0, 300)]
  ];
  return Object.fromEntries(pairs.filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v)]));
}

function send(ctx, env, events) {
  if (!env.AUTH_SERVICE_KEY || !env.AUTH_WORKER || !ctx || events.length === 0) return;
  ctx.waitUntil(
    env.AUTH_WORKER.fetch('https://auth.ben-a90.workers.dev/auth/security/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Service-Key': env.AUTH_SERVICE_KEY },
      body: JSON.stringify({ events: events.slice(0, 25) })
    })
      .then(async (r) => console.log('[security] reported', events.map(e => e.outcome).join(','), '->', r.status, (await r.text()).slice(0, 120)))
      .catch((e) => console.log('[security] report failed:', e.message))
  );
}

function report(ctx, env, request, route, { outcome, username = null, detail = null }) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const key = `${ip}|${outcome}|${route}`;
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev.sentAt < WINDOW_MS) {
    prev.pending++;
    return;
  }
  const count = 1 + (prev?.pending || 0);
  recent.set(key, { sentAt: now, pending: 0 });
  if (recent.size > 2000) {
    for (const [k, v] of recent) if (now - v.sentAt >= WINDOW_MS) recent.delete(k);
  }
  const cf = request.cf || {};
  send(ctx, env, [{
    outcome, route, method: request.method,
    username: username || null,
    ip: ip || null,
    country: cf.country || null, city: cf.city || null, org: cf.asOrganization || null,
    ua: (request.headers.get('User-Agent') || '').slice(0, 200) || null,
    count,
    detail: detail ? String(detail).slice(0, 120) : null
  }]);
}

// Wraps the worker's handler: runs it, and if the response is a refusal,
// classifies and reports it. Successes, OPTIONS preflights and the proxied
// /auth routes are never reported.
export async function watchRefusals(request, env, ctx, handle) {
  const route = new URL(request.url).pathname;
  const skip = request.method === 'OPTIONS' || SKIP_ROUTES.has(route);
  const copy = !skip && request.method === 'POST' ? request.clone() : null;
  const res = await handle();
  if (skip || ![401, 403, 500].includes(res.status)) return res;
  try {
    let errorBody = null;
    try { errorBody = await res.clone().json(); } catch { /* not JSON */ }
    let outcome;
    if (res.status === 500) {
      // The one permission refusal that surfaces as an error: pm/accounting
      // undoing someone else's mark.
      if (!/^You can only undo/.test(errorBody?.error || '')) return res;
      outcome = 'forbidden';
    } else if (KEY_ONLY_ROUTES.has(route)) {
      if (res.status !== 401) return res;
      outcome = 'bad_service_key';
    } else if (res.status === 403) {
      outcome = 'forbidden';
    } else {
      const bearer = (request.headers.get('Authorization') || '').startsWith('Bearer ');
      outcome = bearer ? 'bad_session' : request.headers.get('X-Ledger-Service-Key') ? 'bad_service_key' : 'no_token';
    }
    let action = null;
    try { action = copy ? (await copy.json())?.action : null; } catch { /* no JSON body */ }
    const detail = [action, errorBody?.code].filter(Boolean).join(' · ') || null;
    report(ctx, env, request, route, { outcome, username: refusalUser.get(request) || null, detail });
  } catch { /* reporting must never affect the response */ }
  return res;
}
