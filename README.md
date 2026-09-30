# LEDGER

Einbau's project billing reconciliation: turns Procore T&M tickets, direct costs
and commitments into client invoices and Change Orders, and tracks what's been
billed, budgeted or written off so nothing is billed twice.

## Parts

| Folder | What | Where it runs |
|---|---|---|
| `worker/` | Cloudflare Worker: Procore + Neon logic, auth checks, background refresh | `ledger.ben-a90.workers.dev` |
| `frontend/` | The Procore sidebar app (also installable on a phone) | `ledger-sidebar.pages.dev` |
| `portfolio/` | Company dashboard | `lambwright.github.io/ledger/` |
| `db/schema.sql` | Database layout (Neon Postgres) | — |
| `api-directory/` | Every Procore endpoint LEDGER has verified live | — |

## Access today

- Everyone signs in with **Einbau ID** (auth-worker). The sidebar signs in
  through LEDGER's worker (`/auth/login`, `/auth/verify`), with 14-day
  remember-me sessions.
- **Opening LEDGER** needs `LEDGER` in the user's `apps` list. This is checked
  on every sidebar and dashboard request (`verifyEinbauSession` in
  `worker/src/portfolio.js`).
- **Role:** `user.appRoles.LEDGER`, read from LEDGER's own `/auth/verify` call
  and never from the page (`ledgerRole` / `isLedgerAdmin` in
  `worker/src/bulk.js`). If there's no LEDGER key, LEDGER treats the user as
  `pm`. Only **admin** is enforced so far: it gates bulk project reconciliation
  and Reopen project on the dashboard.
- Other LEDGER apps call the worker with the `LEDGER_SERVICE_KEY` secret (for
  example HANDOFF's `set_project_rates`). That's full access, not tied to a
  person.

## Coming change: Einbau ID role matrix (announced 2026-09-30)

Einbau ID permissions are moving to **company job roles plus a per-app
matrix**. It's owned by the HELM/auth session and signed off by Ben. **No
LEDGER code changes until it ships.**

- **Job roles:** Super Admin (Ben only), Admin, Estimator, Project Manager,
  Project Coordinator, CRM, Accounting, Logistics. New users default to
  Project Manager. Each person has a default role, and any app can override it
  for one person.
- **The matrix,** edited in HELM by Ben only, gives each role "No access" or
  one of each app's levels. Only the Super Admin manages users, roles and the
  matrix.
- **What auth-worker will return** (proposed):
  - `user.apps`: same meaning as today, computed from the matrix.
  - `user.appRoles`: the level for each app the user can open, e.g.
    `{ LEDGER: "pm" }`. It's always an object, and every app in `apps` has a
    key. The Super Admin gets `admin` everywhere.
  - `user.jobRole`: informational only. Don't gate on it.
  - `user.role`: legacy. `admin` only for the Super Admin.
- **LEDGER's levels:**

  | Level | Can do | Job roles |
  |---|---|---|
  | admin | Everything, including bulk reconcile / Reopen project | Admin (Ben, Leela, Josh), Super Admin |
  | accounting | Same as pm for now; kept separate so it can split later | Accounting |
  | pm | Bill (invoice, push to CO, standalone), dispositions, undo, Project Settings | Project Manager, Project Coordinator |
  | viewer | Dashboard and sidebar, read-only | Estimator |
  | no access | — | CRM, Logistics |

- **LEDGER work when it ships:** enforce viewer / pm / accounting in the
  worker, not just admin: read-only actions for viewers, billing and
  disposition actions for pm and up. Hide the billing buttons in the sidebar
  for viewers.

Anything new about this change gets recorded here as it lands.
