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

- Login with employee number + 4-digit PIN (staff) or employee number + password (owner).
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
| C9 | A branch is frozen (no receive, send or purchase) while its count is being entered (section 6.4). |
| C10 | The owner signs in with a password of at least 12 characters, not a PIN. |
| C11 | Every receipt whose quantity differs from the sent quantity is listed for the owner and shown to the sender. |

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
- No automatic backups: a nightly GitHub Actions job runs `pg_dump` (through the Supabase session pooler, because GitHub runners have no IPv6), encrypts the file, and uploads it to a Cloudflare R2 bucket (free tier), keeping 90 days. The repository must be private.
- GitHub disables scheduled workflows after 60 days without repository activity, which would stop both the backup and the keep-alive. Each run re-enables its own workflow through the GitHub API (to be confirmed at set-up), and each run records itself in a `backup_runs` table. The owner settings screen shows the last successful backup and turns red when it is older than 48 hours.
- A backup that has never been restored is not a backup: once before launch and monthly after, the latest file is restored into `gosta-test` and row counts are compared.
- Free-plan limits are to be confirmed on Supabase's official pricing page when the projects are set up.

## 4. Data model

Timestamps are stored in UTC and shown in `Asia/Amman`. Inventory periods are calendar months in `Asia/Amman`. Quantities are `numeric`. Every operational row stores the entered quantity + unit, the conversion rate in force at that moment (`unit_rate`), and the `base_quantity` in the item's base unit. A stored `base_quantity` is never recomputed when a rate later changes.

### Reference data (owner-managed)

| Table | Columns |
|---|---|
| `branches` | `id` (e.g. `BR-01`), `name_ar`, `kind` (`branch` \| `warehouse` \| `waste`), `active` |
| `items` | `id`, `name_ar`, `base_unit`, `item_type` (`syrup` \| `puree` \| `powder` \| `sauce` \| `cups` \| `mixed`), `sort_order`, `active`, `counted` (false = excluded from counts, e.g. American filters), `count_method` (`units` \| `containers`, section 8.1), `net_grams_per_base_unit` (containers only: grams of net weight that make one base unit; 1 when the base unit is the gram) |
| `item_units` | `item_id`, `unit_name`, `conversion_rate` (> 0; base unit row has rate 1), `active`, `count_visible` (this unit gets its own field on the count screen) |
| `item_containers` | `id`, `item_id`, `name_ar` (e.g. "عبوة 1 لتر"), `content_base_quantity` (content of one **closed** container in the base unit; null until the owner sets it), `variants` (text[] of empty-container variants a weighed container can be: `{default}`, or for syrup `{glass_pump, glass_cap, plastic_pump, plastic_cap}`), `active` |
| `container_tares` | `container_id`, `variant`, `tare_grams` (> 0: weight of the empty container with its attachment), `updated_by`, `updated_at` — one row per container and variant |
| `suppliers` | `id`, `name_ar`, `phone`, `active` |
| `supplier_items` | `supplier_id`, `item_id`, `active` |
| `allowed_local_purchases` | `branch_id`, `item_id`, `active` |
| `branch_features` | `branch_id`, `feature_key` (`receive`, `send`, `purchase`, `count`, `balance`), `visible` |
| `app_users` | `id`, `auth_user_id` (unique, null until first login), `employee_number` (unique), `name`, `role` (`manager` \| `distributor` \| `owner`), `branch_id` (null for owner), `active`, `failed_attempts`, `locked_until`, `credential_version` |
| `app_user_secrets` | `user_id`, `secret_hash` — readable by no client role |
| `app_sessions` | `session_id` (the Supabase Auth session id), `user_id`, `created_at`, `expires_at`, `revoked_at` — one row per login; readable by no client role |

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
| `counts` | `id`, `branch_id`, `period_month`, `status` (`draft` \| `submitted` \| `returned` \| `approved`), `submitted_by`, `submitted_at`, `reviewed_by`, `reviewed_at`, `review_note`, `frozen_since` (null when the branch is not frozen by this count), `revision` — one count per branch and month |
| `count_lines` | `count_id`, `item_id`, `state` (`uncounted` \| `counted` \| `none`), `entries` (json: exactly what the employee entered; shape per count method, section 8.1), `base_quantity`, `pending_setup` (bool: counted, but a tare or closed-container content it needs is not set yet, so `base_quantity` is null), `calc` (json: the rates, contents and tares used and when the result was computed), `needs_recount` (bool), `revision`, `effective_at` (the submit time of the round in which this line was last counted) |

