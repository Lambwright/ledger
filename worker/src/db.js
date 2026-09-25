// Low-level Neon (Postgres) access. See index.js for why Neon rather than
// Supabase, and why plain parameterized SQL rather than a query builder.

import { neon } from '@neondatabase/serverless';

let sqlClient = null;

function getSql(env) {
  if (sqlClient) return sqlClient;
  if (!env.NEON_DATABASE_URL) {
    throw new Error('NEON_DATABASE_URL not configured on this Worker yet');
  }
  sqlClient = neon(env.NEON_DATABASE_URL.trim());
  return sqlClient;
}

// $1, $2, ... placeholders, values passed separately — never string-interpolated.
export async function dbQuery(env, query, params) {
  const sql = getSql(env);
  return await sql.query(query, params || []);
}
