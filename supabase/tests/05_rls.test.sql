begin;
select plan(80);

-- fixtures (as postgres) ---------------------------------------------------
insert into purchases(id, request_id, branch_id, supplier_id, created_by) values
  ('a0000000-0000-4000-8000-000000000001', gen_random_uuid(), 'BR-01', 'S-01', (select id from app_users where employee_number = '201')),
  ('a0000000-0000-4000-8000-000000000002', gen_random_uuid(), 'BR-02', 'S-01', (select id from app_users where employee_number = '202'));
insert into purchase_lines(id, purchase_id, item_id, quantity, unit, unit_rate, base_quantity, cost_total) values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'D-001', 1, 'مل', 1, 1, 2),
  ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'D-001', 1, 'مل', 1, 1, 2);
insert into purchase_line_history(purchase_line_id, changed_by, action, old_values)
  values ('a1000000-0000-4000-8000-000000000001', (select id from app_users where employee_number = '201'), 'void', '{}');
insert into transfers(id, request_id, from_branch, to_branch, created_by)
  values ('a2000000-0000-4000-8000-000000000001', gen_random_uuid(), 'BR-14', 'BR-01', (select id from app_users where employee_number = '301'));
insert into transfer_lines(id, transfer_id, item_id, quantity, unit, unit_rate, base_quantity, cost_total)
  values ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'D-001', 1, 'مل', 1, 1, 12.5);
select test.freeze('BR-01'); select test.freeze('BR-02');
insert into count_lines(count_id, item_id)
  select id, 'D-001' from counts where branch_id in ('BR-01', 'BR-02');
insert into activity_log(user_id, action) values ((select id from app_users where employee_number = '100'), 'fixture');
-- ledger: BR-02/D-001 +500; BR-01/D-001 +9000 -1500; BR-02/D-002 baseline 40 then +10 later
insert into stock_movements(branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at) values
  ('BR-02', 'D-001',  500, 'purchase_in',  'purchase_lines',  gen_random_uuid(), '2026-11-01 10:00+03'),
  ('BR-01', 'D-001', 9000, 'purchase_in',  'purchase_lines',  gen_random_uuid(), '2026-11-01 10:00+03'),
  ('BR-01', 'D-001',-1500, 'transfer_out', 'transfer_lines',  gen_random_uuid(), '2026-11-02 10:00+03'),
  ('BR-02', 'D-002',   10, 'purchase_in',  'purchase_lines',  gen_random_uuid(), '2026-11-04 10:00+03');
insert into stock_baselines(branch_id, item_id, base_quantity, effective_at, source)
  values ('BR-02', 'D-002', 40, '2026-11-03 10:00+03', 'count');

-- manager 201 (BR-01) -------------------------------------------------------
select test.act_as('201');
select is((select count(*) from purchases), 1::bigint, 'manager sees only own branch purchases');
select is((select count(*) from transfers), 1::bigint, 'receiver sees transfer addressed to it');
select throws_ok('select cost_total from transfer_lines', '42501');
select throws_ok('select * from transfer_lines', '42501', null, 'select * on transfer_lines is refused by design (cost_total column)');
select is((select count(*) from transfer_lines), 1::bigint, 'receiver sees the line through the column list');
select is((select count(*) from transfer_line_costs), 0::bigint, 'receiver cannot see sender cost');
select is((select count(*) from app_users), 1::bigint, 'manager sees only own app_users row');
select throws_ok('select * from app_user_secrets', '42501');
select throws_ok('select * from app_sessions', '42501');
select throws_ok('select * from rpc_requests', '42501');
select throws_ok($$insert into purchases(branch_id,supplier_id) values ('BR-01','S-01')$$, '42501');
select is((select count(*) from items), 3::bigint, 'reference table readable by a valid session');
select is((select count(*) from branches), 6::bigint, 'branches readable by a valid session');
select is((select count(*) from item_units), 6::bigint, 'item_units readable');
select is((select count(*) from suppliers), 2::bigint, 'suppliers readable');
select is((select count(*) from supplier_items), 2::bigint, 'supplier_items readable');
select is((select count(*) from allowed_local_purchases), 1::bigint, 'allowed_local_purchases: own branch only');
select is((select count(*) from branch_features), 5::bigint, 'branch_features: own branch only');
select is((select count(*) from count_windows), 1::bigint, 'count_windows: own branch only');
select is((select count(*) from counts), 1::bigint, 'counts: own branch only');
select is((select count(*) from count_lines), 1::bigint, 'count_lines follow the visible count');
select is((select count(*) from purchase_lines), 1::bigint, 'purchase_lines follow the visible purchase');
select is((select count(*) from stock_movements where branch_id = 'BR-02'), 0::bigint, 'other branch movements invisible');
select is((select count(*) from stock_movements), 2::bigint, 'own movements visible');
select is((select count(*) from stock_baselines), 0::bigint, 'other branch baselines invisible');
select is((select count(*) from purchase_line_history), 0::bigint, 'purchase_line_history is owner-only');
select is((select count(*) from activity_log), 0::bigint, 'activity_log is owner-only');
-- clients never write, whatever the group
select throws_ok($$insert into items(id,name_ar,base_unit,item_type,sort_order) values ('X','x','مل','syrup',9)$$, '42501', null, 'reference: no insert');
select throws_ok($$update purchases set supplier_id = 'S-02'$$, '42501', null, 'operations: no update');
select throws_ok($$delete from stock_movements$$, '42501', null, 'ledger: no delete');
select throws_ok($$truncate activity_log$$, '42501', null, 'log: no truncate');
select throws_ok($$update app_users set role = 'owner'$$, '42501', null, 'users: no update');
select ok(not has_table_privilege('authenticated', 'public.balances', 'insert,update,delete')
      and not has_table_privilege('authenticated', 'public.transfer_line_costs', 'insert,update,delete'), 'views: read-only for clients');
