begin;
select plan(259);

-- test-local helpers (rolled back with the transaction) ----------------------------------
create schema t7;
grant usage on schema t7 to authenticated;

-- id of the (single) line of the purchase created with this request id
create function t7.lid(p_req uuid) returns uuid language sql stable security definer set search_path = public as
$$ select l.id from purchase_lines l join purchases p on p.id = l.purchase_id where p.request_id = p_req $$;

create function t7.pid(p_req uuid) returns uuid language sql stable security definer set search_path = public as
$$ select id from purchases where request_id = p_req $$;

-- one purchase line, built from typed values so the JSON keeps the scale given
create function t7.pl(p_item text, p_qty numeric, p_unit text, p_cost numeric default null) returns jsonb language sql
as $$ select jsonb_build_object('item_id', p_item, 'quantity', p_qty, 'unit', p_unit, 'cost_total', p_cost) $$;

-- canonical stored state of a line: qty|unit|rate|base|cost|voided
create function t7.ls(p_line uuid) returns text language sql stable security definer set search_path = public as
$$ select concat_ws('|', trim_scale(l.quantity), l.unit, trim_scale(l.unit_rate), trim_scale(l.base_quantity),
         coalesce(trim_scale(l.cost_total)::text, '~'), (l.voided_at is not null)::text)
   from purchase_lines l where l.id = p_line $$;

create function t7.mv(p_line uuid, p_kind text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from stock_movements m where m.ref_id = p_line and m.kind = p_kind $$;

create function t7.hn(p_line uuid) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from purchase_line_history h where h.purchase_line_id = p_line $$;

-- history actions of a line in order
create function t7.ha(p_line uuid) returns text language sql stable security definer set search_path = public as
$$ select string_agg(h.action, ',' order by h.changed_at, h.id) from purchase_line_history h where h.purchase_line_id = p_line $$;

-- n-th (0-based) history row's old_values
create function t7.hv(p_line uuid, p_n int) returns jsonb language sql stable security definer set search_path = public as
$$ select h.old_values from purchase_line_history h where h.purchase_line_id = p_line order by h.changed_at, h.id offset p_n limit 1 $$;

-- the ledger of a line equals the record: sum of its movements = base_quantity, or 0 when voided
create function t7.ledger_ok(p_line uuid) returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select sum(m.base_quantity) from stock_movements m where m.ref_id = p_line), 0)
        = (select case when l.voided_at is null then l.base_quantity else 0 end from purchase_lines l where l.id = p_line) $$;

-- every purchase_adjust of a line is dated exactly at the purchase's created_at and strictly before the
-- EARLIEST history row of the line (no pairing by position: not every call writes both rows)
create function t7.adjust_dating_ok(p_line uuid) returns boolean language sql stable security definer set search_path = public as
$$ select count(*) > 0 and coalesce(bool_and(m.occurred_at = p.created_at
          and m.occurred_at < (select min(h.changed_at) from purchase_line_history h where h.purchase_line_id = p_line)), false)
   from stock_movements m join purchase_lines l on l.id = m.ref_id join purchases p on p.id = l.purchase_id
   where m.ref_id = p_line and m.kind = 'purchase_adjust' $$;

create function t7.adjust_n(p_line uuid) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from stock_movements m where m.ref_id = p_line and m.kind = 'purchase_adjust' $$;

-- a zero baseline now, so each scenario can assert absolute balances
create function t7.zero() returns void language sql security definer set search_path = public as
$$ insert into stock_baselines (branch_id, item_id, base_quantity, effective_at, source)
   select b, i, 0, clock_timestamp(), 'owner_zero'
   from unnest(array['BR-01','BR-14']) b cross join unnest(array['D-001','D-002']) i $$;

grant execute on all functions in schema t7 to authenticated;

-- 1. create writes the ledger -------------------------------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة')))$$, 'manager buys 3 عبوة from S-01');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 2250::numeric, 'balance 2250');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000101')), '3|عبوة|750|2250|~|false', 'line stores quantity, unit, rate 750, base 2250, no cost');
select is((select row(branch_id, supplier_id, created_by)::text from purchases where request_id = 'e7000000-0000-4000-8000-000000000101'),
  (select row('BR-01'::text, 'S-01'::text, id)::text from app_users where employee_number = '201'), 'purchase row: branch, supplier, creator');
select is((select m.branch_id || '|' || trim_scale(m.base_quantity) || '|' || m.ref_table || '|' || (m.created_by = u.id)::text || '|' || (m.occurred_at = p.created_at)::text
           from stock_movements m join purchase_lines l on l.id = m.ref_id join purchases p on p.id = l.purchase_id, app_users u
           where p.request_id = 'e7000000-0000-4000-8000-000000000101' and m.kind = 'purchase_in' and u.employee_number = '201'),
  'BR-01|2250|purchase_lines|true|true', 'purchase_in: branch, +2250, ref table, creator, occurred_at = purchases.created_at');
select is(t7.mv(t7.lid('e7000000-0000-4000-8000-000000000101'), 'purchase_in'), 1::bigint, 'exactly one movement per line');
select is((select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000101')), 1::bigint, 'and no other movement of the line');
select is((select count(*) from activity_log where action = 'create_purchase' and entity_id = t7.pid('e7000000-0000-4000-8000-000000000101')::text), 1::bigint, 'one activity_log row');
select is((select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000101'), 1::bigint, 'one rpc_requests row');

-- 2. idempotent create --------------------------------------------------------------------
select test.act_as('201');
select is((public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة'))))->>'purchase_id',
  t7.pid('e7000000-0000-4000-8000-000000000101')::text, 'same id and body: same purchase_id');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 4, 'عبوة')))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, 4 عبوة');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-02', jsonb_build_array(t7.pl('D-001', 3, 'عبوة')))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other supplier');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 5)))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, cost added');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3.0, 'عبوة')))$$, 'quantity 3.0 is the same request');
