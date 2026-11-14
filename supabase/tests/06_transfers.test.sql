begin;
select plan(255);

-- test-local helpers (rolled back with the transaction) ----------------------------------
create schema t6;
grant usage on schema t6 to authenticated;

create function t6.tid(p_req uuid) returns uuid language sql stable security definer set search_path = public as
$$ select id from transfers where request_id = p_req $$;

create function t6.lid(p_req uuid, p_item text) returns uuid language sql stable security definer set search_path = public as
$$ select l.id from transfer_lines l join transfers t on t.id = l.transfer_id where t.request_id = p_req and l.item_id = p_item $$;

-- one send line / one receive line, built from typed values so the JSON keeps the scale given
create function t6.sl(p_item text, p_qty numeric, p_unit text, p_cost numeric default null) returns jsonb language sql
as $$ select jsonb_build_object('item_id', p_item, 'quantity', p_qty, 'unit', p_unit, 'cost_total', p_cost) $$;

create function t6.rl(p_req uuid, p_item text, p_qty numeric, p_unit text, p_reason text default null, p_note text default null)
returns jsonb language sql stable security definer set search_path = public as
$$ select jsonb_build_object('line_id', t6.lid(p_req, p_item), 'quantity', p_qty, 'unit', p_unit,
                             'diff_reason', p_reason, 'note', p_note) $$;

-- canonical text of a line: status|qty|unit|rate|base|cost|rqty|runit|rrate|rbase|reason|note|by_owner
create function t6.ls(p_req uuid, p_item text) returns text language sql stable security definer set search_path = public as
$$ select concat_ws('|', l.status, trim_scale(l.quantity), l.unit, trim_scale(l.unit_rate), trim_scale(l.base_quantity),
         coalesce(trim_scale(l.cost_total)::text, '~'), coalesce(trim_scale(l.received_quantity)::text, '~'),
         coalesce(l.received_unit, '~'), coalesce(trim_scale(l.received_unit_rate)::text, '~'),
         coalesce(trim_scale(l.received_base_quantity)::text, '~'), coalesce(l.diff_reason, '~'),
         coalesce(l.note, '~'), l.resolved_by_owner::text)
   from transfer_lines l join transfers t on t.id = l.transfer_id where t.request_id = p_req and l.item_id = p_item $$;

create function t6.resolver(p_req uuid, p_item text) returns text language sql stable security definer set search_path = public as
$$ select coalesce(u.employee_number, '~') from transfer_lines l join transfers t on t.id = l.transfer_id
   left join app_users u on u.id = l.resolved_by where t.request_id = p_req and l.item_id = p_item $$;

-- number of stock movements of one kind tied to the lines of one transfer
create function t6.mv(p_req uuid, p_kind text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from stock_movements m join transfer_lines l on l.id = m.ref_id join transfers t on t.id = l.transfer_id
   where t.request_id = p_req and m.kind = p_kind and m.ref_table = 'transfer_lines' $$;

-- a movement of a line, as 'branch|quantity|dated at send time?' (null when none)
create function t6.mvx(p_req uuid, p_item text, p_kind text) returns text language sql stable security definer set search_path = public as
$$ select string_agg(m.branch_id || '|' || trim_scale(m.base_quantity) || '|' || (m.occurred_at = t.created_at)::text, ';' order by m.base_quantity)
   from stock_movements m join transfer_lines l on l.id = m.ref_id join transfers t on t.id = l.transfer_id
   where t.request_id = p_req and l.item_id = p_item and m.kind = p_kind $$;

-- zero the balances the scenarios use, so each scenario can assert absolute numbers
create function t6.zero() returns void language sql security definer set search_path = public as
$$ insert into stock_baselines (branch_id, item_id, base_quantity, effective_at, source)
   select b, i, 0, clock_timestamp(), 'owner_zero'
   from unnest(array['BR-01','BR-02','BR-14']) b cross join unnest(array['D-001','D-002']) i $$;

grant execute on all functions in schema t6 to authenticated;

-- 1. send writes the ledger ---------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'distributor sends two lines');
select test.reset_role();
select is(test.balance('BR-14', 'D-001'), -18000::numeric, 'source D-001 down 18000');
select is(test.balance('BR-01', 'D-001'), 0::numeric, 'destination untouched by a send');
select is(test.balance('BR-14', 'D-002'), -1000::numeric, 'source D-002 down 1000');
select is((select count(*) from transfer_lines l where l.transfer_id = t6.tid('e6000000-0000-4000-8000-000000000101') and l.status = 'pending'), 2::bigint, 'two pending lines');
select is(t6.ls('e6000000-0000-4000-8000-000000000101', 'D-001'), 'pending|2|كرتونة|9000|18000|40|~|~|~|~|~|~|false', 'D-001 line stores rate 9000 and base 18000');
select is(t6.ls('e6000000-0000-4000-8000-000000000101', 'D-002'), 'pending|1|كرتونة|1000|1000|10|~|~|~|~|~|~|false', 'D-002 line stores rate 1000');
select is((select row(from_branch, to_branch, created_by)::text from transfers where request_id = 'e6000000-0000-4000-8000-000000000101'),
  (select row('BR-14'::text, 'BR-01'::text, id)::text from app_users where employee_number = '301'), 'transfer row: branches and creator');
select is(t6.mvx('e6000000-0000-4000-8000-000000000101', 'D-001', 'transfer_out'), 'BR-14|-18000|true', 'transfer_out at source, dated at created_at');
select is(t6.mv('e6000000-0000-4000-8000-000000000101', 'transfer_out'), 2::bigint, 'one transfer_out per line');
select is((select count(*) from activity_log where action = 'send_transfer'), 1::bigint, 'one activity_log row for the send');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000000101'), 1::bigint, 'one rpc_requests row');

-- 2. idempotent send --------------------------------------------------------------------------
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'replay of the same send');
select is((public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10))))->>'transfer_id',
  t6.tid('e6000000-0000-4000-8000-000000000101')::text, 'replay returns the same transfer_id');
