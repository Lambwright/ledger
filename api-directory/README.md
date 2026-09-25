# LEDGER API Directory

A verified, Einbau-specific catalogue of Procore REST API endpoints — every entry here has actually been called against real Einbau data (or checked against Procore's live official docs and then tested), not copied blind from generic documentation.

**Why this exists instead of just linking Procore's docs:** Procore's official reference (developers.procore.com) describes the endpoint shape correctly, but doesn't tell you whether the *resource name* matches what the Procore UI calls it (it often doesn't — see `time_and_material_entries` below), whether Einbau's account/app actually has permission to call it, or what real data looks like once you do. This file is the small, load-bearing subset that's actually confirmed to work (or confirmed to be blocked, and why), so every future Einbau app can look here first instead of rediscovering the same traps.

- `endpoints.json` — machine-readable catalogue, one entry per endpoint.
- Test project used for verification: `562949954996998` (Einbau company `562949953508586`). Known to be missing some records (Prime Contract, possibly others) — that's fine, absence is still a useful data point.
- Calls are made through the LEDGER Cloudflare Worker (`https://ledger.ben-a90.workers.dev`), which handles Procore OAuth2 client_credentials + the required `Procore-Company-Id` header. See [worker/src/index.js](../worker/src/index.js).

## Status values used in `endpoints.json`

- `"verified"` — called live, returned real data (2xx).
- `"path_confirmed_permission_denied"` — path/resource name is correct (Procore recognizes it, returns a structured JSON error, not an HTML 404), but the LEDGER Procore app currently lacks permission to call it (403). **This needs a Procore admin action, not a code fix** — see Open Issues below.
- `"path_confirmed_no_data"` — path is correct, this particular test project just doesn't have that record yet (clean JSON "not found", not an HTML error page).
- `"path_wrong_in_original_intake"` — the `ledger_intake.xlsx` assumed a path/resource name that doesn't exist; corrected here.
- `"doc_confirmed_untested"` — pulled from Procore's live official reference docs, not yet called against real data.

## Full T&M pipeline proven end-to-end, live (2026-09-04)