select is((public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3.00, 'عبوة'))))->>'purchase_id',
  t7.pid('e7000000-0000-4000-8000-000000000101')::text, 'quantity 3.00 replays the same purchase_id');
select test.act_as('301');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000101', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 5)))$$, 'P0001', 'REQUEST_ID_REUSED', 'request id of another user');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 2250::numeric, 'balance still 2250 after every repeat');
select is((select count(*) from purchases) || '|' || (select count(*) from purchase_lines) || '|' || (select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000101'))
          || '|' || (select count(*) from activity_log where action = 'create_purchase') || '|' || (select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000101'),
  '1|1|1|1|1', 'replays wrote nothing: one purchase, line, movement, log row, request row');

-- 3. numeric fingerprint: cost with trailing zeros ----------------------------------------
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000102', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة', 12.5)))$$, 'purchase with cost 12.5');
select is((public.create_purchase('e7000000-0000-4000-8000-000000000102', 'S-01', jsonb_build_array(t7.pl('D-001', 1.0, 'عبوة', 12.500))))->>'purchase_id',
  t7.pid('e7000000-0000-4000-8000-000000000102')::text, 'quantity 1.0 and cost 12.500 replay the same purchase_id');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000102', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة', 12.6)))$$, 'P0001', 'REQUEST_ID_REUSED', 'cost 12.6 is a different request');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000102')), '1|عبوة|750|750|12.5|false', 'cost stored as given');
select is((select count(*) from purchases), 2::bigint, 'the repeats created no purchase');

-- 4. distributor needs cost; roles ---------------------------------------------------------
select t7.zero();
select test.act_as('301');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'COST_REQUIRED', 'distributor without cost');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة', 5), t7.pl('D-001', 1, 'مل')))$$, 'P0001', 'COST_REQUIRED', 'distributor, second line without cost');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000103', 'S-01', jsonb_build_array(t7.pl('D-001', 2, 'عبوة', 30)))$$, 'distributor with cost');
select test.reset_role();
select is(test.balance('BR-14', 'D-001'), 1500::numeric, 'warehouse balance 1500');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000103')), '2|عبوة|750|1500|30|false', 'distributor line stores its cost');
select test.act_as('100');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'FORBIDDEN', 'owner cannot create');
select test.reset_role();

-- 5. refusals -----------------------------------------------------------------------------
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-02', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'SUPPLIER_INVALID', 'inactive supplier S-02');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-99', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'SUPPLIER_INVALID', 'unknown supplier');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', null, jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'SUPPLIER_INVALID', 'null supplier');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-002', 1, 'حبة')))$$, 'P0001', 'ITEM_NOT_ALLOWED', 'item not sold by the supplier (D-002 from S-01)');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة'), t7.pl('D-002', 1, 'حبة')))$$, 'P0001', 'ITEM_NOT_ALLOWED', 'one bad line refuses the whole purchase');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-999', 1, 'عبوة')))$$, 'P0001', 'ITEM_INVALID', 'unknown item is ITEM_INVALID');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-003', 1, 'غم')))$$, 'P0001', 'ITEM_INVALID', 'inactive item is ITEM_INVALID');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'برميل')))$$, 'P0001', 'UNIT_INVALID', 'unknown unit');
select test.act_as('202');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'ITEM_NOT_ALLOWED', 'item not allowed for the branch (202)');
select test.act_as('215');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'FEATURE_HIDDEN', 'purchase hidden for 215');
select test.reset_role();
update supplier_items set active = false where supplier_id = 'S-01' and item_id = 'D-001';
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'ITEM_NOT_ALLOWED', 'inactive supplier_items row');
select test.reset_role();
update supplier_items set active = true where supplier_id = 'S-01' and item_id = 'D-001';
update allowed_local_purchases set active = false where branch_id = 'BR-01' and item_id = 'D-001';
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'ITEM_NOT_ALLOWED', 'inactive allowed_local_purchases row');
select test.reset_role();
update allowed_local_purchases set active = true where branch_id = 'BR-01' and item_id = 'D-001';
select is((select count(*) from purchases), 3::bigint, 'no refusal created a purchase');
select is((select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000990'), 0::bigint, 'no refusal stored a request');

-- 6. malformed p_lines give codes, never a cast error ---------------------------------------
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', null)$$, 'P0001', 'LINES_EMPTY', 'null lines');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[]'::jsonb)$$, 'P0001', 'LINES_EMPTY', 'empty array');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '{}'::jsonb)$$, 'P0001', 'LINES_EMPTY', 'object instead of array');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '"x"'::jsonb)$$, 'P0001', 'LINES_EMPTY', 'string instead of array');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[1]'::jsonb)$$, 'P0001', 'ITEM_INVALID', 'element is not an object');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"unit":"عبوة","quantity":1}]'::jsonb)$$, 'P0001', 'ITEM_INVALID', 'missing item_id');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":{"a":1},"unit":"عبوة","quantity":1}]'::jsonb)$$, 'P0001', 'ITEM_INVALID', 'item_id is an object');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","quantity":1}]'::jsonb)$$, 'P0001', 'UNIT_INVALID', 'missing unit');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'missing quantity');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"abc"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity text');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":{"a":1}}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity object');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":[]}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity array');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"NaN"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity NaN');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"Infinity"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity Infinity');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":0}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity 0');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":-1}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity negative');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"1e999999"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity overflows numeric');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"1e131070"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'quantity x rate overflows numeric');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":"abc"}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'cost text');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":{"a":1}}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'cost object');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":"Infinity"}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'cost Infinity');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":"NaN"}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'cost NaN');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":-1}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'cost negative');
select test.reset_role();
select is((select count(*) from purchases), 3::bigint, 'malformed lines created nothing');