### Ledger

| Table | Columns |
|---|---|
| `stock_movements` | `id`, `branch_id`, `item_id`, `base_quantity` (signed), `kind`, `ref_table`, `ref_id`, `occurred_at`, `created_by`, `created_at` |
| `stock_baselines` | `id`, `branch_id`, `item_id`, `base_quantity`, `effective_at`, `source` (`count` \| `owner_zero`), `ref_id`, `created_by` |
| `activity_log` | `id`, `at`, `user_id`, `action`, `entity_table`, `entity_id`, `details` (json) |
| `rpc_requests` | `request_id`, `rpc_name`, `user_id`, `request_hash`, `result` (json), `created_at` — backs section 6.5 |
| `backup_runs` | `id`, `at`, `ok`, `size_bytes` |

Ledger and log rows are insert-only. Nothing is updated or deleted.

## 5. Login and permissions

### Login

1. The app sends employee number + secret to the `login` Edge Function. The secret is a 4-digit PIN for managers and distributors and a password of at least 12 characters for the owner.
2. The function rejects if the user is missing, inactive, or locked. It verifies the secret against a salted slow hash. Five consecutive failures lock the account for 15 minutes. Every attempt is logged. The check and the lockout counter live in one database function, so they are covered by the database tests.
3. On success it signs the user in to Supabase Auth with a long server-derived secret (never the PIN itself, never known to the client), creating the Auth user on first login, records that login in `app_sessions` with an expiry 7 days ahead, and returns the session. Provisioning is resumable: if an earlier attempt created the Auth user but did not finish, or two first logins arrive together, the next attempt completes it. Public sign-up is disabled in Supabase Auth.

Secrets are never stored in plain text and the hashes are readable only by the server. PINs are set and reset only by the owner through the app. The owner's own password is reset from the Supabase dashboard if it is lost.

Known limit: a 4-digit PIN can still be guessed in days of patient trying, and anyone can lock a colleague out for 15 minutes by typing their employee number. This is accepted for staff accounts, whose reach is one branch and whose every action is logged; it is the reason the owner account does not use a PIN.

### Sessions

- The phone stays signed in for 7 days; a logout button is always visible.
- Every RPC and every row-level-security policy checks that the user is active and that the token's own session (`session_id` claim) exists in `app_sessions`, is not revoked and has not expired. Deactivating a user or resetting their PIN revokes all their sessions; a later login creates a new session and does not revive an old one, so an old token or refresh token stays dead. A reset also advances the user's `credential_version`; a login that was verified with the old PIN but had not finished when the reset happened is refused at the last step.
- Logout revokes the current session on the server.
- **What revocation does and does not stop.** Authorization is checked when a request starts. A reset, deactivation or logout refuses every request that starts afterwards. Requests of that session that were already running at that moment — there can be several — finish normally and are logged under that user. This is accepted; the one exception is a password change, which rechecks before it writes.
- **Owner lockout and recovery.** The 15-minute lockout after five wrong attempts applies to the owner as well, so the owner's password cannot be guessed without limit; the cost is that someone who knows the owner's employee number can keep the owner out for 15 minutes at a time. A lock always expires by itself. If the owner is locked out with no active session, has lost the password, or is being locked out repeatedly, recovery is done from the Supabase dashboard following `docs/runbooks/owner-account-recovery.md`.

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
- A send, receipt or purchase is refused with a plain-Arabic message while the acting branch is frozen by a count (section 6.4). Sending *to* a frozen branch is allowed; the shipment waits as pending.
- **Receive** (`receive_transfer`): the receiver confirms every pending line of one transfer in one call. For each line: received quantity + unit; if it differs from sent, a reason is required. Writes:
  - `transfer_in` at the destination: +received, `occurred_at` = now.
  - If received ≠ sent, `transfer_adjust` at the source: +(sent − received), `occurred_at` = the original send time. Net effect: the source's stock went down by exactly what the destination received.
  - `cost_total` is scaled by received ÷ sent.
  - A receipt entered in the same unit as the send is converted with the rate stored on the line when it was sent, so "received as sent" always equals the sent quantity even if the unit's rate was changed or the unit deactivated in between.
