// Low-level Procore API access: OAuth2 client_credentials token handling + a
// generic request helper. See index.js for the full context on why the path
// is passed in full (not one hardcoded base) and the header requirements.

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const tokenResponse = await fetch('https://login.procore.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.PROCORE_CLIENT_ID)}&client_secret=${encodeURIComponent(env.PROCORE_CLIENT_SECRET)}`
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Procore token exchange failed: ${tokenResponse.status} ${errText}`);
  }

  const tokenData = await tokenResponse.json();
  cachedToken = tokenData.access_token;
  tokenExpiresAt = now + (tokenData.expires_in * 1000);
  return cachedToken;
}

// Returns { status, data } — data is the parsed JSON body (or a descriptive
// object if Procore returned something non-JSON). Throws only on genuine
// transport failure, never on a Procore-level error status — callers decide
// what a given status means for their operation.
// Calls made by this isolate — the scheduled run measures its own usage with
// it (see runScheduled's hourly budget in portfolio.js).
let callCount = 0;
export const procoreCallCount = () => callCount;

// ---- LEDGER's hourly Procore usage, shared across worker instances ----
// (Ben, 2026-11-19: show it in the loading animation.) Procore's headers only
// describe the 25-per-minute bucket until the 600/hour one is nearly gone, so
// LEDGER counts its own calls: each instance adds its calls to one row every
// few seconds, using Procore's rule for the hour (it starts at the first call
// after the last reset). Whenever a response does show the 600 bucket, its
// remaining/reset replace the estimate. Never allowed to break a Procore call.
let pendingCalls = 0;
let pendingSince = null;
let lastFlush = 0;
let calibration = null; // { remaining, reset } from a response that showed the 600 bucket
let rateTableReady = false;

function noteCall(res) {
  pendingCalls++;
  if (!pendingSince) pendingSince = new Date();
  const limit = res?.headers?.get?.('x-rate-limit-limit');
  if (limit === '600') {
    const remaining = Number(res.headers.get('x-rate-limit-remaining'));
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    if (Number.isFinite(remaining) && Number.isFinite(reset)) calibration = { remaining, reset };
  }
}

export async function flushRateCount(env, force = false) {
  if (pendingCalls === 0 && !calibration) return;
  if (!force && !calibration && Date.now() - lastFlush < 3000) return;
  const n = pendingCalls;
  const since = pendingSince || new Date();
  const cal = calibration;
  pendingCalls = 0;
  pendingSince = null;
  calibration = null;
  lastFlush = Date.now();
  try {
    const { dbQuery } = await import('./db.js');
    if (!rateTableReady) {
      await dbQuery(env, `create table if not exists procore_rate_window (
        id text primary key, window_start timestamptz, calls integer not null default 0, updated_at timestamptz not null default now()
      )`, []);
      rateTableReady = true;
    }
    if (n > 0) {
      await dbQuery(env, `insert into procore_rate_window (id, window_start, calls, updated_at) values ('ledger', $1, $2, now())
        on conflict (id) do update set
          calls = case when procore_rate_window.window_start is null or $1 >= procore_rate_window.window_start + interval '1 hour'
                       then $2 else procore_rate_window.calls + $2 end,
          window_start = case when procore_rate_window.window_start is null or $1 >= procore_rate_window.window_start + interval '1 hour'
                       then $1 else procore_rate_window.window_start end,
          updated_at = now()`, [since.toISOString(), n]);
    }
    if (cal) {
      await dbQuery(env, `update procore_rate_window set calls = $1, window_start = to_timestamp($2) - interval '1 hour', updated_at = now()
        where id = 'ledger'`, [Math.max(0, 600 - cal.remaining), cal.reset]);
    }
  } catch (e) {
    console.log('[rate] count not saved:', e.message);
  }
}

// { used, limit, resetAt, exhausted } — read from the shared row, no Procore call.
export async function rateStatus(env) {
  await flushRateCount(env, true);
  const { dbQuery } = await import('./db.js');
  const rows = await dbQuery(env, `select window_start, calls,
      (window_start is null or now() >= window_start + interval '1 hour') as expired
    from procore_rate_window where id = 'ledger'`, []).catch(() => []);
  const r = rows[0];
  if (!r || r.expired) return { used: 0, limit: 600, resetAt: null, exhausted: false };
  const used = Math.min(600, Number(r.calls) || 0);
  return {
    used, limit: 600,
    resetAt: new Date(new Date(r.window_start).getTime() + 3600 * 1000).toISOString(),
    exhausted: used >= 600
  };
}

export async function procoreRequest(env, method, path, data) {
  callCount++;
  if (!path || !path.startsWith('/rest/')) {
    throw new Error(`path must be a full Procore /rest/... path, got: ${path}`);
  }

  const url = `https://api.procore.com${path}`;
  let accessToken = await getAccessToken(env);

  const httpMethod = (method || 'GET').toUpperCase();
  const canHaveBody = data && !['GET', 'HEAD'].includes(httpMethod);

  const doRequest = (token) => fetch(url, {
    method: httpMethod,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Procore-Company-Id': env.PROCORE_COMPANY_ID
    },
    body: canHaveBody ? JSON.stringify(data) : undefined
  }).then((res) => { noteCall(res); return res; });

  let pcResponse = await doRequest(accessToken);

  if (pcResponse.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    accessToken = await getAccessToken(env);
    pcResponse = await doRequest(accessToken);
  }

  // A gateway error (502/503/504) is Procore's servers timing out, and one used to kill a whole billing run
  // on a plain read (2026-11-10, a 504 fetching a T&M entry). Reads are safe to repeat, so they get two more
  // tries. Writes don't: a write that timed out may still have gone through, and a repeat could duplicate it.
  if (!canHaveBody && httpMethod !== 'DELETE') {
    for (let retry = 1; retry <= 2 && [502, 503, 504].includes(pcResponse.status); retry++) {
      await pcResponse.text().catch(() => {});
      console.warn(`[procore] ${pcResponse.status} on ${httpMethod} ${path}, retry ${retry}/2`);
      await new Promise((r) => setTimeout(r, retry * 1500));
      callCount++;
      pcResponse = await doRequest(accessToken);
    }
  }

  const responseText = await pcResponse.text();
  let responseData;
  if (!responseText) {
    responseData = { success: pcResponse.ok, status: pcResponse.status };
  } else {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = {
        error: 'non-JSON response from Procore',
        contentType: pcResponse.headers.get('content-type'),
        requestUrl: url,
        bodyPreview: responseText.slice(0, 500)
      };
    }
  }

  // Rate-limit headers, when Procore sends them, tell us the real window
  // instead of us guessing at pacing/backoff numbers — captured 2026-09-14
  // while investigating repeated 429s under heavy testing load.
  const headers = {};
  for (const [key, value] of pcResponse.headers.entries()) {
    if (/rate.?limit|retry-after/i.test(key)) headers[key] = value;
  }

  await flushRateCount(env);
  return { status: pcResponse.status, data: responseData, headers };
}

