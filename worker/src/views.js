// Shared dashboard views (Ben, 2026-10-21): a standard setup — columns,
// filters, sort — that LEDGER admins publish for everyone, e.g. the view used
// in leadership meetings. Everyone can pick one; only admins can save or
// delete. Personal views live in user_preferences (prefs.js,
// 'portfolio_views'); this is only the shared ones.
import { dbQuery } from './db.js';

const MAX_CONFIG = 8000;
const MAX_NAME = 60;

let ready = false;
async function ensureSharedViews(env) {
  if (ready) return;
  await dbQuery(env, `create table if not exists portfolio_shared_views (
    tenant_id text not null,
    id text not null,
    name text not null,
    config jsonb not null,
    created_by text,
    updated_by text,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
  )`, []);
  ready = true;
}

export async function listSharedViews(env, tenantId) {
  await ensureSharedViews(env);
  return dbQuery(
    env,
    `select id, name, config, created_by, updated_by, updated_at from portfolio_shared_views
     where tenant_id = $1 order by lower(name)`,
    [tenantId]
  );
}

// Creates (no id) or replaces (id) a shared view.
export async function saveSharedView(env, tenantId, { id, name, config }, user) {
  const cleanName = String(name || '').trim().slice(0, MAX_NAME);
  if (!cleanName) throw new Error('A shared view needs a name.');
  const json = JSON.stringify(config ?? {});
  if (json.length > MAX_CONFIG) throw new Error('That view is too large to save.');
  await ensureSharedViews(env);
  const viewId = id ? String(id) : crypto.randomUUID();
  await dbQuery(
    env,
    `insert into portfolio_shared_views (tenant_id, id, name, config, created_by, updated_by, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, $5, now())
     on conflict (tenant_id, id) do update set name = excluded.name, config = excluded.config,
       updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, viewId, cleanName, json, user.username]
  );
  return { id: viewId, name: cleanName };
}

export async function deleteSharedView(env, tenantId, id) {
  await ensureSharedViews(env);
  await dbQuery(env, `delete from portfolio_shared_views where tenant_id = $1 and id = $2`, [tenantId, String(id)]);
  return { deleted: true };
}
