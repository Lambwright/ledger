// Queued reconciling (Ben, 2026-11-19). Budgeted / Written off / Already
// Billed no longer run when they're clicked: each click is saved here (no
// Procore calls at all) and the overnight run does the real work, so a day of
// reconciling can't use up the 600 calls/hour people need for invoicing.
//
// - The sidebar shows each queued item as "To be budgeted" etc. and won't let
//   it be billed; its owner (or a LEDGER admin) can cancel it before tonight.
// - Overnight, each request is re-read from Procore by the same code as before
//   (writeOffRecords / markAsBudgeted / markAsAlreadyBilled), so a deleted
//   record still stops it. On top of that, every item is checked against the
//   amount the person saw when they queued it: if it changed (T&M hours edited,
//   lines added, already marked by someone else…) nothing is written for that
//   item and it fails with the reason.
// - Failed items show on the item in the sidebar ("Couldn't be budgeted
//   overnight: …") until the person marks it again or dismisses it, and in the
//   dashboard's overnight digest for LEDGER admins until an admin reviews it.
//
// Item kinds and keys (what the sidebar can show a badge on):
//   tm   T&M ticket id (its unbilled hours)    dc   direct cost id (all open lines)
//   mat  T&M material id                       dcl  "<dcId>:<lineId>"
//   cml  "<commitmentId>:<lineId>"
import { dbQuery } from './db.js';
import { writeOffRecords, markAsBudgeted, markAsAlreadyBilled, WRITE_OFF_REASONS } from './app.js';

const ACTIONS = { written_off: 'write off', budgeted: 'mark as budgeted', already_billed: 'mark as already billed' };
const KINDS = new Set(['tm', 'mat', 'dc', 'dcl', 'cml']);