select test.reset_role();
select is((select count(*) from transfers where request_id = 'e6000000-0000-4000-8000-000000000101'), 1::bigint, 'still one transfer');
select is((select count(*) from stock_movements where kind = 'transfer_out' and ref_id in
  (select id from transfer_lines where transfer_id = t6.tid('e6000000-0000-4000-8000-000000000101'))), 2::bigint, 'a replay writes no second movement');
select is((select count(*) from activity_log where action = 'send_transfer'), 1::bigint, 'a replay writes no second activity_log row');

-- 3. replay with changed values, 4. request id of another user, 5. numeric fingerprint ----------
select test.act_as('301');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 3, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, quantity 3');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-02',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other destination');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2.0, 'كرتونة', 40.00), t6.sl('D-002', 1.00, 'كرتونة', 10.0)))$$, 'quantity 2.0 / cost 40.00 is the same request');
select is((public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2.0, 'كرتونة', 40.00), t6.sl('D-002', 1.00, 'كرتونة', 10.0))))->>'transfer_id',
  t6.tid('e6000000-0000-4000-8000-000000000101')::text, 'numeric formatting replays the same transfer_id');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2.5, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'P0001', 'REQUEST_ID_REUSED', 'quantity 2.5 is a different request');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 41), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'P0001', 'REQUEST_ID_REUSED', 'cost 41 is a different request');
select test.act_as('201');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000101', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'P0001', 'REQUEST_ID_REUSED', 'request id of another user');
select test.reset_role();
select is((select count(*) from transfers), 1::bigint, 'after all refused repeats there is still one transfer');
select is(t6.ls('e6000000-0000-4000-8000-000000000101', 'D-001'), 'pending|2|كرتونة|9000|18000|40|~|~|~|~|~|~|false', 'and its line is unchanged');

-- 6. distributor needs cost, 7. manager cost optional -----------------------------------------
select test.act_as('301');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'عبوة')))$$,
  'P0001', 'COST_REQUIRED', 'distributor without cost');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 1, 'عبوة', 5), t6.sl('D-002', 1, 'حبة')))$$, 'P0001', 'COST_REQUIRED', 'distributor, second line without cost');
select test.act_as('201');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000701', 'BR-02', jsonb_build_array(t6.sl('D-001', 1, 'عبوة')))$$,
  'manager sends without cost');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000000701', 'D-001'), 'pending|1|عبوة|750|750|~|~|~|~|~|~|~|false', 'cost stays null');
select is(test.balance('BR-01', 'D-001'), -750::numeric, 'manager source down 750 (BR-01 baseline was 0)');
select is((select count(*) from transfers where request_id = 'e6000000-0000-4000-8000-000000000190'), 0::bigint, 'refused sends leave no transfer');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000000190'), 0::bigint, 'and no rpc_requests row');

-- 8. bad destination, 9. parameter validation, 10. feature hidden -----------------------------
select test.act_as('301');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-14', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'BRANCH_INVALID', 'to the own branch');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-09', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'BRANCH_INVALID', 'to an inactive branch');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-XX', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'BRANCH_INVALID', 'to an unknown branch');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', null, jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'BRANCH_INVALID', 'to a null branch');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-001', 0, 'مل', 1)))$$, 'P0001', 'QUANTITY_INVALID', 'zero quantity');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-001', -1, 'مل', 1)))$$, 'P0001', 'QUANTITY_INVALID', 'negative quantity');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","quantity":"NaN","cost_total":1}]')$$, 'P0001', 'QUANTITY_INVALID', 'NaN quantity');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","cost_total":1}]')$$, 'P0001', 'QUANTITY_INVALID', 'missing quantity');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","quantity":"abc","cost_total":1}]')$$, 'P0001', 'QUANTITY_INVALID', 'non-numeric quantity: a code, not a cast error');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","quantity":[1],"cost_total":1}]')$$, 'P0001', 'QUANTITY_INVALID', 'array as quantity');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","quantity":1,"cost_total":"abc"}]')$$, 'P0001', 'COST_INVALID', 'non-numeric cost');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","unit":"مل","quantity":1,"cost_total":-1}]')$$, 'P0001', 'COST_INVALID', 'negative cost');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"unit":"مل","quantity":1,"cost_total":1}]')$$, 'P0001', 'ITEM_INVALID', 'missing item_id');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[{"item_id":"D-001","quantity":1,"cost_total":1}]')$$, 'P0001', 'UNIT_INVALID', 'missing unit');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '{"item_id":"D-001"}')$$, 'P0001', 'LINES_EMPTY', 'lines is an object');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', null)$$, 'P0001', 'LINES_EMPTY', 'lines null');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[]')$$, 'P0001', 'LINES_EMPTY', 'lines empty');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', '[5]')$$, 'P0001', 'ITEM_INVALID', 'a line that is not an object');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-999', 1, 'مل', 1)))$$, 'P0001', 'ITEM_INVALID', 'unknown item');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-003', 1, 'غم', 1)))$$, 'P0001', 'ITEM_INVALID', 'inactive item');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-002', 1, 'عبوة', 1)))$$, 'P0001', 'UNIT_INVALID', 'unit the item does not have');
select test.act_as('215');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'مل')))$$, 'P0001', 'FEATURE_HIDDEN', 'BR-15 send is hidden');
select test.reset_role();
select is((select count(*) from transfers), 2::bigint, 'no refused send left a transfer');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000000190'), 0::bigint, 'and none stored a request');

