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

## Access and roles

- Everyone signs in with **Einbau ID** (auth-worker). The sidebar signs in
  through LEDGER's worker (`/auth/login`, `/auth/verify`), with 14-day
  remember-me sessions.
- **Everything is decided by `user.appRoles.LEDGER`** from LEDGER's own
  `/auth/verify` call, never from the page, and never from `user.role` or
  `jobRole`. The rules live in one file: `worker/src/roles.js`.

  | `appRoles.LEDGER` | What LEDGER does |
  |---|---|
  | `admin` | Everything, plus: undo anyone's marks, dashboard source records, bulk reconcile / Reopen project |
  | `pm` | Billing (invoice, push to CO, standalone), Already Billed / Budgeted / Write Off, undo **own** marks, Project Settings |
  | `accounting` | Same as `pm` for now, kept as its own branch: it may get narrower, never broader. Accounting people who need more are given admin |
  | `viewer` | Dashboard and Review Project, read-only: no billing, dispositions, undo or settings, and the controls are hidden |
  | `access` | LEDGER's "Live" switch in HELM is still off: behaves as LEDGER did before roles (everything except bulk reconcile) |
  | `no_access`, missing, anything else | No access: "You don't have access to LEDGER — ask Ben to grant it in HELM." |

- **Worker enforcement** (`worker/src/index.js`, the sidebar session branch):
  - Actions in `READ_ACTIONS` (lists, details, previews, settings read,
    project search, bulk banner, count upkeep) are open to every level.
  - **Any other action needs write access, so a new action is closed to
    viewers by default.**
  - The undo actions add `reconciled_by = <username>` for pm and accounting.
    Undoing someone else's mark returns "You can only undo items you marked
    yourself".
  - Each record in the sidebar lists carries `myMarks` (which kinds of mark the
    signed-in user made, bulk excluded), so pm and accounting only see the Undo
    links they can use. Admin and `access` see all of them. The worker check
    above stays the real gate.
- **Dashboard** (`/portfolio`): `list` and `refresh_project` are open to
  every level. `source_records` is admin only. `bulk_reconcile` and
  `reopen_project` are admin only.
- Other LEDGER apps call the worker with the `LEDGER_SERVICE_KEY` secret (for
  example HANDOFF's `set_project_rates`). That's full access, not tied to a
  person.

## Einbau ID role matrix: history

**2026-10-05: enforced in LEDGER** (see "Access and roles" above). Deployed with LEDGER's Live switch off; it takes effect when Ben flips it in HELM.

Original announcement (2026-09-30):

Einbau ID permissions moved to **company job roles plus a per-app matrix**,
owned by the HELM/auth session and signed off by Ben.

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
  | accounting | Same as pm for now; kept separate so it can be narrowed later | Accounting |
  | pm | Bill (invoice, push to CO, standalone), dispositions, undo, Project Settings | Project Manager, Project Coordinator |
  | viewer | Dashboard and sidebar, read-only | Estimator |
  | no access | — | CRM, Logistics |

- **Accounting (Ben, 2026-09-30):** an Accounting person who needs extra
  powers is given Admin, per person. The Accounting level itself may later be
  *more limited* than pm, not more powerful. So never build extra powers into
  `accounting`, and keep its checks separate from `pm` in code so it can be
  narrowed without a reshuffle.
- **LEDGER work when it ships:** enforce viewer / pm / accounting in the
  worker, not just admin: read-only actions for viewers, billing and
  disposition actions for pm and up. Hide the billing buttons in the sidebar
  for viewers.

Anything new about this change gets recorded here as it lands.