-- balances: own branch only
select is((select count(*) from balances where branch_id = 'BR-02'), 0::bigint, 'manager gets no balances rows for another branch');
select is((select count(*) from balances where branch_id <> 'BR-01'), 0::bigint, 'manager gets no balances rows outside own branch');
select is((select array_agg(item_id order by item_id) from balances), array['D-001','D-002'], 'own rows are exactly the active items of own branch');
select is((select base_quantity from balances where item_id = 'D-001'), 7500::numeric, 'own D-001 balance');
select is(test.balance('BR-02', 'D-001'), 500::numeric, 'test.balance reads the true ledger while acting as a manager');

-- leak probes: a caller's cheap function must not see rows the view filters out.
-- The temp table and function are created by the caller itself (authenticated has TEMP).
create temp table seen(src text, v numeric);
create function pg_temp.leak_cost(numeric) returns boolean language plpgsql cost 0.0000001
  as $f$ begin insert into seen values ('cost', $1); return true; end $f$;
create function pg_temp.leak_qty(numeric) returns boolean language plpgsql cost 0.0000001
  as $f$ begin insert into seen values ('qty', $1); return true; end $f$;
select is((select count(*) from transfer_line_costs where pg_temp.leak_cost(cost_total)), 0::bigint, 'leak probe on transfer_line_costs runs');
select is_empty($$select 1 from seen where src = 'cost'$$, 'transfer_line_costs: no cost_total reaches a caller function before the filter');
select is((select count(*) from balances where pg_temp.leak_qty(base_quantity)), 2::bigint, 'leak probe on balances runs');
select is_empty($$select 1 from seen where src = 'qty' and v in (500, 50)$$, 'balances: no other-branch quantity reaches a caller function');

-- manager 202 (BR-02) ----------------------------------------------------------
select test.act_as('202');
select is((select count(*) from transfers), 0::bigint, 'uninvolved branch sees nothing');
select is((select base_quantity from balances where branch_id = 'BR-02' and item_id = 'D-001'), 500::numeric, 'BR-02 manager sees own D-001');
select is((select count(*) from balances where branch_id = 'BR-01'), 0::bigint, 'BR-02 manager sees nothing for BR-01');
select is((select count(*) from (select id, transfer_id, item_id from transfer_lines) l), 0::bigint, 'uninvolved branch sees no transfer lines');
select is((select count(*) from transfer_line_costs), 0::bigint, 'uninvolved branch sees no costs');

-- distributor 301 (BR-14) --------------------------------------------------------
select test.act_as('301');
select is((select cost_total from transfer_line_costs), 12.5::numeric, 'sender sees own cost');