-- roles -----------------------------------------------------------------------------------------
select test.act_as('100');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000000190', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'FORBIDDEN', 'owner cannot send');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000000190', t6.tid('e6000000-0000-4000-8000-000000000101'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000000101', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'FORBIDDEN', 'owner cannot receive');
select test.act_as('201');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000000190', t6.lid('e6000000-0000-4000-8000-000000000101', 'D-001'), 'accept')$$, 'P0001', 'FORBIDDEN', 'manager cannot resolve');
select test.act_as('301');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000000190', t6.lid('e6000000-0000-4000-8000-000000000101', 'D-001'), 'deny')$$, 'P0001', 'FORBIDDEN', 'distributor cannot resolve');
select test.reset_role();
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000000190'), 0::bigint, 'role refusals store nothing');

-- null request id ------------------------------------------------------------------------------
select test.act_as('301');
select throws_ok($$select public.send_transfer(null, 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'REQUEST_ID_REQUIRED', 'send without request id');
select test.act_as('201');
select throws_ok($$select public.receive_transfer(null, t6.tid('e6000000-0000-4000-8000-000000000101'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000000101', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'REQUEST_ID_REQUIRED', 'receive without request id');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line(null, t6.lid('e6000000-0000-4000-8000-000000000101', 'D-001'), 'deny')$$, 'P0001', 'REQUEST_ID_REQUIRED', 'owner resolve without request id');
select test.reset_role();
select is((select count(*) from transfers) + (select count(*) from rpc_requests where rpc_name <> 'send_transfer'), 2::bigint, 'null request ids wrote nothing');

-- 12. receive in full + 14. second receive, replay, final lines ---------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000001201', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for the full receipt');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001202', t6.tid('e6000000-0000-4000-8000-000000001201'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001201', 'D-001', 2, 'كرتونة', null, '  hello  '),
                    t6.rl('e6000000-0000-4000-8000-000000001201', 'D-002', 1, 'كرتونة', 'count_error', '   ')))$$, 'receive both lines in full');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 18000::numeric, 'destination D-001 +18000');
select is(test.balance('BR-14', 'D-001'), -18000::numeric, 'source D-001 stays -18000');
select is(test.balance('BR-01', 'D-002'), 1000::numeric, 'destination D-002 +1000');
select is(test.balance('BR-14', 'D-002'), -1000::numeric, 'source D-002 stays -1000');
select is(t6.mv('e6000000-0000-4000-8000-000000001201', 'transfer_adjust'), 0::bigint, 'no transfer_adjust when received as sent');
select is(t6.ls('e6000000-0000-4000-8000-000000001201', 'D-001'), 'received|2|كرتونة|9000|18000|40|2|كرتونة|9000|18000|~|hello|false', 'D-001 final row: note trimmed');
select is(t6.ls('e6000000-0000-4000-8000-000000001201', 'D-002'), 'received|1|كرتونة|1000|1000|10|1|كرتونة|1000|1000|~|~|false', 'D-002 final row: reason without a difference is null, blank note is null');
select is(t6.resolver('e6000000-0000-4000-8000-000000001201', 'D-001'), '201', 'resolved_by is the receiver');
select is((select count(*) from transfer_lines l where l.transfer_id = t6.tid('e6000000-0000-4000-8000-000000001201') and l.resolved_at is not null), 2::bigint, 'resolved_at set');
select is((select count(*) from transfer_lines l join stock_movements m on m.ref_id = l.id and m.kind = 'transfer_in'
           where l.transfer_id = t6.tid('e6000000-0000-4000-8000-000000001201') and m.occurred_at = l.resolved_at), 2::bigint, 'resolved_at equals the transfer_in time');
select is(t6.mvx('e6000000-0000-4000-8000-000000001201', 'D-001', 'transfer_in'), 'BR-01|18000|false', 'transfer_in at the destination, not dated at the send');
select ok((select min(i.occurred_at) from stock_movements i join transfer_lines l on l.id = i.ref_id
           where l.transfer_id = t6.tid('e6000000-0000-4000-8000-000000001201') and i.kind = 'transfer_in')
        > (select max(o.occurred_at) from stock_movements o join transfer_lines l on l.id = o.ref_id
           where l.transfer_id = t6.tid('e6000000-0000-4000-8000-000000001201') and o.kind = 'transfer_out'),
  'transfer_in is later than transfer_out inside one transaction (clock_timestamp, not now)');
select is((select count(*) from stock_movements where kind = 'transfer_in' and created_by = (select id from app_users where employee_number = '201')
           and ref_id in (select id from transfer_lines where transfer_id = t6.tid('e6000000-0000-4000-8000-000000001201'))), 2::bigint, 'two transfer_in rows created by the receiver');
select is((select count(*) from activity_log where action = 'receive_transfer'), 1::bigint, 'one activity_log row for the receipt');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000001202'), 1::bigint, 'one rpc_requests row for the receipt');

select test.act_as('201');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001203', t6.tid('e6000000-0000-4000-8000-000000001201'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001201', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001201', 'D-002', 1, 'كرتونة')))$$,
  'P0001', 'LINE_NOT_PENDING', 'second receive with a new id');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001202', t6.tid('e6000000-0000-4000-8000-000000001201'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001201', 'D-001', 2, 'كرتونة', null, '  hello  '),
                    t6.rl('e6000000-0000-4000-8000-000000001201', 'D-002', 1, 'كرتونة', 'count_error', '   ')))$$, 'replay of the first receipt lives');
select is((public.receive_transfer('e6000000-0000-4000-8000-000000001202', t6.tid('e6000000-0000-4000-8000-000000001201'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001201', 'D-001', 2, 'كرتونة', null, '  hello  '),
                    t6.rl('e6000000-0000-4000-8000-000000001201', 'D-002', 1, 'كرتونة', 'count_error', '   ')))),
  jsonb_build_object('transfer_id', t6.tid('e6000000-0000-4000-8000-000000001201'), 'received', 2), 'replay returns the stored result');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000001204', t6.lid('e6000000-0000-4000-8000-000000001201', 'D-001'), 'accept')$$, 'P0001', 'LINE_NOT_PENDING', 'a received line is final: accept');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000001204', t6.lid('e6000000-0000-4000-8000-000000001201', 'D-001'), 'deny')$$, 'P0001', 'LINE_NOT_PENDING', 'a received line is final: deny');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000001204', t6.lid('e6000000-0000-4000-8000-000000001201', 'D-001'), 'edit_accept', 1, 'كرتونة')$$, 'P0001', 'LINE_NOT_PENDING', 'a received line is final: edit');
