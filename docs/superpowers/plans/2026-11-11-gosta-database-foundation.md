# GOSTA Database Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Supabase database (schema, ledger, row-level security, every stock-rule RPC) and the login Edge Function, all covered by automated tests that run in CI.

**Architecture:** Postgres holds every rule. Each write is one `security definer` RPC in schema `public`, running in one transaction; internal helpers live in schema `app`, which clients cannot call. Clients have no insert/update/delete rights on any table; reads go through row-level security. A single Edge Function turns employee number + secret into a Supabase Auth session and registers that session in the database, where it can be revoked individually.

**Tech Stack:** Supabase CLI (local stack in Docker), Postgres 15, pgTAP (`supabase test db`), pgcrypto, Deno (Edge Function, `deno test`, `npm:postgres` for two-connection tests), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-11-gosta-pwa-design.md` — sections 4, 5, 6, 8, 11.

This is plan 1 of 4. Later plans, each written when the previous one is done: (2) front end for login, receive, send, purchase, balance, sent log; (3) count and owner screens; (4) import script, backup workflow, replay check, cutover.

## Global Constraints

- The client never inserts, updates or deletes a table row. `anon` gets nothing. `authenticated` gets `select` (through RLS) and `execute` only on the entry points this plan names.
- **Function privileges.** Migration `0000` revokes default `execute` from `public`, `anon` and `authenticated` for all future functions in `public` and `app`. Every later migration grants `execute` explicitly, one line per entry point. Nothing else is callable.
- Every function is `security definer` with `set search_path = app, public, extensions, pg_temp` (`pg_temp` last), unless stated otherwise. Stated exceptions: `app.is_finite` (a pure expression used in check constraints; neither, so it stays inlinable; `service_role` has execute) and `app.forbid_update_delete` (only raises; has the search path, not definer).
- Every RPC starts by calling `app.current_app_user()`; a missing or inactive user, or a missing, revoked or expired session, raises `NOT_AUTHENTICATED`.
- **Lock order, always the same:** (1) request-id advisory lock inside `app.request_replay`; (2) branch locks via `app.lock_branches`, which sorts ids; (3) row locks with `select … for update` ordered by id. An RPC takes the row lock on any record it is going to change **before reading the values it bases the change on**.
- **Branch lock rule.** An RPC calls `app.lock_branches` for every branch whose freeze it checks or changes, or to which it writes a movement or baseline dated "now". Movements dated in the past (corrections) need only the row lock.
- **Rules learned in Task 4 that later tasks must follow.** (a) An RPC locks all its branches in **one** `app.lock_branches` call; two calls can invert the order and deadlock. A dynamic list is passed as `variadic <text[]>`. (b) `p_params` for `request_replay`/`request_store` is built with `jsonb_build_object` from the RPC's typed, already-normalised arguments (numbers as `numeric`, never raw client JSON), because `2` and `2.0` hash differently. (c) RLS policies call the session helpers as `(select app.session_ok())`, `(select app.my_role())`, `(select app.my_branch())` so they run once per statement, not once per row. (d) pgcrypto functions are always written schema-qualified: `extensions.crypt`, `extensions.gen_salt`, `extensions.digest`.
- **Rules learned in Task 5.** (e) `balances` is a client-facing view filtered by the caller's session: the owner sees every branch, anyone else only their own branch, and `postgres`, `service_role` or any code without session claims gets **no rows** — silently. RPCs and service jobs never read it; they compute from `stock_baselines` and `stock_movements` directly. (f) A definer-rights view that hides data must be created `with (security_barrier = true)`; without it a caller's function can read the hidden column before the view's filter runs. (g) Clients cannot `select *` from `transfer_lines` (no grant on `cost_total`); they list columns, and read cost from `transfer_line_costs`. (h) Every new table gets `enable row level security` in the migration that creates it; the suite fails otherwise.
- **Rules learned in Task 6.** (i) Every RPC that takes `p_request_id` raises `REQUEST_ID_REQUIRED` when it is null, straight after the role check (the replay helper cannot lock on a null id). `REQUEST_ID_REQUIRED` is part of the error-code list. (j) Optional text from forms is normalised with `nullif(btrim(…), '')` before it is validated or fingerprinted, so an empty string and a missing key are the same request. (k) A cost is scaled and rounded to 3 decimals only when the quantity actually changes; an unchanged line keeps its cost exactly. (l) Tests assert *which* timestamp a row carries (equal to its movement's `occurred_at`, or later than the parent's `created_at`), not merely that it is set.
- **Rules learned in Task 7.** (m) `app.check_quantity` and `app.check_cost` refuse anything above 10^12 (re-created in migration 0008 as a follow-up to 0005), so a quantity × rate product can never overflow into a raw database error; every RPC passes every number through them before arithmetic. (n) An internal function that switches on an action name refuses unknown names instead of falling through to a default branch. (o) A change that alters nothing writes no history and no movement, but the call is still logged.
- **Rules learned in Task 10.** (p) Every secret passes `app.clean_secret` before any `extensions.crypt` call or comparison, on first calls and on replays alike; `app.request_secret_ok` additionally refuses anything over 72 bytes by itself. Login (Task 11) compares a submitted secret only after the same cleaning: staff PINs through `normalize_digits`, owner passwords exactly as typed, and anything over 72 bytes is a wrong secret. (q) Resetting a PIN to the value it already has is a real change: version +1, sessions revoked. (r) Employee numbers are compared as text after digit normalisation: `0204` and `204` are different numbers, at creation and at login. (s) Any RPC that changes `app_users.role` in future must take the same row lock the admin RPCs take, because they read the role before locking on the assumption that it never changes. (t) `rpc_requests` keeps a bcrypt verifier for every secret-carrying request indefinitely (server-only table); a retention job is a later-plan item.
- **Rules learned in Task 11.** (u) **Authorization is checked at request entry, by decision of the owner (2026-11-12).** Every RPC validates the caller's session once, when it starts. Revoking a session (PIN reset, deactivation, logout) stops every request that starts afterwards; it does not stop requests that had already passed the check. **Several such already-authorized requests may finish after the revocation** — there is no limit of one: every request of that session that was in flight at that moment, for example waiting on a branch or row lock, completes normally and is recorded under that user. Each is ordered before the revocation in the sense that it was authorized before it. The single exception is `admin_set_secret`, which rechecks after its row lock (migration 0012) because two competing password changes could otherwise both apply. Tests must not assert that nothing completes after a revocation; they assert that nothing *starts* after it. (v) **The lockout applies to the owner account too, by decision of the owner.** Anyone who knows the owner's employee number can lock that account for 15 minutes at a time with five wrong passwords; the lock always expires by itself. Recovery when no owner session is active, including a lost password and a deliberate repeated lock-out, is documented in `docs/runbooks/owner-account-recovery.md`; its SQL is exercised by a test in Task 12 so the runbook cannot rot. (w) `login_verify`'s secret cleaning mirrors `app.clean_secret` by hand; the two change together. (x) Submitted employee numbers are whitespace-trimmed and digit-normalised, nothing else; leading zeros are significant.
- **Rules learned in Task 12 (real Supabase stack).** (y) The Supabase Auth user of an app user always has the email `<employee_number>@gosta.invalid` and a password derived from the app user id. The login function re-establishes both whenever a sign-in fails for an already attached user (derive secret rotated, or employee number changed in the database), so the invariant heals at the next login; nothing else may write `auth.users`. (z) Test fixtures that insert `auth.users` rows directly must set `created_at`, `updated_at` and the two meta columns, or real Supabase Auth cannot load the user. (aa) Supabase Auth reports the loser of two simultaneous user creations as a server error, not as "already registered"; the function lets `login_attach_auth_user` decide. (ab) **Cutover checklist for the hosted projects (plan 4), found here:** public sign-up disabled; no Auth password policy that demands character classes (the derived password is 64 lowercase hex characters); the Auth sign-in rate limit raised well above the number of staff, because every login reaches Supabase Auth from the function's own address, so the default per-address limit would throttle a morning of logins; a preflight and a POST from the real app origin checked against the hosted gateway (the local gateway overwrites the function's CORS header, so CI cannot prove it); `supabase/config.toml` never pushed to a real project as it stands (its raised local rate limits are for tests); `AUTH_DERIVE_SECRET` set as a function secret, at least 32 characters, never the value in `supabase/functions/.env.ci`.
- **Rules added after the owner's review of Task 12 (2026-11-13).** (ac) Any procedure that changes a user's secret, credential version or sessions — an RPC or a hand-run recovery — takes the lock on that user's `app_users` row **first**, then changes the secret, then the version, then the sessions, all in one transaction. Putting the same statements in a transaction without taking that lock first is not enough: a login verified earlier registers its session with `login_register_session`, which waits only on that row lock. (ad) One rule decides which characters a secret may contain, and it is the same when a secret is set (`app.clean_secret`), when it is checked (`login_verify`) and at the login endpoint: no control characters (Unicode category Cc: U+0000–U+001F and U+007F–U+009F). A password that can be set can always be submitted, and the reverse. Not covered and unverified: Unicode normalisation — the same visible Arabic text typed on two keyboards can differ in code points and would then be a different password. (ae) The login function's routine logs carry a diagnostic tag, the HTTP status and the error code only; never the free-text message from Supabase Auth. (af) **Evidence is labelled by where it was obtained.** "CI" means the local Supabase stack that GitHub Actions starts from this repository; it proves nothing about a hosted project's settings. Hosted checks are listed separately (rule (ab)) and are reported as not done until someone has run them against the hosted project.
- **Clock rule.** `now()` is the transaction start and must not be used for stock ordering. Every "now" written to `occurred_at`, `effective_at`, `frozen_since`, `created_at` of a transfer or purchase, or `submitted_at` is the `timestamptz` returned by `app.lock_branches` (`clock_timestamp()` taken after the locks are held).
- Errors are raised as `raise exception '<CODE>'` (SQLSTATE `P0001`) with a code from Task 4. The database never returns Arabic prose.
- Timestamps are `timestamptz` (UTC). Inventory periods are the first day of a calendar month in `Asia/Amman`, stored as `date`.
- Quantities are `numeric`, never float. Every operational row stores entered `quantity`, `unit`, the `unit_rate` in force when it was entered, and `base_quantity = quantity × unit_rate`. A stored `base_quantity` is never recomputed from current rates.
- `stock_movements`, `stock_baselines`, `activity_log`, `purchase_line_history` are insert-only, enforced by trigger.
- Balances are shown, never used to block an action.
- Every write RPC except `save_count_line` takes `p_request_id uuid`. A repeat with the same id **and the same values** returns the stored result and changes nothing; the same id with different values, a different RPC or a different user raises `REQUEST_ID_REUSED`.
- Migration files are numbered `NNNN_name.sql` and never edited after they are merged.
- Stock-rule tests are never cut.

## Review Focus

1. **Two phones act on the same record at the same moment** (two receipts; receipt vs owner resolution; two purchase edits; edit vs void). Expected: exactly one logical outcome, and the ledger equals the record. (Task 13, two real connections)
2. **A conversion rate or unit changes between send and receipt.** Expected: "received as sent" always equals the sent `base_quantity`; no false difference, no cost change. (Task 6)
3. **A purchase or receipt races the start or the submission of a count.** Expected: it either lands before the freeze and is dated before it, or is refused, or lands after submission and is dated after every line's `effective_at`. Never silently dropped from the balance. (Tasks 9, 13)
4. **An old token after a PIN reset followed by a new login.** Expected: the old access token and the old refresh token stay dead forever. (Tasks 10, 12)
5. **A late or duplicated count autosave.** Expected: a stale save is rejected, never overwrites a newer entry, never creates a count, never freezes a branch. (Task 8)

---

## File Structure

```
supabase/
  config.toml                         CLI config; public sign-ups disabled
  seed.sql                            test fixtures + test helper functions (local/CI only)
  migrations/
    0000_security_baseline.sql        extensions, schema app, default-privilege revokes
    0001_reference.sql                branches, items, item_units, suppliers, supplier_items,
                                      allowed_local_purchases, branch_features, app_users,
                                      app_user_secrets, app_sessions
    0002_reference_hardening.sql      follow-up to 0001: finite-number check on conversion_rate,
                                      base-unit rule made safe under concurrent transactions
    0003_operations.sql               transfers, transfer_lines, purchases, purchase_lines,
                                      purchase_line_history, count_windows, counts, count_lines
    0004_ledger.sql                   stock_movements, stock_baselines, activity_log, rpc_requests,
                                      insert-only triggers, balances view
    0005_helpers.sql                  schema app: session, validation, locking, idempotency, logging
    0006_rls.sql                      table grants + policies
    0007_rpc_transfers.sql            send_transfer, receive_transfer, owner_resolve_transfer_line
    0008_rpc_purchases.sql            create_purchase, edit_purchase_line, void_purchase_line
    0009_rpc_counts.sql               open/close_count_window, start_count, save_count_line,
                                      discard_count, submit_count, review_count, zero_branch_balance
    0010_rpc_users.sql                admin_* user RPCs, set_branch_feature, logout
    0011_login.sql                    login_verify, login_attach_auth_user, login_register_session
    0012_owner_session_recheck.sql    follow-up to 0010: admin_set_secret rechecks the caller's session after the row lock
  functions/login/
    index.ts, derive.ts, derive_test.ts, login_integration_test.ts
  tests/                              pgTAP, one file per migration, plus 20_reconciliation
  tests-concurrency/
    helpers.ts, concurrency_test.ts   Deno, two real database connections