- **Owner accept**: same as a receipt in full, marked `resolved_by_owner`.
- **Owner deny**: line becomes `denied`; `transfer_adjust` returns the full sent quantity to the source (dated at the send time).
- **Owner edit**: changes the sent quantity/unit of a pending line (adjusting the source movement), then accepts it.
- Only `pending` lines can change. A `received` or `denied` line is final.

### 6.3 Purchases

- **Create** (`create_purchase`): validates the supplier is active, each item is sold by that supplier and allowed for the branch, unit valid, quantity > 0, cost present if the user is a distributor. Writes a `purchase_in` movement per line.
- **Owner edit** (`edit_purchase_line`): saves old values to history, updates the line, writes a `purchase_adjust` movement for the difference, dated at the original purchase time. If the unit is unchanged the line keeps the conversion rate it was recorded with, so editing only the cost never changes stock, even if the catalog rate has changed since. Only a deliberate change of unit uses today's rate. The same rule applies when the owner edits a pending transfer.
- **Owner void** (`void_purchase_line`): saves history, marks the line voided, writes a reversing movement dated at the original purchase time.

Dating corrections at the original event time means a correction to something that happened before the latest approved count does not disturb the current balance — the count already captured reality.

### 6.4 Counts and baselines

> **Confirmed by the owner on 2026-11-18 for every branch:** all four physical rules below, and the freeze design that depends on them. The owner opens the count for each branch at the end of the month; employees count from the app they are already signed in to.

- **Start.** The manager presses "بدء الجرد" to begin; nothing is created and nothing is frozen before that. The start screen states the physical rules and requires a tick to confirm each:
  1. **Books first.** Every delivery already on the shelf has been received in the app, and everything already sent out has been recorded as a transfer. The screen lists this branch's shipments still waiting to be received and asks, for each, whether it is physically here; if one is, the manager must receive it before starting.
  2. **No stock use.** The count is done while the branch is not serving — before opening or after closing — and in one sitting.
  3. **Arrivals wait.** A delivery that arrives during the count is put aside, not shelved and not counted, and is received in the app after the count is submitted.
  4. **Nothing leaves** until the count is submitted.
- **What is guaranteed and what is not.** The freeze guarantees that no *recorded* movement falls inside the count. It cannot see stock being used. The approved count equals the real stock at submission only if rules 1–4 were followed; a branch that counts while serving gets an opening balance that is wrong by whatever it used during the count, and the system cannot detect it. Rule 2 is therefore a condition of the count being valid, not advice.
- **Freeze.** From that start until the count is submitted, the branch is frozen: receive, send, purchase, owner-accept of a transfer into it, and zeroing are refused. No recorded movement can fall inside the count, so, given the physical rules above, the submit time is a true "as of" moment. Corrections dated in the past (section 6.3, deny, receipt adjustments at the source) are still allowed; they fall before the baseline.
- The manager sees a banner on every tab while frozen. The owner sees which branches are frozen and since when, and can discard a draft count (or a returned count abandoned mid-recount), which deletes its entries and lifts the freeze. An abandoned count therefore cannot block a branch for longer than the owner allows.
- Approving a count writes one `stock_baselines` row per item (0 for "لا يوجد"), `effective_at` = that line's `effective_at`. Movements after that moment apply on top.
- **Recount.** When the owner returns selected items, the branch freezes again from the moment the manager presses start on the recount until resubmission. Recounted lines take the resubmit time as `effective_at`; untouched lines keep the original submit time.
- **Zero a balance** writes baselines of 0 for every item in the branch, effective now.

