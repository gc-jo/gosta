# GOSTA Database Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Supabase database (schema, ledger, row-level security, every stock-rule RPC) and the login Edge Function, all covered by automated tests that run in CI.

**Architecture:** Postgres holds every rule. Each write is one `security definer` RPC running in one transaction; clients have no insert/update/delete rights on any table. Reads go through row-level security. A single Edge Function turns employee number + secret into a Supabase Auth session; the secret check and lockout live in a database function so they are tested with the rest.

**Tech Stack:** Supabase CLI (local stack in Docker), Postgres 15, pgTAP (`supabase test db`), pgcrypto, Deno (Edge Function + `deno test`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-11-gosta-pwa-design.md` — sections 4, 5, 6, 8 (rules 3, 5, 6, 7, 8), 11.

This is plan 1 of 4. Later plans, each written when the previous one is done: (2) front end for login, receive, send, purchase, balance, sent log; (3) count and owner screens; (4) import script, backup workflow, replay check, cutover.

## Global Constraints

- The client never inserts, updates or deletes a table row. `anon` and `authenticated` get `select` only (through RLS) and `execute` on the RPCs listed here.
- Every RPC is `security definer`, `set search_path = public, extensions`, and one transaction.
- Every RPC starts by calling `current_app_user()`; a missing, inactive or expired session raises `NOT_AUTHENTICATED`.
- Errors are raised as `raise exception '<CODE>'` (SQLSTATE `P0001`) where `<CODE>` is one of the codes in Task 4. The front end maps codes to Arabic; the database never returns Arabic prose.
- Timestamps are `timestamptz` (UTC). Inventory periods are the first day of a calendar month in `Asia/Amman`, stored as `date`.
- Quantities are `numeric`, never float. Every operational row stores entered `quantity` + `unit` and `base_quantity`.
- `stock_movements`, `stock_baselines`, `activity_log`, `purchase_line_history` are insert-only, enforced by trigger even for the table owner.
- Balances are shown, never used to block an action.
- Every write RPC except `save_count_line` takes `p_request_id uuid`; a repeat with the same id returns the stored result and changes nothing.
- Migration files are numbered `NNNN_name.sql` and never edited after they are merged.
- Stock-rule tests are never cut.

## Review Focus

1. **Two phones receive the same transfer at once.** Expected: one succeeds, the other gets `LINE_NOT_PENDING`; exactly one `transfer_in` per line. (Task 6)
2. **Unit deactivated or conversion rate changed after a send, before the receipt.** Expected: the receipt may use any unit that exists for the item, active or not, when it equals the sent unit; stored `base_quantity` of the send is never recomputed. (Task 6)
3. **Count window closed, or month rolls over, while a draft is frozen.** Expected: the draft can still be submitted or discarded; the branch never stays frozen with no way out. (Task 9)
4. **Receipt quantity of zero ("not loaded" for the whole line).** Expected: accepted with reason `not_loaded`; destination gets no movement, source gets the full quantity back, line cost becomes 0. (Task 6)
5. **A user whose session expired or who was deactivated mid-form.** Expected: the RPC raises `NOT_AUTHENTICATED` and writes nothing, and reads return zero rows rather than an error page of data. (Tasks 4, 5)

---

## File Structure

```
supabase/
  config.toml                         CLI config (created by `supabase init`)
  seed.sql                            test fixtures + test helper functions (local/CI only)
  migrations/
    0001_reference.sql                branches, items, item_units, suppliers, supplier_items,
                                      allowed_local_purchases, branch_features, app_users, app_user_secrets
    0002_operations.sql               transfers, transfer_lines, purchases, purchase_lines,
                                      purchase_line_history, count_windows, counts, count_lines
    0003_ledger.sql                   stock_movements, stock_baselines, activity_log, rpc_requests,
                                      insert-only triggers, balances view
    0004_helpers.sql                  current_app_user, require_*, to_base, idempotency helpers, log helper
    0005_rls.sql                      grants + policies
    0006_rpc_transfers.sql            send_transfer, receive_transfer, owner_resolve_transfer_line
    0007_rpc_purchases.sql            create_purchase, edit_purchase_line, void_purchase_line
    0008_rpc_counts.sql               open/close_count_window, save_count_line, submit_count,
                                      review_count, discard_count_draft, zero_branch_balance
    0009_rpc_admin.sql                admin_* user RPCs, set_branch_feature
    0010_login.sql                    login_verify, login_attach_auth_user (service role only)
  functions/login/
    index.ts                          HTTP handler
    derive.ts                         deriveAuthPassword()
    derive_test.ts
  tests/
    01_schema.test.sql … 10_login.test.sql   one pgTAP file per migration
.github/workflows/test.yml            runs db tests + deno tests on every push
legacy/                               src/Code.js, src/index.html moved here unchanged
```

## Fixtures (used by every test task)

`supabase/seed.sql` creates exactly this; tests refer to these ids.

| Kind | Rows |
|---|---|
| branches | `BR-01` فرع 1 (`branch`), `BR-02` فرع 2 (`branch`), `BR-14` المستودع (`warehouse`), `BR-15` التالف (`waste`), `BR-09` (`branch`, `active = false`) |
| items | `D-001` base unit `مل`, type `syrup`; `D-002` base unit `حبة`, type `cups`; `D-003` base `غم`, type `powder`, `active = false` |
| item_units | `D-001`: `مل` ×1, `عبوة` ×750, `كرتونة` ×9000. `D-002`: `حبة` ×1, `كرتونة` ×1000. `D-003`: `غم` ×1 |
| suppliers | `S-01` active, sells `D-001`. `S-02` inactive, sells `D-002` |
| allowed_local_purchases | (`BR-01`, `D-001`), (`BR-14`, `D-001`) |
| branch_features | every (branch, feature) visible, except `BR-15`: `send` and `purchase` hidden |
| app_users | `100` owner (password `correct horse battery`), `201` manager `BR-01` (PIN `1111`), `202` manager `BR-02` (PIN `2222`), `301` distributor `BR-14` (PIN `3333`), `215` manager `BR-15` (PIN `1515`), `299` manager `BR-01` inactive |

Each seeded user has a row in `auth.users` and `auth_user_id` set, and `session_expires_at = now() + interval '7 days'`.

Test helpers in schema `test` (seed only, never in a migration):

- `test.act_as(p_employee_number text) returns void` — `set local role authenticated` and sets `request.jwt.claims` to `{"sub": <auth_user_id>, "role": "authenticated"}`.
- `test.act_as_service() returns void` — `set local role service_role`.
- `test.reset_role() returns void` — `reset role`, clears the claims.
- `test.balance(p_branch text, p_item text) returns numeric` — reads `balances` as postgres; 0 when no row.

---

### Task 1: Repository layout, local stack, CI

**Files:**
- Move: `src/Code.js` → `legacy/Code.js`, `src/index.html` → `legacy/index.html`
- Modify: `README.md` (replace the clasp workflow with: what the repo is, `supabase start`, `supabase db reset`, `supabase test db`; keep one paragraph saying `legacy/` is the old app, reference only)
- Create: `supabase/config.toml` (via `supabase init`), `supabase/seed.sql` (empty for now), `supabase/tests/00_smoke.test.sql`, `.github/workflows/test.yml`

**Interfaces:**
- Produces: `supabase db reset` applies all migrations then `seed.sql`; `supabase test db` runs every `supabase/tests/*.test.sql`.

- [ ] **Step 1: Move the legacy files with `git mv` and run `supabase init`** (accept defaults; project id `gosta`).

- [ ] **Step 2: Write the smoke test `supabase/tests/00_smoke.test.sql`**

```sql
begin;
select plan(2);
select has_extension('pgcrypto');
select has_extension('pgtap');
select * from finish();
rollback;
```

- [ ] **Step 3: Run `supabase start && supabase test db`.** Expected: `has_extension('pgcrypto')` fails or passes depending on the image; if it fails, add `supabase/migrations/0000_extensions.sql` with `create extension if not exists pgcrypto with schema extensions;` and re-run until both pass.

- [ ] **Step 4: Write `.github/workflows/test.yml`.** Trigger: `push` and `pull_request`. One job on `ubuntu-latest`: checkout, `supabase/setup-cli@v1`, `supabase db start`, `supabase test db`, `denoland/setup-deno@v2`, `deno test supabase/functions/` (add `--allow-none` so the job passes while no Deno tests exist yet).

- [ ] **Step 5: Commit** — `chore: move legacy app, add supabase local stack and CI`. Push and confirm the workflow is green.

---

### Task 2: Reference schema and fixtures

**Files:**
- Create: `supabase/migrations/0001_reference.sql`, `supabase/tests/01_schema.test.sql`
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces: the nine reference tables with the columns in spec section 4, plus the fixtures and `test.*` helpers above. Column decisions the spec leaves open:
  - Text primary keys: `branches.id`, `items.id`, `suppliers.id`. `app_users.id uuid default gen_random_uuid()`.
  - `item_units` primary key `(item_id, unit_name)`; check `conversion_rate > 0`. A constraint trigger requires that `items.base_unit` exists in `item_units` for that item with `conversion_rate = 1` (deferred to end of transaction so item + units can be inserted together).
  - `branch_features.feature_key` check in (`receive`,`send`,`purchase`,`count`,`balance`); primary key `(branch_id, feature_key)`. A missing row means visible.
  - `app_users`: check `(role = 'owner') = (branch_id is null)`; `failed_attempts int not null default 0`; `employee_number text unique` matching `^[0-9]+$`.
  - `app_user_secrets(user_id uuid primary key references app_users, secret_hash text not null)`.
  - Enumerations are `text` + check constraints, not Postgres enums (cheaper to migrate).

- [ ] **Step 1: Write the failing test `01_schema.test.sql`**

```sql
begin;
select plan(8);
select has_table('branches'); select has_table('app_user_secrets');
select throws_ok($$insert into item_units values ('D-999','مل',1,true)$$, '23503');          -- unit for a missing item
select throws_ok($$insert into item_units values ('D-001','برميل',0,true)$$, '23514');        -- rate must be > 0
select throws_ok($$insert into branches(id,name_ar,kind,active) values ('BR-77','x','BR-11',true)$$, '23514');  -- junk in kind
select throws_ok($$insert into app_users(employee_number,name,role,branch_id) values ('900','x','owner','BR-01')$$, '23514');
select throws_ok($$insert into supplier_items values ('S-01','D-999',true)$$, '23503');
select is((select count(*) from app_users where auth_user_id is not null), 6::bigint, 'six seeded users');
select * from finish();
rollback;
```

- [ ] **Step 2: Run `supabase db reset && supabase test db`.** Expected: FAIL, tables do not exist.
- [ ] **Step 3: Write `0001_reference.sql`** per the Interfaces block and spec section 4.
- [ ] **Step 4: Write `seed.sql`:** the fixture table above and the four `test.*` helpers. Hash secrets with `extensions.crypt(secret, extensions.gen_salt('bf', 10))`. Insert `auth.users` rows with `id`, `aud = 'authenticated'`, `role = 'authenticated'`, `email = employee_number || '@gosta.invalid'`.
- [ ] **Step 5: Run `supabase db reset && supabase test db`.** Expected: PASS (8/8).
- [ ] **Step 6: Commit** — `feat(db): reference schema and test fixtures`.

---

### Task 3: Operations and ledger schema, balances view

**Files:**
- Create: `supabase/migrations/0002_operations.sql`, `supabase/migrations/0003_ledger.sql`, `supabase/tests/03_ledger.test.sql`

**Interfaces:**
- Produces:
  - Tables per spec section 4. All ids `uuid default gen_random_uuid()` except composite keys: `count_windows (branch_id, period_month)`, `count_lines (count_id, item_id)`. `counts` unique `(branch_id, period_month)`.
  - `transfer_lines.status` check in (`pending`,`received`,`denied`); `diff_reason` check in (`overloaded`,`count_error`,`not_loaded`).
  - `stock_movements.kind` check in (`transfer_out`,`transfer_in`,`transfer_adjust`,`purchase_in`,`purchase_adjust`). Index `(branch_id, item_id, occurred_at)`.
  - `stock_baselines.source` check in (`count`,`owner_zero`). Index `(branch_id, item_id, effective_at desc)`.
  - `rpc_requests(request_id uuid primary key, rpc_name text, user_id uuid, result jsonb, created_at timestamptz default now())`.
  - Trigger function `forbid_update_delete()` raising `IMMUTABLE_ROW`, attached `before update or delete` to the four insert-only tables.
  - View `balances` (`with (security_invoker = true)`), one row per (active branch × active item):

```sql
-- columns: branch_id, item_id, base_quantity numeric, baseline_at timestamptz (null = never counted)
-- base_quantity = latest baseline's quantity (0 if none)
--               + sum(stock_movements.base_quantity) where occurred_at > that baseline's effective_at
--                 (all movements when there is no baseline)
-- "latest" = greatest effective_at, ties broken by greatest id
```

- [ ] **Step 1: Write the failing test `03_ledger.test.sql`** (all inserts as postgres, direct to tables)

```sql
begin;
select plan(7);
-- no baseline: balance is the sum of movements
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001', 9000,'purchase_in','purchase_lines',gen_random_uuid(),'2026-11-01 10:00+03'),
         ('BR-01','D-001',-1500,'transfer_out','transfer_lines',gen_random_uuid(),'2026-11-02 10:00+03');
select is(test.balance('BR-01','D-001'), 7500::numeric);
-- a baseline replaces everything before it
insert into stock_baselines(branch_id,item_id,base_quantity,effective_at,source)
  values ('BR-01','D-001',4000,'2026-11-03 10:00+03','count');
select is(test.balance('BR-01','D-001'), 4000::numeric);
-- a movement dated before the baseline does not disturb the balance
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001',-750,'purchase_adjust','purchase_lines',gen_random_uuid(),'2026-11-01 10:00+03');
select is(test.balance('BR-01','D-001'), 4000::numeric);
-- a movement after it applies on top
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001',750,'transfer_in','transfer_lines',gen_random_uuid(),'2026-11-04 10:00+03');
select is(test.balance('BR-01','D-001'), 4750::numeric);
select is((select baseline_at from balances where branch_id='BR-02' and item_id='D-001'), null, 'never counted');
select throws_ok($$update stock_movements set base_quantity = 0$$, 'IMMUTABLE_ROW');
select throws_ok($$delete from stock_baselines$$, 'IMMUTABLE_ROW');
select * from finish();
rollback;
```

- [ ] **Step 2: Run `supabase db reset && supabase test db`.** Expected: FAIL.
- [ ] **Step 3: Write `0002_operations.sql` and `0003_ledger.sql`.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): operations tables, insert-only ledger, balances view`.

---

### Task 4: Helper functions and error codes

**Files:**
- Create: `supabase/migrations/0004_helpers.sql`, `supabase/tests/04_helpers.test.sql`

**Interfaces:**
- Produces (all in `public`, none granted to `authenticated` except where noted):
  - `current_app_user() returns app_users` — row where `auth_user_id = auth.uid()`, `active`, `now() < session_expires_at`; otherwise raises `NOT_AUTHENTICATED`.
  - `session_user_ok() returns boolean` — same check, returns false instead of raising; `stable`; granted to `authenticated` (used by RLS).
  - `my_role() returns text`, `my_branch() returns text` — `stable`, null when `session_user_ok()` is false; granted to `authenticated`.
  - `require_role(variadic p_roles text[]) returns app_users` — raises `FORBIDDEN` if the caller's role is not listed.
  - `require_feature(p_branch_id text, p_feature_key text) returns void` — raises `FEATURE_HIDDEN` when a `branch_features` row has `visible = false`.
  - `require_not_frozen(p_branch_id text) returns void` — raises `BRANCH_FROZEN` when any `counts` row for the branch has `frozen_since is not null`.
  - `to_base(p_item_id text, p_quantity numeric, p_unit text, p_allow_inactive boolean default false) returns numeric` — raises `ITEM_INVALID` (missing or inactive item), `UNIT_INVALID` (no such unit, or inactive and not allowed), `QUANTITY_INVALID` (null or < 0). Zero is allowed here; callers that need > 0 check it.
  - `request_replay(p_request_id uuid, p_rpc_name text) returns jsonb` — takes `pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0))`; returns the stored `result` if a row exists for this id **and** the same `rpc_name` and caller, raises `REQUEST_ID_REUSED` if the id exists for a different rpc or user, else null.
  - `request_store(p_request_id uuid, p_rpc_name text, p_user_id uuid, p_result jsonb) returns jsonb` — inserts and returns `p_result`.
  - `log_action(p_user_id uuid, p_action text, p_entity_table text, p_entity_id text, p_details jsonb) returns void`.

Complete list of error codes (the front-end plan maps exactly these):
`NOT_AUTHENTICATED`, `FORBIDDEN`, `FEATURE_HIDDEN`, `BRANCH_FROZEN`, `BRANCH_INVALID`, `ITEM_INVALID`, `UNIT_INVALID`, `QUANTITY_INVALID`, `COST_REQUIRED`, `COST_INVALID`, `LINES_EMPTY`, `LINES_INCOMPLETE`, `LINE_NOT_PENDING`, `DIFF_REASON_REQUIRED`, `SUPPLIER_INVALID`, `ITEM_NOT_ALLOWED`, `LINE_VOIDED`, `WINDOW_CLOSED`, `WINDOW_EXISTS`, `COUNT_LOCKED`, `COUNT_INCOMPLETE`, `COUNT_NOT_SUBMITTED`, `COUNT_NOT_DRAFT`, `ENTRIES_INVALID`, `USER_INVALID`, `SECRET_WEAK`, `EMPLOYEE_NUMBER_TAKEN`, `REQUEST_ID_REUSED`, `IMMUTABLE_ROW`.

- [ ] **Step 1: Write the failing test `04_helpers.test.sql`**

```sql
begin;
select plan(12);
select test.act_as('201');
select is((current_app_user()).employee_number, '201');
select is(my_branch(), 'BR-01'); select is(my_role(), 'manager');
select test.reset_role();
update app_users set session_expires_at = now() - interval '1 second' where employee_number = '201';
select test.act_as('201');
select throws_ok('select current_app_user()', 'NOT_AUTHENTICATED');
select is(session_user_ok(), false);
select test.act_as('299');
select throws_ok('select current_app_user()', 'NOT_AUTHENTICATED');   -- inactive user
select test.reset_role();
select is(to_base('D-001', 2, 'عبوة'), 1500::numeric);
select is(to_base('D-001', 0.5, 'كرتونة'), 4500::numeric);
select throws_ok($$select to_base('D-001', 1, 'حبة')$$, 'UNIT_INVALID');   -- another item's unit
select throws_ok($$select to_base('D-003', 1, 'غم')$$, 'ITEM_INVALID');    -- inactive item
select throws_ok($$select to_base('D-001', -1, 'مل')$$, 'QUANTITY_INVALID');
select throws_ok($$select require_feature('BR-15','send')$$, 'FEATURE_HIDDEN');
select * from finish();
rollback;
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0004_helpers.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): session, validation and idempotency helpers`.

---

### Task 5: Grants and row-level security

**Files:**
- Create: `supabase/migrations/0005_rls.sql`, `supabase/tests/05_rls.test.sql`

**Interfaces:**
- Consumes: `session_user_ok()`, `my_role()`, `my_branch()`.
- Produces: RLS enabled on every table in `public`. `revoke all … from anon, authenticated` then `grant select` to `authenticated` only on the tables below. `anon` gets nothing. No insert/update/delete policy exists anywhere. `alter default privileges … revoke execute on functions from public` so later RPCs must be granted explicitly.

| Tables | `select` policy for `authenticated` |
|---|---|
| `branches`, `items`, `item_units`, `suppliers`, `supplier_items` | `session_user_ok()` |
| `allowed_local_purchases`, `branch_features`, `count_windows`, `counts`, `stock_movements`, `stock_baselines`, `purchases` | owner, or `branch_id = my_branch()` |
| `transfers` | owner, or `my_branch() in (from_branch, to_branch)` |
| `transfer_lines`, `purchase_lines`, `count_lines` | exists a visible parent row (same rule as the parent) |
| `app_users` | owner sees all; others see only their own row |
| `purchase_line_history`, `activity_log`, `backup_runs` (created in plan 4) | owner only |
| `app_user_secrets`, `rpc_requests` | no grant, no policy |

One column rule: a receiving branch must not learn the sender's cost. Enforce with a column grant — `grant select (every column except cost_total) on transfer_lines` — and expose cost through view `transfer_line_costs(line_id, cost_total)` (`security_invoker = false`, owner `postgres`) filtered to: owner, or the caller's branch is the transfer's `from_branch`.

- [ ] **Step 1: Write the failing test `05_rls.test.sql`.** Insert as postgres: one purchase for `BR-01` and one for `BR-02`; one transfer `BR-14 → BR-01` with one line, `cost_total = 12.5`. Then:

```sql
select plan(11);
select test.act_as('201');
select is((select count(*) from purchases), 1::bigint, 'manager sees only own branch purchases');
select is((select count(*) from transfers), 1::bigint, 'receiver sees transfer addressed to it');
select throws_ok('select cost_total from transfer_lines', '42501');
select is((select count(*) from transfer_line_costs), 0::bigint, 'receiver cannot see sender cost');
select is((select count(*) from app_users), 1::bigint);
select throws_ok('select * from app_user_secrets', '42501');
select throws_ok($$insert into purchases(branch_id,supplier_id) values ('BR-01','S-01')$$, '42501');
select test.act_as('202');
select is((select count(*) from transfers), 0::bigint, 'uninvolved branch sees nothing');
select test.act_as('301');
select is((select cost_total from transfer_line_costs), 12.5::numeric, 'sender sees own cost');
select test.act_as('100');
select is((select count(*) from purchases), 2::bigint, 'owner sees all');
select test.reset_role();
update app_users set session_expires_at = now() where employee_number = '201';
select test.act_as('201');
select is((select count(*) from items), 0::bigint, 'expired session reads nothing');
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0005_rls.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): grants and row-level security`.

---

### Task 6: Transfer RPCs

**Files:**
- Create: `supabase/migrations/0006_rpc_transfers.sql`, `supabase/tests/06_transfers.test.sql`

**Interfaces:**
- Consumes: Task 4 helpers.
- Produces (granted to `authenticated`):
  - `send_transfer(p_request_id uuid, p_to_branch text, p_lines jsonb) returns jsonb` → `{"transfer_id": uuid}`. `p_lines`: `[{"item_id","quantity","unit","cost_total"?}]`.
  - `receive_transfer(p_request_id uuid, p_transfer_id uuid, p_lines jsonb) returns jsonb` → `{"transfer_id": uuid, "received": int}`. `p_lines`: `[{"line_id","quantity","unit","diff_reason"?,"note"?}]`.
  - `owner_resolve_transfer_line(p_request_id uuid, p_line_id uuid, p_action text, p_quantity numeric default null, p_unit text default null) returns jsonb` → `{"line_id": uuid, "status": text}`. `p_action` in (`accept`,`deny`,`edit_accept`).

Rules beyond spec section 6.2 that the implementer cannot infer:

- `send_transfer`: roles `manager`, `distributor`; source = caller's branch; `require_feature(source,'send')`; `require_not_frozen(source)`; destination must exist, be active, differ from source (`BRANCH_INVALID`); destination may be frozen. Empty array → `LINES_EMPTY`. Each quantity must be > 0. Distributor: `cost_total` required per line (`COST_REQUIRED`); any role: `cost_total < 0` → `COST_INVALID`. The same item may appear on several lines. Movement `occurred_at` = transfer `created_at`.
- `receive_transfer`: caller's branch must equal `to_branch` (`FORBIDDEN`); `require_feature(dest,'receive')`; `require_not_frozen(dest)`. Lock the transfer's lines `for update`. `p_lines` must contain exactly the set of currently pending line ids, no more, no fewer (`LINES_INCOMPLETE`); if the transfer has no pending lines → `LINE_NOT_PENDING`. Received quantity ≥ 0. Unit resolved with `to_base(..., p_allow_inactive => unit = sent unit)`. If `received_base_quantity <> base_quantity`, `diff_reason` is required (`DIFF_REASON_REQUIRED`). No `transfer_in` row when received is 0. `transfer_adjust` at the source = `base_quantity − received_base_quantity` (may be negative when overloaded), `occurred_at` = transfer `created_at`. `cost_total := round(cost_total * received_base / base, 3)` when cost is not null.
- `owner_resolve_transfer_line`: role `owner`; line must be `pending` (`LINE_NOT_PENDING`). `accept` and `edit_accept` call `require_not_frozen(to_branch)`. `edit_accept` requires `p_quantity > 0` and `p_unit`; it writes `transfer_adjust` at the source for `old_base − new_base` dated at the send time, updates `quantity`/`unit`/`base_quantity`, scales cost the same way, then accepts in full. `deny`: `transfer_adjust` +`base_quantity` at the source dated at the send time; no destination movement. All three set `resolved_by_owner = true`.
- Every path sets `resolved_by`, `resolved_at`, and calls `log_action`.

- [ ] **Step 1: Write the failing tests `06_transfers.test.sql`.** One test per line below; each asserts with `test.balance` and row checks. Baseline for the arithmetic tests: `301` sends `BR-14 → BR-01`: `D-001` 2 `كرتونة` (18000 مل) cost 40, and `D-002` 1 `كرتونة` (1000) cost 10.

| Test | Assertion |
|---|---|
| send writes ledger | `balance(BR-14,D-001) = -18000`, `balance(BR-01,D-001) = 0`, two lines `pending` |
| send idempotent | same `p_request_id` twice → same `transfer_id`, still one transfer, balance unchanged |
| request id reuse | same id by user `201` → `REQUEST_ID_REUSED` |
| distributor needs cost | line without `cost_total` → `COST_REQUIRED` |
| manager cost optional | `201` sends to `BR-02` without cost → ok |
| bad destination | `BR-14` (self), `BR-09` (inactive), `BR-XX` → `BRANCH_INVALID` each |
| zero quantity | → `QUANTITY_INVALID` |
| feature hidden | `215` sends → `FEATURE_HIDDEN` |
| receive in full | `201` confirms both as sent → `balance(BR-01,D-001) = 18000`, `balance(BR-14,D-001) = -18000`, no `transfer_adjust` rows |
| receive short | `D-001` received 1 `كرتونة` + reason `not_loaded` → `balance(BR-01,D-001) = 9000`, `balance(BR-14,D-001) = -9000`, line `cost_total = 20.000` |
| receive over | `D-002` received 1200 `حبة`, `overloaded` → `balance(BR-14,D-002) = -1200`, `cost_total = 12.000` |
| receive zero | `D-001` received 0, `not_loaded` → no `transfer_in` row, `balance(BR-14,D-001) = 0`, `cost_total = 0` |
| diff needs reason | different quantity, no reason → `DIFF_REASON_REQUIRED` |
| partial confirm refused | only one of two line ids → `LINES_INCOMPLETE`, nothing written |
| wrong branch | `202` receives → `FORBIDDEN` |
| double receive | second call with a new request id → `LINE_NOT_PENDING`; exactly one `transfer_in` per line |
| received is final | owner `accept` on a received line → `LINE_NOT_PENDING` |
| receive with deactivated sent unit | set `item_units.active = false` for (`D-001`,`كرتونة`) after the send; receive "as sent" → ok; receive in an inactive unit other than the sent one → `UNIT_INVALID` |
| owner accept | `balance(BR-01,D-001) = 18000`, `resolved_by_owner = true` |
| owner deny | `balance(BR-14,D-001) = 0`, `balance(BR-01,D-001) = 0`, status `denied` |
| owner edit_accept | edit to 1 `كرتونة` → `balance(BR-14,D-001) = -9000`, `balance(BR-01,D-001) = 9000`, `cost_total = 20.000` |
| adjust dated at send time | insert a `BR-14` baseline for `D-001` of 50000 effective between the send and the receipt; receive short by 9000 → `balance(BR-14,D-001)` stays `50000` |
| frozen source / destination | set `counts.frozen_since` for `BR-14` → send raises `BRANCH_FROZEN`; for `BR-01` → send to it succeeds, receive and owner `accept` raise `BRANCH_FROZEN`, owner `deny` succeeds |
| expired session | expire `201`, receive → `NOT_AUTHENTICATED`, no rows written |

- [ ] **Step 2: Run.** Expected: FAIL (functions missing).
- [ ] **Step 3: Write `0006_rpc_transfers.sql`.** Shape of every RPC: `current_app_user` / `require_role` → `request_replay` (return if not null) → validate → write → `log_action` → `return request_store(...)`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): transfer send, receive and owner resolution`.

---

### Task 7: Purchase RPCs

**Files:**
- Create: `supabase/migrations/0007_rpc_purchases.sql`, `supabase/tests/07_purchases.test.sql`

**Interfaces:**
- Produces (granted to `authenticated`):
  - `create_purchase(p_request_id uuid, p_supplier_id text, p_lines jsonb) returns jsonb` → `{"purchase_id": uuid}`. Lines as in `send_transfer`.
  - `edit_purchase_line(p_request_id uuid, p_line_id uuid, p_quantity numeric, p_unit text, p_cost_total numeric) returns jsonb` → `{"line_id": uuid}`.
  - `void_purchase_line(p_request_id uuid, p_line_id uuid) returns jsonb` → `{"line_id": uuid}`.

Rules beyond spec section 6.3:

- `create_purchase`: roles `manager`, `distributor`; branch = caller's; `require_feature(branch,'purchase')`; `require_not_frozen(branch)`; supplier exists and active (`SUPPLIER_INVALID`); each item has an active `supplier_items` row for that supplier **and** an active `allowed_local_purchases` row for the branch (`ITEM_NOT_ALLOWED`); quantity > 0; cost rule identical to `send_transfer`.
- `edit_purchase_line`: owner only; voided line → `LINE_VOIDED`; quantity > 0; history row `action = 'edit'`, `old_values` = `{quantity, unit, base_quantity, cost_total}`; one `purchase_adjust` of `new_base − old_base` dated at the purchase's `created_at` (no movement row when the difference is 0). Allowed while the branch is frozen.
- `void_purchase_line`: owner only; already voided → `LINE_VOIDED`; history `action = 'void'`; `purchase_adjust` of `−base_quantity` dated at `created_at`.

- [ ] **Step 1: Write the failing tests `07_purchases.test.sql`**

| Test | Assertion |
|---|---|
| create | `201` buys `D-001` 3 `عبوة` from `S-01` → `balance(BR-01,D-001) = 2250` |
| idempotent | same request id → same `purchase_id`, balance still 2250 |
| distributor needs cost | `301` without cost → `COST_REQUIRED` |
| inactive supplier | `S-02` → `SUPPLIER_INVALID` |
| item not sold by supplier | `D-002` from `S-01` → `ITEM_NOT_ALLOWED` |
| item not allowed for branch | `202` buys `D-001` from `S-01` → `ITEM_NOT_ALLOWED` |
| feature hidden | `215` → `FEATURE_HIDDEN` |
| frozen | freeze `BR-01` → `BRANCH_FROZEN` |
| edit | owner edits to 1 `عبوة`, cost 5 → balance `750`; one history row with `old_values->>'base_quantity' = '2250'` |
| edit by manager | → `FORBIDDEN` |
| void | → balance `0`, `voided_at` set, history `action = 'void'` |
| void twice / edit voided | → `LINE_VOIDED` |
| correction before a baseline | baseline `BR-01`/`D-001` = 1000 effective after the purchase; void → balance stays `1000` |
| correction after no baseline change | purchase after the baseline; edit 3→1 `عبوة` → balance `1000 + 750` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0007_rpc_purchases.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): purchase create, owner edit and void`.

---

### Task 8: Count windows, drafts and the freeze

**Files:**
- Create: `supabase/migrations/0008_rpc_counts.sql` (first half), `supabase/tests/08_count_entry.test.sql`

**Interfaces:**
- Produces (granted to `authenticated`):
  - `open_count_window(p_request_id uuid, p_branch_id text, p_period_month date) returns jsonb` → `{"branch_id","period_month"}`.
  - `close_count_window(p_request_id uuid, p_branch_id text, p_period_month date) returns jsonb`.
  - `save_count_line(p_item_id text, p_state text, p_entries jsonb) returns jsonb` → `{"count_id": uuid, "base_quantity": numeric, "counted": int, "total": int}`.
  - `discard_count_draft(p_request_id uuid, p_count_id uuid) returns jsonb` → `{"count_id": uuid}`.

Rules:

- `open_count_window`: owner; unknown or inactive branch, or a `p_period_month` that is not the first of a month → `BRANCH_INVALID`; a window that is already `open` → `WINDOW_EXISTS`. Re-opening a closed window sets it back to `open`.
- `save_count_line`: roles `manager`, `distributor`; own branch; `require_feature(branch,'count')`. Finds the branch's count that is `draft` or `returned`; if none, requires an `open` window for the branch (`WINDOW_CLOSED`) — the latest open one — and creates the `draft` count with one `count_lines` row per **active** item, `state = 'uncounted'`. A count that is `submitted` or `approved` for that window → `COUNT_LOCKED`.
  - Sets `counts.frozen_since = now()` if it is null. This is the only place a freeze starts.
  - In a `returned` count only lines with `needs_recount = true` may be saved (`COUNT_LOCKED` otherwise).
  - `p_state` in (`counted`,`none`,`uncounted`). `counted`: `p_entries` is a non-empty array of `{"unit","quantity"}`, each unit valid for the item, each quantity ≥ 0, no unit twice (`ENTRIES_INVALID`); `base_quantity` = sum of `to_base`. `none`: entries must be null or `[]`; `base_quantity = 0`. `uncounted`: clears entries and `base_quantity` (lets the manager undo).
  - This generic `entries` shape is what launches if the per-type rules file is late (spec section 8, "Open"). Per-type shapes will be added as a later migration that only widens the validation.
  - Not idempotency-keyed: it is an upsert, last write wins.
- `discard_count_draft`: owner; count must be `draft` or `returned` (`COUNT_NOT_DRAFT` otherwise); deletes its lines and the count row; the freeze goes with it. Discarding a `returned` count throws the whole count away and the manager starts again — that is the only way out of an abandoned recount, and the owner screen must say so before confirming.
- `close_count_window`: owner; sets `closed`. It does **not** touch an existing draft: a frozen draft can still be saved, submitted or discarded after the window closes.

- [ ] **Step 1: Write the failing tests `08_count_entry.test.sql`**

| Test | Assertion |
|---|---|
| no window | `201` saves → `WINDOW_CLOSED` |
| open + first save | owner opens `BR-01`, `2026-11-01`; `201` saves `D-001` counted `[{"unit":"كرتونة","quantity":1},{"unit":"عبوة","quantity":2}]` → `base_quantity = 10500`, `counted = 1`, `total = 2` (only active items), `frozen_since` not null |
| freeze blocks | after that save: `create_purchase` by `201` → `BRANCH_FROZEN` |
| none state | save `D-002` state `none` → `base_quantity = 0` |
| blank is not zero | `counted` with `[]` → `ENTRIES_INVALID` |
| duplicate unit | two entries with `عبوة` → `ENTRIES_INVALID` |
| undo | save `uncounted` → `counted` back to 0 in the result; branch stays frozen |
| other branch isolated | `202` saving → `WINDOW_CLOSED` (no window for `BR-02`) |
| discard | owner discards → no `counts` row; `create_purchase` by `201` succeeds |
| discard submitted | submit, then discard → `COUNT_NOT_DRAFT` |
| close does not strand | open, save, owner closes window → `save_count_line` still works; `discard_count_draft` still works |
| duplicate open | → `WINDOW_EXISTS` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write the four functions.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): count windows, draft entry and branch freeze`.

---

### Task 9: Count submit, review, baselines, zeroing

**Files:**
- Modify: `supabase/migrations/0008_rpc_counts.sql` (append; this migration is not merged until this task is done)
- Create: `supabase/tests/09_count_review.test.sql`

**Interfaces:**
- Consumes: Task 8 functions.
- Produces (granted to `authenticated`):
  - `submit_count(p_request_id uuid) returns jsonb` → `{"count_id": uuid, "submitted_at": timestamptz}`.
  - `review_count(p_request_id uuid, p_count_id uuid, p_action text, p_item_ids text[] default null, p_note text default null) returns jsonb` → `{"count_id": uuid, "status": text}`. `p_action` in (`approve`,`return`).
  - `zero_branch_balance(p_request_id uuid, p_branch_id text) returns jsonb` → `{"branch_id": text, "items": int}`.

Rules:

- `submit_count`: caller's branch's `draft` or `returned` count (`COUNT_NOT_DRAFT` if none). Any line `uncounted` → `COUNT_INCOMPLETE`. Sets `status = 'submitted'`, `submitted_by/at`, `frozen_since = null`. Sets `count_lines.effective_at = now()` on: every line when coming from `draft`; only lines with `needs_recount = true` when coming from `returned`, then clears `needs_recount`. Works whether the window is open or closed.
- `review_count`: owner; count must be `submitted` (`COUNT_NOT_SUBMITTED`).
  - `approve`: one `stock_baselines` row per line, `base_quantity` = line's, `effective_at` = line's `effective_at`, `source = 'count'`, `ref_id = count_id`; status `approved`.
  - `return`: note required (`ENTRIES_INVALID` if blank). `p_item_ids` null → every line gets `needs_recount = true`, `state = 'uncounted'`, entries cleared. Otherwise only the listed lines (each must belong to the count, else `ITEM_INVALID`). Status `returned`. The branch is **not** frozen until the first `save_count_line` of the recount.
- `zero_branch_balance`: owner; `require_not_frozen(branch)`; one baseline of 0 per active item, `effective_at = now()`, `source = 'owner_zero'`.
- An item activated after the draft was created has no line and gets no baseline; its balance continues from movements. Accepted for launch.

- [ ] **Step 1: Write the failing tests `09_count_review.test.sql`.** Setup for each: owner opens `BR-01` / `2026-11-01`.

| Test | Assertion |
|---|---|
| submit incomplete | one item saved, submit → `COUNT_INCOMPLETE` |
| submit unfreezes | both saved, submit → `frozen_since is null`; `create_purchase` succeeds; `save_count_line` → `COUNT_LOCKED` |
| approve creates baselines | `D-001` counted 10500, `D-002` `none`; approve → `balance(BR-01,D-001) = 10500`, `balances.baseline_at` = `submitted_at`; a `stock_baselines` row of 0 exists for `D-002` |
| movements after submit apply | submit, then purchase 1 `عبوة`, then approve → balance `11250` |
| movements before the count are replaced | purchase 9000 first, then count 10500 and approve → balance `10500` |
| approve unsubmitted | → `COUNT_NOT_SUBMITTED` |
| return selected | return `{D-001}` with note → `D-001` line `uncounted` + `needs_recount`, `D-002` unchanged; saving `D-002` → `COUNT_LOCKED`; branch not frozen until `D-001` is saved, frozen after |
| recount timestamps | resubmit → `D-001.effective_at` = resubmit time, `D-002.effective_at` = first submit time; a purchase of `D-001` made between the two submits is **not** in the balance after approval, a purchase of `D-002` made between them **is** |
| return without note | → `ENTRIES_INVALID` |
| month rollover | draft started for `2026-11-01`; owner closes that window and opens `2026-12-01`; `201` can still save and submit the November draft |
| zero | purchases exist; owner zeroes `BR-01` → every active item balance `0`; a later purchase adds on top |
| zero while frozen | → `BRANCH_FROZEN` |
| abandoned recount | return `{D-001}`, `201` saves `D-001` (frozen), owner discards → no `counts` row, branch not frozen |
| manager cannot review | `201` calls `review_count` → `FORBIDDEN` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Append the three functions.** **Step 4: Run all tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): count submit, owner review, baselines and zeroing`.

---

### Task 10: User administration RPCs

**Files:**
- Create: `supabase/migrations/0009_rpc_admin.sql`, `supabase/tests/09b_admin.test.sql`

**Interfaces:**
- Produces (owner only, granted to `authenticated`):
  - `admin_create_user(p_request_id uuid, p_employee_number text, p_name text, p_role text, p_branch_id text, p_secret text) returns jsonb` → `{"user_id": uuid}`.
  - `admin_set_secret(p_request_id uuid, p_user_id uuid, p_secret text) returns jsonb`.
  - `admin_set_user_active(p_request_id uuid, p_user_id uuid, p_active boolean) returns jsonb`.
  - `admin_unlock_user(p_request_id uuid, p_user_id uuid) returns jsonb`.
  - `set_branch_feature(p_request_id uuid, p_branch_id text, p_feature_key text, p_visible boolean) returns jsonb`.
  - Internal `assert_secret_ok(p_role text, p_secret text) returns void`: manager/distributor → exactly 4 ASCII digits; owner → at least 12 characters; else `SECRET_WEAK`.

Rules:

- `rpc_requests.result` and `activity_log.details` must never contain `p_secret`.
- `admin_create_user`: duplicate number → `EMPLOYEE_NUMBER_TAKEN`; role/branch mismatch or unknown branch → `USER_INVALID`. `auth_user_id` stays null; the login function creates the Auth user on first login.
- `admin_set_secret`, and `admin_set_user_active(false)`: set `session_expires_at = now()` so access ends immediately; `admin_set_secret` also zeroes `failed_attempts` and `locked_until`.
- `admin_set_user_active(false)` on the caller's own row → `USER_INVALID` (the owner cannot lock themselves out).
- `admin_set_secret` on an owner row is allowed only for the caller's own row.

- [ ] **Step 1: Write the failing tests**

| Test | Assertion |
|---|---|
| create | owner creates `203`, manager, `BR-02`, `4444` → row exists, a hash exists and `secret_hash <> '4444'` |
| weak secrets | manager `12345`, manager `12a4`, owner `short` → `SECRET_WEAK` |
| duplicate | `201` again → `EMPLOYEE_NUMBER_TAKEN` |
| manager with no branch / owner with branch | → `USER_INVALID` |
| not owner | `201` calls any admin RPC → `FORBIDDEN` |
| reset ends session | owner resets `201`; `test.act_as('201')`; `select current_app_user()` → `NOT_AUTHENTICATED` |
| deactivate ends session | same after `admin_set_user_active(false)` |
| self-deactivate | → `USER_INVALID` |
| secret not leaked | no `rpc_requests.result::text` or `activity_log.details::text` contains `4444` |
| feature toggle | hide `purchase` for `BR-01` → `create_purchase` by `201` raises `FEATURE_HIDDEN` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0009_rpc_admin.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): owner user administration and feature visibility`.

---

### Task 11: Login verification in the database

**Files:**
- Create: `supabase/migrations/0010_login.sql`, `supabase/tests/10_login.test.sql`

**Interfaces:**
- Produces (granted to `service_role` only, revoked from `authenticated` and `anon`):
  - `login_verify(p_employee_number text, p_secret text) returns jsonb` — never raises for a bad credential. Returns `{"ok": true, "user_id": uuid, "auth_user_id": uuid|null}` or `{"ok": false, "reason": "invalid"|"locked", "locked_until": timestamptz|null}`.
  - `login_attach_auth_user(p_user_id uuid, p_auth_user_id uuid) returns void` — sets `auth_user_id` only when it is null.

Rules:

- Unknown number, inactive user and wrong secret all return `reason: "invalid"` (no account enumeration). For an unknown number still run one `crypt()` against a fixed dummy hash so timing does not reveal existence.
- Row locked `for update`. If `locked_until > now()` → `locked`, without checking the secret and without counting.
- Wrong secret: `failed_attempts += 1`; on reaching 5 set `locked_until = now() + interval '15 minutes'` and reset `failed_attempts = 0`.
- Correct secret: `failed_attempts = 0`, `locked_until = null`, `session_expires_at = now() + interval '7 days'`.
- Every call writes `activity_log` with action `LOGIN_OK`, `LOGIN_FAILED` or `LOGIN_LOCKED`; `details` holds the employee number, never the secret.
- Digits are normalised before lookup and comparison: Arabic-Indic `٠-٩` and Eastern `۰-۹` → `0-9` (function `normalize_digits(text) returns text`, `immutable`).

- [ ] **Step 1: Write the failing tests `10_login.test.sql`** (all after `test.act_as_service()`)

| Test | Assertion |
|---|---|
| ok | `('201','1111')` → `ok = true`, `user_id` matches, session ≈ 7 days ahead |
| Arabic digits | `('٢٠١','١١١١')` → `ok = true` |
| owner password | `('100','correct horse battery')` → ok; `('100','1111')` → `invalid` |
| wrong / unknown / inactive | `('201','0000')`, `('999','1111')`, `('299','1111')` → all `reason = 'invalid'` |
| lockout | five wrong for `202` → fifth returns `locked` with `locked_until` ≈ +15 min; the right PIN now → `locked` |
| lock expires | set `locked_until` to the past → right PIN → ok |
| success resets counter | four wrong, one right, four wrong → not locked |
| logged | three `activity_log` rows for three attempts, none containing the secret |
| not callable by clients | `test.act_as('201')`; `select login_verify('201','1111')` → `42501` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0010_login.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): login verification with lockout`.

---

### Task 12: Login Edge Function

**Files:**
- Create: `supabase/functions/login/index.ts`, `supabase/functions/login/derive.ts`, `supabase/functions/login/derive_test.ts`, `supabase/functions/login/login_integration_test.ts`
- Modify: `.github/workflows/test.yml` (start the full stack with `supabase start`, serve functions, run the integration test), `supabase/config.toml` (`[functions.login] verify_jwt = false`)

**Interfaces:**
- Consumes: `login_verify`, `login_attach_auth_user`.
- Produces:
  - `deriveAuthPassword(secret: string, userId: string): Promise<string>` — lowercase hex HMAC-SHA-256 of `userId` keyed by `secret` (64 chars).
  - `POST /functions/v1/login`, body `{"employee_number": string, "secret": string}`.
    - 200 `{"access_token","refresh_token","expires_at","user":{"id","name","role","branch_id"}}`
    - 401 `{"error":"INVALID_CREDENTIALS"}`
    - 423 `{"error":"LOCKED","locked_until": ISO string}`
    - 400 `{"error":"BAD_REQUEST"}` for a missing/non-string field or a body over 1 KB
    - CORS: `OPTIONS` handled; `Access-Control-Allow-Origin` = env `APP_ORIGIN`.
  - Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` (provided by the platform), `AUTH_DERIVE_SECRET` (≥ 32 random bytes, set with `supabase secrets set`), `APP_ORIGIN`.

Flow: service-role client calls `login_verify` → on ok, if `auth_user_id` is null, `auth.admin.createUser({ email: "<employee_number>@gosta.invalid", password: derived, email_confirm: true })` then `login_attach_auth_user` → anon client `auth.signInWithPassword` with the derived password → return the session. If sign-in fails for an existing Auth user (derive secret rotated), `auth.admin.updateUserById(id, { password: derived })` once and retry. The service-role key and the derived password never appear in a response or a log line.

- [ ] **Step 1: Write the failing unit test `derive_test.ts`**

```ts
Deno.test("deriveAuthPassword is deterministic, 64 hex chars, and depends on both inputs", async () => {
  const a = await deriveAuthPassword("k1", "u1");
  assertEquals(a, await deriveAuthPassword("k1", "u1"));
  assertMatch(a, /^[0-9a-f]{64}$/);
  assertNotEquals(a, await deriveAuthPassword("k2", "u1"));
  assertNotEquals(a, await deriveAuthPassword("k1", "u2"));
});
```

- [ ] **Step 2: Run `deno test supabase/functions/login/derive_test.ts`.** Expected: FAIL (module missing). **Step 3: Implement `derive.ts`** with Web Crypto. **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Write the failing integration test `login_integration_test.ts`** (runs against `supabase start` + `supabase functions serve`, fixtures from seed; reads the URL and anon key from env)

| Test | Assertion |
|---|---|
| good PIN | `201`/`1111` → 200; using `access_token`, `select` from `purchases` via PostgREST returns 200 and `rpc/send_transfer` with a valid body returns a `transfer_id` |
| first login creates the Auth user | owner creates user `204` through `rpc/admin_create_user`; login `204` → 200; second login → 200 |
| wrong PIN | → 401 `INVALID_CREDENTIALS`; body has no other keys |
| lockout | five wrong for `202` → 423 with `locked_until` |
| reset ends access | owner calls `rpc/admin_set_secret` for `201`; the old `access_token` now gets zero rows from `items` and `NOT_AUTHENTICATED` from an RPC |
| bad body | `{}` → 400 |

- [ ] **Step 6: Run.** Expected: FAIL (404). **Step 7: Implement `index.ts`.** **Step 8: Run.** Expected: PASS.
- [ ] **Step 9: Update the workflow, push, confirm CI is green.**
- [ ] **Step 10: Commit** — `feat: login edge function`.

---

### Task 13: Whole-ledger reconciliation test

**Files:**
- Create: `supabase/tests/20_reconciliation.test.sql`

**Interfaces:**
- Consumes: every RPC above. Produces no new code; it is the guard against rules that are each right and wrong together.

- [ ] **Step 1: Write the test.** Script, through RPCs only, as the proper users: three sends from `BR-14` (one received in full, one short, one denied by the owner), one `BR-01 → BR-02` send left pending, two purchases (one edited, one voided), a full count of `BR-01` approved, one more send and receipt after the count. Then assert:

```sql
-- 1. Conservation: for every item, total stock across all branches equals
--    non-voided purchases (current base_quantity) minus quantity still in transit (pending lines),
--    ignoring baselines.
select is(
  (select coalesce(sum(base_quantity),0) from stock_movements where item_id = 'D-001'),
  (select coalesce(sum(base_quantity),0) from purchase_lines where item_id = 'D-001' and voided_at is null)
  - (select coalesce(sum(base_quantity),0) from transfer_lines where item_id = 'D-001' and status = 'pending'));
-- 2. Every received line: exactly one transfer_in equal to received_base_quantity (none when it is 0).
-- 3. Every line's net effect at the source equals -received_base_quantity (received), 0 (denied), -base_quantity (pending).
-- 4. No stock_movements row has ref_id pointing at a missing row.
-- 5. balances for BR-01 equals the approved count plus movements after each line's effective_at, computed independently in the test with a plain query.
```

Write assertions 2–5 as `is()`/`is_empty()` checks in the same style.

- [ ] **Step 2: Run `supabase db reset && supabase test db`.** Expected: PASS. If any assertion fails, the bug is in an RPC from Tasks 6–9: fix it there with a new targeted test in that task's file, not here.
- [ ] **Step 3: Commit** — `test(db): whole-ledger reconciliation`.

---

## Done means

- `supabase db reset && supabase test db` passes locally and in CI, as do both Deno test files.
- No table in `public` is writable by `authenticated` or `anon` (assert in `05_rls.test.sql`: `select is_empty($$select table_name, privilege_type from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema = 'public' and privilege_type <> 'SELECT'$$)`).
- Nothing has been applied to `gosta-test` or `gosta-live`; applying migrations to real projects is the first task of plan 2 and needs the owner's access (spec section 14).
