-- LEDGER database schema (Neon Postgres)
-- Applied via the LEDGER Worker's {target: "db"} passthrough, split into individual
-- statements (Neon's driver rejects multi-statement queries) — see reference_infrastructure
-- memory for the one-off script used, or just run this directly in Neon's SQL Editor.
--
-- Design notes (see api-directory/README.md for the full evidence trail):
--   * tenant_id = Procore company ID everywhere, for the multi-tenant commercial version from day one.
--   * billing_records only ever holds rows for things a PM actually acted on (billed or written off).
--     "Pending" is not a stored status — it's the absence of a row for that record. Keeps the table
--     lean and matches how Ben described the three real states he wants (applied to invoice /
--     written off / pending).
--   * For record_type = 'timecard', procore_record_id MUST be the timecard's timecard_entry_id
--     (the pointer to the original Timesheet entry), NOT the T&M-side timecard record id. Proven
--     2026-09-04: the same timecard_entry_id can be attached to two different T&M tickets with no
--     warning from Procore — timecard_entry_id is the only reliable key for catching that.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ============================================================
-- billing_records — one row per transaction included in an invoice, OR written off.
-- The anti-double-billing backbone: before anything gets billed, LEDGER checks whether
-- a row already exists here for that (tenant_id, project_id, record_type, procore_record_id).
-- ============================================================
create table billing_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,                 -- Procore company ID
  project_id text not null,                -- Procore project ID
  record_type text not null check (record_type in ('tm_ticket', 'direct_cost', 'sub_invoice', 'timecard', 'billing_period', 'direct_cost_line', 'commitment_line')),
  -- 'direct_cost_line': one real line item within a direct cost, billed individually —
  -- added 2026-09-22 for per-line DC billing. procore_record_id is "<direct_cost_id>:<line_item_id>"
  -- (NOT just the line item's own id — the prefix lets the list view group rows back to their
  -- parent DC with zero extra Procore calls). A DC with an existing whole-DC 'direct_cost' row
  -- from before this existed is ALWAYS treated as fully billed — the two record_types are never
  -- reconciled against each other, by design (see api-directory / project memory for why).
  -- 'commitment_line': one real line item within a Commitment (Work Order/Purchase Order
  -- Contract), billed individually with markup, same shape as 'direct_cost_line' -- added
  -- 2026-09-24. procore_record_id is "<commitment_id>:<line_item_id>". See is_estimated below.
  -- Applied via ALTER TABLE against the live DB; this file's CHECK constraint updated to match.
  procore_record_id text not null,         -- see note above re: timecard_entry_id for record_type = 'timecard'
  invoice_id text,                         -- Procore invoice (Payment Application) ID this was charged against
  invoice_number text,
  billing_period_id uuid,                  -- FK to billing_periods added below, after that table exists
  amount_billed numeric(12, 2) not null,
  status text not null check (status in ('billed', 'written_off', 'reconciled_to_period', 'draft_co')),
  -- 'draft_co': pushed to a Change Event + draft Change Order, NOT yet approved/invoiced —
  -- added 2026-09-09 for the "push to CO, stop one step short" flow. Applied via ALTER
  -- TABLE against the live DB; this file's CHECK constraint updated to match for anyone
  -- re-running the schema from scratch.
  write_off_reason text,                   -- required at the application layer when status = 'written_off'
  reconciled_at timestamptz not null default now(),
  reconciled_by text not null,             -- Procore user ID of the PM who reconciled it
  created_at timestamptz not null default now(),
  change_order_id text,                    -- Procore Prime Change Order id, set for status = 'draft_co'
                                            -- (and 'billed', once approved from one). Added 2026-09-14 so
                                            -- LEDGER can notice when a PM deletes the CO in Procore and
                                            -- self-heal the row back to unbilled instead of staying stuck
                                            -- claiming a timecard that no longer has any real record behind it.
  change_event_id text,                    -- Procore Change Event id, same row, same reason.
  is_estimated boolean not null default false, -- record_type='commitment_line' only (2026-09-24):
                                            -- true when this line was billed to the client BEFORE
                                            -- the subcontractor had actually invoiced the commitment
                                            -- (a real Requisition existed at bill time). Procore
                                            -- doesn't expose per-line invoiced status for Commitments,
                                            -- only commitment-level totals -- so this flag is
                                            -- COMMITMENT-level, not line-level: once ANY line on a
                                            -- commitment is billed with is_estimated=true, no further
                                            -- lines on that SAME commitment may be billed until a
                                            -- real Requisition exists and a reconciling Change Order
                                            -- is built (not yet implemented -- see project memory).
  billed_outside_ledger boolean not null default false, -- status='billed' via "Already Billed" (2026-09-25):
                                            -- billed on an invoice LEDGER didn't create. Counts as billed
                                            -- everywhere (blocks double-billing); has its own simple undo.
  source_timecard_key text,                -- record_type='commitment_line' only (2026-09-24): the T&M
                                            -- reconciliation key (timecard_entry_id) of the subcontractor
                                            -- timecard this commitment line came from, parsed from Einvoice's
                                            -- "Timecard #<n>" description. Lets T&M billing treat those hours
                                            -- as already billed, and vice versa (no double-billing across sources).

  -- One record can only ever be billed/written-off ONCE per tenant+project. This is the actual
  -- database-level enforcement of the reconciliation check, not just an application-layer lookup.
  unique (tenant_id, project_id, record_type, procore_record_id)
);