select test.reset_role();
select is(t6.mv('e6000000-0000-4000-8000-000000001201', 'transfer_in'), 2::bigint, 'still one transfer_in per line');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000001203'), 0::bigint, 'the refused second receive stored nothing');
select is((select count(*) from activity_log where action = 'receive_transfer'), 1::bigint, 'and logged nothing');

-- 13. receive short and over ---------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000001301', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for short / over');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001302', t6.tid('e6000000-0000-4000-8000-000000001301'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001301', 'D-001', 1, 'كرتونة', 'not_loaded'),
                    t6.rl('e6000000-0000-4000-8000-000000001301', 'D-002', 1200, 'حبة', 'overloaded')))$$, 'receive short and over');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 9000::numeric, 'short: destination +9000');
select is(test.balance('BR-14', 'D-001'), -9000::numeric, 'short: source net -9000');
select is(test.balance('BR-01', 'D-002'), 1200::numeric, 'over: destination +1200');
select is(test.balance('BR-14', 'D-002'), -1200::numeric, 'over: source net -1200');
select is(t6.ls('e6000000-0000-4000-8000-000000001301', 'D-001'), 'received|2|كرتونة|9000|18000|20|1|كرتونة|9000|9000|not_loaded|~|false', 'short row: cost 20');
select is(t6.ls('e6000000-0000-4000-8000-000000001301', 'D-002'), 'received|1|كرتونة|1000|1000|12|1200|حبة|1|1200|overloaded|~|false', 'over row: cost 12, base unit rate 1');
select is((select cost_total::text from transfer_lines where id = t6.lid('e6000000-0000-4000-8000-000000001301', 'D-001')), '20.000', 'short cost is exactly 20.000');
select is(t6.mvx('e6000000-0000-4000-8000-000000001301', 'D-001', 'transfer_adjust'), 'BR-14|9000|true', 'short: adjust +9000 at the source, dated at the send');
select is(t6.mvx('e6000000-0000-4000-8000-000000001301', 'D-002', 'transfer_adjust'), 'BR-14|-200|true', 'over: adjust -200 at the source, dated at the send');
select is(t6.mvx('e6000000-0000-4000-8000-000000001301', 'D-001', 'transfer_in'), 'BR-01|9000|false', 'short: transfer_in 9000 at the destination');
select is(t6.mvx('e6000000-0000-4000-8000-000000001301', 'D-002', 'transfer_in'), 'BR-01|1200|false', 'over: transfer_in 1200 at the destination');

-- 15. receive zero ---------------------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000001501', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for zero');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001502', t6.tid('e6000000-0000-4000-8000-000000001501'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001501', 'D-001', 0, 'كرتونة', 'not_loaded')))$$, 'receive zero');
select test.reset_role();
select is(t6.mv('e6000000-0000-4000-8000-000000001501', 'transfer_in'), 0::bigint, 'no transfer_in when nothing arrived');
select is(test.balance('BR-14', 'D-001'), 0::numeric, 'source back to 0');
select is(test.balance('BR-01', 'D-001'), 0::numeric, 'destination 0');
select is(t6.ls('e6000000-0000-4000-8000-000000001501', 'D-001'), 'received|2|كرتونة|9000|18000|0|0|كرتونة|9000|0|not_loaded|~|false', 'zero row: cost 0, base 0');
select is(t6.mvx('e6000000-0000-4000-8000-000000001501', 'D-001', 'transfer_adjust'), 'BR-14|18000|true', 'zero: full adjust back to the source');
select ok((select l.resolved_at > t.created_at from transfer_lines l join transfers t on t.id = l.transfer_id where t.request_id = 'e6000000-0000-4000-8000-000000001501'), 'zero: resolved_at is after the send');

-- 16. difference needs a reason, 17. partial confirm refused, 18. wrong branch ---------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000001601', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for refusals');
select test.act_as('201');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 1, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$,
  'P0001', 'DIFF_REASON_REQUIRED', 'a difference without a reason');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 1, 'كرتونة', 'foo'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$,
  'P0001', 'DIFF_REASON_REQUIRED', 'an invalid reason value');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'LINES_INCOMPLETE', 'one of two lines');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'LINES_INCOMPLETE', 'a duplicated line id');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة'),
                    t6.rl('e6000000-0000-4000-8000-000000000101', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'LINES_INCOMPLETE', 'a line id of another transfer');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  '[{"line_id":"not-a-uuid","quantity":1,"unit":"كرتونة"}]')$$, 'P0001', 'LINES_INCOMPLETE', 'a line id that is not a uuid');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(jsonb_build_object('line_id', t6.lid('e6000000-0000-4000-8000-000000001601', 'D-001'), 'unit', 'كرتونة'),
                    t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$, 'P0001', 'QUANTITY_INVALID', 'a line without quantity');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(jsonb_build_object('line_id', t6.lid('e6000000-0000-4000-8000-000000001601', 'D-001'), 'quantity', 'abc', 'unit', 'كرتونة'),
                    t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$, 'P0001', 'QUANTITY_INVALID', 'a non-numeric received quantity');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', -1, 'كرتونة', 'not_loaded'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$,
  'P0001', 'QUANTITY_INVALID', 'a negative received quantity');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(jsonb_build_object('line_id', t6.lid('e6000000-0000-4000-8000-000000001601', 'D-001'), 'quantity', 2),
                    t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$, 'P0001', 'UNIT_INVALID', 'a line without unit');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'), '"x"')$$, 'P0001', 'LINES_EMPTY', 'lines is not an array');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'), '[]')$$, 'P0001', 'LINES_EMPTY', 'lines empty');