-- 7. request id is required in all three ---------------------------------------------------
select test.act_as('201');
select throws_ok($$select public.create_purchase(null, 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'REQUEST_ID_REQUIRED', 'create without a request id');
select test.act_as('100');
select throws_ok($$select public.edit_purchase_line(null, t7.lid('e7000000-0000-4000-8000-000000000101'), 1, 'عبوة', null)$$, 'P0001', 'REQUEST_ID_REQUIRED', 'edit without a request id');
select throws_ok($$select public.void_purchase_line(null, t7.lid('e7000000-0000-4000-8000-000000000101'))$$, 'P0001', 'REQUEST_ID_REQUIRED', 'void without a request id');
select test.reset_role();

-- 8. role boundaries on edit and void ------------------------------------------------------
select test.act_as('201');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 1, 'عبوة', null)$$, 'P0001', 'FORBIDDEN', 'manager cannot edit');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'))$$, 'P0001', 'FORBIDDEN', 'manager cannot void');
select test.act_as('301');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000103'), 1, 'عبوة', 5)$$, 'P0001', 'FORBIDDEN', 'distributor cannot edit');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000103'))$$, 'P0001', 'FORBIDDEN', 'distributor cannot void');
select test.act_as('100');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', gen_random_uuid(), 1, 'عبوة', null)$$, 'P0001', 'FORBIDDEN', 'edit of an unknown line: FORBIDDEN, existence not revealed');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000990', gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'void of an unknown line: FORBIDDEN');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', null, 1, 'عبوة', null)$$, 'P0001', 'FORBIDDEN', 'edit with a null line id: FORBIDDEN');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000990', null)$$, 'P0001', 'FORBIDDEN', 'void with a null line id: FORBIDDEN');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000101')) || '|' || t7.hn(t7.lid('e7000000-0000-4000-8000-000000000101')) || '|' || t7.ls(t7.lid('e7000000-0000-4000-8000-000000000103')) || '|' || t7.hn(t7.lid('e7000000-0000-4000-8000-000000000103')),
  '3|عبوة|750|2250|~|false|0|2|عبوة|750|1500|30|false|0', 'refusals changed nothing and wrote no history');

-- 9. edit validation ----------------------------------------------------------------------
select test.act_as('100');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 0, 'عبوة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit quantity 0');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), -1, 'عبوة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit quantity negative');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 'NaN', 'عبوة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit quantity NaN');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), null, 'عبوة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit quantity null');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 1, 'عبوة', -1)$$, 'P0001', 'COST_INVALID', 'edit cost negative');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 1, 'عبوة', 'Infinity')$$, 'P0001', 'COST_INVALID', 'edit cost Infinity');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 1, null, null)$$, 'P0001', 'UNIT_INVALID', 'edit without a unit');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), 1, 'برميل', null)$$, 'P0001', 'UNIT_INVALID', 'edit to an unknown unit');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000101'), '1e131070', 'كرتونة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit quantity x rate overflows numeric');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000101')) || '|' || t7.hn(t7.lid('e7000000-0000-4000-8000-000000000101')) || '|' || (select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000101')),
  '3|عبوة|750|2250|~|false|0|1', 'refused edits changed nothing');

-- 10. edit: 3 -> 1 عبوة with cost 5 --------------------------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000201', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة, cost 10');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000202', t7.lid('e7000000-0000-4000-8000-000000000201'), 1, 'عبوة', 5)$$, 'owner edits to 1 عبوة, cost 5');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 750::numeric, 'balance 750');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000201')), '1|عبوة|750|750|5|false', 'line updated');
select is((select count(*) from purchase_line_history where purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000201') and old_values->>'base_quantity' = '2250'), 1::bigint, 'one history row with old base_quantity 2250');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000201'), 0), '{"quantity":3,"unit":"عبوة","unit_rate":750,"base_quantity":2250,"cost_total":10}'::jsonb, 'history holds the values before the edit');
select is((select m.branch_id || '|' || trim_scale(m.base_quantity) || '|' || (m.occurred_at = p.created_at)::text || '|' || m.ref_table || '|' || (m.created_by = u.id)::text
           from stock_movements m join purchase_lines l on l.id = m.ref_id join purchases p on p.id = l.purchase_id, app_users u
           where m.ref_id = t7.lid('e7000000-0000-4000-8000-000000000201') and m.kind = 'purchase_adjust' and u.employee_number = '100'),
  'BR-01|-1500|true|purchase_lines|true', 'purchase_adjust: BR-01, -1500, dated at the purchase, created_by owner');