create index idx_billing_records_lookup on billing_records (tenant_id, project_id, record_type, procore_record_id);
create index idx_billing_records_invoice on billing_records (invoice_id) where invoice_id is not null;
create index idx_billing_records_co on billing_records (tenant_id, project_id, change_order_id) where change_order_id is not null;
create index idx_billing_records_period on billing_records (billing_period_id) where billing_period_id is not null;
create index idx_billing_records_source_timecard on billing_records (tenant_id, project_id, source_timecard_key) where source_timecard_key is not null;

-- ============================================================
-- billing_periods — LEDGER-owned billing periods (Fixed Price mode, and available for T&M too).
-- Deliberately NOT modeled on Procore's own "Billing Period" object, which is just plumbing the
-- Payment Application API happens to require — Ben confirmed Einbau's actual invoicing cadence is
-- ad hoc/sporadic, not a fixed recurring schedule, so this lets a PM pick any date range.
-- ============================================================
create table billing_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  project_id text not null,
  period_start date not null,
  period_end date not null,
  label text,                              -- e.g. "July 1-14 Billing"
  invoice_id text,                         -- populated once a PM confirms/creates the invoice
  status text not null default 'open' check (status in ('open', 'invoiced', 'confirmed')),
  created_by text not null,                -- Procore user ID
  created_at timestamptz not null default now()
);

create index idx_billing_periods_project on billing_periods (tenant_id, project_id);

-- billing_records references billing_periods, so this FK is added after both tables exist.
alter table billing_records
  add constraint fk_billing_records_period foreign key (billing_period_id) references billing_periods(id);

-- ============================================================
-- labour_rates — LEDGER owns the entire rate table (confirmed 2026-09-04: Procore has no usable
-- rate data at all — rates only ever attach to Classifications, which Einbau doesn't use and
-- doesn't even have enabled). project_id nullable = company-wide default; set = per-project override.
-- ============================================================
create table labour_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  project_id text,                         -- null = company-wide default for this tenant
  region text not null check (region in ('GTA', 'Muskoka', 'Calgary', 'Vancouver', 'Maritimes', 'Quebec', 'Remote', 'Default')),
  time_type text not null check (time_type in ('regular', 'overtime', 'double_time', 'per_diem')),
  bill_rate numeric(10, 2) not null,
  set_by_user_id text,                     -- Procore user ID who last set this rate
  updated_at timestamptz not null default now()
);

