// Per-person view preferences — e.g. which dashboard columns someone shows and
// in what order (Ben, 2026-10-06). Stored per Einbau ID username so they follow
// the person between devices. Any LEDGER level may save their own: it changes
// nothing but their own view.
import { dbQuery } from './db.js';
import { ensurePrefsSchema } from './schema.js';

// Only these keys may be stored, each with a size cap.
const ALLOWED = { portfolio_columns: 4000 };

export async function getPrefs(env, tenantId, username) {
  await ensurePrefsSchema(env);
  const rows = await dbQuery(
    env,
    `select pref_key, value from user_preferences where tenant_id = $1 and username = $2`,
    [tenantId, username]
  );
  return Object.fromEntries(rows.map((r) => [r.pref_key, r.value]));
}

export async function savePref(env, tenantId, username, key, value) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, key)) throw new Error(`Unknown preference: ${key}`);
  const json = JSON.stringify(value ?? null);
  if (json.length > ALLOWED[key]) throw new Error('That preference is too large to save.');
  await ensurePrefsSchema(env);
  await dbQuery(
    env,
    `insert into user_preferences (tenant_id, username, pref_key, value) values ($1, $2, $3, $4::jsonb)
     on conflict (tenant_id, username, pref_key) do update set value = excluded.value, updated_at = now()`,
    [tenantId, username, key, json]
  );
  return { saved: true };
}