select is((select h.changed_by = u.id from purchase_line_history h, app_users u where h.purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000201') and u.employee_number = '100'), true, 'history changed_by is the owner');
select is((select count(*) from activity_log where action = 'edit_purchase_line' and entity_id = t7.lid('e7000000-0000-4000-8000-000000000201')::text), 1::bigint, 'one activity_log row for the edit');
select is(t7.ha(t7.lid('e7000000-0000-4000-8000-000000000201')), 'edit', 'history action is edit');

-- 11. two edits in sequence: 3 -> 2 -> 1 ----------------------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000211', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة')))$$, 'buy 3 عبوة');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000212', t7.lid('e7000000-0000-4000-8000-000000000211'), 2, 'عبوة', null)$$, 'edit to 2');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000213', t7.lid('e7000000-0000-4000-8000-000000000211'), 1, 'عبوة', null)$$, 'edit to 1');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 750::numeric, 'balance 750 = line base_quantity');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000211')), '1|عبوة|750|750|~|false', 'line is 1 عبوة');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000211')), 2::bigint, 'two history rows');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000211')), 'ledger equals the record');

-- 12. cost-only edit after a catalog rate change: no movement, rate preserved --------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000301', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة, cost 10');
select test.reset_role();
update item_units set conversion_rate = 1000 where item_id = 'D-001' and unit_name = 'عبوة';
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000302', t7.lid('e7000000-0000-4000-8000-000000000301'), 3, 'عبوة', 9)$$, 'owner edits only the cost');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000301')), '3|عبوة|750|2250|9|false', 'cost 9; unit_rate still 750; base_quantity still 2250');
select is((select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000301')), 1::bigint, 'still exactly one movement (the original purchase_in)');
select is(t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000301')), 0::bigint, 'no purchase_adjust row');
select is(test.balance('BR-01', 'D-001'), 2250::numeric, 'balance unchanged at 2250');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000301')), 1::bigint, 'exactly one history row');
select is((select old_values->>'cost_total' || '|' || (old_values->>'unit_rate') from purchase_line_history where purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000301')), '10|750', 'history: old cost 10, old unit_rate 750');
update item_units set active = false where item_id = 'D-001' and unit_name = 'عبوة';
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000303', t7.lid('e7000000-0000-4000-8000-000000000301'), 3, 'عبوة', 8)$$, 'cost-only edit with the unit deactivated');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000301')), '3|عبوة|750|2250|8|false', 'deactivated unit: cost 8, rate 750, base 2250');
select is(t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000301')) || '|' || test.balance('BR-01', 'D-001'), '0|2250', 'deactivated unit: still no movement, balance 2250');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000301')), 2::bigint, 'two history rows after two cost edits');
-- an edit that changes nothing: success, no history, no movement, request stored
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000304', t7.lid('e7000000-0000-4000-8000-000000000301'), 3, 'عبوة', 8)$$, 'no-op edit succeeds');
select test.reset_role();
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000301')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000301')) || '|' || (select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000304')
          || '|' || (select count(*) from activity_log where action = 'edit_purchase_line' and entity_id = t7.lid('e7000000-0000-4000-8000-000000000301')::text),
  '2|0|1|3', 'no-op edit: no new history, no movement, request stored, call logged');
-- clearing the cost, then setting it again: old cost null is a JSON null
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000305', t7.lid('e7000000-0000-4000-8000-000000000301'), 3, 'عبوة', null)$$, 'owner clears the cost');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000306', t7.lid('e7000000-0000-4000-8000-000000000301'), 3, 'عبوة', 7.5)$$, 'owner sets a cost again');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000301')), '3|عبوة|750|2250|7.5|false', 'cost 7.5 after clearing');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000301'), 2), '{"quantity":3,"unit":"عبوة","unit_rate":750,"base_quantity":2250,"cost_total":8}'::jsonb, 'history 3: the cost before clearing');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000301'), 3)->'cost_total', 'null'::jsonb, 'history 4: a cleared cost is a JSON null');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000301')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000301')) || '|' || test.balance('BR-01', 'D-001'), '4|0|2250', 'four history rows, still no movement, balance 2250');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000301')), 'ledger equals the record after cost-only edits');
update item_units set active = true where item_id = 'D-001' and unit_name = 'عبوة';
update item_units set conversion_rate = 750 where item_id = 'D-001' and unit_name = 'عبوة';

-- 13. quantity edit in the same unit after a rate change uses the stored rate ---------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000401', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة');
select test.reset_role();
update item_units set conversion_rate = 1000 where item_id = 'D-001' and unit_name = 'عبوة';
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000402', t7.lid('e7000000-0000-4000-8000-000000000401'), 2, 'عبوة', 10)$$, 'edit to 2 عبوة after the rate change');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000401')), '2|عبوة|750|1500|10|false', 'base 1500 = 2 x stored 750');
select is(test.balance('BR-01', 'D-001'), 1500::numeric, 'balance 1500');
select is((select string_agg(trim_scale(m.base_quantity)::text, ',') from stock_movements m where m.ref_id = t7.lid('e7000000-0000-4000-8000-000000000401') and m.kind = 'purchase_adjust'), '-750', 'one purchase_adjust of -750');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000401')), 'ledger equals the record');
update item_units set conversion_rate = 750 where item_id = 'D-001' and unit_name = 'عبوة';