### 6.5 No double submissions

Every write RPC takes a `request_id` generated by the app when the form opens. A repeated call with the same `request_id` and the same values returns the original result and changes nothing. The same `request_id` with different values is refused, so the app must generate a new id whenever the form's contents change after a failed attempt that it knows did not save.

### 6.6 Concurrency and ordering

- Any two operations that change the same record (a transfer line, a purchase line, a count) lock it first and then read it, so two simultaneous edits cannot both act on the old value.
- Operations that write stock for a branch "now", and the start and submission of that branch's count, take the same per-branch lock. The time recorded for each is read after the lock is held, so the order of timestamps is the order in which things actually happened.
- These rules are tested with two real simultaneous connections, not only in sequence.

## 7. Screens

Visual design: keep the current app's look (emerald, Cairo font, rounded white cards, same layout) with tidier spacing, larger touch targets and consistent buttons. Arabic and RTL throughout.

### Manager and distributor — bottom tab bar

| Tab | Behaviour |
|---|---|
| استلام | Shipments waiting for this branch, by sender and date. Open one; per line confirm as sent, or enter the real quantity + unit and pick a reason. Review, then confirm the shipment. |
| تحويل | Pick destination; add items with quantity and unit (cost for distributor); review; send. |
| شراء | Pick supplier; only items that supplier sells and the branch may buy are offered; quantity and unit (cost for distributor, optional for manager); review; save. Below the form: this branch's purchases today, read-only (the current app has this). |
| جرد | Section 8. |
| رصيد | Current balance per item in recognisable units, with the date of the last approved count. Until the branch has an approved count the tab shows "لا يوجد جرد افتتاحي بعد" instead of numbers. |
| سجل الإرسال | Distributor only. Transfers sent in the last 7 days and each line's status. Lines received with a different quantity are highlighted with the received quantity and the reason. |

### Owner

| Area | Behaviour |
|---|---|
| الأرصدة | Balance for any branch and item. |
| المشتريات | Filter by date range and branch; totals; edit or void a line. |
| التحويلات | Filter by date range, branch, status. Stuck (pending) transfers listed first with accept, deny, edit. A "فروقات الاستلام" filter lists every line received with a different quantity: sender, receiver, sent, received, reason, note. |
| الجرد | Open/close a window per branch and month; review submitted counts; approve or return (whole count or ticked items, with a note). Review flags any item counted above "opening + received", which is physically impossible. |
| الإعدادات | Users (create, deactivate, reset PIN, unlock), feature visibility per branch, zero a balance, database size, last successful backup. |
| معاملات التحويل | Count setup per item (section 8.1): units and conversion rates and which units appear on the count screen, count method, containers with their closed content, and the empty weight of every container variant. Lists every counted item whose setup is incomplete. Replaces the "معاملات التحويل" tab of the old count sheet; its values are imported once at launch. |

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
4. Entry by count method, with conversion done by the app (section 8.1). The employee counts and weighs; the app checks, converts and adds up.
5. Entries are saved to the server as a `draft` as they are typed; the manager can leave and resume on any device. Each save carries the revision it was based on; a late or duplicated save is rejected instead of overwriting newer work, and a save can never create a count or start a freeze. A rejected save is never reported as saved: the app keeps what the employee typed, reloads the stored value and compares; if they match it is marked saved, and if another phone stored something different both values are shown and the employee chooses.
6. Submit is disabled until every item has a state. A summary screen precedes confirmation, and the submission names the revision that summary showed; if anything changed since, it is refused and the summary reloads. After submit the count is locked for the manager.
7. Owner approves, or returns the whole count or selected items with a note; the manager recounts only those and resubmits.
8. Approval creates the baselines (section 6.4). The owner cannot approve while any line is `pending_setup` (section 8.1); the review screen lists those items and links to their setup.

No branch has ever completed a count, so the first approved count in the new system is each branch's opening balance.

### 8.1 Count entry by item

Source: the owner's count method, `docs/owner/2026-11-16-count-method-draft.md`, with the owner's decisions of 2026-11-18. Where the draft describes the old design (a PIN per branch, a Google Sheet for factors and output), this section replaces it as stated.