select test.reset_role();
select is((select count(*) from transfer_lines where transfer_id = t6.tid('e6000000-0000-4000-8000-000000001601') and status = 'pending'), 2::bigint, 'nothing was written by any refusal: both lines pending');
select is(t6.mv('e6000000-0000-4000-8000-000000001601', 'transfer_in') + t6.mv('e6000000-0000-4000-8000-000000001601', 'transfer_adjust'), 0::bigint, 'no movement from refusals');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000001690'), 0::bigint, 'no request stored by refusals');
select test.act_as('202');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$, 'P0001', 'FORBIDDEN', 'another branch cannot receive');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', gen_random_uuid(),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة')))$$, 'P0001', 'FORBIDDEN', 'unknown transfer: FORBIDDEN, existence not revealed');
select test.act_as('301');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000001690', t6.tid('e6000000-0000-4000-8000-000000001601'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000001601', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000001601', 'D-002', 1, 'كرتونة')))$$, 'P0001', 'FORBIDDEN', 'the sender cannot receive');
select test.reset_role();

-- 20-22. rate changed / unit deactivated after the send ---------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002001', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send before the rate change');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002101', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'second send before the rate change');
select test.reset_role();
update item_units set conversion_rate = 8000 where item_id = 'D-001' and unit_name = 'كرتونة';
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002002', t6.tid('e6000000-0000-4000-8000-000000002001'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002001', 'D-001', 2, 'كرتونة')))$$, 'rate changed: same unit as sent, no reason');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002102', t6.tid('e6000000-0000-4000-8000-000000002101'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002101', 'D-001', 24, 'عبوة')))$$, 'rate changed: other unit 24 x 750, no reason');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000002001', 'D-001'), 'received|2|كرتونة|9000|18000|40|2|كرتونة|9000|18000|~|~|false', 'same unit uses the stored rate 9000, not 8000');
select is(t6.mv('e6000000-0000-4000-8000-000000002001', 'transfer_adjust'), 0::bigint, 'no adjust for the same-unit receipt');
select is(t6.ls('e6000000-0000-4000-8000-000000002101', 'D-001'), 'received|2|كرتونة|9000|18000|40|24|عبوة|750|18000|~|~|false', 'other unit uses its current rate');
select is(t6.mv('e6000000-0000-4000-8000-000000002101', 'transfer_adjust'), 0::bigint, 'no adjust for 24 x 750');
select is(test.balance('BR-01', 'D-001'), 36000::numeric, 'destination got 18000 twice');
select is(test.balance('BR-14', 'D-001'), -36000::numeric, 'source net -36000');
update item_units set conversion_rate = 9000 where item_id = 'D-001' and unit_name = 'كرتونة';

select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002201', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'كرتونة', 10)))$$, 'send for deactivation');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002301', 'BR-01', jsonb_build_array(t6.sl('D-001', 9000, 'مل', 10)))$$, 'send in the base unit');
select test.reset_role();
update item_units set active = false where item_id = 'D-001' and unit_name = 'كرتونة';
select test.act_as('301');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002390', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'كرتونة', 10)))$$, 'P0001', 'UNIT_INVALID', 'a new send in an inactive unit');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002202', t6.tid('e6000000-0000-4000-8000-000000002201'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002201', 'D-001', 1, 'كرتونة')))$$, 'sent unit deactivated: received as sent is fine');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002302', t6.tid('e6000000-0000-4000-8000-000000002301'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002301', 'D-001', 1, 'كرتونة')))$$, 'P0001', 'UNIT_INVALID', 'a different, inactive unit is refused');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002303', t6.tid('e6000000-0000-4000-8000-000000002301'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002301', 'D-001', 9000, 'مل')))$$, 'the active sent unit is fine');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000002201', 'D-001'), 'received|1|كرتونة|9000|9000|10|1|كرتونة|9000|9000|~|~|false', 'deactivated sent unit: final row');
select is((select count(*) from rpc_requests where request_id = 'e6000000-0000-4000-8000-000000002302'), 0::bigint, 'the refused receipt stored nothing');
update item_units set active = true where item_id = 'D-001' and unit_name = 'كرتونة';

-- 23. owner accept ------------------------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002401', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for owner resolution');
select test.act_as('100');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002402', t6.lid('e6000000-0000-4000-8000-000000002401', 'D-001'), 'accept')$$, 'owner accepts D-001');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 18000::numeric, 'accept: destination 18000');
select is(test.balance('BR-14', 'D-001'), -18000::numeric, 'accept: source -18000');
select is(t6.ls('e6000000-0000-4000-8000-000000002401', 'D-001'), 'received|2|كرتونة|9000|18000|40|2|كرتونة|9000|18000|~|~|true', 'accept: final row, resolved_by_owner');
select is(t6.resolver('e6000000-0000-4000-8000-000000002401', 'D-001'), '100', 'accept: resolved_by is the owner');
select is(t6.mv('e6000000-0000-4000-8000-000000002401', 'transfer_adjust'), 0::bigint, 'accept: no adjust');
select ok((select l.resolved_at = m.occurred_at from transfer_lines l join stock_movements m on m.ref_id = l.id and m.kind = 'transfer_in'
           where l.id = t6.lid('e6000000-0000-4000-8000-000000002401', 'D-001')), 'accept: resolved_at equals the transfer_in time');
select is(test.balance('BR-14', 'D-002'), -1000::numeric, 'the other line is still pending at the source');
select is(test.balance('BR-01', 'D-002'), 0::numeric, 'and nothing at the destination');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002403', t6.lid('e6000000-0000-4000-8000-000000002401', 'D-001'), 'accept')$$, 'P0001', 'LINE_NOT_PENDING', 'accept twice');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002403', gen_random_uuid(), 'accept')$$, 'P0001', 'LINE_NOT_PENDING', 'unknown line id');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002403', t6.lid('e6000000-0000-4000-8000-000000002401', 'D-002'), 'bogus')$$, 'P0001', 'FORBIDDEN', 'unknown action');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002404', t6.tid('e6000000-0000-4000-8000-000000002401'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002401', 'D-002', 1, 'كرتونة')))$$, 'receive covers exactly the one pending line');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000002401', 'D-002'), 'received|1|كرتونة|1000|1000|10|1|كرتونة|1000|1000|~|~|false', 'the manager receipt is not marked as owner');