-- Plain UNIQUE(tenant_id, project_id, region, time_type) would NOT actually dedupe company-wide
-- defaults, since Postgres treats every NULL project_id as distinct from every other NULL in a
-- UNIQUE constraint. coalesce() forces all "no project override" rows to collide correctly.
create unique index idx_labour_rates_unique on labour_rates (tenant_id, coalesce(project_id, ''), region, time_type);
create index idx_labour_rates_lookup on labour_rates (tenant_id, project_id, region, time_type);

-- ============================================================
-- project_settings — one row per project that has an explicit billing-mode
-- OVERRIDE. Absence of a row means "derive the mode from Procore's own
-- project_type" (see app.js resolveBillingMode) — this table only stores the
-- exception, not every project's mode.
--   'tm'           — every T&M timecard must be individually billed; unlinked
--                    timecards are a real flag (a billing leak).
--   'fixed_price'  — base labour is absorbed into the quoted SOV, LEDGER
--                    doesn't track it; T&M tickets are genuine change work,
--                    billed as usual but an unlinked timecard on one of them
--                    is normal (ad hoc extra-work entry), not a red flag.
--   'non_billable' — Overhead / Warranty projects. Not billed to a client;
--                    LEDGER refuses to bill here unless overridden.
-- ============================================================
create table project_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  project_id text not null,
  billing_mode text check (billing_mode in ('tm', 'fixed_price', 'non_billable')), -- null = derive from project type
  -- Project Settings (2026-09-24): per-project defaults that pre-fill the
  -- Configure screen. Null always means "use the company default".
  dc_markup_percent numeric(7, 3),
  cm_markup_percent numeric(7, 3),
  tm_group_by text,
  dc_group_by text,
  cm_group_by text,
  default_prime_contract_id text,
  updated_by text not null,                -- Procore user ID who set the override
  updated_at timestamptz not null default now(),
  unique (tenant_id, project_id)
);

create index idx_project_settings_lookup on project_settings (tenant_id, project_id);

-- ============================================================
-- write_offs — audit trail. Every written-off billing_record gets a matching row here.
-- ============================================================
create table write_offs (
  id uuid primary key default gen_random_uuid(),
  billing_record_id uuid not null references billing_records(id),
  tenant_id text not null,
  project_id text not null,
  reason_category text not null check (reason_category in ('warranty', 'service_call', 'goodwill', 'pm_decision', 'other')),
  reason_notes text,
  written_off_by text not null,            -- Procore user ID
  written_off_at timestamptz not null default now(),
  amount numeric(12, 2) not null
);

create index idx_write_offs_record on write_offs (billing_record_id);
create index idx_write_offs_project on write_offs (tenant_id, project_id);

-- ============================================================
-- Row-Level Security — tenant isolation. Commercial-version-ready from day one.
-- LEDGER's Cloudflare Worker connects as the main Neon role, which owns these tables and so
-- bypasses RLS by default (Postgres doesn't apply RLS to a table's owner unless FORCE ROW LEVEL
-- SECURITY is set) — that's expected, the Worker is the trusted backend enforcing tenant_id
-- filtering in its own queries. RLS here is the defense-in-depth backstop for any future path
-- that might query the database with a lesser-privileged role (e.g. a future frontend-direct
-- connection using a scoped Postgres role rather than going through the Worker).
-- ============================================================
alter table billing_records enable row level security;
alter table billing_periods enable row level security;
alter table labour_rates enable row level security;
alter table write_offs enable row level security;
alter table project_settings enable row level security;

-- No policies are created yet on purpose — with RLS enabled and zero policies, the anon key can
-- read/write NOTHING on these tables by default (fail closed). Add scoped policies here once the
-- frontend's auth model is designed (e.g. matching a JWT claim to tenant_id).