.github/workflows/test.yml
legacy/                               src/Code.js, src/index.html moved here unchanged
```

## Fixtures (used by every test task)

`supabase/seed.sql` creates exactly this; tests refer to these ids.

| Kind | Rows |
|---|---|
| branches | `BR-01`, `BR-02`, `BR-03` (`branch`); `BR-14` (`warehouse`); `BR-15` (`waste`); `BR-09` (`branch`, `active = false`) |
| items | `D-001` base unit `مل`, type `syrup`; `D-002` base unit `حبة`, type `cups`; `D-003` base `غم`, type `powder`, `active = false` |
| item_units | `D-001`: `مل` ×1, `عبوة` ×750, `كرتونة` ×9000. `D-002`: `حبة` ×1, `كرتونة` ×1000. `D-003`: `غم` ×1 |
| suppliers | `S-01` active, sells `D-001`. `S-02` inactive, sells `D-002` |
| allowed_local_purchases | (`BR-01`, `D-001`), (`BR-03`, `D-001`), (`BR-14`, `D-001`) |
| branch_features | every (branch, feature) visible, except `BR-15`: `send` and `purchase` hidden |
| app_users | `100` owner (password `correct horse battery`), `201` manager `BR-01` (PIN `1111`), `202` manager `BR-02` (PIN `2222`), `203` manager `BR-03` (PIN `0303`), `301` distributor `BR-14` (PIN `3333`), `215` manager `BR-15` (PIN `1515`), `299` manager `BR-01` inactive |

Each seeded user has an `auth.users` row (`email = <employee_number>@gosta.invalid`), `auth_user_id` set, and one `app_sessions` row with a fixed `session_id` expiring in 7 days. `BR-03` and user `203` are reserved for the concurrency tests (Task 13), which commit data; pgTAP tests must not depend on `BR-03` being empty.

As built in Task 2: the base unit row of every item must exist, have rate 1 **and be active** (deferred constraint trigger; inside a pgTAP transaction it fires only at commit or after `set constraints all immediate`); ids of branches, items and suppliers cannot be blank; seeded `auth.users` rows carry `instance_id`, `email_confirmed_at` and empty-string token columns so Supabase Auth can load them; `test.act_as_service` sets the claims to `{"role":"service_role"}`.

Test helpers in schema `test` (seed only, never in a migration):

- `test.act_as(p_employee_number text) returns void` — `set local role authenticated`; sets `request.jwt.claims` to `{"sub": <auth_user_id>, "role": "authenticated", "session_id": <seeded session id>}`.
- `test.act_as_service() returns void` — `set local role service_role`.
- `test.reset_role() returns void` — `reset role`, clears the claims.
- `test.balance(p_branch text, p_item text) returns numeric` — computes the balance from `stock_baselines` and `stock_movements` directly with the view's arithmetic (it does not read the `balances` view, which is filtered by session); independent of who the test is acting as; 0 when there is nothing.
- `test.expire_session(p_employee_number text) returns void` — sets that user's `app_sessions.expires_at` to one second ago.
- `test.freeze(p_branch text) returns void` — as postgres, inserts an open window and a `draft` count for the current month with `frozen_since = clock_timestamp()`.

---

### Task 1: Repository layout, local stack, security baseline, CI

**Files:**
- Move: `src/Code.js` → `legacy/Code.js`, `src/index.html` → `legacy/index.html`
- Modify: `README.md` (replace the clasp workflow with: what the repo is, `supabase start`, `supabase db reset`, `supabase test db`; one paragraph saying `legacy/` is the old app, reference only)
- Create: `supabase/config.toml` (via `supabase init`), `supabase/migrations/0000_security_baseline.sql`, `supabase/seed.sql` (empty for now), `supabase/tests/00_baseline.test.sql`, `.github/workflows/test.yml`

**Interfaces:**
- Produces: `supabase db reset` applies all migrations then `seed.sql`; `supabase test db` runs every `supabase/tests/*.test.sql`. Schema `app` exists. Any function created later in `public` or `app` is executable by nobody but its owner and `service_role` until granted.

- [ ] **Step 1: `git mv` the legacy files and run `supabase init`** (project id `gosta`). In `config.toml` set `[auth] enable_signup = false`.

- [ ] **Step 2: Write the failing test `00_baseline.test.sql`**

```sql
begin;
select plan(5);
select has_extension('pgcrypto'); select has_extension('pgtap'); select has_schema('app');
create function public.probe_pub() returns int language sql as 'select 1';
create function app.probe_app() returns int language sql as 'select 1';
select ok(not has_function_privilege('authenticated', 'public.probe_pub()', 'execute')
      and not has_function_privilege('anon', 'public.probe_pub()', 'execute'), 'new public functions are closed');
select ok(not has_function_privilege('authenticated', 'app.probe_app()', 'execute'), 'new app functions are closed');
select * from finish();
rollback;
```

- [ ] **Step 3: Run `supabase start && supabase test db`.** Expected: FAIL.
- [ ] **Step 4: Write `0000_security_baseline.sql`:** `create extension if not exists pgcrypto with schema extensions`; `create schema app`; `grant usage on schema app to authenticated, service_role`; `alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated`; the same for schema `app`; and `alter default privileges for role postgres revoke execute on functions from public` (global default).
- [ ] **Step 5: Run.** Expected: PASS (5/5).
- [ ] **Step 6: Write `.github/workflows/test.yml`.** Trigger: `push`, `pull_request`. One job on `ubuntu-latest`: checkout, `supabase/setup-cli@v1`, `supabase db start`, `supabase test db`, `denoland/setup-deno@v2`, `deno test --permit-no-files supabase/functions/`.
- [ ] **Step 7: Commit** — `chore: move legacy app, add supabase local stack, security baseline and CI`. Push; confirm the workflow is green.

---

### Task 2: Reference schema and fixtures

**Files:**
- Create: `supabase/migrations/0001_reference.sql`, `supabase/tests/01_schema.test.sql`
- Modify: `supabase/seed.sql`

**Interfaces:**
- Produces: the reference tables of spec section 4, the fixtures and the `test.*` helpers above. Decisions the spec leaves open:
  - Text primary keys: `branches.id`, `items.id`, `suppliers.id`.
  - `item_units` primary key `(item_id, unit_name)`; check `conversion_rate > 0`. A deferred constraint trigger requires that `items.base_unit` exists in `item_units` for that item with `conversion_rate = 1`.
  - `branch_features.feature_key` check in (`receive`,`send`,`purchase`,`count`,`balance`); primary key `(branch_id, feature_key)`. A missing row means visible.
  - `app_users(id uuid primary key default gen_random_uuid(), auth_user_id uuid unique null references auth.users(id), employee_number text unique not null check (employee_number ~ '^[0-9]+$'), name text not null, role text not null, branch_id text null references branches, active boolean not null default true, failed_attempts int not null default 0, locked_until timestamptz null, credential_version int not null default 0)`; check `(role = 'owner') = (branch_id is null)`. There is **no** `session_expires_at` column.
  - `app_user_secrets(user_id uuid primary key references app_users, secret_hash text not null)`.
  - `app_sessions(session_id uuid primary key, user_id uuid not null references app_users, created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null, revoked_at timestamptz null)`; index on `user_id`.
  - Enumerations are `text` + check constraints, not Postgres enums.

- [ ] **Step 1: Write the failing test `01_schema.test.sql`**

```sql
begin;
select plan(9);
select has_table('branches'); select has_table('app_user_secrets'); select has_table('app_sessions');
select hasnt_column('app_users', 'session_expires_at');
select throws_ok($$insert into item_units values ('D-999','مل',1,true)$$, '23503');          -- unit for a missing item
select throws_ok($$insert into item_units values ('D-001','برميل',0,true)$$, '23514');        -- rate must be > 0
select throws_ok($$insert into branches(id,name_ar,kind,active) values ('BR-77','x','BR-11',true)$$, '23514');
select throws_ok($$insert into app_users(employee_number,name,role,branch_id) values ('900','x','owner','BR-01')$$, '23514');
select is((select count(*) from app_users u join app_sessions s on s.user_id = u.id), 7::bigint, 'seven seeded users with a session');
select * from finish();
rollback;
```

- [ ] **Step 2: Run `supabase db reset && supabase test db`.** Expected: FAIL.
- [ ] **Step 3: Write `0001_reference.sql`.**
- [ ] **Step 4: Write `seed.sql`:** fixtures and `test.*` helpers (`test.freeze` is added in Task 3 when its tables exist). Hash secrets with `extensions.crypt(secret, extensions.gen_salt('bf', 10))`. Insert `auth.users` rows with `id`, `aud = 'authenticated'`, `role = 'authenticated'`, `email`.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** — `feat(db): reference schema, sessions table and test fixtures`.

---

### Task 3: Operations and ledger schema, balances view

**Files:**
- Create: `supabase/migrations/0002_reference_hardening.sql`, `supabase/migrations/0003_operations.sql`, `supabase/migrations/0004_ledger.sql`, `supabase/tests/02_hardening.test.sql`, `supabase/tests/03_ledger.test.sql`, `supabase/tests-concurrency/helpers.ts`, `supabase/tests-concurrency/base_unit_test.ts`
- Modify: `.github/workflows/test.yml` (run the concurrency tests after the pgTAP step)
- Modify: `supabase/seed.sql` (add `test.freeze` and `test.balance`; Task 2 deliberately left both out because their tables and view did not exist yet)

**Interfaces:**
- **Owner additions (2026-11-12).** Migration 0001 is accepted and is not edited; changes to its schema go in `0002_reference_hardening.sql`:
  - **Finite numbers.** Postgres `numeric` accepts `NaN`, `Infinity` and `-Infinity`, and `NaN > 0` is true, so `conversion_rate > 0` does not stop `NaN`. Add `app.is_finite(numeric) returns boolean` (`immutable`, null → null) and a named check using it on `item_units.conversion_rate`. Every numeric column created in this task (`quantity`, `unit_rate`, `base_quantity`, `cost_total`, `received_quantity`, `received_unit_rate`, `received_base_quantity`, movement and baseline `base_quantity`, count line `base_quantity`) gets the same check, each named `<table>_<column>_finite`.
  - **Base-unit rule under concurrency.** The rule is checked per transaction at commit, so two transactions that are each valid alone can together break it: one repoints `items.base_unit` to a second rate-1 unit while the other changes that unit's rate. Replace `app.check_item_base_unit` (`create or replace`, same triggers) so that it first takes `select … from public.items where id = … for update` on each affected item and then checks. The second transaction then waits and its check sees the first one's committed change.
- Produces: tables per spec section 4, with these explicit additions and constraints:
  - All ids `uuid default gen_random_uuid()` except composite keys `count_windows (branch_id, period_month)` and `count_lines (count_id, item_id)`.
  - `transfer_lines`: `unit_rate numeric not null check (unit_rate > 0)`, `received_unit_rate numeric null`; check `base_quantity = quantity * unit_rate`; `status` check in (`pending`,`received`,`denied`); `diff_reason` check in (`overloaded`,`count_error`,`not_loaded`).
  - `purchase_lines`: `unit_rate numeric not null check (unit_rate > 0)`; check `base_quantity = quantity * unit_rate`.
  - `counts`: unique `(branch_id, period_month)`; `status` check in (`draft`,`submitted`,`returned`,`approved`); `frozen_since timestamptz null`; `revision int not null default 0`; check `frozen_since is null or status in ('draft','returned')`.
  - `count_lines`: `state` check in (`uncounted`,`counted`,`none`); `revision int not null default 0`; `needs_recount boolean not null default false`; `effective_at timestamptz null`; check `(state = 'uncounted') = (base_quantity is null)`.
  - `stock_movements.kind` check in (`transfer_out`,`transfer_in`,`transfer_adjust`,`purchase_in`,`purchase_adjust`). Index `(branch_id, item_id, occurred_at)`.
  - `stock_baselines.source` check in (`count`,`owner_zero`). Index `(branch_id, item_id, effective_at desc)`.
  - `rpc_requests(request_id uuid primary key, rpc_name text not null, user_id uuid not null, request_hash text not null, secret_verifier text null, result jsonb not null, created_at timestamptz not null default clock_timestamp())`.
  - Trigger function `app.forbid_update_delete()` raising `IMMUTABLE_ROW`, attached `before update or delete` (row level) and `before truncate` (statement level) to the four insert-only tables.
  - View `balances` (`with (security_invoker = true)`), one row per (active branch × active item):

```sql
-- columns: branch_id, item_id, base_quantity numeric, baseline_at timestamptz (null = never counted)
-- base_quantity = latest baseline's quantity (0 if none)
--               + sum(stock_movements.base_quantity) where occurred_at > that baseline's effective_at
--                 (all movements when there is no baseline)
-- "latest" = greatest effective_at, ties broken by greatest seq (stock_baselines.seq is an identity column: the row written last wins)
```

- [ ] **Step 1: Write the failing test `03_ledger.test.sql`** (inserts as postgres, direct to tables, explicit timestamps)

```sql
begin;
select plan(8);
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001', 9000,'purchase_in','purchase_lines',gen_random_uuid(),'2026-11-01 10:00+03'),
         ('BR-01','D-001',-1500,'transfer_out','transfer_lines',gen_random_uuid(),'2026-11-02 10:00+03');
select is(test.balance('BR-01','D-001'), 7500::numeric, 'no baseline: sum of movements');
insert into stock_baselines(branch_id,item_id,base_quantity,effective_at,source)
  values ('BR-01','D-001',4000,'2026-11-03 10:00+03','count');
select is(test.balance('BR-01','D-001'), 4000::numeric, 'baseline replaces earlier movements');
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001',-750,'purchase_adjust','purchase_lines',gen_random_uuid(),'2026-11-01 10:00+03');
select is(test.balance('BR-01','D-001'), 4000::numeric, 'correction dated before the baseline is ignored');
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001',750,'transfer_in','transfer_lines',gen_random_uuid(),'2026-11-04 10:00+03');
select is(test.balance('BR-01','D-001'), 4750::numeric, 'later movement applies on top');
select is((select baseline_at from balances where branch_id='BR-02' and item_id='D-001'), null, 'never counted');
select throws_ok($$update stock_movements set base_quantity = 0$$, 'IMMUTABLE_ROW');
select throws_ok($$delete from stock_baselines$$, 'IMMUTABLE_ROW');
select throws_ok($$insert into counts(branch_id,period_month,status,frozen_since) values ('BR-02','2026-11-01','submitted',now())$$, '23514');
select * from finish();
rollback;
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write migrations 0003 and 0004, `test.freeze` and `test.balance`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): operations tables, insert-only ledger, balances view`.
- [ ] **Step 6: Write the failing test `02_hardening.test.sql`:** `NaN`, `Infinity` and `-Infinity` are each refused (`23514`) as `item_units.conversion_rate`; `app.is_finite` returns true for `0`, `-1.5`, `9000` and false for the three specials; and, after 0003/0004 exist, `NaN` and `Infinity` are refused in `stock_movements.base_quantity`, `stock_baselines.base_quantity`, `purchase_lines.quantity` and `transfer_lines.cost_total`.
- [ ] **Step 7: Write `0002_reference_hardening.sql`; run.** Expected: PASS, and `01b_base_unit.test.sql` still passes unchanged.
- [ ] **Step 8: Write the two-transaction test `supabase/tests-concurrency/base_unit_test.ts`** (Deno, `npm:postgres`, two dedicated connections to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`; `helpers.ts` exports `connect()` only for now — Task 13 extends it). Each test creates its own item (`D-9xx`) with units `مل` ×1 and `لتر` ×1, commits, and cleans up after itself.

| Test | A | B | Assertion |
|---|---|---|---|
| repoint vs rate change | `begin; update items set base_unit = 'لتر'` | `begin; update item_units set conversion_rate = 1000 where unit_name = 'لتر'; commit` (started after A's update, before A commits) | A commits first; B's commit is refused (`23514`); afterwards the item's base unit row has rate 1 |
| rate change vs repoint | same two statements, B's transaction committing first | | the later commit is refused; the rule holds |
| repoint vs deactivate | A repoints to `لتر` | B sets `active = false` on `لتر` | the later commit is refused; the base unit row is active |
| control | A and B change two different items | | both commit |

  Show RED once against 0001's function (before 0002 is applied, or with the `for update` line removed in a scratch database): the first test ends with a base unit of rate 1000.
- [ ] **Step 9: Add the workflow step** after `supabase test db`: `deno test --allow-net=127.0.0.1:54322 --allow-env --allow-read --allow-sys supabase/tests-concurrency/` (move `denoland/setup-deno@v2` before it). Narrow the permissions to what the driver actually needs once CI shows them.
- [ ] **Step 10: Commit** — `feat(db): finite-number checks, concurrency-safe base-unit rule`.

---

### Task 4: Internal helpers and error codes

**Files:**
- Create: `supabase/migrations/0005_helpers.sql`, `supabase/tests/04_helpers.test.sql`

**Interfaces:**
- Produces, all in schema `app`. Only the three marked **(RLS)** are granted to `authenticated`; nothing is granted to `anon`.
  - `app.current_app_user() returns app_users` — the row where `auth_user_id = auth.uid()` and `active`, and an `app_sessions` row exists with `session_id = (auth.jwt() ->> 'session_id')::uuid`, the same `user_id`, `revoked_at is null`, `clock_timestamp() < expires_at`. Otherwise raises `NOT_AUTHENTICATED`.
  - `app.session_ok() returns boolean` **(RLS)** — same check, false instead of raising; `stable`.
  - `app.my_role() returns text`, `app.my_branch() returns text` **(RLS)** — `stable`; null when `session_ok()` is false.
  - `app.require_role(variadic p_roles text[]) returns app_users` — `FORBIDDEN` if the caller's role is not listed.
  - `app.require_feature(p_branch_id text, p_feature_key text) returns void` — `FEATURE_HIDDEN`.
  - `app.lock_branches(variadic p_branch_ids text[]) returns timestamptz` — `pg_advisory_xact_lock(hashtextextended('branch:' || id, 0))` for each distinct id in ascending order, then returns `clock_timestamp()`.
  - `app.require_not_frozen(p_branch_id text) returns void` — `BRANCH_FROZEN` when any `counts` row for the branch has `frozen_since is not null`. Callers must already hold the branch lock.
  - `app.unit_rate(p_item_id text, p_unit text, p_allow_inactive boolean default false) returns numeric` — `ITEM_INVALID` (missing or inactive item), `UNIT_INVALID` (no such unit, or inactive and not allowed).
  - `app.check_quantity(p_quantity numeric, p_allow_zero boolean) returns numeric` — `QUANTITY_INVALID` for null, `NaN`, `Infinity`, `-Infinity` (via `app.is_finite`), negative, or zero when not allowed. The finite test comes first: `NaN > 0` is true in Postgres, so a sign test alone lets `NaN` through.
  - `app.check_cost(p_cost numeric) returns numeric` — null passes through as null; `COST_INVALID` for `NaN`, `Infinity`, `-Infinity` or negative. Every RPC validates costs with this and quantities with `check_quantity`, so a bad number is refused with a plain error code before it can reach a table check constraint.
  - `app.request_replay(p_request_id uuid, p_rpc_name text, p_user_id uuid, p_params jsonb) returns jsonb` — takes `pg_advisory_xact_lock(hashtextextended('req:' || p_request_id, 0))`. No row → null. Row with the same `rpc_name`, `user_id` and `request_hash` → its `result`. Anything else → `REQUEST_ID_REUSED`. `request_hash = encode(digest(p_rpc_name || ':' || p_params::text, 'sha256'), 'hex')`; `p_params` is a `jsonb` built by the RPC from all its arguments except secrets.
  - `app.request_store(p_request_id uuid, p_rpc_name text, p_user_id uuid, p_params jsonb, p_result jsonb, p_secret text default null) returns jsonb` — inserts and returns `p_result`. When `p_secret` is given it stores `secret_verifier = crypt(p_secret, gen_salt('bf', 10))`: a verifier that belongs to this request and never changes afterwards.
  - `app.request_secret_ok(p_request_id uuid, p_secret text) returns boolean` — `crypt(p_secret, secret_verifier) = secret_verifier` for that request row.
  - `app.log_action(p_user_id uuid, p_action text, p_entity_table text, p_entity_id text, p_details jsonb) returns void`.
  - `app.normalize_digits(p text) returns text` — `immutable`; maps `٠-٩` and `۰-۹` to `0-9`.

Complete list of error codes (the front-end plan maps exactly these):
`NOT_AUTHENTICATED`, `FORBIDDEN`, `FEATURE_HIDDEN`, `BRANCH_FROZEN`, `BRANCH_INVALID`, `ITEM_INVALID`, `UNIT_INVALID`, `QUANTITY_INVALID`, `COST_REQUIRED`, `COST_INVALID`, `LINES_EMPTY`, `LINES_INCOMPLETE`, `LINE_NOT_PENDING`, `DIFF_REASON_REQUIRED`, `SUPPLIER_INVALID`, `ITEM_NOT_ALLOWED`, `LINE_VOIDED`, `WINDOW_CLOSED`, `WINDOW_EXISTS`, `COUNT_LOCKED`, `COUNT_NOT_STARTED`, `COUNT_INCOMPLETE`, `COUNT_NOT_SUBMITTED`, `COUNT_NOT_OPEN`, `STALE_WRITE`, `ENTRIES_INVALID`, `NOTE_REQUIRED`, `USER_INVALID`, `SECRET_WEAK`, `SECRET_TOO_LONG`, `EMPLOYEE_NUMBER_TAKEN`, `REQUEST_ID_REUSED`, `REQUEST_ID_REQUIRED`, `FEATURE_INVALID`, `IMMUTABLE_ROW`.

- [ ] **Step 1: Write the failing test `04_helpers.test.sql`.** Functions that clients cannot call are tested as postgres with the claims set by hand (`select set_config('request.jwt.claims', …, true)` without changing role); client-visible behaviour is tested through the three RLS helpers.

```sql
begin;
select plan(29);  -- set to the real number of assertions if it differs; never drop one
-- client-visible
select test.act_as('201');
select is(app.session_ok(), true); select is(app.my_branch(), 'BR-01'); select is(app.my_role(), 'manager');
select throws_ok('select app.current_app_user()', '42501', null, 'internal helper is not callable by clients');
select throws_ok($$select app.request_store(gen_random_uuid(),'x',gen_random_uuid(),'{}','{}')$$, '42501');
select throws_ok($$select app.log_action(null,'x','x','x','{}')$$, '42501');
select test.reset_role();
select test.expire_session('201'); select test.act_as('201');
select is(app.session_ok(), false, 'expired session'); select is(app.my_branch(), null);
select test.act_as('299'); select is(app.session_ok(), false, 'inactive user');
select test.reset_role();
update app_sessions set revoked_at = clock_timestamp() where user_id = (select id from app_users where employee_number='202');
select test.act_as('202'); select is(app.session_ok(), false, 'revoked session');
select test.reset_role();
-- internal, as postgres
select is(app.unit_rate('D-001','عبوة'), 750::numeric);
select throws_ok($$select app.unit_rate('D-001','حبة')$$, 'UNIT_INVALID');
select throws_ok($$select app.unit_rate('D-003','غم')$$, 'ITEM_INVALID');
select throws_ok($$select app.check_quantity(0, false)$$, 'QUANTITY_INVALID');
select is(app.check_quantity(0, true), 0::numeric); select is(app.check_quantity(2.5, false), 2.5::numeric);
select throws_ok($$select app.check_quantity(null, true)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity(-1, true)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('NaN', false)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('Infinity', false)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('-Infinity', true)$$, 'QUANTITY_INVALID');
select is(app.check_cost(null), null::numeric); select is(app.check_cost(0), 0::numeric);
select throws_ok($$select app.check_cost('NaN')$$, 'COST_INVALID');
select throws_ok($$select app.check_cost('Infinity')$$, 'COST_INVALID');
select throws_ok($$select app.check_cost(-0.01)$$, 'COST_INVALID');
select throws_ok($$select app.require_feature('BR-15','send')$$, 'FEATURE_HIDDEN');
select is(app.normalize_digits('٢٠١'), '201');
-- replay: same values replay, changed values are refused
select app.request_store('00000000-0000-0000-0000-000000000001','r', (select id from app_users where employee_number='201'), '{"q":2}', '{"ok":1}');
select throws_ok($$select app.request_replay('00000000-0000-0000-0000-000000000001','r',(select id from app_users where employee_number='201'),'{"q":3}')$$, 'REQUEST_ID_REUSED');
select * from finish();
rollback;
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0005_helpers.sql`**, ending with the three explicit grants. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): session, validation, locking and idempotency helpers`.

---

### Task 5: Table grants and row-level security

**Files:**
- Create: `supabase/migrations/0006_rls.sql`, `supabase/tests/05_rls.test.sql`

**Interfaces:**
- Consumes: `app.session_ok()`, `app.my_role()`, `app.my_branch()`.
- Produces: RLS enabled on every table in `public`. `revoke all on all tables in schema public from anon, authenticated`, then `grant select` to `authenticated` only as below. No insert/update/delete policy exists anywhere.

| Tables | `select` policy for `authenticated` |
|---|---|
| `branches`, `items`, `item_units`, `suppliers`, `supplier_items` | `app.session_ok()` |
| `allowed_local_purchases`, `branch_features`, `count_windows`, `counts`, `stock_movements`, `stock_baselines`, `purchases` | owner, or `branch_id = app.my_branch()` |
| `transfers` | owner, or `app.my_branch() in (from_branch, to_branch)` |
| `transfer_lines`, `purchase_lines`, `count_lines` | exists a visible parent row |
| `app_users` | owner sees all; others only their own row |
| `purchase_line_history`, `activity_log` | owner only |
| `app_user_secrets`, `app_sessions`, `rpc_requests` | no grant, no policy |

A receiving branch must not learn the sender's cost: `grant select (every column except cost_total) on transfer_lines to authenticated`, and expose cost through view `transfer_line_costs(line_id, cost_total)` (`security_invoker = false`) filtered to owner, or caller's branch = the transfer's `from_branch`.

- [ ] **Step 1: Write the failing test `05_rls.test.sql`.** As postgres insert one purchase for `BR-01` and one for `BR-02`, one transfer `BR-14 → BR-01` with one line, `cost_total = 12.5`, and one `stock_movements` row of +500 for (`BR-02`, `D-001`). Then the assertions below, **plus the balance-view test carried over from Task 3** (it could not fail there because no RLS existed): after `test.act_as('201')`, `select count(*) from balances where branch_id = 'BR-02'` is 0 and `select count(*) from balances where branch_id = 'BR-01'` is 2 (the view obeys RLS for the caller), while `test.balance('BR-02','D-001')` still returns 500 (the helper reads as the owner); as the owner (`test.act_as('100')`) `balances` shows the BR-02 row with 500. Raise the plan count accordingly.

```sql
select plan(14);
select test.act_as('201');
select is((select count(*) from purchases), 1::bigint, 'manager sees only own branch purchases');
select is((select count(*) from transfers), 1::bigint, 'receiver sees transfer addressed to it');
select throws_ok('select cost_total from transfer_lines', '42501');
select is((select count(*) from transfer_line_costs), 0::bigint, 'receiver cannot see sender cost');
select is((select count(*) from app_users), 1::bigint);
select throws_ok('select * from app_user_secrets', '42501');
select throws_ok('select * from app_sessions', '42501');
select throws_ok($$insert into purchases(branch_id,supplier_id) values ('BR-01','S-01')$$, '42501');
select test.act_as('202');
select is((select count(*) from transfers), 0::bigint, 'uninvolved branch sees nothing');
select test.act_as('301');
select is((select cost_total from transfer_line_costs), 12.5::numeric, 'sender sees own cost');
select test.act_as('100');
select is((select count(*) from purchases), 2::bigint, 'owner sees all');
select test.reset_role(); select test.expire_session('201'); select test.act_as('201');
select is((select count(*) from items), 0::bigint, 'expired session reads nothing');
select test.reset_role();
select is_empty($$select table_name, privilege_type from information_schema.role_table_grants
  where grantee in ('anon','authenticated','PUBLIC') and table_schema = 'public' and privilege_type <> 'SELECT'$$, 'no client write privilege on any table');
select is_empty($$select table_name from information_schema.role_table_grants
  where grantee in ('anon','PUBLIC') and table_schema = 'public'$$, 'anon reads nothing');
```

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0006_rls.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): table grants and row-level security`.

---

### Task 6: Transfer RPCs

**Files:**
- Create: `supabase/migrations/0007_rpc_transfers.sql`, `supabase/tests/06_transfers.test.sql`

**Interfaces:**
- Consumes: Task 4 helpers.
- Produces (each granted to `authenticated`):
  - `send_transfer(p_request_id uuid, p_to_branch text, p_lines jsonb) returns jsonb` → `{"transfer_id": uuid}`. `p_lines`: `[{"item_id","quantity","unit","cost_total"?}]`.
  - `receive_transfer(p_request_id uuid, p_transfer_id uuid, p_lines jsonb) returns jsonb` → `{"transfer_id": uuid, "received": int}`. `p_lines`: `[{"line_id","quantity","unit","diff_reason"?,"note"?}]`.
  - `owner_resolve_transfer_line(p_request_id uuid, p_line_id uuid, p_action text, p_quantity numeric default null, p_unit text default null) returns jsonb` → `{"line_id": uuid, "status": text}`. `p_action` in (`accept`,`deny`,`edit_accept`).

Shape of every write RPC in this plan: `current_app_user` / `require_role` → `request_replay` (return if not null) → read immutable parents to learn the branches → `lock_branches` (keep the returned timestamp `v_now`) → row locks `for update` → validate → write using `v_now` → `log_action` → `return request_store(…)`.

Rules beyond spec section 6.2:

- `send_transfer`: roles `manager`, `distributor`; source = caller's branch; lock source; `require_feature(source,'send')`; `require_not_frozen(source)`; destination must exist, be active, differ from source (`BRANCH_INVALID`); destination may be frozen and is not locked. Empty array → `LINES_EMPTY`. Quantity > 0. Distributor: `cost_total` required per line (`COST_REQUIRED`); any role: `cost_total < 0` → `COST_INVALID`. Stores `unit_rate` = current rate. `transfers.created_at` and each `transfer_out.occurred_at` = `v_now`.
- `receive_transfer`: read `from_branch`, `to_branch` from the transfer (immutable); caller's branch must equal `to_branch` (`FORBIDDEN`); lock destination; `require_feature(dest,'receive')`; `require_not_frozen(dest)`. `select … from transfer_lines where transfer_id = … for update order by id`, then evaluate. `p_lines` must be exactly the set of pending line ids (`LINES_INCOMPLETE`); no pending lines → `LINE_NOT_PENDING`. Received quantity ≥ 0.
  - **Receipt conversion.** If the received unit equals the line's sent unit, `received_unit_rate := the line's stored unit_rate` — whatever the unit's current rate or active flag. Otherwise `received_unit_rate := app.unit_rate(item, unit)` (must be active). `received_base_quantity = quantity × received_unit_rate`. So "as sent" always equals `base_quantity` exactly.
  - If `received_base_quantity <> base_quantity`, `diff_reason` is required (`DIFF_REASON_REQUIRED`). No `transfer_in` row when received is 0. `transfer_in.occurred_at = v_now`. `transfer_adjust` at the source = `base_quantity − received_base_quantity` (negative when overloaded), `occurred_at` = `transfers.created_at`. `cost_total := round(cost_total × received_base / base, 3)` when cost is not null.
- `owner_resolve_transfer_line`: role `owner`. Read the line's transfer to learn the branches; for `accept` and `edit_accept` lock the destination and `require_not_frozen` it; then `select … for update` the line and only then check `status = 'pending'` (`LINE_NOT_PENDING`). `edit_accept` requires `p_quantity > 0` and `p_unit`; the rate follows the **edit conversion rule** of Task 7 (same unit → the line's stored `unit_rate`; different unit → that unit's current active rate); it writes `transfer_adjust` at the source for `old_base − new_base` dated at the send time, updates `quantity`/`unit`/`unit_rate`/`base_quantity`, scales cost, then accepts in full. `deny`: `transfer_adjust` +`base_quantity` at the source dated at the send time; no destination movement; no branch lock. All three set `resolved_by_owner = true`.
- Every path sets `resolved_by`, `resolved_at` (`v_now`, or `clock_timestamp()` for `deny`).
- **Numeric fingerprint rule (all RPCs in Tasks 6–10 that take a number).** Before calling `request_replay`, rebuild the parameters from typed values: every quantity and cost goes through `app.check_quantity` / `app.check_cost` and then `trim_scale(...)`, text ids and units are taken as given, and `p_lines` is rebuilt element by element with `jsonb_build_object` in the caller's order. `2`, `2.0` and `2.00` must produce the same `request_hash`; a retry is a retry however the phone formats the number.

- [ ] **Step 1: Write the failing tests `06_transfers.test.sql`.** Each asserts with `test.balance` and row checks. Baseline for arithmetic tests: `301` sends `BR-14 → BR-01`: `D-001` 2 `كرتونة` (18000 مل) cost 40, and `D-002` 1 `كرتونة` (1000) cost 10.

| Test | Assertion |
|---|---|
| send writes ledger | `balance(BR-14,D-001) = -18000`, `balance(BR-01,D-001) = 0`, two lines `pending`, `unit_rate = 9000` on the first |
| send idempotent | same id and body twice → same `transfer_id`, one transfer |
| replay with changed values | same id, quantity 3 instead of 2 → `REQUEST_ID_REUSED`; still one transfer of 2 |
| request id from another user | → `REQUEST_ID_REUSED` |
| **numeric fingerprint** | same id, same body except quantity written `2.0` instead of `2` and cost `40.00` instead of `40` → replays the same `transfer_id` (not `REQUEST_ID_REUSED`); same id with quantity `2.5` → `REQUEST_ID_REUSED`. Same pair of checks for `receive_transfer` (received quantity `1.0` vs `1`) and `owner_resolve_transfer_line` (`p_quantity` `1.0` vs `1`) |
| distributor needs cost | → `COST_REQUIRED` |
| manager cost optional | `201` sends to `BR-02` without cost → ok |
| bad destination | `BR-14` (self), `BR-09` (inactive), `BR-XX` → `BRANCH_INVALID` each |
| zero quantity | → `QUANTITY_INVALID` |
| feature hidden | `215` sends → `FEATURE_HIDDEN` |
| receive in full | `balance(BR-01,D-001) = 18000`, `balance(BR-14,D-001) = -18000`, no `transfer_adjust` rows |
| receive short | `D-001` received 1 `كرتونة`, `not_loaded` → `balance(BR-01,D-001) = 9000`, `balance(BR-14,D-001) = -9000`, `cost_total = 20.000` |
| receive over | `D-002` received 1200 `حبة`, `overloaded` → `balance(BR-14,D-002) = -1200`, `cost_total = 12.000` |
| receive zero | `D-001` received 0, `not_loaded` → no `transfer_in`, `balance(BR-14,D-001) = 0`, `cost_total = 0` |
| diff needs reason | → `DIFF_REASON_REQUIRED` |
| partial confirm refused | one of two line ids → `LINES_INCOMPLETE`, nothing written |
| wrong branch | `202` receives → `FORBIDDEN` |
| second receive | new request id → `LINE_NOT_PENDING`; one `transfer_in` per line |
| received is final | owner `accept` on a received line → `LINE_NOT_PENDING` |
| **rate changed after send** | after the send, `update item_units set conversion_rate = 8000` for (`D-001`,`كرتونة`); receive 2 `كرتونة` with **no** reason → ok, `received_base_quantity = 18000`, `cost_total = 40`, no `transfer_adjust` |
| rate changed, other unit | same change; receive 24 `عبوة` (= 18000) with no reason → ok |
| sent unit deactivated | deactivate (`D-001`,`كرتونة`) after the send; receive as sent → ok; receive in a different inactive unit → `UNIT_INVALID` |
| owner accept | `balance(BR-01,D-001) = 18000`, `resolved_by_owner = true` |
| owner deny | `balance(BR-14,D-001) = 0`, `balance(BR-01,D-001) = 0`, status `denied` |
| owner edit_accept | edit to 1 `كرتونة` → `balance(BR-14,D-001) = -9000`, `balance(BR-01,D-001) = 9000`, `cost_total = 20.000` |
| owner edit_accept after a rate change | set (`D-001`,`كرتونة`) to 8000 after the send; `edit_accept` to 1 `كرتونة` → `balance(BR-01,D-001) = 9000` (stored rate), not 8000 |
| adjust dated at send time | insert a `BR-14` baseline for `D-001` of 50000 with `effective_at = clock_timestamp()` between the send and the receipt; receive short by 9000 → `balance(BR-14,D-001) = 50000` |
| frozen source / destination | `test.freeze('BR-14')` → send raises `BRANCH_FROZEN`; `test.freeze('BR-01')` → send to it succeeds, receive and owner `accept` raise `BRANCH_FROZEN`, owner `deny` succeeds |
| expired session | `test.expire_session('201')`, receive → `NOT_AUTHENTICATED`, no rows written |
| ordering inside one transaction | send then receive in the same test transaction → `transfer_in.occurred_at > transfer_out.occurred_at` (proves `clock_timestamp`, not `now()`) |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0007_rpc_transfers.sql`** with three `grant execute … to authenticated` lines. **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): transfer send, receive and owner resolution`.

> **Follow-up recorded after acceptance (transfer overflow).** As accepted, `send_transfer` and `app.receive_transfer_line` in `0007` multiply quantity × rate with no guard, so an absurd quantity (for example `1e131070`) surfaced as SQLSTATE 22003 instead of `QUANTITY_INVALID`; the transaction aborted and nothing was written. `0007` is frozen and was not edited. The gap is closed in `0008_rpc_purchases.sql`, which re-creates `app.check_quantity` and `app.check_cost` with a ceiling of 10^12 (rule (m)); every quantity in the transfer RPCs already passes through `check_quantity`, so the product can no longer overflow. Regression tests live in `07_purchases.test.sql` (`send_transfer` with `1e131070` and `1e13`, `receive_transfer` with `1e13` → `QUANTITY_INVALID`, nothing written). Remaining for Task 13: include one oversized-quantity case in the two-connection suite so the bound is also exercised outside a single test transaction. If the ceiling ever has to change, change it in a new migration by re-creating the two helpers, never by editing 0005 or 0008.

---

### Task 7: Purchase RPCs

**Files:**
- Create: `supabase/migrations/0008_rpc_purchases.sql`, `supabase/tests/07_purchases.test.sql`

**Interfaces:**
- Produces (each granted to `authenticated`):
  - `create_purchase(p_request_id uuid, p_supplier_id text, p_lines jsonb) returns jsonb` → `{"purchase_id": uuid}`. Lines as in `send_transfer`.
  - `edit_purchase_line(p_request_id uuid, p_line_id uuid, p_quantity numeric, p_unit text, p_cost_total numeric) returns jsonb` → `{"line_id": uuid}`.
  - `void_purchase_line(p_request_id uuid, p_line_id uuid) returns jsonb` → `{"line_id": uuid}`.

Rules beyond spec section 6.3:

- `create_purchase`: roles `manager`, `distributor`; branch = caller's; lock branch; `require_feature(branch,'purchase')`; `require_not_frozen(branch)`; supplier exists and active (`SUPPLIER_INVALID`); each item has an active `supplier_items` row for that supplier **and** an active `allowed_local_purchases` row for the branch (`ITEM_NOT_ALLOWED`); quantity > 0; cost rule identical to `send_transfer`. `created_at` and `purchase_in.occurred_at` = `v_now`.
- `edit_purchase_line`: owner only. `select … for update` the line **first**; every value used to compute the adjustment is read after that lock. Voided → `LINE_VOIDED`; quantity > 0; history row `action = 'edit'`, `old_values` = `{quantity, unit, unit_rate, base_quantity, cost_total}`; one `purchase_adjust` of `new_base − old_base` dated at the purchase's `created_at` (none when the difference is 0). No branch lock; allowed while frozen.
  - **Edit conversion rule.** If `p_unit` equals the line's current unit, the line's stored `unit_rate` is kept, whatever the catalog says today and whether or not the unit is still active; `new_base = p_quantity × stored unit_rate`. Only when `p_unit` differs is the rate looked up: `app.unit_rate(item, p_unit)` (must be active), and that rate is stored on the line. So an edit that changes only the cost writes no movement, ever.
- `void_purchase_line`: owner only; same lock-first rule; already voided → `LINE_VOIDED`; history `action = 'void'`; `purchase_adjust` of `−base_quantity` dated at `created_at`.

- [ ] **Step 1: Write the failing tests `07_purchases.test.sql`**

| Test | Assertion |
|---|---|
| create | `201` buys `D-001` 3 `عبوة` from `S-01` → `balance(BR-01,D-001) = 2250` |
| idempotent / changed values | same id + body → same `purchase_id`, balance 2250; same id with 4 `عبوة` → `REQUEST_ID_REUSED` |
| **numeric fingerprint** | same id with quantity `3.0` and cost written with trailing zeros → replays the same `purchase_id`; `edit_purchase_line` retried with `p_quantity` `1.0` vs `1` and `p_cost_total` `5.00` vs `5` → replays, one history row |
| distributor needs cost | `301` without cost → `COST_REQUIRED` |
| inactive supplier | `S-02` → `SUPPLIER_INVALID` |
| item not sold by supplier | `D-002` from `S-01` → `ITEM_NOT_ALLOWED` |
| item not allowed for branch | `202` buys `D-001` from `S-01` → `ITEM_NOT_ALLOWED` |
| feature hidden | `215` → `FEATURE_HIDDEN` |
| frozen | `test.freeze('BR-01')` → `BRANCH_FROZEN` |
| edit | owner edits to 1 `عبوة`, cost 5 → balance `750`; one history row with `old_values->>'base_quantity' = '2250'` |
| two edits in sequence | 3 → 2 → 1 `عبوة` → balance `750` = line `base_quantity`; two history rows |
| **cost-only edit after a rate change** | buy 3 `عبوة` (2250); `update item_units set conversion_rate = 1000` for (`D-001`,`عبوة`); owner edits the line to 3 `عبوة`, cost 9 → no `purchase_adjust` row, `base_quantity = 2250`, `unit_rate = 750`, balance `2250`, `cost_total = 9` |
| quantity edit after a rate change | same set-up; edit to 2 `عبوة` → `base_quantity = 1500`, balance `1500` |
| deliberate unit change after a rate change | same set-up; edit to 3000 `مل` → `unit_rate = 1`, balance `3000`; then edit back to 3 `عبوة` → `unit_rate = 1000`, balance `3000` (the unit changed, so today's rate applies) |
| edit in the same deactivated unit | deactivate (`D-001`,`عبوة`); edit quantity 3 → 2 `عبوة` → ok; edit to a different inactive unit → `UNIT_INVALID` |
| edit by manager | → `FORBIDDEN` |
| void | → balance `0`, `voided_at` set, history `action = 'void'` |
| void twice / edit voided | → `LINE_VOIDED` |
| correction before a baseline | baseline `BR-01`/`D-001` = 1000 with `effective_at = clock_timestamp()` after the purchase; void → balance stays `1000` |
| correction after a baseline | purchase after that baseline; edit 3→1 `عبوة` → balance `1750` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0008_rpc_purchases.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): purchase create, owner edit and void`.

---

### Task 8: Count windows, explicit start, revisioned drafts

> **Blocked: pending owner confirmation of the physical counting procedure** (spec section 6.4). Do not start Task 8 or Task 9 until the owner confirms. Tasks 1–7 and 10–12 do not depend on it.

**Files:**
- Create: `supabase/migrations/0009_rpc_counts.sql` (first half), `supabase/tests/08_count_entry.test.sql`

**Interfaces:**
- Produces (each granted to `authenticated`):
  - `open_count_window(p_request_id uuid, p_branch_id text, p_period_month date) returns jsonb` → `{"branch_id","period_month"}`.
  - `close_count_window(p_request_id uuid, p_branch_id text, p_period_month date) returns jsonb`.
  - `start_count(p_request_id uuid) returns jsonb` → `{"count_id": uuid, "frozen_since": timestamptz, "revision": int}`.
  - `save_count_line(p_count_id uuid, p_item_id text, p_expected_revision int, p_state text, p_entries jsonb) returns jsonb` → `{"base_quantity": numeric|null, "line_revision": int, "count_revision": int, "counted": int, "total": int}`.
  - `discard_count(p_request_id uuid, p_count_id uuid) returns jsonb` → `{"count_id": uuid}`.

Rules:

- `open_count_window`: owner; unknown or inactive branch, or a `p_period_month` that is not the first of a month → `BRANCH_INVALID`; already `open` → `WINDOW_EXISTS`. Re-opening a closed window sets it back to `open`.
- `close_count_window`: owner; sets `closed`. It does not touch an existing count: a started count can still be saved, submitted or discarded after its window closes.
- `start_count` — **the only place a count is created and the only place a freeze starts.** Roles `manager`, `distributor`; own branch; lock branch; `require_feature(branch,'count')`.
  - Branch has a `draft` count → return it unchanged (idempotent re-entry).
  - Branch has a `returned` count → set `frozen_since = v_now` if null, return it (start of the recount).
  - Otherwise the latest `open` window for the branch is required (`WINDOW_CLOSED`); if a count already exists for that window (`submitted` or `approved`) → `COUNT_LOCKED`; else create the `draft` with `frozen_since = v_now` and one `count_lines` row per **active** item, `state = 'uncounted'`.
- `save_count_line`: roles `manager`, `distributor`. `select … from counts where id = p_count_id for update`. No such count (for example, discarded) → `COUNT_NOT_OPEN`. Count not of the caller's branch → `FORBIDDEN`. Status not `draft`/`returned` → `COUNT_LOCKED`. `frozen_since is null` (returned, recount not started) → `COUNT_NOT_STARTED`. It never creates a count and never sets `frozen_since`.
  - `p_expected_revision` must equal the line's current `revision` (`STALE_WRITE`). On success the line's `revision` and the count's `revision` each increase by 1.
  - In a `returned` count only lines with `needs_recount = true` may be saved (`COUNT_LOCKED`).
  - `p_state` in (`counted`,`none`,`uncounted`). `counted`: `p_entries` is a non-empty array of `{"unit","quantity"}`, each unit active for the item, each quantity ≥ 0, no unit twice (`ENTRIES_INVALID`); `base_quantity` = Σ quantity × current rate. `none`: entries null or `[]`; `base_quantity = 0`. `uncounted`: clears entries, `base_quantity = null`.
  - This generic `entries` shape launches if the per-type rules file is late (spec section 8, "Open"). Per-type shapes arrive as a later migration that only widens validation.
  - No `p_request_id`: the revision check makes a duplicate delivery fail with `STALE_WRITE`.
  - **`STALE_WRITE` means "this save was not applied", never "already saved".** The line may hold this phone's earlier duplicate or another phone's different value; the database cannot tell which. Contract for the client (built in plan 3, fixed here): keep the employee's entry on screen, refetch the line, compare stored `state` + `entries` with what the employee intended. Equal → mark saved and adopt the new revision. Different → show both values as a conflict and let the employee choose; choosing theirs re-saves with the fresh revision. The client must never show "تم الحفظ" on `STALE_WRITE` without that comparison.
- `discard_count`: owner; lock branch; row lock; status must be `draft` or `returned` (`COUNT_NOT_OPEN`); deletes the lines and the count row, which lifts the freeze. Discarding a `returned` count throws the whole count away — the only way out of an abandoned recount; the owner screen must say so.

- [ ] **Step 1: Write the failing tests `08_count_entry.test.sql`**

| Test | Assertion |
|---|---|
| no window | `201` calls `start_count` → `WINDOW_CLOSED` |
| start creates and freezes | owner opens `BR-01`/`2026-11-01`; `start_count` → `frozen_since` not null, two lines (active items only), all `uncounted`, `revision = 0` |
| start is re-entrant | second `start_count` with a new request id → same `count_id`, same `frozen_since` |
| freeze blocks | after start, before any save: `create_purchase` by `201` → `BRANCH_FROZEN` |
| save | `D-001` rev 0, counted `[{"unit":"كرتونة","quantity":1},{"unit":"عبوة","quantity":2}]` → `base_quantity = 10500`, `line_revision = 1`, `count_revision = 1`, `counted = 1`, `total = 2` |
| **stale save rejected** | save `D-001` rev 1 with 12 `عبوة` (→ rev 2); then a late save with `p_expected_revision = 1` and 10 `عبوة` → `STALE_WRITE`; stored `base_quantity = 9000` |
| stale duplicate is also rejected | re-send the identical 12 `عبوة` save with `p_expected_revision = 1` → `STALE_WRITE`; line `revision` still 2 (the database does not guess; the client compares) |
| none state | `D-002` state `none` → `base_quantity = 0` |
| blank is not zero | `counted` with `[]` → `ENTRIES_INVALID` |
| duplicate unit | → `ENTRIES_INVALID` |
| undo | save `uncounted` → `base_quantity` null; branch still frozen |
| other branch | `202` saves into `BR-01`'s count id → `FORBIDDEN` |
| **late save after discard** | owner discards; a save with the old `count_id` → `COUNT_NOT_OPEN`; no `counts` row exists; `create_purchase` by `201` succeeds |
| close does not strand | start, owner closes the window → `save_count_line` still works; `discard_count` still works |
| duplicate open | → `WINDOW_EXISTS` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write the five functions.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): count windows, explicit start, revisioned draft entry`.

---

### Task 9: Count submit, review, baselines, zeroing

**Files:**
- Modify: `supabase/migrations/0009_rpc_counts.sql` (append; not merged until this task is done)
- Create: `supabase/tests/09_count_review.test.sql`

**Interfaces:**
- Consumes: Task 8 functions.
- Produces (each granted to `authenticated`):
  - `submit_count(p_request_id uuid, p_count_id uuid, p_expected_revision int) returns jsonb` → `{"count_id": uuid, "submitted_at": timestamptz}`.
  - `review_count(p_request_id uuid, p_count_id uuid, p_action text, p_item_ids text[] default null, p_note text default null) returns jsonb` → `{"count_id": uuid, "status": text}`. `p_action` in (`approve`,`return`).
  - `zero_branch_balance(p_request_id uuid, p_branch_id text) returns jsonb` → `{"branch_id": text, "items": int}`.

Rules:

- `submit_count`: roles `manager`, `distributor`; lock branch; row-lock the count. Not the caller's branch → `FORBIDDEN`; status not `draft`/`returned` → `COUNT_LOCKED`; `frozen_since is null` → `COUNT_NOT_STARTED`; `p_expected_revision <> counts.revision` → `STALE_WRITE` (the employee must confirm what the summary screen showed); any line `uncounted` → `COUNT_INCOMPLETE`. Sets `status = 'submitted'`, `submitted_by`, `submitted_at = v_now`, `frozen_since = null`. Sets `count_lines.effective_at = v_now` on every line when coming from `draft`; only on lines with `needs_recount = true` when coming from `returned`, then clears `needs_recount`. Works whether the window is open or closed.
- `review_count`: owner; row-lock the count; must be `submitted` (`COUNT_NOT_SUBMITTED`).
  - `approve`: one `stock_baselines` row per line, `base_quantity` = line's, `effective_at` = line's `effective_at`, `source = 'count'`, `ref_id = count_id`; status `approved`.
  - `return`: blank note → `NOTE_REQUIRED`. `p_item_ids` null → every line; otherwise only the listed lines (each must belong to the count, else `ITEM_INVALID`). Those lines get `needs_recount = true`, `state = 'uncounted'`, entries and `base_quantity` cleared, `revision + 1`. Status `returned`, `frozen_since` stays null until `start_count`.
- `zero_branch_balance`: owner; lock branch; `require_not_frozen(branch)`; one baseline of 0 per active item, `effective_at = v_now`, `source = 'owner_zero'`.
- An item activated after the count was started has no line and gets no baseline; its balance continues from movements. Accepted for launch.

- [ ] **Step 1: Write the failing tests `09_count_review.test.sql`.** Setup for each: owner opens `BR-01`/`2026-11-01`, `201` calls `start_count`. Statement order inside one test transaction is real time order because every stamp is `clock_timestamp()` taken under the branch lock; the first test proves it.

| Test | Assertion |
|---|---|
| stamps are ordered | start, save all, submit, then `create_purchase` → `purchase_in.occurred_at > submitted_at > frozen_since` (captured before submit) |
| submit incomplete | one item saved → `COUNT_INCOMPLETE` |
| submit stale | all saved (count revision 2), submit with `p_expected_revision = 1` → `STALE_WRITE` |
| submit unfreezes | submit → `frozen_since is null`; `create_purchase` succeeds; `save_count_line` → `COUNT_LOCKED` |
| approve creates baselines | `D-001` 10500, `D-002` `none`; approve → `balance(BR-01,D-001) = 10500`, `baseline_at = submitted_at`; a baseline of 0 exists for `D-002` |
| movements after submit apply | submit, purchase 1 `عبوة`, approve → balance `11250` |
| movements before the count are replaced | purchase 9000 (before `start_count`), count 10500, approve → balance `10500` |
| approve unsubmitted | → `COUNT_NOT_SUBMITTED` |
| return selected | return `{D-001}` with note → `D-001` line `uncounted` + `needs_recount`; branch **not** frozen; `save_count_line` → `COUNT_NOT_STARTED`; after `start_count` branch frozen, saving `D-002` → `COUNT_LOCKED`, saving `D-001` ok |
| recount timestamps | resubmit → `D-001.effective_at` = resubmit time, `D-002.effective_at` = first submit time; a `D-001` purchase made between the two submits is **not** in the balance after approval, a `D-002`-style movement made between them (insert a `transfer_in` via a real send + receive) **is** |
| return without note | → `NOTE_REQUIRED` |
| month rollover | count started for `2026-11-01`; owner closes that window and opens `2026-12-01`; `201` can still save and submit the November count |
| abandoned recount | return `{D-001}`, `start_count`, owner `discard_count` → no `counts` row, branch not frozen |
| discard submitted | submit, then `discard_count` → `COUNT_NOT_OPEN` |
| zero | purchases exist; owner zeroes `BR-01` → every active item `0`; a later purchase adds on top |
| zero while frozen | → `BRANCH_FROZEN` |
| manager cannot review | → `FORBIDDEN` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Append the three functions.** **Step 4: Run all tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): count submit, owner review, baselines and zeroing`.

---

### Task 10: User administration, session revocation, logout

**Files:**
- Create: `supabase/migrations/0010_rpc_users.sql`, `supabase/tests/09b_users.test.sql`

**Interfaces:**
- Produces (each granted to `authenticated`; all but `logout` are owner only):
  - `admin_create_user(p_request_id uuid, p_employee_number text, p_name text, p_role text, p_branch_id text, p_secret text) returns jsonb` → `{"user_id": uuid}`.
  - `admin_set_secret(p_request_id uuid, p_user_id uuid, p_secret text) returns jsonb`.
  - `admin_set_user_active(p_request_id uuid, p_user_id uuid, p_active boolean) returns jsonb`.
  - `admin_unlock_user(p_request_id uuid, p_user_id uuid) returns jsonb`.
  - `set_branch_feature(p_request_id uuid, p_branch_id text, p_feature_key text, p_visible boolean) returns jsonb`.
  - `logout() returns void` — revokes the caller's current `app_sessions` row.
  - Internal `app.clean_secret(p_role text, p_secret text) returns text`: manager/distributor → `normalize_digits`, then must be exactly 4 ASCII digits; owner → returned exactly as given (no normalisation), at least 12 characters; else `SECRET_WEAK`.
  - **bcrypt boundary.** bcrypt reads only the first 72 **bytes** of its input, silently, so two long passwords that differ only after byte 72 would be the same password. `clean_secret` therefore raises `SECRET_TOO_LONG` when `octet_length(p_secret) > 72` (bytes, not characters: an Arabic letter is 2 bytes, so the limit can be 36 Arabic characters). Every value passed to `extensions.crypt` in this plan — the stored hash, the request verifier in `app.request_store`, the comparison in `login_verify` — has passed this check or is refused before `crypt` is called. Add `SECRET_TOO_LONG` to the error-code list.
  - Internal `app.revoke_sessions(p_user_id uuid) returns void` — sets `revoked_at = clock_timestamp()` on every unrevoked session of the user.

Rules:

- The secret is never part of `p_params`, `rpc_requests.result` or `activity_log.details`.
- **Replay with a secret.** `admin_create_user` and `admin_set_secret` pass the cleaned secret to `request_store`, which keeps a verifier on the request row itself. When `request_replay` returns a stored result, the RPC returns it only if `app.request_secret_ok(p_request_id, clean_secret)`, else `REQUEST_ID_REUSED`. The comparison is against the original request, not the user's current hash, so a later PIN change cannot alter the answer. A replay never changes the stored PIN.
- `admin_create_user`: employee number normalised with `normalize_digits`; duplicate → `EMPLOYEE_NUMBER_TAKEN`; role/branch mismatch or unknown branch → `USER_INVALID`. `auth_user_id` stays null until first login. **Role `owner` is refused (`USER_INVALID`)**: owner accounts are not created through the app (the spec has one owner, provisioned at set-up), which also means `admin_set_secret` and `admin_set_user_active` can only ever meet an owner row that is the caller's own.
- `set_branch_feature`: unknown or inactive branch → `BRANCH_INVALID`; a feature key outside the five allowed → `FEATURE_INVALID` (new code); upserts the row.
- **Migration numbering.** This task keeps its assigned number, `0010_rpc_users.sql`, although `0009_rpc_counts.sql` (Tasks 8–9, paused) does not exist yet. A fresh database applies files in filename order, so adding 0009 later is fine locally and in CI. On a hosted project that has already had 0010 applied, an earlier-numbered file is refused by default; nothing is hosted yet, and plan 2's first task (applying migrations to `gosta-test`) must not start until 0009 exists or must apply with the out-of-order flag deliberately.
- `admin_set_secret` and `admin_set_user_active(false)` call `app.revoke_sessions` and set `credential_version = credential_version + 1`, both under the user-row lock. `admin_set_secret` also zeroes `failed_attempts` and `locked_until`. Row-lock the `app_users` row first.
- `admin_set_user_active(false)` on the caller's own row → `USER_INVALID`.
- `admin_set_secret` on an owner row is allowed only for the caller's own row; it revokes the owner's other sessions but not the calling one.

- [ ] **Step 1: Write the failing tests**

| Test | Assertion |
|---|---|
| create | owner creates `204`, manager, `BR-02`, `4444` → row exists; hash exists and `secret_hash <> '4444'` |
| Arabic-digit PIN | create `205` with `٥٥٥٥` → `crypt('5555', secret_hash) = secret_hash` |
| weak secrets | manager `12345`, manager `12a4`, owner `short` → `SECRET_WEAK` |
| **bcrypt boundary** | owner password of exactly 72 ASCII bytes → accepted, and the stored hash does **not** match the same string with its last character changed; 73 ASCII bytes → `SECRET_TOO_LONG`; 36 Arabic letters (72 bytes) → accepted; 37 Arabic letters (74 bytes, 37 characters) → `SECRET_TOO_LONG`; nothing is stored and no request row is written on refusal |
| duplicate | `201` again → `EMPLOYEE_NUMBER_TAKEN` |
| role/branch mismatch | → `USER_INVALID` |
| not owner | `201` calls any admin RPC → `FORBIDDEN` |
| reset revokes | owner resets `201` → every `app_sessions` row of `201` has `revoked_at`; `test.act_as('201')`; `app.session_ok()` = false; `send_transfer` → `NOT_AUTHENTICATED` |
| **reset then new session** | after the reset, insert a second `app_sessions` row for `201` (a new login); the seeded session is still refused, the new one is accepted |
| deactivate revokes | same assertions after `admin_set_user_active(false)` |
| self-deactivate | → `USER_INVALID` |
| logout | `test.act_as('202')`; `select logout()`; `app.session_ok()` = false |
| secret replay | `admin_set_secret` twice with the same id and PIN → same result; same id, different PIN → `REQUEST_ID_REUSED` and the stored hash still matches the first PIN |
| **secret replay after an intervening change** | request A sets `201` to `1111`; request B sets it to `2222`; retry A with `1111` → A's stored result, and the user's hash **still matches `2222`**, `credential_version` unchanged by the retry; reuse A's id with `2222` → `REQUEST_ID_REUSED` |
| version advances | `credential_version` goes up by 1 on each real `admin_set_secret` and on deactivation, and not on `admin_unlock_user` |
| secret not leaked | no `rpc_requests` row (`result::text`, `request_hash`, `secret_verifier`) or `activity_log.details::text` contains `4444` |
| feature toggle | hide `purchase` for `BR-01` → `create_purchase` by `201` raises `FEATURE_HIDDEN` |

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0010_rpc_users.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): user administration, per-session revocation, logout`.

---

### Task 11: Login verification in the database

**Files:**
- Create: `supabase/migrations/0011_login.sql`, `supabase/migrations/0012_owner_session_recheck.sql`, `supabase/tests/10_login.test.sql`, `supabase/tests-concurrency/owner_password_test.ts`
- Modify: `supabase/tests-concurrency/helpers.ts` (add what the new two-connection test needs)

**Interfaces:**
- Produces (in `public`, each granted to `service_role` **only**):
  - `login_verify(p_employee_number text, p_secret text) returns jsonb` — never raises for a bad credential. Returns `{"ok": true, "user_id": uuid, "auth_user_id": uuid|null, "employee_number": text, "credential_version": int}` or `{"ok": false, "reason": "invalid"|"locked", "locked_until": timestamptz|null}`.
  - `login_attach_auth_user(p_user_id uuid) returns uuid` — finds `auth.users` by `email = <employee_number>@gosta.invalid`; if the app row's `auth_user_id` is null, sets it; returns the app row's `auth_user_id` (null when no such Auth user exists). Row-locks the `app_users` row, so concurrent calls agree.
  - `login_register_session(p_user_id uuid, p_session_id uuid, p_credential_version int) returns void` — `select … for update` the user row, then raises `USER_INVALID` if the user is missing, inactive, or `credential_version <> p_credential_version` (the secret was reset, or the user deactivated, after this login was verified). Otherwise inserts `app_sessions` with `expires_at = clock_timestamp() + interval '7 days'`; `on conflict (session_id) do nothing`. Because reset and registration take the same row lock, a login is either registered before the reset (and revoked by it) or refused after it.

Rules:

- The employee number is always normalised with `normalize_digits`. The secret is normalised only when the matched user's role is not `owner`; an owner password is compared exactly as typed.
- Unknown number, inactive user and wrong secret all return `reason: "invalid"`. For an unknown number run one `crypt()` against a fixed dummy hash so timing does not reveal existence.
- `select … for update` the user row. If `locked_until > clock_timestamp()` → `locked`, without checking the secret and without counting.
- Wrong secret: `failed_attempts += 1`; on reaching 5 set `locked_until = clock_timestamp() + interval '15 minutes'`, reset `failed_attempts = 0`.
- Correct secret: `failed_attempts = 0`, `locked_until = null`; then call `login_attach_auth_user` so a half-finished earlier provisioning is repaired here. It does not create a session.
- Every call writes `activity_log` with `LOGIN_OK`, `LOGIN_FAILED` or `LOGIN_LOCKED`; `details` holds the employee number, never the secret.
- **bcrypt boundary.** A submitted secret with `octet_length > 72` is treated as a wrong secret (`invalid`, counted towards lockout, dummy-hash timing preserved) and is never passed to `extensions.crypt`: otherwise a 73-byte guess whose first 72 bytes match would log in.

- [ ] **Step 1: Write the failing tests `10_login.test.sql`** (after `test.act_as_service()` unless stated)

| Test | Assertion |
|---|---|
| ok | `('201','1111')` → `ok = true`, `user_id` matches; no new `app_sessions` row |
| Arabic digits, staff | `('٢٠١','١١١١')` → ok |
| owner password exact | `('100','correct horse battery')` → ok; `('100','1111')` → `invalid`. Set the owner's password to `كلمة سر ١٢٣٤٥٦` via `admin_set_secret`; that exact string → ok; the same with `123456` in Latin digits → `invalid` |
| wrong / unknown / inactive | `('201','0000')`, `('999','1111')`, `('299','1111')` → all `invalid` |
| **bcrypt boundary** | set the owner's password to a 72-byte string P; `login_verify('100', P)` → ok; `login_verify('100', P || 'x')` (73 bytes, first 72 identical) → `invalid`; a 200-byte secret for `201` → `invalid`, no error |
| lockout | five wrong for `202` → fifth returns `locked`, `locked_until` ≈ +15 min; the right PIN now → `locked` |
| lock expires | set `locked_until` to the past → right PIN → ok |
| success resets counter | four wrong, one right, four wrong → not locked |
| logged | three `activity_log` rows for three attempts, none containing the secret |
| attach repairs | create user `206` (no Auth user); insert an `auth.users` row with email `206@gosta.invalid`; `login_verify('206', pin)` → `auth_user_id` equals that row's id |
| attach is stable | `login_attach_auth_user` twice → same id; a second `auth.users` row cannot be attached to an already attached user |
| register session | `login_register_session(user, gen_random_uuid(), <version from login_verify>)` → one row expiring ≈ +7 days; for inactive `299` → `USER_INVALID` |
| **missing credential version** | `login_register_session(user, gen_random_uuid(), null)` → `USER_INVALID`, no session row; null user id and null session id → `USER_INVALID`; a version one lower and one higher than the current one → `USER_INVALID` |
| leading zeros | create users `0204` and `204` with different PINs; each logs in only with its own number and PIN; `login_verify('204', <PIN of 0204>)` → `invalid` |
| **login in flight during a reset** | `login_verify('201','1111')` → version v; as owner `admin_set_secret('201', '7777')`; as service `login_register_session(user, new id, v)` → `USER_INVALID`; `201` has no unrevoked session |
| login in flight during a deactivation | same with `admin_set_user_active(false)` → `USER_INVALID` |
| not callable by clients | `test.act_as('201')`; each of the three functions → `42501` |
| server role keeps execute | `has_function_privilege('service_role', …, 'execute')` is true for each of the three functions, and one of them is actually called after `test.act_as_service()` (deferred from Task 1 by the owner: first server-only functions) |

- **Owner additions (2026-11-12).**
  - **Missing credential version.** `login_register_session` raises `USER_INVALID` when `p_credential_version` is null (a null would otherwise compare as "unknown" and slip past a `<>` test), and likewise for a null `p_user_id` or `p_session_id`. Tested next to the stale-version cases.
  - **Leading zeros are kept.** Employee numbers are compared as text after digit normalisation only: `0204` and `204` are different users, at login exactly as at creation (Task 10 decision, unchanged).
  - **Follow-up migration `0012_owner_session_recheck.sql`.** As accepted in 0010, `admin_set_secret` checks the caller's session before it waits for the target row lock. When the owner changes their own password from session S2, S2 revokes the owner's other session S1 under that lock; a request from S1 that was already waiting then went on to change the password although S1 had just been revoked. 0012 re-creates `public.admin_set_secret` (same signature, attributes, grants and behaviour; 0010 is not edited) with one addition: immediately after the `select … for update` on the target row it calls `app.current_app_user()` again, so a caller whose session was revoked while it waited is refused with `NOT_AUTHENTICATED` and nothing is written. For a self-change the row locked is the caller's own row, which is exactly the lock a concurrent revocation holds, so the recheck is exact; for other targets it is a best-effort second look.
  - **Two-connection regression `owner_password_test.ts`:** owner with two live sessions S1 and S2 (the second inserted and committed by the test, removed afterwards). A (as S2): `begin`, `admin_set_secret(own id, P2)`, not yet committed. B (as S1): `begin`, `admin_set_secret(own id, P3)` → shown to be waiting on a lock. A commits. Assert: B fails with `NOT_AUTHENTICATED`; the stored hash matches P2 and not P3; `credential_version` rose by exactly 1; S1 is revoked and S2 is not. The test restores the owner's original hash, version and sessions before it ends, so later suites can still log the owner in. RED is shown against the database without 0012: B succeeds and the password is P3.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Write `0011_login.sql`.** **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): login verification, lockout, session registration`.

---

### Task 12: Login Edge Function

**Files:**
- Create: `supabase/functions/login/index.ts`, `derive.ts`, `derive_test.ts`, `login_integration_test.ts`
- Modify: `.github/workflows/test.yml`, `supabase/config.toml` (`[functions.login] verify_jwt = false`)

**Interfaces:**
- Consumes: `login_verify`, `login_attach_auth_user`, `login_register_session`.
- Produces:
  - `deriveAuthPassword(secret: string, userId: string): Promise<string>` — lowercase hex HMAC-SHA-256 of `userId` keyed by `secret` (64 chars).
  - `sessionIdFromJwt(accessToken: string): string` — the `session_id` claim of the payload; throws if absent.
  - `POST /functions/v1/login`, body `{"employee_number": string, "secret": string}`.
    - 200 `{"access_token","refresh_token","expires_at","user":{"id","name","role","branch_id"}}`
    - 401 `{"error":"INVALID_CREDENTIALS"}`
    - 423 `{"error":"LOCKED","locked_until": ISO string}`
    - 400 `{"error":"BAD_REQUEST"}` for a missing/non-string field or a body over 1 KB
    - 500 `{"error":"SERVER_ERROR"}` with no detail
    - CORS: `OPTIONS` handled; `Access-Control-Allow-Origin` = env `APP_ORIGIN`.
  - Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `AUTH_DERIVE_SECRET` (≥ 32 random bytes), `APP_ORIGIN`.

Flow, every step safe to repeat:

1. `login_verify`. Not ok → 401 / 423.
2. If `auth_user_id` is null: `auth.admin.createUser({ email, password: derived, email_confirm: true })`. An "already registered" error is **not** a failure (an earlier attempt or a simultaneous login got there first). Then `login_attach_auth_user(user_id)`; a null result → 500.
3. If the user was attached in this request, `auth.admin.updateUserById(auth_user_id, { password: derived })` — the Auth user found by email is only trusted after its password is set to ours.
4. Anon client `signInWithPassword(email, derived)`. On failure for an existing user (derive secret rotated), do step 3 once and retry.
5. `login_register_session(user_id, sessionIdFromJwt(access_token), credential_version)` with the version from step 1. If it raises `USER_INVALID`, sign the just-created Auth session out with the admin API (best effort) and return 401 `INVALID_CREDENTIALS`; the unregistered token is useless either way.
6. Return the session. The service-role key and the derived password never appear in a response or log line.

- [ ] **Step 1: Write the failing unit tests `derive_test.ts`**

```ts
Deno.test("deriveAuthPassword is deterministic, 64 hex chars, depends on both inputs", async () => {
  const a = await deriveAuthPassword("k1", "u1");
  assertEquals(a, await deriveAuthPassword("k1", "u1"));
  assertMatch(a, /^[0-9a-f]{64}$/);
  assertNotEquals(a, await deriveAuthPassword("k2", "u1"));
  assertNotEquals(a, await deriveAuthPassword("k1", "u2"));
});
Deno.test("sessionIdFromJwt reads the claim and rejects a token without it", () => {
  const jwt = (p: object) => `x.${btoa(JSON.stringify(p)).replace(/=+$/, "")}.y`;
  assertEquals(sessionIdFromJwt(jwt({ session_id: "abc" })), "abc");
  assertThrows(() => sessionIdFromJwt(jwt({ sub: "u" })));
});
```

- [ ] **Step 2: Run `deno test supabase/functions/login/derive_test.ts`.** Expected: FAIL. **Step 3: Implement `derive.ts`** (Web Crypto; base64url-safe decode). **Step 4: Run.** Expected: PASS.

- [ ] **Step 5: Write the failing integration test `login_integration_test.ts`.** Runs against `supabase start` + `supabase functions serve`, after `supabase db reset`. Run with `deno test --allow-net=127.0.0.1 --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY` — no `-A`.

| Test | Assertion |
|---|---|
| good PIN | `201`/`1111` → 200; with `access_token`, `select` from `purchases` returns 200 and `rpc/send_transfer` with a valid body returns a `transfer_id` |
| first login provisions | owner creates `207` via `rpc/admin_create_user`; login → 200; second login → 200; exactly one Auth user with that email |
| **interrupted provisioning** | owner creates `208`; with the service key create an Auth user `208@gosta.invalid` with a random password and do **not** attach it; login `208` → 200 |
| **simultaneous first logins** | owner creates `209`; `Promise.all` of two logins → both 200; one Auth user; `app_users.auth_user_id` set |
| wrong PIN | → 401 `INVALID_CREDENTIALS`; body has no other keys |
| lockout | five wrong for `202` → 423 with `locked_until` |
| **reset, re-login, old tokens** | login `201` → tokens A. Owner `rpc/admin_set_secret` to `7777`. Login `201`/`7777` → tokens B (200). Then: access token A reads zero rows from `items` and gets `NOT_AUTHENTICATED` from an RPC; refreshing with refresh token A, if GoTrue still issues a token, yields one that is refused the same way; tokens B work |
| logout | `rpc/logout` with tokens B → the same access token is refused afterwards |
| registration refused end to end | with the service key call `login_verify` for `202`, then `admin_set_secret` as owner, then `login_register_session` with the stale version → error; a token obtained by signing in directly against Auth for `202` (derived password) but never registered reads zero rows from `items` |
| bad body | `{}` → 400 |

- [ ] **Step 6: Run.** Expected: FAIL (404). **Step 7: Implement `index.ts`.** **Step 8: Run.** Expected: PASS.
- [ ] **Step 9: Update the workflow** (`supabase start`, `supabase functions serve` in the background with an env file holding `AUTH_DERIVE_SECRET` and `APP_ORIGIN`, then the integration test). Push; confirm CI is green.
- [ ] **Step 10: Commit** — `feat: login edge function with per-session registration`.

---

### Task 13: Concurrency tests on two real connections

**Files:**
- Create: `supabase/tests-concurrency/concurrency_test.ts`
- Modify: `supabase/tests-concurrency/helpers.ts` (created in Task 3 with `connect()`; add the rest here)
- Modify: `.github/workflows/test.yml` (run after `supabase db reset`: `deno test --allow-net=127.0.0.1:54322 --allow-env supabase/tests-concurrency/`)

**Interfaces:**
- Consumes: every RPC; `test.act_as`. pgTAP runs each file in one transaction and cannot overlap two; these tests use `npm:postgres` with two connections to `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. They commit data, so they use only `BR-03` / user `203` / the owner / `BR-14` as sender, fresh request ids, and assert on their own rows.
- Produces in `helpers.ts`:
  - `connect(): Sql` — one dedicated connection (`max: 1`).
  - `begin(sql: Sql, employeeNumber: string): Promise<void>` — `begin` then `select test.act_as($1)`.
  - `rpc(sql: Sql, name: string, args: Record<string, unknown>): Promise<{ ok: unknown } | { error: string }>` — returns the Postgres error message as `error` instead of throwing.
  - `overlap(a: () => Promise<T>, b: () => Promise<U>, commitA: () => Promise<void>): Promise<[T, U]>` — starts `a` and awaits it, starts `b` without awaiting, polls `pg_stat_activity` on a third connection until `b`'s backend has `wait_event_type = 'Lock'` (fail the test after 5 s if it never blocks), then runs `commitA` and awaits `b`.

- [ ] **Step 1: Write the tests.** Each one: A opens a transaction and runs its RPC, B's RPC is shown to block, A commits, B finishes and commits.

| Test | A | B | Assertion |
|---|---|---|---|
| double receipt | `203` receives transfer T | `203` receives T (new request id) | one `ok`, one `LINE_NOT_PENDING`; one `transfer_in` per line |
| receipt vs owner deny | `203` receives T2 short by half | owner `deny` on the same line | B → `LINE_NOT_PENDING`; source net for the line = `−received_base_quantity`. Run again with A and B swapped: A → line `denied`, B → `LINE_NOT_PENDING`, source net = 0 |
| two purchase edits | owner edits line 100 → 80 `مل` | owner edits the same line → 60 `مل` | both ok; line `base_quantity = 60`; Σ `stock_movements` for that line's `ref_id` = 60; two history rows whose `old_values` are 100 then 80 |
| edit vs void | owner edits 100 → 80 | owner voids | B ok; line voided; Σ movements = 0. Swapped: A voids, B → `LINE_VOIDED`; Σ = 0 |
| same request id twice | `203` `create_purchase` with id R | same call, same id R | both return the same `purchase_id`; one purchase row |
| start of count vs purchase | `203` `start_count` | `203` `create_purchase` | B → `BRANCH_FROZEN`; no purchase row |
| purchase vs start of count | `203` `create_purchase` | `203` `start_count` | both ok; `purchase_in.occurred_at < counts.frozen_since` |
| **purchase that began before submission** | on connection A: `begin`, `select now()` (pins the transaction start), do nothing else yet | on connection B (no overlap helper): `203` saves all lines, `submit_count`, commit | then A calls `create_purchase` and commits → ok; `purchase_in.occurred_at > ` every line's `effective_at`; after the owner approves, `balance(BR-03, D-001)` = counted quantity + purchased quantity |

- [ ] **Step 2: Run** `supabase db reset && deno test … supabase/tests-concurrency/`. Expected: PASS. A failure here is a locking or clock bug in the RPC named in the row: fix it in that RPC's migration (not yet merged) and re-run all suites.
- [ ] **Step 3: Sabotage check, once, not committed:** remove `for update` from `edit_purchase_line`, confirm "two purchase edits" fails with a ledger sum of 40, restore it. This proves the test can see the bug it exists for.
- [ ] **Step 4: Commit** — `test(db): two-connection concurrency suite`.

---

### Task 14: Whole-ledger reconciliation test

**Files:**
- Create: `supabase/tests/20_reconciliation.test.sql`

**Interfaces:**
- Consumes: every RPC above. Produces no new code.

- [ ] **Step 1: Write the test.** Through RPCs only, as the proper users, on `BR-01`, `BR-02`, `BR-14`: three sends from `BR-14` (one received in full, one short, one denied by the owner), one `BR-01 → BR-02` send left pending, two purchases (one edited, one voided), a full count of `BR-01` started, saved, submitted and approved, one more send and receipt after the count, and one conversion-rate change between a send and its "as sent" receipt. Restrict every assertion to those three branches. Then assert:

```sql
-- 1. Conservation: total stock across the three branches equals
--    non-voided purchases minus quantity still in transit, ignoring baselines.
select is(
  (select coalesce(sum(base_quantity),0) from stock_movements where item_id = 'D-001' and branch_id in ('BR-01','BR-02','BR-14')),
  (select coalesce(sum(pl.base_quantity),0) from purchase_lines pl join purchases p on p.id = pl.purchase_id
     where pl.item_id = 'D-001' and pl.voided_at is null and p.branch_id in ('BR-01','BR-02','BR-14'))
  - (select coalesce(sum(tl.base_quantity),0) from transfer_lines tl join transfers t on t.id = tl.transfer_id
     where tl.item_id = 'D-001' and tl.status = 'pending' and t.from_branch in ('BR-01','BR-02','BR-14')));
-- 2. Every received line: exactly one transfer_in equal to received_base_quantity (none when it is 0).
-- 3. Every line's net effect at the source: -received_base_quantity (received), 0 (denied), -base_quantity (pending).
-- 4. Every purchase line: sum of its movements = base_quantity, or 0 when voided.
-- 5. No stock_movements row has a ref_id pointing at a missing row.
-- 6. balances for BR-01 equals the approved count plus movements after each line's effective_at,
--    computed independently in the test with a plain query.
```

Write assertions 2–6 as `is()` / `is_empty()` checks in the same style.

- [ ] **Step 2: Run `supabase db reset && supabase test db`.** Expected: PASS. A failing assertion means a bug in an RPC from Tasks 6–9: fix it there with a targeted test in that task's file.
- [ ] **Step 3: Commit** — `test(db): whole-ledger reconciliation`.

---

## Done means

- `supabase db reset && supabase test db`, both Deno suites under `supabase/functions/`, and `supabase/tests-concurrency/` pass locally and in CI.
- Effective function privileges are closed. Add to `05_rls.test.sql` once all migrations exist, and keep it last:

```sql
-- every function clients can execute is on this list, and nothing else is
select set_eq(
  $$select p.pronamespace::regnamespace || '.' || p.proname from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))$$,
  array['app.session_ok','app.my_role','app.my_branch',
        'public.send_transfer','public.receive_transfer','public.owner_resolve_transfer_line',
        'public.create_purchase','public.edit_purchase_line','public.void_purchase_line',
        'public.open_count_window','public.close_count_window','public.start_count','public.save_count_line',
        'public.discard_count','public.submit_count','public.review_count','public.zero_branch_balance',
        'public.admin_create_user','public.admin_set_secret','public.admin_set_user_active','public.admin_unlock_user',
        'public.set_branch_feature','public.logout']);
select is_empty(
  $$select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
      and has_function_privilege('anon', p.oid, 'execute')$$, 'anon can execute nothing');
```

- Nothing has been applied to `gosta-test` or `gosta-live`. Applying migrations to real projects is the first task of plan 2 and needs the owner's access (spec section 14). At that point confirm on the hosted project: public sign-ups disabled, and the `postgres` role can read `auth.users` (required by `login_attach_auth_user`).