**Order on screen.** Sections in fixed order: puree (regular, then 1883), syrup (hot, then cold), sauces, powders, cups / lids / straws, miscellaneous. Before the first section the app reminds the employee to check the bar, the fridge and the store room. Order inside a section is `items.sort_order`. Items with `counted = false` never appear (American filters, shakers, butter bags, mini tart).

**Every item has one count method.**

*`units`* — one numeric field per unit with `count_visible = true`, whole numbers ≥ 0, plus "لا يوجد". Total = Σ quantity × rate. This covers:
- powders: كيلو and غرام side by side (2 كيلو + 350 غرام = 2,350 g; 1,250 typed in غرام shows "1 كيلو و250 غرام" and stays 1,250 g);
- cups, lids, straws: full carton, full bundle outside the counted cartons, loose pieces outside both; an open bundle is counted in pieces;
- miscellaneous, each with its own visible units: cup holders (carton + bundle, no loose field), spoons / gloves / bags (bundle only), cheesecake moulds (mould = 14 + loose pieces), tart (pieces), visa and cash rolls (new rolls only), and the reviewed packs (Bom Bom, Code Red, Red Bull by box + cans outside it; soda and cream chargers by pack + unused outside it; cookies by piece).

*`containers`* — for puree, syrup, sauces, liquid milk, condensed milk and Vitali cream. For each container size of the item:
1. The employee enters **closed** and **open** counts (0 if none), presses "تأكيد العدد", then enters both again on a blank screen. If either differs, the app asks for a recount of that item; nothing is saved until the two entries match.
2. The app shows **exactly as many weight fields as the confirmed open count**, each on its own card ("العبوة ٢ من ٤", grams) with progress ("تم إدخال ٢ من ٤ أوزان"). The employee weighs each open container alone, with its attachment, and types the scale reading as shown, then moves it aside so it is not weighed twice.
3. Syrup only: next to each weight, one choice of **بمب** or **غطاي**, and a separate tick **الزجاجة بلاستك** (unticked = glass). Each container has its own choice. These map to the variants `glass_pump`, `glass_cap`, `plastic_pump`, `plastic_cap`. Other items use `default`.
4. Changing the open count goes back to the counts screen. Weights that still belong to the same containers are kept; if the count drops, the employee picks which readings to remove.

Items packed in outer units count those too, in their own fields (liquid milk: full cartons of 12 + closed bottles outside them + weights of open ones).

**What the app computes** (never shown as a task to the employee):
- net of an open container = scale reading − `tare_grams` of its container and variant;
- line total in the base unit = Σ outer packs × rate + Σ closed × `content_base_quantity` + Σ net ÷ `net_grams_per_base_unit`, rounded to 3 decimals.
  Examples: syrup, base unit غرام, `net_grams_per_base_unit = 1`; liquid milk, base unit عبوة (1 l), carton = 12, net ÷ 1,000; condensed milk, base unit علبة (397 g), net ÷ 397; Vitali cream, base unit غرام, closed content set per container size from 1,100 g/l.
- Syrup is counted in grams. Closed content is set as a weight per container size; the label (e.g. 1,000 ml) only names the size. Sugar-free syrup is counted inside hot syrup; hot is one item, so hot containers that differ in content are separate container sizes of that one item.

**Readings are checked when saved.** Counts are whole numbers ≥ 0. A reading must be > 0 grams; a reading below the known empty weight of its container and variant is refused with "الوزن أقل من وزن العبوة الفارغة، أعد الوزن". A reading is kept exactly as typed; nothing is rounded before the calculation.

**Missing setup never blocks the employee.** Empty weights and closed contents are the owner's setup, done in the app (section 7, معاملات التحويل), and the employee never sees them. If a value the calculation needs is not set yet, the line is still saved and can be submitted: it is `counted` with `pending_setup = true` and no `base_quantity`, and the readings are kept. When the owner sets the missing value, every line of every **not yet approved** count that needs it is recomputed from its original readings, and `calc` records the values used and the time. The owner cannot approve a count while any of its lines is pending. Approved counts are never recomputed: their baselines are final, like every stored `base_quantity`.

