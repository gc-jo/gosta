# GOSTA inventory — PWA rebuild design

Date: 2026-11-11 · Target launch: 2026-12-01 · Go/no-go: 2026-11-26 · Fallback launch: 2027-01-01

## 1. Goal

Replace the Google Apps Script + Google Sheets inventory app with an installable web app (PWA) that is:

- **Fast** — each action is one database round trip, not a 1–4 s Apps Script call.
- **Easy to maintain and extend** — one folder per feature; stock rules in one place; automated tests.
- **Idiot-proof** — Arabic, RTL, hard to enter a wrong number.
- **Free to run.**

Users: 20–30 internal staff across 16 active branches in Jordan, on personal phones. One owner administers everything.

## 2. Scope

### In scope for launch

Everything the current app does for its three roles, rebuilt with the same flows:

- Login with employee number + 4-digit PIN.
- Branch manager: receive transfers, send branch-to-branch transfers, local purchases, inventory count, balance view.
- Distributor (warehouse): the same as a manager, plus a sent log (last 7 days) and required cost.
- Owner: balances, purchases, transfers, counts, settings.

Changes from the current app:

| # | Change |
|---|---|
| C1 | Distributor is a branch manager of the warehouse, plus the sent log. |
| C2 | Owner can edit or void any purchase. History of old values is kept. |
| C3 | Owner resolves unreceived ("stuck") transfers: accept, deny, or edit-then-accept. |
| C4 | Received transfers can never be edited by anyone. |
| C5 | Cost is a **line total**. Required for the distributor on transfers and purchases; optional for managers. |
| C6 | On receipt, the quantity the receiver confirms is the real quantity for both branches (section 6.2). |
| C7 | Inventory count is improved: save-and-continue, multi-unit entry, completeness enforced, owner review, approved count becomes the opening balance. Per-item-type entry screens are defined in a separate file from the owner (section 8). |
| C8 | Balances are computed from a ledger, never stored. |

### Out of scope

- Recipe-based consumption and variance reporting (version 2; the ledger is shaped to accept it).
- Offline use. The app is **online only**.
- Migration of historical transfers, purchases, logs or balances.
- In-app screens for editing items, units, suppliers, supplier items and allowed purchases. At launch the owner edits these in the Supabase table view.
- Editing transfers after receipt. Exports. Push notifications.

## 3. Architecture

```
Phone (PWA: React + TypeScript)
   │  HTTPS, supabase-js
   ▼
Supabase (Frankfurt)
   ├─ Auth            sessions
   ├─ Edge Function   login (PIN check, lockout)
   ├─ Postgres        tables, row-level security, RPC functions = all stock rules
   └─ (nightly)  ◄──  GitHub Actions: encrypted pg_dump backup
Cloudflare Pages      static hosting, auto-deploy from GitHub
```

Principles:

- **Thin app, smart database.** Every write goes through a Postgres function (RPC). Each function is one transaction: it fully happens or does not happen. The client never inserts, updates or deletes table rows directly.
- **Reads** go straight from the client to tables/views, filtered by row-level security.
- **No custom server.**

### Stack

| Layer | Choice |
|---|---|
| Front end | React, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, `vite-plugin-pwa` |
| Back end | Supabase free plan: Postgres, Auth, one Edge Function |
| Hosting | Cloudflare Pages free plan |
| CI | GitHub Actions: tests on every push, nightly backup |

### Environments

