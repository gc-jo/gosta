-- Table grants and row-level security.
-- Clients (authenticated) get select through RLS and nothing else; anon gets
-- nothing. No insert/update/delete policy exists anywhere. Every write goes
-- through a security definer RPC. Creates no functions.

-- 1. Close everything ----------------------------------------------------
-- On a real Supabase project, default privileges give anon, authenticated and
-- service_role ALL on everything postgres creates in public, so the tables of
-- 0001-0004 are open until revoked here. service_role is left as it is.
revoke all on all tables in schema public from anon, authenticated;     -- includes views
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- 2. Row-level security on every table -----------------------------------
alter table branches                enable row level security;
alter table items                   enable row level security;
alter table item_units              enable row level security;
alter table suppliers               enable row level security;
alter table supplier_items          enable row level security;
alter table allowed_local_purchases enable row level security;
alter table branch_features         enable row level security;
alter table app_users               enable row level security;
alter table app_user_secrets        enable row level security;
alter table app_sessions            enable row level security;
alter table transfers               enable row level security;
alter table transfer_lines          enable row level security;
alter table purchases               enable row level security;
alter table purchase_lines          enable row level security;
alter table purchase_line_history   enable row level security;
alter table count_windows           enable row level security;
alter table counts                  enable row level security;
alter table count_lines             enable row level security;
alter table stock_movements         enable row level security;
alter table stock_baselines         enable row level security;
alter table activity_log            enable row level security;
alter table rpc_requests           enable row level security;

-- 3. Grants and policies --------------------------------------------------
-- Every condition requires a valid session. my_role() and my_branch() are null
-- when the session is not ok, so null never grants (no "is distinct from",
-- no "not (...)" around them).

-- reference data: any valid session
grant select on branches, items, item_units, suppliers, supplier_items to authenticated;
create policy branches_select       on branches       for select to authenticated using ((select app.session_ok()));
create policy items_select          on items          for select to authenticated using ((select app.session_ok()));
create policy item_units_select     on item_units     for select to authenticated using ((select app.session_ok()));
create policy suppliers_select      on suppliers      for select to authenticated using ((select app.session_ok()));
create policy supplier_items_select on supplier_items for select to authenticated using ((select app.session_ok()));

-- per-branch tables: owner, or the caller's own branch
grant select on allowed_local_purchases, branch_features, count_windows, counts,
                stock_movements, stock_baselines, purchases to authenticated;
create policy allowed_local_purchases_select on allowed_local_purchases for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy branch_features_select on branch_features for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy count_windows_select on count_windows for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy counts_select on counts for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy stock_movements_select on stock_movements for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy stock_baselines_select on stock_baselines for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));
create policy purchases_select on purchases for select to authenticated
  using ((select app.session_ok()) and ((select app.my_role()) = 'owner' or branch_id = (select app.my_branch())));

-- transfers: owner, or either end of the transfer
grant select on transfers to authenticated;
create policy transfers_select on transfers for select to authenticated
  using ((select app.session_ok())
         and ((select app.my_role()) = 'owner' or (select app.my_branch()) in (from_branch, to_branch)));

-- child tables: a row is visible when its parent row is visible. These policies
-- rely on the parent table's own policy: the subquery is itself filtered by RLS.
-- transfer_lines: every column except cost_total. A receiving branch must not learn
-- the sender's cost. Consequence, by design: `select * from transfer_lines` fails with
-- 42501 for clients; they must list columns. Cost is exposed by transfer_line_costs.
grant select (id, transfer_id, item_id, quantity, unit, unit_rate, base_quantity, status,
              received_quantity, received_unit, received_unit_rate, received_base_quantity,
              diff_reason, note, resolved_by, resolved_at, resolved_by_owner)
  on transfer_lines to authenticated;
create policy transfer_lines_select on transfer_lines for select to authenticated
  using (exists (select 1 from transfers p where p.id = transfer_lines.transfer_id));
grant select on purchase_lines to authenticated;
create policy purchase_lines_select on purchase_lines for select to authenticated
  using (exists (select 1 from purchases p where p.id = purchase_lines.purchase_id));
grant select on count_lines to authenticated;
create policy count_lines_select on count_lines for select to authenticated
  using (exists (select 1 from counts p where p.id = count_lines.count_id));

-- app_users: the owner sees everyone, anyone else only their own row
grant select on app_users to authenticated;
create policy app_users_select on app_users for select to authenticated
  using ((select app.session_ok())
         and ((select app.my_role()) = 'owner' or auth_user_id = (select auth.uid())));

-- owner only
grant select on purchase_line_history, activity_log to authenticated;
create policy purchase_line_history_select on purchase_line_history for select to authenticated
  using ((select app.session_ok()) and (select app.my_role()) = 'owner');
create policy activity_log_select on activity_log for select to authenticated
  using ((select app.session_ok()) and (select app.my_role()) = 'owner');

-- app_user_secrets, app_sessions, rpc_requests: RLS on, no grant, no policy.
-- (backup_runs does not exist yet; a later plan creates and secures it.)

-- 4. Views -------------------------------------------------------------------
-- transfer_line_costs: the sender's cost. Owned by postgres and not security
-- invoker, so it reads transfer_lines past the column grant and past RLS; the
-- where clause is therefore the whole access rule.
create view transfer_line_costs with (security_invoker = false) as
select l.id as line_id, l.cost_total
from transfer_lines l
join transfers t on t.id = l.transfer_id
where (select app.session_ok())
  and ((select app.my_role()) = 'owner' or t.from_branch = (select app.my_branch()));
grant select on transfer_line_costs to authenticated;

-- balances: same columns and arithmetic as 0004, plus a row filter. Reference
-- tables are readable by any valid session, so without the filter a manager would
-- get a zero row for every other branch. Owner sees every branch; anyone else only
-- their own; no valid session, no rows. security_invoker keeps the caller's RLS
-- on branches, items, stock_baselines and stock_movements applying as well.
create or replace view balances with (security_invoker = true) as
select b.id as branch_id,
       i.id as item_id,
       coalesce(bl.base_quantity, 0) + coalesce((
         select sum(m.base_quantity)
         from stock_movements m
         where m.branch_id = b.id and m.item_id = i.id
           and (bl.effective_at is null or m.occurred_at > bl.effective_at)
       ), 0) as base_quantity,
       bl.effective_at as baseline_at
from branches b
cross join items i
left join lateral (
  select s.base_quantity, s.effective_at
  from stock_baselines s
  where s.branch_id = b.id and s.item_id = i.id
  order by s.effective_at desc, s.seq desc
  limit 1
) bl on true
where b.active and i.active
  and (select app.session_ok())
  and ((select app.my_role()) = 'owner' or b.id = (select app.my_branch()));
grant select on balances to authenticated;