-- 14. deliberate unit change uses today's rate and stores it --------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000501', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة');
select test.reset_role();
update item_units set conversion_rate = 1000 where item_id = 'D-001' and unit_name = 'عبوة';
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000502', t7.lid('e7000000-0000-4000-8000-000000000501'), 3000, 'مل', 10)$$, 'edit to 3000 مل');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000501')), '3000|مل|1|3000|10|false', 'unit مل: rate 1 stored, base 3000');
select is(test.balance('BR-01', 'D-001'), 3000::numeric, 'balance 3000');
select is((select string_agg(trim_scale(m.base_quantity)::text, ',') from stock_movements m where m.ref_id = t7.lid('e7000000-0000-4000-8000-000000000501') and m.kind = 'purchase_adjust'), '750', 'one purchase_adjust of +750');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000503', t7.lid('e7000000-0000-4000-8000-000000000501'), 3, 'عبوة', 10)$$, 'edit back to 3 عبوة');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000501')), '3|عبوة|1000|3000|10|false', 'the unit changed, so today''s rate 1000 applies');
select is(test.balance('BR-01', 'D-001') || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000501')), '3000|1', 'same base: balance 3000 and no second adjust');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000501')), 2::bigint, 'a unit change with no stock effect still writes history');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000501'), 1), '{"quantity":3000,"unit":"مل","unit_rate":1,"base_quantity":3000,"cost_total":10}'::jsonb, 'second history row holds the مل state');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000501')), 'ledger equals the record');
update item_units set conversion_rate = 750 where item_id = 'D-001' and unit_name = 'عبوة';

-- 15. edit in a deactivated unit ------------------------------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000601', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة');
select test.reset_role();
update item_units set active = false where item_id = 'D-001' and unit_name in ('عبوة', 'كرتونة');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000602', t7.lid('e7000000-0000-4000-8000-000000000601'), 2, 'عبوة', 10)$$, 'quantity 3 -> 2 in the deactivated unit');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000601'), 1, 'كرتونة', 10)$$, 'P0001', 'UNIT_INVALID', 'a different inactive unit is refused');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000601')), '2|عبوة|750|1500|10|false', 'deactivated unit: 2 x stored 750');
select is(test.balance('BR-01', 'D-001') || '|' || t7.hn(t7.lid('e7000000-0000-4000-8000-000000000601')), '1500|1', 'balance 1500, the refused edit wrote no history');
update item_units set active = true where item_id = 'D-001' and unit_name in ('عبوة', 'كرتونة');

-- 16. history chain: edit, edit, void; dating; ledger ---------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000701', 'S-01', jsonb_build_array(t7.pl('D-001', 4, 'عبوة', 20)))$$, 'buy 4 عبوة, cost 20 (line A)');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000711', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 5)))$$, 'buy 3 عبوة, cost 5 (line B)');
select test.reset_role();
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000701')), 'ledger equals the record after create');
select ok((select m.occurred_at = p.created_at from stock_movements m join purchase_lines l on l.id = m.ref_id join purchases p on p.id = l.purchase_id
           where l.id = t7.lid('e7000000-0000-4000-8000-000000000701') and m.kind = 'purchase_in'), 'purchase_in occurred_at = purchases.created_at');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000702', t7.lid('e7000000-0000-4000-8000-000000000701'), 3, 'عبوة', 15)$$, 'edit A: 4 -> 3, cost 15');
select test.reset_role();
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000701')), 'ledger equals the record after edit 1');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000712', t7.lid('e7000000-0000-4000-8000-000000000711'), 1, 'عبوة', 5)$$, 'edit B (another line)');
select test.reset_role();
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000701')), 1::bigint, 'the edit of line B added nothing to the history of line A');
select is(t7.ha(t7.lid('e7000000-0000-4000-8000-000000000711')), 'edit', 'line B has its own history row');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000703', t7.lid('e7000000-0000-4000-8000-000000000701'), 2, 'عبوة', 10)$$, 'edit A: 3 -> 2, cost 10');
select test.reset_role();
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000701')), 'ledger equals the record after edit 2');
select test.act_as('100');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000704', t7.lid('e7000000-0000-4000-8000-000000000701'))$$, 'void A');
select test.reset_role();
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000701')), 'ledger equals the record after the void: sum 0');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000701')), 3::bigint, 'exactly three history rows');
select is(t7.ha(t7.lid('e7000000-0000-4000-8000-000000000701')), 'edit,edit,void', 'actions in order: edit, edit, void');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000701'), 0), '{"quantity":4,"unit":"عبوة","unit_rate":750,"base_quantity":3000,"cost_total":20}'::jsonb, 'row 1: state before edit 1 (all five keys)');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000701'), 1), '{"quantity":3,"unit":"عبوة","unit_rate":750,"base_quantity":2250,"cost_total":15}'::jsonb, 'row 2: state before edit 2');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000701'), 2), '{"quantity":2,"unit":"عبوة","unit_rate":750,"base_quantity":1500,"cost_total":10}'::jsonb, 'row 3: state before the void');
select is((select array_agg(k order by k) from purchase_line_history h, jsonb_object_keys(h.old_values) k where h.purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000701') and h.action = 'void'),
  array['base_quantity','cost_total','quantity','unit','unit_rate'], 'the void row has exactly the five keys');
select is((select count(*) from purchase_line_history h where h.purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000701') and jsonb_typeof(h.old_values->'quantity') = 'number'
           and jsonb_typeof(h.old_values->'unit_rate') = 'number' and jsonb_typeof(h.old_values->'base_quantity') = 'number'
           and jsonb_typeof(h.old_values->'cost_total') = 'number' and jsonb_typeof(h.old_values->'unit') = 'string'), 3::bigint, 'numbers are JSON numbers, the unit a string');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000701')), '2|عبوة|750|1500|10|true', 'after the void: quantity, unit and base stay, the void flag removes it');
select is((select (l.voided_by = u.id)::text || '|' || (l.voided_at = h.changed_at)::text || '|' || (l.voided_at > p.created_at)::text
           from purchase_lines l join purchases p on p.id = l.purchase_id
           join purchase_line_history h on h.purchase_line_id = l.id and h.action = 'void', app_users u
           where l.id = t7.lid('e7000000-0000-4000-8000-000000000701') and u.employee_number = '100'),
  'true|true|true', 'voided_by is the owner; voided_at = the void history time, after the purchase');
select is((select count(*) from purchase_line_history h where h.purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000701') and h.changed_by = (select id from app_users where employee_number = '100')), 3::bigint, 'every history row is by the owner');
select is(t7.hv(t7.lid('e7000000-0000-4000-8000-000000000711'), 0), '{"quantity":3,"unit":"عبوة","unit_rate":750,"base_quantity":2250,"cost_total":5}'::jsonb, 'history of line B untouched by the changes to line A');
select is(test.balance('BR-01', 'D-001'), 750::numeric, 'balance: A voided (0) + B 1 عبوة (750)');
select is((select string_agg(trim_scale(m.base_quantity)::text, ',' order by m.created_at, m.id) from stock_movements m where m.ref_id = t7.lid('e7000000-0000-4000-8000-000000000701') and m.kind = 'purchase_adjust'), '-750,-750,-1500', 'adjusts: -750, -750, then the void reverses -1500');
select is((select count(*) from stock_movements m join purchase_lines l on l.id = m.ref_id join purchases p on p.id = l.purchase_id
           where l.id = t7.lid('e7000000-0000-4000-8000-000000000701') and m.kind = 'purchase_adjust' and m.occurred_at = p.created_at), 3::bigint, 'all three adjustments (two edits, one void) are dated exactly at purchases.created_at');
select ok(t7.adjust_dating_ok(t7.lid('e7000000-0000-4000-8000-000000000701')), 'each adjustment is strictly earlier than the earliest history row of the line');
select is(t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000701')), 3::bigint, 'three adjustments in total');
select throws_ok($$update purchase_line_history set action = 'void' where purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000701')$$, 'P0001', 'IMMUTABLE_ROW', 'history cannot be updated');
select throws_ok($$delete from purchase_line_history where purchase_line_id = t7.lid('e7000000-0000-4000-8000-000000000701')$$, 'P0001', 'IMMUTABLE_ROW', 'history cannot be deleted');
select test.act_as('100');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000701'), 1, 'عبوة', 1)$$, 'P0001', 'LINE_VOIDED', 'edit of a voided line');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000701'))$$, 'P0001', 'LINE_VOIDED', 'void twice');
select test.reset_role();
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000701')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000701')) || '|' || test.balance('BR-01', 'D-001'), '3|3|750', 'the refused calls wrote nothing');