let ready = false;
export async function ensureQueueSchema(env) {
  if (ready) return;
  await dbQuery(env, `create table if not exists reconcile_queue (
    id uuid primary key default gen_random_uuid(),
    tenant_id text not null,
    project_id text not null,
    action text not null check (action in ('written_off', 'budgeted', 'already_billed')),
    options jsonb not null default '{}'::jsonb,
    requested_by text not null,
    requested_at timestamptz not null default now(),
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'partly_failed', 'cancelled')),
    started_at timestamptz,
    completed_at timestamptz,
    attempts integer not null default 0
  )`, []);
  await dbQuery(env, `create table if not exists reconcile_queue_items (
    queue_id uuid not null references reconcile_queue(id) on delete cascade,
    tenant_id text not null,
    project_id text not null,
    item_kind text not null,
    item_key text not null,
    label text,
    expected_amount numeric,
    material_amount numeric,
    status text not null default 'queued' check (status in ('queued', 'done', 'failed', 'cancelled')),
    error text,
    actual_amount numeric,
    tried_at timestamptz,
    dismissed_at timestamptz,
    reviewed_by text,
    reviewed_at timestamptz,
    primary key (queue_id, item_kind, item_key)
  )`, []);
  await dbQuery(env, `create index if not exists reconcile_queue_items_project on reconcile_queue_items (tenant_id, project_id, status)`, []);
  await dbQuery(env, `create index if not exists reconcile_queue_status on reconcile_queue (tenant_id, status, requested_at)`, []);
  ready = true;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Saves a click as a queued request. items: [{ kind, key, label, expected, amount? }]
// (amount = a material's value). No Procore calls.
export async function queueReconcile(env, { tenantId, projectId, action, items, options = {}, userId }) {
  await ensureQueueSchema(env);
  if (!ACTIONS[action]) throw new Error(`Unknown action: ${action}`);
  const clean = (Array.isArray(items) ? items : [])
    .filter(i => i && KINDS.has(i.kind) && i.key != null && String(i.key) !== '')
    .map(i => ({
      kind: i.kind, key: String(i.key), label: i.label ? String(i.label).slice(0, 200) : null,
      expected: i.expected == null || i.expected === '' || !Number.isFinite(Number(i.expected)) ? null : round2(i.expected),
      amount: i.kind === 'mat' ? round2(Number(i.amount) || 0) : null
    }));
  if (clean.length === 0) throw new Error(`Nothing selected to ${ACTIONS[action]}.`);
  const opts = {
    reasonCategory: options.reasonCategory || null,
    reasonNotes: options.reasonNotes || null,
    notes: options.notes || null,
    invoiceNumber: options.invoiceNumber?.trim() || null
  };
  if (action === 'written_off' && !WRITE_OFF_REASONS.includes(opts.reasonCategory)) {
    throw new Error('Choose a reason before writing off.');
  }
  const already = await dbQuery(env, `
    select i.item_kind, i.item_key, i.label, q.action from reconcile_queue_items i join reconcile_queue q on q.id = i.queue_id
    where i.tenant_id = $1 and i.project_id = $2 and i.status = 'queued'
      and (i.item_kind || '|' || i.item_key) = any($3::text[])`,
  [tenantId, String(projectId), clean.map(i => `${i.kind}|${i.key}`)]);
  if (already.length > 0) {
    throw new Error(`Already queued for tonight: ${already.map(a => a.label || a.item_key).slice(0, 5).join(', ')}${already.length > 5 ? '…' : ''}. Cancel that first to change it.`);
  }
  const q = await dbQuery(env, `insert into reconcile_queue (tenant_id, project_id, action, options, requested_by)
    values ($1, $2, $3, $4::jsonb, $5) returning id, requested_at`,
  [tenantId, String(projectId), action, JSON.stringify(opts), userId || 'ledger-system']);
  const queueId = q[0].id;
  const values = [];
  const params = [queueId, tenantId, String(projectId)];
  clean.forEach((i, n) => {
    const b = 4 + n * 5;
    values.push(`($1, $2, $3, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    params.push(i.kind, i.key, i.label, i.expected, i.amount);
  });
  await dbQuery(env, `insert into reconcile_queue_items (queue_id, tenant_id, project_id, item_kind, item_key, label, expected_amount, material_amount)
    values ${values.join(', ')}`, params);
  // Marking it again replaces an old overnight failure's badge.
  await dbQuery(env, `update reconcile_queue_items set dismissed_at = now()
    where tenant_id = $1 and project_id = $2 and status = 'failed' and dismissed_at is null
      and (item_kind || '|' || item_key) = any($3::text[])`,
  [tenantId, String(projectId), clean.map(i => `${i.kind}|${i.key}`)]);
  return { queueId, queued: clean.length, total: round2(clean.reduce((s, i) => s + (i.expected ?? i.amount ?? 0), 0)), state: await queueState(env, { tenantId, projectId }) };
}

// What the sidebar shows on items: everything queued, plus overnight failures
// not yet dismissed. DB only.
export async function queueState(env, { tenantId, projectId }) {
  await ensureQueueSchema(env);
  const rows = await dbQuery(env, `
    select i.item_kind as kind, i.item_key as key, i.label, i.status, i.error, i.expected_amount as expected,
           i.actual_amount as actual, i.tried_at, q.action, q.requested_by, q.requested_at, q.id as queue_id
    from reconcile_queue_items i join reconcile_queue q on q.id = i.queue_id
    where i.tenant_id = $1 and i.project_id = $2
      and (i.status = 'queued' or (i.status = 'failed' and i.dismissed_at is null))
    order by q.requested_at`, [tenantId, String(projectId)]);
  return rows.map(r => ({
    ...r,
    expected: r.expected == null ? null : Number(r.expected),
    actual: r.actual == null ? null : Number(r.actual)
  }));
}

// Cancel a queued item, or dismiss a failed one. pm/accounting: their own only.
export async function cancelQueued(env, { tenantId, projectId, kind, key, onlyRequestedBy = null }) {
  await ensureQueueSchema(env);
  const rows = await dbQuery(env, `
    select i.queue_id, i.status, q.requested_by from reconcile_queue_items i join reconcile_queue q on q.id = i.queue_id
    where i.tenant_id = $1 and i.project_id = $2 and i.item_kind = $3 and i.item_key = $4
      and (i.status = 'queued' or (i.status = 'failed' and i.dismissed_at is null))`,
  [tenantId, String(projectId), kind, String(key)]);
  if (rows.length === 0) return { changed: 0, state: await queueState(env, { tenantId, projectId }) };
  if (onlyRequestedBy && rows.some(r => r.requested_by !== onlyRequestedBy)) {
    throw new Error('Only the person who queued this (or a LEDGER admin) can cancel it.');
  }
  for (const r of rows) {
    if (r.status === 'queued') {
      await dbQuery(env, `update reconcile_queue_items set status = 'cancelled', tried_at = now()
        where queue_id = $1 and item_kind = $2 and item_key = $3 and status = 'queued'`, [r.queue_id, kind, String(key)]);
      await dbQuery(env, `update reconcile_queue set status = 'cancelled', completed_at = now()
        where id = $1 and status = 'queued'
          and not exists (select 1 from reconcile_queue_items where queue_id = $1 and status = 'queued')`, [r.queue_id]);
    } else {
      await dbQuery(env, `update reconcile_queue_items set dismissed_at = now()
        where queue_id = $1 and item_kind = $2 and item_key = $3`, [r.queue_id, kind, String(key)]);
    }
  }
  return { changed: rows.length, state: await queueState(env, { tenantId, projectId }) };
}

// Ids that are queued on a project, by kind — billing refuses them.
export async function queuedConflicts(env, { tenantId, projectId, entryIds = [], directCostIds = [], directCostLineIds = [], commitmentLineIds = [], materialIds = [] }) {
  await ensureQueueSchema(env);
  const wanted = [
    ...entryIds.map(id => `tm|${id}`), ...materialIds.map(id => `mat|${id}`),
    ...directCostIds.map(id => `dc|${id}`), ...directCostLineIds.map(id => `dcl|${id}`),
    // A whole DC queued also covers each of its lines, and the reverse.
    ...directCostLineIds.map(k => `dc|${String(k).split(':')[0]}`),
    ...commitmentLineIds.map(id => `cml|${id}`)
  ];
  if (wanted.length === 0) return [];
  const rows = await dbQuery(env, `
    select i.label, i.item_key, q.action from reconcile_queue_items i join reconcile_queue q on q.id = i.queue_id
    where i.tenant_id = $1 and i.project_id = $2 and i.status = 'queued'
      and ((i.item_kind || '|' || i.item_key) = any($3::text[])
        or (i.item_kind = 'dcl' and split_part(i.item_key, ':', 1) = any($4::text[])))`,
  [tenantId, String(projectId), wanted, directCostIds.map(String)]);
  return rows;
}

// ---------- overnight ----------

// Which queued item a row to be written belongs to.
function itemOfRow(row, keys) {
  const id = String(row.procoreRecordId);
  if (row.recordType === 'timecard' || !row.recordType) return row.entryId != null ? `tm|${row.entryId}` : null;
  if (row.recordType === 'tm_material') return `mat|${id}`;
  if (row.recordType === 'commitment_line') return `cml|${id}`;
  if (row.recordType === 'direct_cost_line') return keys.has(`dcl|${id}`) ? `dcl|${id}` : `dc|${id.split(':')[0]}`;
  return null;
}

class ItemsChanged extends Error {
  constructor(problems) {
    super('changed');
    this.problems = problems; // Map "kind|key" -> { actual, message }
  }
}

function changeCheck(items, problemsOut) {
  return async (rows) => {
    const keys = new Set(items.map(i => `${i.item_kind}|${i.item_key}`));
    const actual = new Map([...keys].map(k => [k, 0]));
    for (const r of rows) {
      const k = itemOfRow(r, keys);
      if (k && actual.has(k)) actual.set(k, actual.get(k) + (Number(r.amount) || 0));
    }
    const problems = new Map();
    for (const i of items) {
      const k = `${i.item_kind}|${i.item_key}`;
      const got = round2(actual.get(k) || 0);
      if (i.expected_amount == null) continue;
      const want = round2(i.expected_amount);
      if (Math.abs(got - want) < 0.01) continue;
      problems.set(k, {
        actual: got,
        message: got === 0
          ? `Nothing left to mark: it was already billed, written off, budgeted or put on a draft CO since it was queued.`
          : `Changed since it was queued: it was ${money(want)} then, it's ${money(got)} now.`
      });
    }
    if (problems.size > 0) {
      problemsOut.value = problems;
      throw new ItemsChanged(problems);
    }
  };
}