-- 24. owner deny ----------------------------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002501', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for deny');
select test.act_as('100');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002502', t6.lid('e6000000-0000-4000-8000-000000002501', 'D-001'), 'deny')$$, 'owner denies D-001');
select test.reset_role();
select is(test.balance('BR-14', 'D-001'), 0::numeric, 'deny: source back to 0');
select is(test.balance('BR-01', 'D-001'), 0::numeric, 'deny: destination 0');
select is(t6.ls('e6000000-0000-4000-8000-000000002501', 'D-001'), 'denied|2|كرتونة|9000|18000|40|~|~|~|~|~|~|true', 'deny: final row, no received_* values');
select is(t6.resolver('e6000000-0000-4000-8000-000000002501', 'D-001'), '100', 'deny: resolved_by is the owner');
select ok((select resolved_at is not null from transfer_lines where id = t6.lid('e6000000-0000-4000-8000-000000002501', 'D-001')), 'deny: resolved_at set');
select ok((select l.resolved_at > t.created_at from transfer_lines l join transfers t on t.id = l.transfer_id where l.id = t6.lid('e6000000-0000-4000-8000-000000002501', 'D-001')), 'deny: resolved_at is after the send');
select is(t6.mvx('e6000000-0000-4000-8000-000000002501', 'D-001', 'transfer_adjust'), 'BR-14|18000|true', 'deny: adjust +18000 at the source, dated at the send');
select is(t6.mv('e6000000-0000-4000-8000-000000002501', 'transfer_in'), 0::bigint, 'deny: no destination movement');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002503', t6.lid('e6000000-0000-4000-8000-000000002501', 'D-001'), 'deny')$$, 'P0001', 'LINE_NOT_PENDING', 'a denied line is final: deny');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002503', t6.lid('e6000000-0000-4000-8000-000000002501', 'D-001'), 'accept')$$, 'P0001', 'LINE_NOT_PENDING', 'a denied line is final: accept');
select test.act_as('201');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002504', t6.tid('e6000000-0000-4000-8000-000000002501'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002501', 'D-001', 2, 'كرتونة'), t6.rl('e6000000-0000-4000-8000-000000002501', 'D-002', 1, 'كرتونة')))$$,
  'P0001', 'LINES_INCOMPLETE', 'receive must cover only the pending line: a denied line id is not pending');

-- 25. owner edit_accept ------------------------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002601', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for edit');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002701', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for edit in another unit');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002690', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', 0, 'كرتونة')$$, 'P0001', 'QUANTITY_INVALID', 'edit to zero');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002690', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', null, 'كرتونة')$$, 'P0001', 'QUANTITY_INVALID', 'edit without quantity');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002690', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', 1, null)$$, 'P0001', 'UNIT_INVALID', 'edit without unit');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002690', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', 1, 'برميل')$$, 'P0001', 'UNIT_INVALID', 'edit to an unknown unit');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002690', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', 'NaN', 'كرتونة')$$, 'P0001', 'QUANTITY_INVALID', 'edit to NaN');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002602', t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001'), 'edit_accept', 1, 'كرتونة')$$, 'owner edits 2 to 1 كرتونة and accepts');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002702', t6.lid('e6000000-0000-4000-8000-000000002701', 'D-001'), 'edit_accept', 24, 'عبوة')$$, 'owner edits to 24 عبوة (same base) and accepts');
select test.reset_role();
select is(test.balance('BR-14', 'D-001'), -27000::numeric, 'edit: source net -9000 -18000');
select is(test.balance('BR-01', 'D-001'), 27000::numeric, 'edit: destination +9000 +18000');
select is(t6.ls('e6000000-0000-4000-8000-000000002601', 'D-001'), 'received|1|كرتونة|9000|9000|20|1|كرتونة|9000|9000|~|~|true', 'edit 2 to 1: sent values corrected, cost 20');
select is((select cost_total::text from transfer_lines where id = t6.lid('e6000000-0000-4000-8000-000000002601', 'D-001')), '20.000', 'edited cost is exactly 20.000');
select is(t6.mvx('e6000000-0000-4000-8000-000000002601', 'D-001', 'transfer_adjust'), 'BR-14|9000|true', 'edit: adjust +9000 at the source, dated at the send');
select is(t6.mvx('e6000000-0000-4000-8000-000000002601', 'D-001', 'transfer_in'), 'BR-01|9000|false', 'edit: transfer_in 9000');
select is(t6.ls('e6000000-0000-4000-8000-000000002701', 'D-001'), 'received|24|عبوة|750|18000|40|24|عبوة|750|18000|~|~|true', 'edit to another unit: current rate 750 stored');
select is(t6.mv('e6000000-0000-4000-8000-000000002701', 'transfer_adjust'), 0::bigint, 'same base quantity: no adjust row');

-- owner edit after a rate change ---------------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002801', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send before the rate change');
select test.reset_role();
update item_units set conversion_rate = 8000 where item_id = 'D-001' and unit_name = 'كرتونة';
select test.act_as('100');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000002802', t6.lid('e6000000-0000-4000-8000-000000002801', 'D-001'), 'edit_accept', 1, 'كرتونة')$$, 'edit after the rate change');
select test.reset_role();
select is(test.balance('BR-01', 'D-001'), 9000::numeric, 'the stored rate 9000 applies, not 8000');
select is(test.balance('BR-14', 'D-001'), -9000::numeric, 'source net -9000');
select is(t6.ls('e6000000-0000-4000-8000-000000002801', 'D-001'), 'received|1|كرتونة|9000|9000|20|1|كرتونة|9000|9000|~|~|true', 'row keeps rate 9000');
update item_units set conversion_rate = 9000 where item_id = 'D-001' and unit_name = 'كرتونة';

