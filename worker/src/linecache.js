// A memory of each Procore record's line items, for the sidebar's LISTS only
// (Ben, 2026-11-16). On 2026-11-16 LEDGER used all 600 calls of its hour while
// Devid marked 34 commitments Already Billed: every reload of the commitments
// list re-read the lines of every commitment with a LEDGER mark on it, about
// 38 calls a reload. Direct costs did the same for partly-billed DCs.
//
// A cached copy is used only while the record's header, which the list reads
// anyway, still matches: its total and its updated_at. Tested on Test Project
// 2026-11-16: a DC line's amount change moves both the header total and
// updated_at; a description-only edit moves neither, which doesn't matter here
// because the lists only use line ids and amounts. Adding or deleting a line
// with an amount moves the total. A same-total swap or a $0 line would slip
// past the stamp, so a copy is never trusted for more than MAX_AGE_HOURS.
//
// Billing, writing off, budgeting and Already Billed never use this. They
// re-read every record they act on and stop if one is gone.
import { dbQuery } from './db.js';
import { ensureLineCacheSchema } from './schema.js';

const MAX_AGE_HOURS = 6;

// null = this header can't vouch for its lines (no total or no updated_at),
// so the caller fetches them.
export function headerStamp(header) {
  const total = header?.grand_total ?? header?.amount;
  if (total == null || total === '' || !header?.updated_at) return null;
  const n = Number(total);
  if (!Number.isFinite(n)) return null;
  return `${header.updated_at}|${n.toFixed(2)}`;
}

// recordId(string) -> { stamp, lines }. A failure reads as "nothing cached",
// so the list just fetches as it did before.
export async function loadLineCache(env, tenantId, projectId, kind, maxAgeHours = MAX_AGE_HOURS) {
  try {
    await ensureLineCacheSchema(env);
    const rows = await dbQuery(
      env,
      `select record_id, stamp, lines from procore_line_cache
       where tenant_id = $1 and project_id = $2 and record_kind = $3
         and fetched_at > now() - make_interval(hours => $4)`,
      [String(tenantId), String(projectId), kind, maxAgeHours]
    );
    return new Map(rows.map(r => [String(r.record_id), { stamp: r.stamp, lines: r.lines }]));
  } catch (e) {
    console.log('[line-cache] read failed, fetching instead:', e.message);
    return new Map();
  }
}

// The cached lines when the stamp still matches, else null.
export function cachedLines(cache, recordId, stamp) {
  if (!stamp) return null;
  const hit = cache.get(String(recordId));
  return hit && hit.stamp === stamp && Array.isArray(hit.lines) ? hit.lines : null;
}

// Keeps only what the lists use: each line's id and amount.
export function slimLines(lines) {
  return (lines || []).map(li => ({ id: li.id, amount: li.amount ?? null }));
}

// entries: [{ recordId, stamp, lines }]. Entries without a stamp are skipped.
// Best effort: a failed save only means the next load fetches again.
export async function saveLineCache(env, tenantId, projectId, kind, entries) {
  const rows = entries.filter(e => e.stamp).map(e => ({ record_id: String(e.recordId), stamp: e.stamp, lines: slimLines(e.lines) }));
  if (rows.length === 0) return;
  try {
    await ensureLineCacheSchema(env);
    await dbQuery(
      env,
      `insert into procore_line_cache (tenant_id, project_id, record_kind, record_id, stamp, lines, fetched_at)
       select $1, $2, $3, x.record_id, x.stamp, x.lines, now()
       from jsonb_to_recordset($4::jsonb) as x(record_id text, stamp text, lines jsonb)
       on conflict (tenant_id, project_id, record_kind, record_id)
       do update set stamp = excluded.stamp, lines = excluded.lines, fetched_at = now()`,
      [String(tenantId), String(projectId), kind, JSON.stringify(rows)]
    );
  } catch (e) {
    console.log('[line-cache] save failed:', e.message);
  }
}