function money(n) {
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function argsFor(q, items) {
  const of = (kind) => items.filter(i => i.item_kind === kind).map(i => i.item_key);
  const materials = items.filter(i => i.item_kind === 'mat');
  return {
    tenantId: q.tenant_id, projectId: q.project_id, userId: q.requested_by,
    entryIds: of('tm'), directCostIds: of('dc'), directCostLineIds: of('dcl'), commitmentIds: [], commitmentLineIds: of('cml'),
    materialIds: materials.map(m => m.item_key),
    materialAmounts: Object.fromEntries(materials.map(m => [m.item_key, Number(m.material_amount) || 0])),
    reasonCategory: q.options?.reasonCategory, reasonNotes: q.options?.reasonNotes,
    notes: q.options?.notes, invoiceNumber: q.options?.invoiceNumber
  };
}

async function runOnce(env, q, items) {
  const problems = { value: null };
  const args = { ...argsFor(q, items), beforeInsert: changeCheck(items, problems) };
  if (q.action === 'written_off') return writeOffRecords(env, args);
  if (q.action === 'budgeted') return markAsBudgeted(env, args);
  return markAsAlreadyBilled(env, args);
}

const isRateLimit = (e) => /\b429\b|rate limit/i.test(String(e?.message || e));

async function setItems(env, queueId, items, status, error = null, actual = null) {
  for (const i of items) {
    await dbQuery(env, `update reconcile_queue_items set status = $4, error = $5, actual_amount = $6, tried_at = now()
      where queue_id = $1 and item_kind = $2 and item_key = $3`,
    [queueId, i.item_kind, i.item_key, status, error, actual]);
  }
}

export async function hasQueuedReconciles(env, tenantId) {
  await ensureQueueSchema(env);
  const rows = await dbQuery(env, `select 1 from reconcile_queue where tenant_id = $1 and status = 'queued' limit 1`, [tenantId]);
  return rows.length > 0;
}

// One queued request per call, oldest first. Returns a log line, or null if
// there was nothing to do. A rate limit puts it back in the queue untouched.
export async function processNextQueuedReconcile(env, tenantId) {
  await ensureQueueSchema(env);
  // A run that died mid-way leaves 'running' — back in the queue after 20 min.
  await dbQuery(env, `update reconcile_queue set status = 'queued'
    where tenant_id = $1 and status = 'running' and started_at < now() - interval '20 minutes'`, [tenantId]);
  const picked = await dbQuery(env, `
    update reconcile_queue set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (select id from reconcile_queue where tenant_id = $1 and status = 'queued' order by requested_at limit 1 for update skip locked)
    returning *`, [tenantId]);
  const q = picked[0];
  if (!q) return null;
  const items = await dbQuery(env, `select * from reconcile_queue_items where queue_id = $1 and status = 'queued'`, [q.id]);
  if (items.length === 0) {
    await dbQuery(env, `update reconcile_queue set status = 'cancelled', completed_at = now() where id = $1`, [q.id]);
    return `queue ${q.id}: nothing left (cancelled)`;
  }

  const failed = [];
  const done = [];
  // Run the whole request; on a change, drop the changed items and run the
  // rest once more; on any other error, run each item alone so one deleted
  // record doesn't fail the others.
  let pending = items;
  for (let round = 0; round < 2 && pending.length > 0; round++) {
    try {
      await runOnce(env, q, pending);
      done.push(...pending);
      pending = [];
    } catch (e) {
      if (isRateLimit(e)) {
        await dbQuery(env, `update reconcile_queue set status = 'queued' where id = $1`, [q.id]);
        throw e;
      }
      if (e instanceof ItemsChanged) {
        const keep = [];
        for (const i of pending) {
          const p = e.problems.get(`${i.item_kind}|${i.item_key}`);
          if (p) failed.push({ item: i, error: p.message, actual: p.actual });
          else keep.push(i);
        }
        pending = keep;
        continue;
      }
      if (pending.length === 1) {
        failed.push({ item: pending[0], error: e.message });
        pending = [];
        break;
      }
      // Isolate: each item on its own.
      for (const i of pending) {
        try {
          await runOnce(env, q, [i]);
          done.push(i);
        } catch (e2) {
          if (isRateLimit(e2)) {
            await setItems(env, q.id, done, 'done');
            for (const f of failed) await setItems(env, q.id, [f.item], 'failed', f.error, f.actual ?? null);
            await dbQuery(env, `update reconcile_queue set status = 'queued' where id = $1`, [q.id]);
            throw e2;
          }
          const p = e2 instanceof ItemsChanged ? e2.problems.get(`${i.item_kind}|${i.item_key}`) : null;
          failed.push({ item: i, error: p ? p.message : e2.message, actual: p ? p.actual : null });
        }
      }
      pending = [];
    }
  }
  // Anything still pending after two rounds kept changing — fail it.
  for (const i of pending) failed.push({ item: i, error: 'Kept changing while it was being marked — try again.' });

  await setItems(env, q.id, done, 'done');
  for (const f of failed) await setItems(env, q.id, [f.item], 'failed', f.error, f.actual ?? null);
  const status = failed.length === 0 ? 'done' : done.length === 0 ? 'failed' : 'partly_failed';
  await dbQuery(env, `update reconcile_queue set status = $2, completed_at = now() where id = $1`, [q.id, status]);
  return `queued ${q.action} on ${q.project_id}: ${done.length} done, ${failed.length} failed`;
}

// ---------- dashboard digest (LEDGER admins) ----------

export async function reconcileDigest(env, { tenantId }) {
  await ensureQueueSchema(env);
  const failed = await dbQuery(env, `
    select i.queue_id, i.project_id, p.name as project_name, p.project_number, i.item_kind as kind, i.item_key as key, i.label,
           i.expected_amount as expected, i.actual_amount as actual, i.error, i.tried_at,
           q.action, q.requested_by, q.requested_at, q.options
    from reconcile_queue_items i
    join reconcile_queue q on q.id = i.queue_id
    left join portfolio_projects p on p.tenant_id = i.tenant_id and p.project_id = i.project_id
    where i.tenant_id = $1 and i.status = 'failed' and i.reviewed_at is null
    order by i.tried_at desc
    limit 500`, [tenantId]);
  const queued = await dbQuery(env, `
    select count(*)::int as items, count(distinct i.project_id)::int as projects
    from reconcile_queue_items i where i.tenant_id = $1 and i.status = 'queued'`, [tenantId]);
  const lastNight = await dbQuery(env, `
    select count(*) filter (where status = 'done')::int as done, count(*) filter (where status = 'failed')::int as failed
    from reconcile_queue_items where tenant_id = $1 and tried_at > now() - interval '24 hours'`, [tenantId]);
  return {
    failed: failed.map(f => ({ ...f, expected: f.expected == null ? null : Number(f.expected), actual: f.actual == null ? null : Number(f.actual) })),
    queued: queued[0] || { items: 0, projects: 0 },
    last24h: lastNight[0] || { done: 0, failed: 0 }
  };
}

export async function markDigestReviewed(env, { tenantId, items, userId }) {
  await ensureQueueSchema(env);
  const list = (Array.isArray(items) ? items : []).filter(i => i && i.queue_id && i.kind && i.key != null);
  for (const i of list) {
    await dbQuery(env, `update reconcile_queue_items set reviewed_at = now(), reviewed_by = $5
      where tenant_id = $1 and queue_id = $2 and item_kind = $3 and item_key = $4 and status = 'failed'`,
    [tenantId, i.queue_id, i.kind, String(i.key), userId]);
  }
  return { reviewed: list.length };
}