**Submission.** Every counted item needs a state; "لا يوجد" is an explicit zero; a blank field means not finished. A `containers` line is complete only when both counts are confirmed and every open container has a reading. There is no "could not count" state. The review screen lists unfinished items and takes the employee back to them.

**Period.** A count belongs to the month the owner opened it for, also when counting runs past midnight.

**Replaced from the old design.** Login is the employee's own number and PIN (section 5), not a PIN per branch. Factors live in the app, not a sheet tab. The old summary sheet is replaced by the owner's count review screen, which shows per branch and item the date, quantity, unit and state; every original reading, the values used and any recount stay stored.

**Open, owner to supply before the first real count:** the final item list and each item's count method and visible units; container sizes and closed contents; empty weights (these may also be entered after a count); sauce sizes; whether the double count also applies to sauces (assumed yes, as proposed in the draft); the count frequency per branch; the policy for damaged and expired stock (not part of the count as specified).

## 9. Launch data

Imported once into `gosta-live` from the owner's cleaned reference data: branches, items (with `item_type`), units, suppliers, supplier items, allowed local purchases. Users are created fresh with new PINs.

Owner clean-up before import:

- Remove units for non-existent items D-052, D-075, D-076, D-081; add a base-unit row for D-092.
- Remove 42 allowed-purchase rows and 3 supplier-item rows that reference non-existent items; fix the row with `BR-11` in the status column.
- Remove 6 empty supplier rows; add "مورد محلي" as a real supplier if it is still used.
- Set `kind` for the warehouse (BR-14) and waste (BR-15) branches.
- Assign an item type to each of the 89 items.
- For counting (section 8.1): each item's `counted` flag, count method and visible units; containers and closed contents; empty weights where known. Imported from the old count sheet's "معاملات التحويل" tab; anything missing is entered later on the owner's setup screen.

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

- **Database tests** for every RPC: happy path, each validation, each permission boundary, idempotency, and ledger arithmetic (send/receive with differences, changed conversion rates, deny, owner edit, purchase edit/void before and after a baseline, count approval, zeroing).
- **Concurrency tests** on two real database connections: double receipt, receipt against owner resolution, two edits of one purchase, edit against void, and purchases racing the start and the submission of a count.
- **Session tests**: after a PIN reset and a new login, the old access token and old refresh token are still refused.
- **Replay check**: the real July–November transfers and purchases are replayed through the RPCs on the test project; totals in and out must reconcile.
- **Front-end tests** for quantity/unit conversion, digit normalisation and form validation.
- **Owner acceptance checklist** run on `gosta-test` on Nov 24–26.
- CI runs all automated tests on every push; nothing deploys on a failure.

## 12. Deployment and cutover

- `main` deploys to Cloudflare Pages automatically; migrations are applied to test, then live.
- Nov 27–30: reference data imported to live, users created, app installed on phones, count windows opened for opening balances.
- Dec 1: live. The old Apps Script deployment is disabled for staff the same day; the Sheet and the script stay untouched for 14 days.
- **Rollback.** Until Dec 15 the owner can re-enable the old deployment in minutes. Movements entered in the new app during that time would be re-keyed by hand from the owner's purchases and transfers screens; at about 35 rows a day this is tolerable for a few days and not beyond, so a rollback decision is made within the first week or not at all.
- **Opening balances are a launch risk, not a detail.** No branch has ever finished a count, and balances stay blank until one is approved. Transfers and purchases work without a balance, so launch does not wait for counts, but the owner tracks the opening count per branch as a checklist and the acceptance test on Nov 24–26 includes one full count, start to approval, by a real branch manager.

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
| Count rules file | Nov 16 — received; confirmed with decisions on Nov 18 (section 8.1) |
| Count setup: item list with count methods, container sizes and contents, empty weights (section 8.1, "Open") | before the first real count |
| Cleaned reference data with item types | Nov 20 |
| Launch user list with roles and branches | Nov 24 |
| Acceptance testing | Nov 24–26 |