Ran the whole chain for real against a dedicated "E2E test" Prime Contract (id `562949959682464`, contract #3 on the test project):

1. **Created a Prime Change Order** directly via API (`POST .../prime_change_orders`, `contract_id` required) — succeeded, status `draft`, `created_by` shows LEDGER's own identity.
2. **Added a line item** (`POST v2.0 .../prime_change_orders/{id}/line_items`) — first attempt failed with `wbs_code_id` "Budget Code was not found." **Real gotcha, now documented**: `wbs_code_id` is NOT the plain Cost Code id from `/cost_codes` — it's a separate, combined Cost-Code-x-Cost-Type id. Find/create these via `GET /rest/v1.0/projects/{id}/work_breakdown_structure/wbs_codes?query=<search>`. Once found (`49-04-01.L` = "Time and Material - REGULAR TIME.Labor", id `562951682873166`), the line item created fine with the amount auto-calculated correctly ($1,920 = 24hrs × $80).
3. **Confirmed the draft CO's total does NOT touch the contract's real numbers.** The $1,920 shows up under `draft_change_orders_amount` on the contract, but `revised_contract_amount` and `approved_change_orders` stay untouched — a draft CO is fully inert until approved.
4. **Tried to approve the CO directly via PATCH — blocked.** `422`: `"The status of this Prime Contract Change Order cannot be changed because it is set via workflow."` **This is the load-bearing finding**: Change Order approval is gated by Procore's actual review/workflow engine, not a status field LEDGER (or anyone) can just write to via the API. LEDGER can build the CE and CO automatically, but getting real dollars onto the contract's SOV requires an actual human approval action inside Procore — this cannot be fully automated away, and the "PM never touches it" language in the original spec needs revisiting for the CO-approval step specifically.

**UPDATE — completed later the same day.** Turned out the CO's "set via workflow" block was because a workflow was actually attached (project template default) that Ben didn't know was still active — he'd never intentionally set one up (workflows are considered too much setup overhead to bother with normally). He turned it off, and the SAME PATCH call that was rejected then succeeded immediately: `status: "approved"`, `reviewed_at` auto-stamped. **This means, for Einbau specifically (no active approval workflows), a direct "Approve CO" button inside LEDGER's own sidebar can call this same endpoint directly — no redirect to Procore's native CO page needed.** Design note for later: that button should attempt the direct approve first and gracefully fall back to "open in Procore for manual approval" if it hits the workflow-gated 422 specifically — because this WILL come back if a workflow is ever re-enabled, and definitely will apply to any future multi-tenant customer who does run real approval workflows.

With the CO actually approved, the contract's real numbers updated: `revised_contract_amount` $100 -> $2,020, `approved_change_orders` -> $1,920.00, `draft_change_orders_amount` back to $0. Continued the chain for real:

5. **Found the existing Billing Period** Ben had created (`GET /rest/v1.0/projects/{id}/billing_periods`) — id `562949955654355`, status `open`.
6. **Created the draft Payment Application** for real (`POST /rest/v1.0/prime_contracts/{id}/payment_applications`) — succeeded. Its `g703` (line items) came through AUTOMATICALLY from the contract's real SOV, no line items needed in the create call: the pre-existing $100 line, plus our new $1,920 T&M line, both present with correct cost codes.
7. **New CO line items land on the invoice at 0% billed by default** (normal AIA progress-billing behavior — you declare how much of each line to claim *this period*, it doesn't assume 100% just because it's newly on the contract). Fixed via the dedicated **Payment Application Line Item** endpoint: `PATCH /rest/v1.0/prime_contracts/{id}/payment_application_line_items/{line_item_id}`, body `{project_id, payment_application_line_item: {work_completed_this_period: "1920.00"}}` — NOT nested inside the parent payment_application PATCH (tried that first, silently no-opped, 200 but no change). **Gotcha**: this contract is `accounting_method: "amount"` — sending a `work_completed_this_period_quantity` field alongside the amount gets rejected (`"Quantity update not allowed on amount accounting contract"`) — amount-based contracts take dollars only, no quantity.
8. **Result**: the T&M line now shows `total_completed_and_stored_to_date: "1920.00"`, **100% complete**, fully claimed on this draft invoice.

**The entire T&M billing pipeline is now proven end-to-end with real data and real dollar amounts, every step live-tested**: signed T&M ticket -> LEDGER-built Change Event -> LEDGER-built Prime Change Order -> human/workflow-appropriate approval -> Billing Period -> LEDGER-built draft Invoice -> line item claimed at the correct amount. Nothing left in this chain is speculative.

## Gotcha: Prime Contracts permission gap fails SILENTLY, not with a 403 (2026-09-04)

Confirmed 3 real Prime Contracts exist on the test project (visible in Procore's UI, screenshot-confirmed same project/URL). All three API variants tried — `GET /rest/v1.0/prime_contracts?project_id=...`, `GET /rest/v2.0/companies/{c}/projects/{p}/prime_contracts` (BETA), and `GET /rest/v1.0/prime_contract?project_id=...` (singular "show first") — return empty (`200 {"data":[]}` / `[]`) or a soft `{"message":"Item not found"}` (404) instead of the structured `403 insufficient access` every other permission-gated tool has returned all session. **This looks identical to "no contracts exist" unless you already know they do — a real trap for anything built on this API blindly.** Almost certainly the "Prime Contracts" tool on the LEDGER user's permission template hasn't been bumped yet, same underlying cause as the earlier T&M/Direct Costs/Commitments gap — just failing quietly instead of loudly. Needs the same fix: bump Prime Contracts permission on the LEDGER user, then re-test.

## Headline finding: Procore does not prevent double-billing a timecard (2026-09-04)

The single most important open question in the intake sheet — does a T&M ticket record which timesheet entry it came from, and does Procore stop the same timesheet being billed twice — is now answered with hard evidence, not a guess. Ben deliberately attached the same 6 timesheet entries to two separate T&M tickets. Procore allowed it with no warning. But the underlying `timecard_entry_id` field on each ticket's timecard record was identical across both tickets — so the join key LEDGER needs to catch this *does* exist, Procore just never checks it. Full detail in `endpoints.json` under "List Time and Material Timecards." This is the concrete justification for `billing_records` checking `timecard_entry_id` against everything already billed before any T&M ticket gets included in an invoice.

## LEDGER's actual write/read scope, clarified by Ben (2026-09-04)

- **LEDGER will never create Direct Costs, Requisitions, or Commitments.** These are read-only billing/cost sources for LEDGER, same treatment as timesheets — pull them, apply markup, track reconciliation status. The only genuine write path in the spec is T&M: LEDGER creates the CE -> CO -> Invoice chain. The Direct Cost create test earlier today was just to confirm the API pattern/gotcha still holds, not a sign LEDGER will ever originate DC records.
- **A separate system called "Einvoice"** (its own Procore connected-app identity, seen as `created_by: "einvoice-2b65f0b7"` on Work Order Contracts during a live Commitment Contracts pull) already exists — built by a different human developer, not part of LEDGER. It costs timesheets per-person, approves them as costed items, and auto-generates the Procore commitments/sub-invoices for subcontractor billing, aiming to take that whole flow from timesheet approval to a vendor-approved draft sub-invoice in one click. It has no bearing on LEDGER today: LEDGER only ever *reads* whatever commitments/contracts Einvoice feeds into Procore, never creates or modifies them. Eventually Ben's plan is to have a real developer review and unify all of Einbau's internal apps (SCOUT, INTAKE, PUNCH, LEDGER, Einvoice, TALLY, etc.) under one umbrella system — not urgent, just context for why this exists alongside LEDGER without conflicting.
- **DC/attachment display requirement for LEDGER's UI**: when showing a Direct Cost, LEDGER needs to render any attachments inline in the side panel (photos) or provide a way to open them (other files) — not just show the DC's numbers. Procore's attachment objects across every resource seen today follow the same shape: `url` (direct file link) plus, for images, `presentation_url` and `thumbnail_url` for inline rendering (confirmed pattern from T&M Entry attachments). Direct Cost's own attachment field names not yet confirmed against a real attached file (our test DC has none) — verify once one exists with a real receipt/photo attached.

## T&M ticket → Change Event push: known gaps for LEDGER to fix (2026-09-04)

- **Line items show work classification, not the person's name — and worse, there's no field to recover it from afterward.** Confirmed by dumping a full change_item object: no `party_id`, no `login_information`, no reference to the source timecard anywhere. The description text is the ONLY place identity ever lived, and since multiple workers share a classification, their lines are textually IDENTICAL — three separate "Overtime" lines with no way to tell them apart post-push. **Architecture conclusion: LEDGER cannot reliably patch Procore's native push after the fact (text-matching breaks the moment two people share a classification). LEDGER must construct the Change Event itself** — read the T&M ticket + its timecards (which do have full identity: `party.name`, `timecard_entry_id`) and `POST /rest/v1.1/change_events` directly with each line built correctly from the start, rather than relying on Procore's native push button and patching afterward.
- **Update Change Event confirmed**: `PATCH /rest/v1.1/change_events/{id}?project_id=...`, body `{change_event: {change_items: [{id, description, cost_impact, revenue_impact, budget_impact, deleted}, ...]}}` — can update or soft-delete individual line items by id. Useful for LEDGER-initiated corrections generally, just not a reliable fix for the classification/name problem specifically (see above).
- **Create Change Event confirmed live**: `POST /rest/v1.1/change_events?project_id=...`, body `{change_event: {number, title, description, scope, status: {id}, change_items: [...]}}`. `status.id` must be a real Change Event status id for the company (invalid ids return 400). Tested for real — LEDGER successfully created CE #007 as its own identity (`created_by: "ledger-56d21402"`).
- **Linking a LEDGER-built CE back to its source T&M ticket(s) — confirmed the right endpoint, blocked by permission.** So Procore's native "linked to" UI still shows correctly even when LEDGER builds the Change Event itself (not Procore's native push), use `PATCH /rest/v1.0/projects/{id}/time_and_material_entries/bulk_update`, body `{time_and_material_entry: {time_and_material_entry_ids: [...], change_event_id: X, update_change_event_attachment: true}}` (works for one or many tickets at once — e.g. multiple T&M tickets rolled into a single CE). Tried it live: `403`. Reads on T&M Tickets work fine at Standard; this write action (and a plain status PATCH tried earlier) do not — **writing to T&M entries needs Admin, not just Standard**, on that tool's permission.
- **Cost codes — the 49-04 T&M series (as requested)**, real ids from the project's cost code tree:
  - `49-04` Time and Material — id `562950364797613`
  - `49-04-01` REGULAR TIME — id `562950364805730`
  - `49-04-02` TIME AND HALF — id `562950364805728` (maps to timecard time_type "Overtime")
  - `49-04-03` DOUBLE TIME — id `562950364805729`
  - Note: **Per Diem is NOT in this family** — it lives at `49-01-06-05` under Travel/Expenses instead. If LEDGER defaults every T&M line to the 49-04 series, per diem lines need a different cost code or an explicit exception.
- **Cost code IDs are project-scoped, not company-scoped — confirmed, this is a real gotcha LEDGER must handle everywhere it touches cost codes.** Every cost code record has both a project-specific `id` (`biller_type: "Project"`, `biller_id: <project>`, only valid on that one project) and a stable, company-wide `standard_cost_code_id`. There is no separate company-level "Standard Cost Codes" list endpoint (checked the full Work Breakdown Structure category in the docs — doesn't exist) — the mapping is only discoverable by reading a project's own `cost_codes` list. Correct pattern for LEDGER: resolve and store `standard_cost_code_id` once (from any project) as the stable reference in the rate/cost-code config; then on every project LEDGER actually builds a Change Event for, fetch that project's own cost_codes and match on `standard_cost_code_id` to get the right project-scoped `id` to use. Same 49-04 codes verified with both ids: 49-04 → project id `562950364797613` / standard id `562949960221300`; 49-04-01 → `562950364805730` / `562949960221301`; 49-04-02 → `562950364805728` / `562949960221302`; 49-04-03 → `562950364805729` / `562949960221303` (all specific to test project 562949954996998 — will differ on every other project).
- **No usable rate data lives in Procore at all** — confirmed by Ben directly: rates only attach to Classifications, and that feature isn't even enabled on Einbau's account, and Einbau doesn't use classifications meaningfully regardless. This fully resolves the intake sheet's rate-ownership open question — LEDGER owns the rate table entirely, no ambiguity left.

Compared two real pushes of a signed T&M ticket to a Change Event (same underlying data: 3 workers × Regular + Overtime hours), using different Procore push/grouping settings:

- **Default/aggregated setting**: collapses to one line item per time type ACROSS ALL WORKERS — e.g. "Regular Time: 24 hrs" as a single line, no per-person attribution at all.
- **Alternate setting** (`group_labor_totals_by` and/or `group_equipment_totals_by`, seen on the Time and Material Notification config — exact UI location TBD, ask Ben which setting he used): produces one line item **per person per time type** — matches Ben's stated "fine" fallback exactly (ideal is per person per *timecard entry*, which would differ from per-time-type only when one worker has multiple entries of the same time type on one ticket).

**Bigger gap, confirmed on both fresh pushes**: line items carry the correct **quantity** (hours) but `unit_cost` and `amount` both come through as `0.0` — Procore's native push does not apply a bill rate. An older, manually-fixed-up CE (#004) shows real dollars ($80/hr), confirming someone has to go apply the rate by hand after every push today. **This is a clean, concrete LEDGER feature**: auto-apply the correct rate (region + time type, from the rate table) to every line item the moment it lands, instead of leaving it at $0.

Also confirmed (see endpoints.json "List Change Events"): the auto-generated **description** text is just the ticket's free-text description + two hardcoded links, no cost/hours summary — even though the structured data (change_items) is fully correct. Also confirmed real T&M ticket statuses are `field_verified` / `Close Ticket` / `Revise and Resubmit` / `Reject` — NOT "approved" as the intake sheet's spec language implied. **Note also**: creating a real signature via the API requires a genuine multi-step file upload (POST for upload instructions → multipart POST of the actual file to Procore's storage → reference the resulting upload_id) — cannot be faked with a one-line JSON request. Attempting to force a status transition directly via PATCH (bypassing signatures) was correctly rejected by Procore with a 403, even with Standard-level T&M permissions — this isn't a LEDGER permission gap, it's Procore intentionally not allowing the approval workflow to be bypassed.

## Resolved: Financial Management permission gap

**Fixed 2026-09-04.** Root cause was neither the app manifest nor the permission template's tool levels (both were already correct/Admin) — it was that the LEDGER user's project membership on the test project predated the template being set correctly, and Procore doesn't retroactively apply an updated default template to an existing project membership. Ben fixed it by updating the LEDGER user's permissions directly on the test project (a bulk "remove from all projects, fix default template, re-add to all projects" action is available in Procore's Company Directory for applying this fix company-wide later). T&M Entries, Direct Costs, and Commitment Contracts are now all confirmed live. Timesheets is still separately blocked — see its entry in `endpoints.json`, likely a wrong path rather than another permission issue.

## Old notes (superseded, kept for context)

As of 2026-09-04: the app manifest itself (confirmed by Ben) already declares `"standard"` access to every relevant tool, and the app is confirmed **installed** in the Einbau company. The remaining gap is on the **LEDGER user's** permission template — Procore's connected-app model has two independent ceilings (app manifest scope, and the underlying user identity's permission template) and effective access is the *minimum* of the two.

Confirmed narrow: this is **not** a blanket "no project access" problem.
- **Works fine**: company-level reads (`/companies`, `/companies/{id}`), and project-level Directory reads (`/projects/{id}/users`) — real Einbau people came back by name.
- **Still blocked (`403`)**: every Financial Management / Construction Financials endpoint tried — T&M Entries, Direct Costs, Commitment Contracts. Paths are confirmed correct (structured JSON errors, not HTML 404s), so this is purely a permission gap.

**Action needed from Ben**: in Procore Company Admin, find the LEDGER user (created when the app was installed) and check its Permission Template / default project permissions — specifically the **Financial Management** tool group (covers Time & Material, Direct Costs, Commitments, Invoicing, Prime Contract). Directory access is already fine on that same template, so this is a targeted fix, not a full rebuild of the template. Set as a company-wide default so it applies to future projects too, not just the current test project.

## Backfill notice (2026-09-18)

Everything below this point through "Open issue" was discovered live across several
sessions between 2026-09-13 and 2026-09-18 (rate limiting, direct-cost billing, the
action-first combined flow, direct-cost grouping, write-offs) but never got written back
into this file at the time — it only ever landed in `worker/src/app.js` code comments and
session memory. Ben caught the gap (2026-09-18: "we're still scraping every page... and
recording all the endpoints right?") — this section is the backfill. Going forward,
update this file in the same session as the discovery, not after.

## Real rate limit, confirmed via response headers (2026-09-14)

Every Procore response carries `x-rate-limit-limit`, `x-rate-limit-remaining`,
`x-rate-limit-reset` (unix timestamp). Confirmed live: **25 requests per rolling 60-second
window, shared across the ENTIRE Connector app + company** — not per-user, not
per-project. A large batch (many CO line-item POSTs in a row) will hit this well before
any per-endpoint limit. LEDGER paces itself by reading these headers directly
(`throttleForRateLimit` in `worker/src/app.js`) rather than a blind fixed delay, and on an
actual 429 waits for the real `x-rate-limit-reset` time rather than guessing.

## g703 continuation sheet — the real mechanics of claiming an invoice line (2026-09-14)

**`GET /rest/v1.0/payment_applications/{id}?project_id={project_id}`** — full invoice
detail, including the `g703` array (the AIA-style continuation sheet). Each row: `id`,
`added_from_source` (`'contract'` = base SOV, or `'change_order'` + `added_from_source_id`),
`scheduled_value`, `scheduled_quantity`, `scheduled_unit_price`, `description_of_work`. A
project with billing history has MANY rows sharing the same cost code from different COs
over time — filter to `added_from_source === 'change_order'` plus a source-id match
before matching by amount, or you'll match the wrong old row (or nothing).

**CORRECTION, confirmed live 2026-09-23**: `added_from_source_id` does NOT reliably equal
the Prime Change Order's own `id`. On a real unit-accounting-method contract, it equaled
the CO's `legacy_package_id` field instead (from `GET
.../prime_change_orders/{id}`) — a completely different number from `id`. This was a real
bug in LEDGER (matched on `id` alone, silently found zero rows on affected COs, always
misdiagnosed as rate-limiting) — see [[project_g703_claim_id_bug]] for the full story and
the fix (match against BOTH `id` and `legacy_package_id`). Not yet determined how often
`legacy_package_id !== id` in practice, or whether it correlates with accounting_method,
contract age, or something else — every prior successfully-claimed invoice in this
project's history was on an amount-type contract, so this may be new territory rather
than something that was silently broken all along on amount contracts too. Treat `id` as
NOT a safe assumption for this field going forward; always match against both.

**`PATCH /rest/v1.0/prime_contracts/{contract_id}/payment_application_line_items/{row_id}`**
— body `{project_id, payment_application_line_item: {work_completed_this_period: "X.XX"}}`
claims one row. On a `unit`-accounting contract (see `prime_contracts.accounting_method`,
via `GET /rest/v1.0/prime_contracts?project_id=X`), also required:
`work_completed_this_period_quantity`. Sending the quantity field on an `amount`-accounting
contract gets rejected (`"Quantity update not allowed on amount accounting contract"`);
omitting it on a `unit` contract gets rejected (`"Quantity is required"`) — check
`accounting_method` first rather than guessing, though LEDGER also retries the other shape
as a fallback.

**`GET /rest/v1.0/prime_contracts/{id}/payment_applications?project_id=X&per_page=300`**
— list of a contract's invoices (`id`, `invoice_number`, `status`). Used to scan every
contract on a project for the biggest existing numeric `invoice_number` + 1 (LEDGER's
sequential invoice numbering).

**Open issue, not root-caused**: a real, fully-valid, executed Change Order (confirmed
correct cost codes, correct `grand_total`, `executed: true` on re-fetch) has twice now
produced ZERO matching g703 rows on the invoice created right after it — not a partial
match, not a timing race (re-checked minutes later, still zero). Both occurrences
correlated with a cost code that had just been added/touched in the project's Budget
moments before the test. Current mitigation is honest surfacing (list the unclaimed
lines, let the PM complete them by hand in Procore) — see `approveAndInvoiceChangeOrder`
in `app.js`. Real root cause unknown; a live Network-tab capture of Procore's own UI
doing the same flow (in progress as of 2026-09-18) may reveal what LEDGER's API-only
approach is missing.

## Prime Change Order detail + line items (confirmed live, multiple sessions)

**`GET /rest/v1.0/projects/{project_id}/prime_change_orders/{id}`** — single CO detail:
`status`, `executed` (bool), `contract_id`, `grand_total`, `title`, `number`. Confirmed a
CO can be `status: "approved", executed: true` with a correct `grand_total` while its
linked Change Event (see below) never leaves `"Open"` status — the two objects' lifecycles
are independent in Procore, approving/executing a CO does NOT auto-transition its CE.

**`GET /rest/v2.0/companies/{company_id}/projects/{project_id}/prime_change_orders/{id}/line_items`**
— real shape per line: `id`, `description`, `amount`, `quantity`, `unit_cost`, `uom`,
`wbs_code: {id, flat_code, description}`, `wbs_code_id`. Matches what LEDGER posts on
create.

**`GET /rest/v1.1/change_events/{id}?project_id={project_id}`** — single CE detail,
`status: {id, name, mapped_to_status}`. Every LEDGER-created CE observed so far stays
`"Open"`/`"open"` indefinitely, including ones whose linked CO is long since approved and
executed — confirmed across every CE checked on the test project (2026-09-17).

## Prime Contract's own line_items — the STATIC base SOV, not the live continuation sheet (2026-09-17)

**`GET /rest/v2.0/companies/{company_id}/projects/{project_id}/prime_contracts/{id}/line_items`**
— returns the contract's ORIGINAL bid-scope line items only. Confirmed on a test contract
with 2 already-executed Change Orders on it (their value fully reflected in
`revised_contract_amount` and in existing invoices' g703): this endpoint still showed only
the single original $100 line, nothing from either CO. **Do not use this endpoint to check
whether a CO's impact has "landed"** — it doesn't reflect CO-driven growth at all, only
the base contract's own static SOV. (The g703 array on a payment_application is the real
place CO-driven lines show up — see above.)

## Direct cost line items — real multi-line shape (2026-09-17)

**`GET /rest/v1.0/projects/{project_id}/direct_costs/{id}/line_items`** — array, one entry
per real line item on the direct cost. Each: `id`, `amount` (this line's own dollar
value — the field LEDGER bills off), `cost_code: {id, name, full_code, budgeted}`,
`wbs_code: {id, flat_code, description}`, `description`, `line_item_type: {id, name,
code}`, `quantity`, `unit_cost`, `uom`, `total_amount`, `extended_amount`. Confirmed live
with a real 3-line-item direct cost ($100 + $50 + $500). **The direct cost's own header
`amount`/`grand_total` field stays in sync with the sum of its line items** — confirmed by
re-checking after adding new lines to an already-created DC — but can be transiently
`null` in the same request cycle a brand-new line item was just added, before settling;
exact settle timing not measured. LEDGER's `per_dc` billing mode trusts the header total
directly (fine, confirmed accurate); `per_line_item` mode (added 2026-09-17) bills each
line item under its own real cost code instead of collapsing everything under just the
first one's.

**Update 2026-09-22, live against the same DC after it sat for 5 days with lines already
on it**: the header `amount` was still `null` — NOT just a transient just-added state as
originally assumed, it can stay null indefinitely. Per-line DC billing (shipped this day,
see [[project_dc_per_line_billing]]) now sums the real line items' own `amount` fields
directly instead of trusting the header at all. Also confirmed live: each line item's
`id` is stable and globally unique (three real ids checked, no collisions, no null-id
case seen), and the list response is a plain flat array with no pagination
metadata/wrapper for a 3-line DC — small enough that this wasn't stress-tested for a
DC with many more lines.

## WBS codes are populated by the project's Budget, not company-wide cost-code existence (2026-09-16/17)

A cost code can exist company-wide (visible in `GET /cost_codes`) without showing up at
all in a given project's `GET .../work_breakdown_structure/wbs_codes?query=X` search
results — confirmed live on two separate projects where a standard T&M cost code
(`49-04-03` Double Time) was simply never added to that PROJECT's own Budget. Symptom:
LEDGER's `findWbsCodeIds` finds nothing, throws "No WBS code found for time type: X on
this project" — the fix is adding the cost code to that project's **Budget** in Procore
(a different tool from the WBS structure admin screen, which can look like it already
has the code without it actually being usable). See the `project-wbs-vs-budget` memory
for the full incident.

## Create Billing Period (2026-09-14)

**`POST /rest/v1.0/projects/{project_id}/billing_periods`** — body `{billing_period:
{start_date, end_date, due_date}}`. `due_date` — LEDGER defaults it to `end_date` when the
caller doesn't supply one explicitly; not yet confirmed whether Procore itself requires
`due_date` or would accept its absence (LEDGER never actually omits it, so this hasn't
been tested bare).

## Project type / billing-mode source (confirmed 2026-09-10)

**`GET /rest/v1.0/projects/{id}?company_id={cid}`** — the `?company_id=` query param is REQUIRED; without it → `400`. (`/rest/v1.1/projects/{id}` and `/rest/v1.0/companies/{cid}/projects/{id}` both → `404`.) Returns `project_type: {id, name}`, plus `project_stage: {id, name, is_concept_stage}`, `sector`, `delivery_method`, `dictionary_type`.

The company projects list **`GET /rest/v1.0/companies/{cid}/projects`** carries `type_name` and `stage_name` (plain strings) per item — cheaper when you just need the type and are already listing.

**`GET /rest/v1.0/companies/{cid}/project_types`** → Einbau's configured types: `Contract`, `Overhead`, `Service Call`, `Time & Material`, `Warranty`.

Real distribution across 567 Einbau projects: Contract 297, Time & Material 131, Service Call 92, Overhead 19, Warranty 1, unset 27. LEDGER billing-mode mapping lives in the `project-billing-mode` memory: Time & Material + Service Call → T&M mode; Contract → Fixed-Price mode; Overhead + Warranty → not client-billable. Demo project "AB - KPS - Costco #1790 Lloydminster" (562949955397029) is type **Contract** — a quoted job carrying ~18 T&M change tickets.