Two Supabase projects (the free plan's limit): `gosta-test` and `gosta-live`. Schema changes are numbered migration files in the repository, applied to test first, then live.

### Free-plan constraints and mitigations

- 500 MB database: current volume is about 1,000 rows/month, so this is not a practical limit. The owner settings screen shows current size.
- Pause after 7 idle days: daily use and the nightly backup job prevent it.
- No automatic backups: a nightly GitHub Actions job runs `pg_dump`, encrypts the file, and stores it as a workflow artifact (90-day retention). The repository must be private.
- Free-plan limits are to be confirmed on Supabase's official pricing page when the projects are set up.

## 4. Data model

Timestamps are stored in UTC and shown in `Asia/Amman`. Inventory periods are calendar months in `Asia/Amman`. Quantities are `numeric`. Every operational row stores both the entered quantity + unit and the `base_quantity` in the item's base unit.

### Reference data (owner-managed)

| Table | Columns |
|---|---|
| `branches` | `id` (e.g. `BR-01`), `name_ar`, `kind` (`branch` \| `warehouse` \| `waste`), `active` |
| `items` | `id`, `name_ar`, `base_unit`, `item_type` (`syrup` \| `puree` \| `powder` \| `sauce` \| `cups` \| `mixed`), `sort_order`, `active` |
| `item_units` | `item_id`, `unit_name`, `conversion_rate` (> 0; base unit row has rate 1), `active` |
| `suppliers` | `id`, `name_ar`, `phone`, `active` |
| `supplier_items` | `supplier_id`, `item_id`, `active` |
| `allowed_local_purchases` | `branch_id`, `item_id`, `active` |
| `branch_features` | `branch_id`, `feature_key` (`receive`, `send`, `purchase`, `count`, `balance`), `visible` |
| `app_users` | `id` (= auth user id), `employee_number` (unique), `name`, `role` (`manager` \| `distributor` \| `owner`), `branch_id` (null for owner), `active`, `failed_attempts`, `locked_until`, `session_expires_at` |

Foreign keys and check constraints make the dirty data found in the current sheet (units for missing items, blank suppliers, a branch id typed into a status column) impossible to enter.

### Operations

| Table | Columns |
|---|---|
| `transfers` | `id`, `request_id` (unique), `from_branch`, `to_branch`, `created_by`, `created_at` |
| `transfer_lines` | `id`, `transfer_id`, `item_id`, `quantity`, `unit`, `base_quantity`, `cost_total` (nullable), `status` (`pending` \| `received` \| `denied`), `received_quantity`, `received_unit`, `received_base_quantity`, `diff_reason` (`overloaded` \| `count_error` \| `not_loaded`), `note`, `resolved_by`, `resolved_at`, `resolved_by_owner` (bool) |
| `purchases` | `id`, `request_id` (unique), `branch_id`, `supplier_id`, `created_by`, `created_at` |
| `purchase_lines` | `id`, `purchase_id`, `item_id`, `quantity`, `unit`, `base_quantity`, `cost_total` (nullable), `voided_at`, `voided_by` |
| `purchase_line_history` | `id`, `purchase_line_id`, `changed_by`, `changed_at`, `action` (`edit` \| `void`), `old_values` (json) |
| `count_windows` | `branch_id`, `period_month`, `status` (`open` \| `closed`), `opened_by`, `opened_at`, `closed_by`, `closed_at` — one row per branch and month |
| `counts` | `id`, `branch_id`, `period_month`, `status` (`draft` \| `submitted` \| `returned` \| `approved`), `submitted_by`, `submitted_at`, `reviewed_by`, `reviewed_at`, `review_note` — one non-superseded count per branch and month |
| `count_lines` | `count_id`, `item_id`, `state` (`uncounted` \| `counted` \| `none`), `entries` (json: per-unit inputs; shape per item type, section 8), `base_quantity`, `needs_recount` (bool) |

### Ledger

| Table | Columns |
|---|---|
| `stock_movements` | `id`, `branch_id`, `item_id`, `base_quantity` (signed), `kind`, `ref_table`, `ref_id`, `occurred_at`, `created_by`, `created_at` |
| `stock_baselines` | `id`, `branch_id`, `item_id`, `base_quantity`, `effective_at`, `source` (`count` \| `owner_zero`), `ref_id`, `created_by` |
| `activity_log` | `id`, `at`, `user_id`, `action`, `entity_table`, `entity_id`, `details` (json) |

Ledger and log rows are insert-only. Nothing is updated or deleted.

## 5. Login and permissions

### Login

1. The app sends employee number + PIN to the `login` Edge Function.
2. The function rejects if the user is missing, inactive, or locked. It verifies the PIN against a salted slow hash. Five consecutive failures lock the account for 15 minutes. Every attempt is logged.
3. On success it signs the user in to Supabase Auth with a long server-derived secret (never the PIN itself, never known to the client), sets `session_expires_at` to 7 days ahead, and returns the session.

The PIN is never stored in plain text. PINs are set and reset only by the owner through the app.

### Sessions

- The phone stays signed in for 7 days; a logout button is always visible.
- Every RPC and every row-level-security policy checks `active = true` and `now() < session_expires_at`. Deactivating a user or resetting their PIN ends their access immediately.

### Permissions (enforced in the database)

| Capability | Manager | Distributor | Owner |
|---|---|---|---|
| Read own branch's transfers, purchases, counts, balance | yes | yes | all branches |
| Receive transfers addressed to own branch | yes | yes | — |
| Send transfers from own branch | yes | yes, cost required | — |
| Local purchase (allowed items and supplier items only) | yes, cost optional | yes, cost required | — |
| Count own branch while its window is open | yes | yes | — |
| Sent log, last 7 days | — | yes | all, any dates |
| Edit / void purchases | — | — | yes |
| Resolve stuck transfers | — | — | yes |
| Open / close count windows; approve / return counts | — | — | yes |
| Zero a branch's balance | — | — | yes |
| Manage users, PINs, feature visibility | — | — | yes |

Managers and distributors can never read another branch's stock, purchases or costs. A feature hidden for a branch in `branch_features` is hidden in the UI and refused by the matching RPC. The waste branch's keeper is a manager with send and purchase hidden.

## 6. Stock rules

### 6.1 Balance

For a branch and item:

> balance = latest baseline quantity (0 if none) + sum of movements with `occurred_at` after that baseline's `effective_at`

Because consumption is not recorded, a balance means "last count plus what came in, minus what was sent out". Balances are **shown, never used to block** an action: sending more than the balance is allowed.

### 6.2 Transfers

- **Send** (`send_transfer`): validates branch, items, units, quantities > 0, destination active and different from source, cost present if the sender is a distributor. Writes the transfer, its lines (`pending`), and one `transfer_out` movement per line (−`base_quantity`, source branch).
- **Receive** (`receive_transfer`): the receiver confirms every pending line of one transfer in one call. For each line: received quantity + unit; if it differs from sent, a reason is required. Writes:
  - `transfer_in` at the destination: +received, `occurred_at` = now.
  - If received ≠ sent, `transfer_adjust` at the source: +(sent − received), `occurred_at` = the original send time. Net effect: the source's stock went down by exactly what the destination received.
  - `cost_total` is scaled by received ÷ sent.
- **Owner accept**: same as a receipt in full, marked `resolved_by_owner`.
- **Owner deny**: line becomes `denied`; `transfer_adjust` returns the full sent quantity to the source (dated at the send time).
- **Owner edit**: changes the sent quantity/unit of a pending line (adjusting the source movement), then accepts it.
- Only `pending` lines can change. A `received` or `denied` line is final.

### 6.3 Purchases

- **Create** (`create_purchase`): validates the supplier is active, each item is sold by that supplier and allowed for the branch, unit valid, quantity > 0, cost present if the user is a distributor. Writes a `purchase_in` movement per line.
- **Owner edit** (`edit_purchase_line`): saves old values to history, updates the line, writes a `purchase_adjust` movement for the difference, dated at the original purchase time.
- **Owner void** (`void_purchase_line`): saves history, marks the line voided, writes a reversing movement dated at the original purchase time.

Dating corrections at the original event time means a correction to something that happened before the latest approved count does not disturb the current balance — the count already captured reality.

### 6.4 Counts and baselines

- Approving a count writes one `stock_baselines` row per counted item, `effective_at` = the moment the manager submitted. Movements after that moment apply on top.
- **Zero a balance** writes baselines of 0 for every item in the branch, effective now.

### 6.5 No double submissions

Every write RPC takes a `request_id` generated by the app when the form opens. A repeated call with the same `request_id` returns the original result and changes nothing.

## 7. Screens

Visual design: keep the current app's look (emerald, Cairo font, rounded white cards, same layout) with tidier spacing, larger touch targets and consistent buttons. Arabic and RTL throughout.

### Manager and distributor — bottom tab bar

| Tab | Behaviour |
|---|---|
| استلام | Shipments waiting for this branch, by sender and date. Open one; per line confirm as sent, or enter the real quantity + unit and pick a reason. Review, then confirm the shipment. |
| تحويل | Pick destination; add items with quantity and unit (cost for distributor); review; send. |
| شراء | Pick supplier; only items that supplier sells and the branch may buy are offered; quantity and unit (cost for distributor, optional for manager); review; save. |
| جرد | Section 8. |
| رصيد | Current balance per item in recognisable units, with the date of the last approved count. |
| سجل الإرسال | Distributor only. Transfers sent in the last 7 days and each line's status. |

### Owner

| Area | Behaviour |
|---|---|
| الأرصدة | Balance for any branch and item. |
| المشتريات | Filter by date range and branch; totals; edit or void a line. |
| التحويلات | Filter by date range, branch, status. Stuck (pending) transfers listed first with accept, deny, edit. |
| الجرد | Open/close a window per branch and month; review submitted counts; approve or return (whole count or ticked items, with a note). Review flags any item counted above "opening + received", which is physically impossible. |
| الإعدادات | Users (create, deactivate, reset PIN, unlock), feature visibility per branch, zero a balance, database size. |

### Idiot-proofing rules (every screen)

1. Every quantity shows its unit and the live conversion to the base unit.
2. A review screen precedes every submit.
3. Unusual-quantity warning: if a line's base quantity is more than 5× the largest quantity that branch entered for that item in the past 60 days, ask "هل أنت متأكد؟" with the number spelled out. Warn, never block. No history → no warning.
4. Choices, not typing, for items, units, suppliers, branches and reasons. Free text only for optional notes.
5. Arabic-Indic and Latin digits both accepted; numeric keypad on quantity fields.
6. The submit button locks while sending. The result is always an explicit "تم الحفظ" or a plain-Arabic error saying what to do.
7. On failure, entered values stay on screen.
8. App updates apply automatically on next open.

With no connection, the app shows a clear "لا يوجد اتصال بالإنترنت" state and disables submitting.

## 8. Inventory count

Fixed by this design:

1. Owner opens a window for a branch and month.
2. Manager counts **blind** (no expected quantity shown). Items in sort order, with search, a progress indicator, and a "remaining only" filter.
3. Each item ends in one of two states: counted, or explicitly "لا يوجد". Blank is not zero.
4. Multi-unit entry with conversion.
5. Entries are saved to the server as a `draft` as they are typed; the manager can leave and resume on any device.
6. Submit is disabled until every item has a state. A summary screen precedes confirmation. After submit the count is locked for the manager.
7. Owner approves, or returns the whole count or selected items with a note; the manager recounts only those and resubmits.
8. Approval creates the baselines (section 6.4).

**Open:** the entry screen for each of the six item types (syrup, puree, powder, sauce, cups, mixed) is defined by a file the owner will supply by 2026-11-16. It will be added to this spec as section 8.1 and determines the shape of `count_lines.entries`. If it arrives later, launch uses a single generic multi-unit entry screen and the per-type screens follow after launch.

No branch has ever completed a count, so the first approved count in the new system is each branch's opening balance.

## 9. Launch data

Imported once into `gosta-live` from the owner's cleaned reference data: branches, items (with `item_type`), units, suppliers, supplier items, allowed local purchases. Users are created fresh with new PINs.

Owner clean-up before import:

- Remove units for non-existent items D-052, D-075, D-076, D-081; add a base-unit row for D-092.
- Remove 42 allowed-purchase rows and 3 supplier-item rows that reference non-existent items; fix the row with `BR-11` in the status column.
- Remove 6 empty supplier rows; add "مورد محلي" as a real supplier if it is still used.
- Set `kind` for the warehouse (BR-14) and waste (BR-15) branches.
- Assign an item type to each of the 89 items.

The import script validates everything and refuses to load on any error, listing each problem.

## 10. Code organisation

```
app/                      front end
  src/features/<feature>/ login, receive, send, purchase, count, balance, sent-log, owner-*
  src/shared/             UI components, number/unit helpers, Supabase client, Arabic strings
supabase/
  migrations/             numbered schema + RPC files
  functions/login/        Edge Function
  tests/                  database tests
scripts/import/           one-time reference-data import
legacy/                   the old Apps Script app, unchanged, for reference
docs/
```

Each feature folder owns its screens, its data calls and its tests, and depends only on `shared/`.

## 11. Testing

- **Database tests** for every RPC: happy path, each validation, each permission boundary, idempotency, and ledger arithmetic (send/receive with differences, deny, owner edit, purchase edit/void before and after a baseline, count approval, zeroing).
- **Replay check**: the real July–November transfers and purchases are replayed through the RPCs on the test project; totals in and out must reconcile.
- **Front-end tests** for quantity/unit conversion, digit normalisation and form validation.
- **Owner acceptance checklist** run on `gosta-test` on Nov 24–26.
- CI runs all automated tests on every push; nothing deploys on a failure.

## 12. Deployment and cutover

- `main` deploys to Cloudflare Pages automatically; migrations are applied to test, then live.
- Nov 27–30: reference data imported to live, users created, app installed on phones, count windows opened for opening balances.
- Dec 1: live. The old Apps Script deployment is disabled the same day.

## 13. Schedule

| Dates | Work |
|---|---|
| Nov 12–13 | Spec and plan approved; project access set up |
| Nov 13–17 | Schema, ledger, RPCs, database tests, login |
| Nov 16 | Count rules file due from owner |
| Nov 17–21 | Receive, send, purchase, balance, sent log |
| Nov 21–24 | Count and owner screens |
| Nov 24–26 | Import to test; owner acceptance testing |
| Nov 26 | Go / no-go |
| Nov 27–30 | Live set-up |
| Dec 1 | Launch |

Order of cuts if time runs short: (1) polish on owner report screens, (2) per-type count screens (generic screen ships instead), (3) launch moves to Jan 1. Tests on stock rules are never cut.

## 14. Needed from the owner

| Item | By |
|---|---|
| Access to the two Supabase projects and Cloudflare Pages (keys entered through secure settings, never in chat) | Nov 13 |
| Count rules file | Nov 16 |
| Cleaned reference data with item types | Nov 20 |
| Launch user list with roles and branches | Nov 24 |
| Acceptance testing | Nov 24–26 |