-- numeric fingerprint for receive and owner resolution -----------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000002901', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for receive fingerprint');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003001', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for owner fingerprint');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002902', t6.tid('e6000000-0000-4000-8000-000000002901'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002901', 'D-001', 1, 'كرتونة', 'not_loaded')))$$, 'receive 1');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002902', t6.tid('e6000000-0000-4000-8000-000000002901'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002901', 'D-001', 1.0, 'كرتونة', 'not_loaded')))$$, 'receive 1.0 is the same request');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000002902', t6.tid('e6000000-0000-4000-8000-000000002901'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000002901', 'D-001', 1.5, 'كرتونة', 'not_loaded')))$$, 'P0001', 'REQUEST_ID_REUSED', 'receive 1.5 is another request');
select test.act_as('100');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003002', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'edit_accept', 1, 'كرتونة')$$, 'owner edit to 1');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003002', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'edit_accept', 1.0, 'كرتونة')$$, 'owner edit to 1.0 is the same request');
select is((public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003002', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'edit_accept', 1.00, 'كرتونة')),
  jsonb_build_object('line_id', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'status', 'received'), 'the replay returns the stored result');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003002', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'edit_accept', 1.5, 'كرتونة')$$, 'P0001', 'REQUEST_ID_REUSED', 'owner edit 1.5 is another request');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003002', t6.lid('e6000000-0000-4000-8000-000000003001', 'D-001'), 'accept')$$, 'P0001', 'REQUEST_ID_REUSED', 'another action under the same id');
select test.reset_role();
select is(t6.mv('e6000000-0000-4000-8000-000000002901', 'transfer_adjust'), 1::bigint, 'receive replays wrote one adjust only');
select is(t6.mv('e6000000-0000-4000-8000-000000003001', 'transfer_adjust'), 1::bigint, 'owner replays wrote one adjust only');
select is(t6.mv('e6000000-0000-4000-8000-000000003001', 'transfer_in'), 1::bigint, 'and one transfer_in only');
select is((select count(*) from rpc_requests where request_id in ('e6000000-0000-4000-8000-000000002902', 'e6000000-0000-4000-8000-000000003002')), 2::bigint, 'one rpc_requests row per request id');

-- 29. the adjust is dated at the send time ----------------------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003101', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send before the baseline');
select test.reset_role();
insert into stock_baselines (branch_id, item_id, base_quantity, effective_at, source)
  values ('BR-14', 'D-001', 50000, clock_timestamp(), 'owner_zero');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003102', t6.tid('e6000000-0000-4000-8000-000000003101'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003101', 'D-001', 1, 'كرتونة', 'not_loaded')))$$, 'receive short after the baseline');
select test.reset_role();
select is(test.balance('BR-14', 'D-001'), 50000::numeric, 'the baseline absorbed the send and its adjust: 50000');
select is(test.balance('BR-01', 'D-001'), 9000::numeric, 'the receipt, dated now, counts at the destination');

-- lenient reason on an exact receipt; cost kept exactly --------------------------------------------------------
select t6.zero();
select test.act_as('301');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003401', 'BR-01',
  jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40), t6.sl('D-002', 1, 'كرتونة', 10)))$$, 'send for exact receipts');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003403', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for short receipts');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003405', 'BR-01', jsonb_build_array(t6.sl('D-001', 2, 'كرتونة', 40)))$$, 'send for the reason replay');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003501', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'كرتونة', 10.12345)))$$, 'send with a cost of 5 decimals');
select test.act_as('201');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003402', t6.tid('e6000000-0000-4000-8000-000000003401'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003401', 'D-001', 2, 'كرتونة', ''), t6.rl('e6000000-0000-4000-8000-000000003401', 'D-002', 1, 'كرتونة', 'foo')))$$,
  'exact receipt with an empty and a junk reason succeeds');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003490', t6.tid('e6000000-0000-4000-8000-000000003403'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003403', 'D-001', 1, 'كرتونة', '')))$$, 'P0001', 'DIFF_REASON_REQUIRED', 'short receipt with an empty reason');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003490', t6.tid('e6000000-0000-4000-8000-000000003403'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003403', 'D-001', 1, 'كرتونة', 'foo')))$$, 'P0001', 'DIFF_REASON_REQUIRED', 'short receipt with a junk reason');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003406', t6.tid('e6000000-0000-4000-8000-000000003405'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003405', 'D-001', 2, 'كرتونة', '')))$$, 'full receipt sent with an empty reason');
select is((public.receive_transfer('e6000000-0000-4000-8000-000000003406', t6.tid('e6000000-0000-4000-8000-000000003405'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003405', 'D-001', 2, 'كرتونة') - 'diff_reason'))),
  jsonb_build_object('transfer_id', t6.tid('e6000000-0000-4000-8000-000000003405'), 'received', 1), 'retry without the key replays the stored result');
select lives_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003502', t6.tid('e6000000-0000-4000-8000-000000003501'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003501', 'D-001', 1, 'كرتونة')))$$, 'receive the 5-decimal cost in full');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000003401', 'D-001'), 'received|2|كرتونة|9000|18000|40|2|كرتونة|9000|18000|~|~|false', 'empty reason stored as null');
select is(t6.ls('e6000000-0000-4000-8000-000000003401', 'D-002'), 'received|1|كرتونة|1000|1000|10|1|كرتونة|1000|1000|~|~|false', 'junk reason stored as null');
select is(t6.ls('e6000000-0000-4000-8000-000000003501', 'D-001'), 'received|1|كرتونة|9000|9000|10.12345|1|كرتونة|9000|9000|~|~|false', 'an exact receipt keeps the cost 10.12345');
select is(t6.mv('e6000000-0000-4000-8000-000000003405', 'transfer_in'), 1::bigint, 'the replay wrote no second transfer_in');
select is(t6.ls('e6000000-0000-4000-8000-000000003403', 'D-001'), 'pending|2|كرتونة|9000|18000|40|~|~|~|~|~|~|false', 'refused short receipts left the line pending');