-- 17. corrections and baselines -------------------------------------------------------------
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000801', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'purchase before the baseline');
select test.reset_role();
insert into stock_baselines (branch_id, item_id, base_quantity, effective_at, source)
  values ('BR-01', 'D-001', 1000, clock_timestamp(), 'count');
select is(test.balance('BR-01', 'D-001'), 1000::numeric, 'baseline 1000 after the purchase');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000802', t7.lid('e7000000-0000-4000-8000-000000000801'), 1, 'عبوة', 10)$$, 'edit 3 -> 1 before the baseline');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 1000::numeric, 'the edit leaves the balance at 1000 (dated before the baseline)');
select is(t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000801')), 1::bigint, 'the adjustment exists in the ledger');
select test.act_as('100');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000803', t7.lid('e7000000-0000-4000-8000-000000000801'))$$, 'void before the baseline');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 1000::numeric, 'the void leaves the balance at 1000');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000801')) and t7.hn(t7.lid('e7000000-0000-4000-8000-000000000801')) = 2, 'ledger equals the record; history kept');
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000811', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'purchase after the baseline');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 3250::numeric, 'balance 1000 + 2250');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000812', t7.lid('e7000000-0000-4000-8000-000000000811'), 1, 'عبوة', 10)$$, 'edit 3 -> 1 after the baseline');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 1750::numeric, 'balance 1750: changed by exactly the difference (-1500)');
select test.act_as('100');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000813', t7.lid('e7000000-0000-4000-8000-000000000811'))$$, 'void after the baseline');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 1000::numeric, 'balance 1000: the void removed exactly 750');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000811')), 'ledger equals the record: voided, sum 0');

-- 18. replays of edit and void --------------------------------------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000901', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة')))$$, 'buy 3 عبوة for the edit replay');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000911', 'S-01', jsonb_build_array(t7.pl('D-001', 2, 'عبوة', 4)))$$, 'buy 2 عبوة for the void replay');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'), 1, 'عبوة', 5)$$, 'edit to 1, cost 5');
select is((public.edit_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'), 1.0, 'عبوة', 5.00))->>'line_id', t7.lid('e7000000-0000-4000-8000-000000000901')::text, 'retry with 1.0 and 5.00 replays the same line_id');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'), 2, 'عبوة', 5)$$, 'P0001', 'REQUEST_ID_REUSED', 'quantity 2 is a different request');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'), 1, 'عبوة', 6)$$, 'P0001', 'REQUEST_ID_REUSED', 'cost 6 is a different request');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'))$$, 'P0001', 'REQUEST_ID_REUSED', 'the edit request id used for a void');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000912', t7.lid('e7000000-0000-4000-8000-000000000911'))$$, 'void');
select is((public.void_purchase_line('e7000000-0000-4000-8000-000000000912', t7.lid('e7000000-0000-4000-8000-000000000911')))->>'line_id', t7.lid('e7000000-0000-4000-8000-000000000911')::text, 'void replay returns the same line_id');
select throws_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000912', t7.lid('e7000000-0000-4000-8000-000000000901'))$$, 'P0001', 'REQUEST_ID_REUSED', 'void request id for another line');
select test.act_as('201');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000902', t7.lid('e7000000-0000-4000-8000-000000000901'), 1, 'عبوة', 5)$$, 'P0001', 'FORBIDDEN', 'a manager replaying the owner request id: FORBIDDEN first');
select test.reset_role();
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000901')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000901')) || '|' || (select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000901'))
          || '|' || (select count(*) from activity_log where action = 'edit_purchase_line' and entity_id = t7.lid('e7000000-0000-4000-8000-000000000901')::text)
          || '|' || (select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000902'),
  '1|1|2|1|1', 'edit replays wrote nothing: one history row, one adjust, two movements, one log row, one request row');
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000911')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000911')) || '|' || (select count(*) from stock_movements where ref_id = t7.lid('e7000000-0000-4000-8000-000000000911'))
          || '|' || (select count(*) from activity_log where action = 'void_purchase_line' and entity_id = t7.lid('e7000000-0000-4000-8000-000000000911')::text)
          || '|' || (select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000912'),
  '1|1|2|1|1', 'void replays wrote nothing');