-- owner ----------------------------------------------------------------------------
select test.act_as('100');
select is((select count(*) from purchases), 2::bigint, 'owner sees all');
select is((select count(*) from app_users), 7::bigint, 'owner sees all users');
select is((select count(*) from stock_movements), 4::bigint, 'owner sees every movement');
select is((select count(*) from purchase_line_history), 1::bigint, 'owner reads purchase_line_history');
select is((select count(*) from activity_log), 1::bigint, 'owner reads activity_log');
select is((select cost_total from transfer_line_costs), 12.5::numeric, 'owner sees cost');
select is((select base_quantity from balances where branch_id = 'BR-02' and item_id = 'D-001'), 500::numeric, 'owner sees BR-02/D-001 = 500');
select is((select base_quantity from balances where branch_id = 'BR-02' and item_id = 'D-002'), 50::numeric, 'owner sees BR-02/D-002 = baseline 40 + later 10');
select isnt((select baseline_at from balances where branch_id = 'BR-02' and item_id = 'D-002'), null, 'baseline_at set');
select is((select base_quantity from balances where branch_id = 'BR-01' and item_id = 'D-001'), 7500::numeric, 'owner sees BR-01/D-001 = 7500');
select is((select count(*) from balances), 10::bigint, 'owner sees every active branch x active item');
select test.reset_role();
select is(test.balance('BR-02', 'D-001'), 500::numeric, 'test.balance after reset_role');

-- anon ----------------------------------------------------------------------------
set local role anon;
select throws_ok('select * from items', '42501', null, 'anon cannot read items');
select throws_ok('select * from balances', '42501', null, 'anon cannot read balances');
select test.reset_role();

-- revoked session and inactive user ---------------------------------------------
update app_sessions set revoked_at = clock_timestamp() where user_id = (select id from app_users where employee_number = '203');
select test.act_as('203');
select is((select count(*) from items), 0::bigint, 'revoked session reads nothing');
select is((select count(*) from balances), 0::bigint, 'revoked session sees no balances');
select test.act_as('299');
select is((select count(*) from items), 0::bigint, 'inactive user reads nothing');
select is((select count(*) from balances), 0::bigint, 'inactive user sees no balances');
select test.reset_role();

-- expired session ----------------------------------------------------------------
select test.expire_session('201'); select test.act_as('201');
select is((select count(*) from items), 0::bigint, 'expired session reads nothing');
select is((select count(*) from balances), 0::bigint, 'expired session sees no balances');
select is((select count(*) from app_users), 0::bigint, 'expired session sees no users');
select is((select count(*) from transfer_line_costs), 0::bigint, 'expired session sees no costs');
select test.reset_role();

-- catalog ---------------------------------------------------------------------------
select is_empty($$select table_name, privilege_type from information_schema.role_table_grants
  where grantee in ('anon','authenticated','PUBLIC') and table_schema = 'public' and privilege_type <> 'SELECT'$$, 'no client write privilege on any table');
select is_empty($$select table_name from information_schema.role_table_grants
  where grantee in ('anon','PUBLIC') and table_schema = 'public'$$, 'anon reads nothing');
select is_empty($$select table_name, column_name, privilege_type from information_schema.role_column_grants
  where grantee in ('anon','authenticated','PUBLIC') and table_schema = 'public' and privilege_type <> 'SELECT'$$, 'no client write privilege on any column');
select ok(not has_column_privilege('authenticated', 'public.transfer_lines', 'cost_total', 'select'), 'cost_total is not granted');
select is_empty($$select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relrowsecurity$$, 'every table in public has RLS enabled');
select is_empty($$select tablename, policyname from pg_policies where schemaname = 'public' and (cmd <> 'SELECT' or roles <> '{authenticated}')$$, 'every policy is select-only for authenticated');
select is_empty($$select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
  and (has_sequence_privilege('anon', c.oid, 'usage,select,update') or has_sequence_privilege('authenticated', c.oid, 'usage,select,update'))$$, 'clients hold nothing on sequences');
select is((select array_agg(n order by n) from (
    select p.pronamespace::regnamespace::text || '.' || p.proname as n from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))) s),
  array['app.my_branch','app.my_role','app.session_ok','public.owner_resolve_transfer_line','public.receive_transfer','public.send_transfer'], 'functions executable by clients are exactly the three RLS helpers and the transfer RPCs');
-- tables created by later migrations start closed
create table public.probe_tbl (id int generated always as identity primary key);
select is_empty($$select 1 from information_schema.role_table_grants where table_name = 'probe_tbl' and grantee in ('anon','authenticated','PUBLIC')$$, 'new tables start closed');
select ok(not has_sequence_privilege('authenticated', 'public.probe_tbl_id_seq', 'usage,select,update') and not has_sequence_privilege('anon', 'public.probe_tbl_id_seq', 'usage,select,update'), 'new sequences start closed');

select * from finish();
rollback;