// Multipart upload (2026-10-28) — attaching files, e.g. T&M ticket backup on
// an invoice (ticketbackup.js). `form` is a FormData; fetch sets the
// multipart boundary itself, so there's no Content-Type here.
export async function procoreUpload(env, method, path, form) {
  callCount++;
  if (!path || !path.startsWith('/rest/')) throw new Error(`path must be a full Procore /rest/... path, got: ${path}`);
  const token = await getAccessToken(env);
  const res = await fetch(`https://api.procore.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Procore-Company-Id': env.PROCORE_COMPANY_ID },
    body: form
  });
  noteCall(res);
  await flushRateCount(env);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { bodyPreview: text.slice(0, 300) }; }
  return { status: res.status, data };
}

// A file Procore hands out as a redirect to signed storage — e.g. a T&M
// ticket's own PDF, GET .../time_and_material_entries/{id}.pdf (found
// 2026-11-03). The storage URL needs no auth, so it's fetched without ours.
// Returns { status, bytes } (bytes only on 200).
export async function procoreDownload(env, path) {
  callCount++;
  if (!path || !path.startsWith('/rest/')) throw new Error(`path must be a full Procore /rest/... path, got: ${path}`);
  const token = await getAccessToken(env);
  const res = await fetch(`https://api.procore.com${path}`, {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${token}`, 'Procore-Company-Id': env.PROCORE_COMPANY_ID }
  });
  noteCall(res);
  await flushRateCount(env);
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    const file = await fetch(location);
    return { status: file.status, bytes: file.ok ? new Uint8Array(await file.arrayBuffer()) : null };
  }
  return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
}