select is(test.balance('BR-01', 'D-001'), 750::numeric, 'balances: line 901 is 750, line 911 is voided');

-- 19b. literal void: a zeroed item, one line, void -> balance 0 -----------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000971', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة', 10)))$$, 'buy one line from a zeroed state');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 750::numeric, 'balance 750 after the purchase');
select test.act_as('100');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000972', t7.lid('e7000000-0000-4000-8000-000000000971'))$$, 'void it');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 0::numeric, 'void: balance is exactly 0');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000971')), 'ledger equals the record: voided, sum 0');

-- 19c. dating helper with a call that writes history but no adjustment ----------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000981', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'buy 3 عبوة');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000982', t7.lid('e7000000-0000-4000-8000-000000000981'), 3, 'عبوة', 12)$$, 'cost-only edit (history, no adjust)');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000983', t7.lid('e7000000-0000-4000-8000-000000000981'), 2, 'عبوة', 12)$$, 'quantity edit (history and adjust)');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000984', t7.lid('e7000000-0000-4000-8000-000000000981'))$$, 'void (history and adjust)');
select test.reset_role();
select is(t7.hn(t7.lid('e7000000-0000-4000-8000-000000000981')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000981')) || '|' || t7.ha(t7.lid('e7000000-0000-4000-8000-000000000981')), '3|2|edit,edit,void', 'three history rows but only two adjustments');
select ok(t7.adjust_dating_ok(t7.lid('e7000000-0000-4000-8000-000000000981')), 'dating helper holds where position pairing would not');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000981')), 'ledger equals the record');

-- 19. frozen branch: create refused, owner corrections allowed ------------------------------
select t7.zero();
select test.act_as('201');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000951', 'S-01', jsonb_build_array(t7.pl('D-001', 3, 'عبوة', 10)))$$, 'purchase before the freeze (line E)');
select lives_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000961', 'S-01', jsonb_build_array(t7.pl('D-001', 2, 'عبوة', 10)))$$, 'purchase before the freeze (line V)');
select test.reset_role();
select test.freeze('BR-01');
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', jsonb_build_array(t7.pl('D-001', 1, 'عبوة')))$$, 'P0001', 'BRANCH_FROZEN', 'create is refused while frozen');
select test.act_as('100');
select lives_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000952', t7.lid('e7000000-0000-4000-8000-000000000951'), 1, 'عبوة', 10)$$, 'owner edit works while the branch is frozen');
select lives_ok($$select public.void_purchase_line('e7000000-0000-4000-8000-000000000962', t7.lid('e7000000-0000-4000-8000-000000000961'))$$, 'owner void works while the branch is frozen');
select test.reset_role();
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000951')) || '|' || t7.ls(t7.lid('e7000000-0000-4000-8000-000000000961')), '1|عبوة|750|750|10|false|2|عبوة|750|1500|10|true', 'frozen: edit and void applied');
select ok(t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000951')) and t7.ledger_ok(t7.lid('e7000000-0000-4000-8000-000000000961')) and t7.adjust_dating_ok(t7.lid('e7000000-0000-4000-8000-000000000951')) and t7.adjust_dating_ok(t7.lid('e7000000-0000-4000-8000-000000000961')),
  'frozen: ledger equals the record and the corrections are dated at the purchase');
select is((select count(*) from purchases where request_id = 'e7000000-0000-4000-8000-000000000990'), 0::bigint, 'the refused create left no purchase');

-- 19d. internal action guard ---------------------------------------------------------------
select throws_ok($$select app.purchase_line_change(t7.lid('e7000000-0000-4000-8000-000000000711'), 'bogus', 1, 'عبوة', null, (select id from app_users where employee_number = '100'))$$, 'P0001', 'FORBIDDEN', 'unknown action is refused');
select throws_ok($$select app.purchase_line_change(t7.lid('e7000000-0000-4000-8000-000000000711'), null, 1, 'عبوة', null, (select id from app_users where employee_number = '100'))$$, 'P0001', 'FORBIDDEN', 'null action is refused');
select is(t7.ls(t7.lid('e7000000-0000-4000-8000-000000000711')) || '|' || t7.hn(t7.lid('e7000000-0000-4000-8000-000000000711')) || '|' || t7.adjust_n(t7.lid('e7000000-0000-4000-8000-000000000711')), '1|عبوة|750|750|5|false|1|1', 'a refused action wrote nothing (line B: one edit before)');

-- 19e. bounded quantities and costs (helpers of 0005 hardened in 0008) -----------------------
select lives_ok($$select app.check_quantity(1000000000000, false)$$, 'quantity 10^12 passes');
select throws_ok($$select app.check_quantity(1000000000001, false)$$, 'P0001', 'QUANTITY_INVALID', 'quantity above 10^12 is refused');
select throws_ok($$select app.check_quantity(1000000000001, true)$$, 'P0001', 'QUANTITY_INVALID', 'also when zero is allowed');
select is(app.check_quantity(0, true), 0::numeric, 'zero still passes where allowed');
select lives_ok($$select app.check_cost(1000000000000)$$, 'cost 10^12 passes');
select throws_ok($$select app.check_cost(1000000000001)$$, 'P0001', 'COST_INVALID', 'cost above 10^12 is refused');
select is(app.check_cost(null), null::numeric, 'null cost still passes');
select ok(not has_function_privilege('authenticated', 'app.check_quantity(numeric,boolean)', 'execute')
      and not has_function_privilege('authenticated', 'app.check_cost(numeric)', 'execute')
      and not has_function_privilege('anon', 'app.check_quantity(numeric,boolean)', 'execute')
      and not has_function_privilege('anon', 'app.check_cost(numeric)', 'execute'), 'the helpers stay closed to clients');
select test.act_as('201');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":"1e13"}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'create_purchase quantity 1e13');
select throws_ok($$select public.create_purchase('e7000000-0000-4000-8000-000000000990', 'S-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":"1e13"}]'::jsonb)$$, 'P0001', 'COST_INVALID', 'create_purchase cost 1e13');
select test.act_as('100');
select throws_ok($$select public.edit_purchase_line('e7000000-0000-4000-8000-000000000990', t7.lid('e7000000-0000-4000-8000-000000000711'), '1e13', 'عبوة', null)$$, 'P0001', 'QUANTITY_INVALID', 'edit_purchase_line quantity 1e13');
select test.reset_role();

-- 19f. transfer RPCs (0007, unchanged) are protected by the same bounds ----------------------
select count(*) as n0 from transfers \gset
select test.act_as('301');
select throws_ok($$select public.send_transfer('e7000000-0000-4000-8000-000000000990', 'BR-01', '[{"item_id":"D-001","unit":"كرتونة","quantity":"1e131070","cost_total":5}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'send_transfer quantity 1e131070 is QUANTITY_INVALID, not 22003');
select throws_ok($$select public.send_transfer('e7000000-0000-4000-8000-000000000990', 'BR-01', '[{"item_id":"D-001","unit":"كرتونة","quantity":"1e13","cost_total":5}]'::jsonb)$$, 'P0001', 'QUANTITY_INVALID', 'send_transfer quantity 1e13');
select test.reset_role();
select is((select count(*) from transfers), :n0::bigint, 'the refused sends wrote no transfer');
select is((select count(*) from stock_movements where kind = 'transfer_out'), 0::bigint, 'and no movement');
select test.act_as('301');
select lives_ok($$select public.send_transfer('e7000000-0000-4000-8000-000000000991', 'BR-01', '[{"item_id":"D-001","unit":"عبوة","quantity":1,"cost_total":5}]'::jsonb)$$, 'a normal send for the receive check');
select test.act_as('201');
select throws_ok($$select public.receive_transfer('e7000000-0000-4000-8000-000000000990', (select id from transfers where request_id = 'e7000000-0000-4000-8000-000000000991'),
  jsonb_build_array(jsonb_build_object('line_id', (select l.id from transfer_lines l join transfers t on t.id = l.transfer_id where t.request_id = 'e7000000-0000-4000-8000-000000000991'),
                                       'quantity', 1e13::numeric, 'unit', 'عبوة')))$$, 'P0001', 'QUANTITY_INVALID', 'receive_transfer received quantity 1e13');
select test.reset_role();
select is((select status from transfer_lines l join transfers t on t.id = l.transfer_id where t.request_id = 'e7000000-0000-4000-8000-000000000991'), 'pending', 'the refused receipt left the line pending');

-- 20. activity log: one row per successful call, none on failure ----------------------------
select is((select count(*) from activity_log where action = 'create_purchase'), (select count(*) from purchases), 'one create_purchase log row per purchase');
select is((select count(*) from activity_log where action = 'edit_purchase_line'), (select count(*) from rpc_requests where rpc_name = 'edit_purchase_line'), 'one edit_purchase_line log row per stored edit request');
select is((select count(*) from activity_log where action = 'void_purchase_line'), (select count(*) from rpc_requests where rpc_name = 'void_purchase_line'), 'one void_purchase_line log row per stored void request');
select is((select count(*) from rpc_requests where request_id = 'e7000000-0000-4000-8000-000000000990'), 0::bigint, 'no failed call stored a request');

-- 21. privileges ----------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.create_purchase(uuid,text,jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.edit_purchase_line(uuid,uuid,numeric,text,numeric)', 'execute')
      and has_function_privilege('authenticated', 'public.void_purchase_line(uuid,uuid)', 'execute'), 'authenticated may execute the three RPCs');
select ok(not has_function_privilege('anon', 'public.create_purchase(uuid,text,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.edit_purchase_line(uuid,uuid,numeric,text,numeric)', 'execute')
      and not has_function_privilege('anon', 'public.void_purchase_line(uuid,uuid)', 'execute'), 'anon may not');

select * from finish();
rollback;