-- invariants over every line created above -----------------------------------------------------------------------
select is_empty($$select l.id from transfer_lines l join transfers t on t.id = l.transfer_id
  where coalesce((select sum(m.base_quantity) from stock_movements m where m.ref_id = l.id and m.branch_id = t.from_branch), 0)
        <> case l.status when 'received' then -l.received_base_quantity when 'denied' then 0 else -l.base_quantity end
     or coalesce((select sum(m.base_quantity) from stock_movements m where m.ref_id = l.id and m.branch_id = t.to_branch), 0)
        <> case when l.status = 'received' then l.received_base_quantity else 0 end$$,
  'net effect per line: source -received (received), 0 (denied), -base (pending); destination +received');
select is((select count(*) from transfers), (select count(*) from activity_log where action = 'send_transfer'), 'one send log row per transfer');
select is((select count(*) from rpc_requests where rpc_name = 'receive_transfer'), (select count(*) from activity_log where action = 'receive_transfer'), 'one receive log row per stored receive');
select is((select count(*) from rpc_requests where rpc_name = 'owner_resolve_transfer_line'), (select count(*) from activity_log where action = 'owner_resolve_transfer_line'), 'one owner log row per stored resolve');
select is_empty($$select 1 from stock_movements m where m.ref_table = 'transfer_lines' and m.created_by is null$$, 'every transfer movement names its creator');

-- 30. frozen source / destination ---------------------------------------------------------------------------------
select t6.zero();
select test.reset_role();
select test.freeze('BR-14');
select test.act_as('301');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003290', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'مل', 1)))$$, 'P0001', 'BRANCH_FROZEN', 'a frozen source cannot send');
select test.reset_role();
select test.freeze('BR-01');
select test.act_as('202');
select lives_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003202', 'BR-01', jsonb_build_array(t6.sl('D-001', 1, 'عبوة'), t6.sl('D-002', 1, 'حبة')))$$, 'sending to a frozen branch works');
select test.act_as('201');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003290', t6.tid('e6000000-0000-4000-8000-000000003202'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003202', 'D-001', 1, 'عبوة'), t6.rl('e6000000-0000-4000-8000-000000003202', 'D-002', 1, 'حبة')))$$, 'P0001', 'BRANCH_FROZEN', 'a frozen destination cannot receive');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003290', 'BR-02', jsonb_build_array(t6.sl('D-001', 1, 'مل')))$$, 'P0001', 'BRANCH_FROZEN', 'a frozen branch cannot send either');
select test.act_as('100');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003290', t6.lid('e6000000-0000-4000-8000-000000003202', 'D-001'), 'accept')$$, 'P0001', 'BRANCH_FROZEN', 'owner accept into a frozen branch');
select throws_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003290', t6.lid('e6000000-0000-4000-8000-000000003202', 'D-001'), 'edit_accept', 1, 'عبوة')$$, 'P0001', 'BRANCH_FROZEN', 'owner edit_accept into a frozen branch');
select lives_ok($$select public.owner_resolve_transfer_line('e6000000-0000-4000-8000-000000003203', t6.lid('e6000000-0000-4000-8000-000000003202', 'D-001'), 'deny')$$, 'owner deny works while the destination is frozen');
select test.reset_role();
select is(t6.ls('e6000000-0000-4000-8000-000000003202', 'D-001'), 'denied|1|عبوة|750|750|~|~|~|~|~|~|~|true', 'denied during the freeze');
select is(t6.ls('e6000000-0000-4000-8000-000000003202', 'D-002'), 'pending|1|حبة|1|1|~|~|~|~|~|~|~|false', 'the other line stayed pending');
select is(t6.mv('e6000000-0000-4000-8000-000000003202', 'transfer_in'), 0::bigint, 'no destination movement while frozen');
select is(t6.mvx('e6000000-0000-4000-8000-000000003202', 'D-001', 'transfer_adjust'), 'BR-02|750|true', 'the deny adjust went to the sender');

-- expired session -----------------------------------------------------------------------------------------------
select test.expire_session('201');
select test.act_as('201');
select throws_ok($$select public.receive_transfer('e6000000-0000-4000-8000-000000003301', t6.tid('e6000000-0000-4000-8000-000000003202'),
  jsonb_build_array(t6.rl('e6000000-0000-4000-8000-000000003202', 'D-002', 1, 'حبة')))$$, 'P0001', 'NOT_AUTHENTICATED', 'receive with an expired session');
select throws_ok($$select public.send_transfer('e6000000-0000-4000-8000-000000003302', 'BR-02', jsonb_build_array(t6.sl('D-001', 1, 'مل')))$$, 'P0001', 'NOT_AUTHENTICATED', 'send with an expired session');
select test.reset_role();
select is((select count(*) from rpc_requests where request_id in ('e6000000-0000-4000-8000-000000003301', 'e6000000-0000-4000-8000-000000003302')), 0::bigint, 'nothing stored');
select is(t6.ls('e6000000-0000-4000-8000-000000003202', 'D-002'), 'pending|1|حبة|1|1|~|~|~|~|~|~|~|false', 'nothing written: still pending');

-- privileges -----------------------------------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.send_transfer(uuid,text,jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.receive_transfer(uuid,uuid,jsonb)', 'execute')
      and has_function_privilege('authenticated', 'public.owner_resolve_transfer_line(uuid,uuid,text,numeric,text)', 'execute'), 'authenticated may execute the three RPCs');
select ok(not has_function_privilege('anon', 'public.send_transfer(uuid,text,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.receive_transfer(uuid,uuid,jsonb)', 'execute')
      and not has_function_privilege('anon', 'public.owner_resolve_transfer_line(uuid,uuid,text,numeric,text)', 'execute'), 'anon may not');

select * from finish();
rollback;
