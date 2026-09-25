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
export async function procoreRequest(env, method, path, data) {
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
  });

  let pcResponse = await doRequest(accessToken);

  if (pcResponse.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    accessToken = await getAccessToken(env);
    pcResponse = await doRequest(accessToken);
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

  return { status: pcResponse.status, data: responseData, headers };
}
