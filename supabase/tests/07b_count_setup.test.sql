begin;
select no_plan();

-- Each row of Task 7b's test table is covered below. No Task 8 RPC is used.
create schema t7b;
grant usage on schema t7b to authenticated;
create function t7b.call(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin execute p_sql into v_result; return v_result; end;
$$;
grant execute on function t7b.call(text) to authenticated;

-- owner only, request ids, and authenticated-only entry points ----------------
create temporary table calls (id uuid, action text, sql text, changed text);
insert into calls values
 ('f7b00000-0000-4000-8000-000000000001', 'set_item_count_setup',
  $$select set_item_count_setup('f7b00000-0000-4000-8000-000000000001','D-006',false,'units',null)$$,
  $$select set_item_count_setup('f7b00000-0000-4000-8000-000000000001','D-006',true,'units',null)$$),
 ('f7b00000-0000-4000-8000-000000000002', 'set_item_unit',
  $$select set_item_unit('f7b00000-0000-4000-8000-000000000002','D-006','علبة',10,true,false)$$,
  $$select set_item_unit('f7b00000-0000-4000-8000-000000000002','D-006','علبة',11,true,false)$$),
 ('f7b00000-0000-4000-8000-000000000003', 'set_item_container',
  $$select set_item_container('f7b00000-0000-4000-8000-000000000003','D-006-test','D-006','اختبار',10,array['default'],true)$$,
  $$select set_item_container('f7b00000-0000-4000-8000-000000000003','D-006-test','D-006','اختبار',11,array['default'],true)$$),
 ('f7b00000-0000-4000-8000-000000000004', 'set_container_tare',
  $$select set_container_tare('f7b00000-0000-4000-8000-000000000004','D-006-test','default',10)$$,
  $$select set_container_tare('f7b00000-0000-4000-8000-000000000004','D-006-test','default',11)$$);
grant select on calls to authenticated;
select test.act_as('201');
select throws_ok(sql, 'P0001', 'FORBIDDEN', action || ': manager refused') from calls;
select test.reset_role();
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok(sql, 'P0001', 'NOT_AUTHENTICATED', action || ': no session refused') from calls;
select test.reset_role();
select test.act_as('100');
-- Build the null-id calls without altering any other argument.
select throws_ok(replace(sql, quote_literal(id::text), 'null'), 'P0001', 'REQUEST_ID_REQUIRED',
                 action || ': request id required') from calls;

-- replay: all four RPCs, including a later intervening change -----------------
select lives_ok(sql, action || ': owner succeeds') from calls order by id;
select test.reset_role();
create temporary table original_results as
 select c.id, r.result, (select count(*) from activity_log a where a.action = c.action) as logs
 from calls c join rpc_requests r on r.request_id = c.id;
grant select on original_results to authenticated;
select is((select count(*) from original_results), 4::bigint, 'all four results stored');
select is((select count(*) from activity_log where action in (select action from calls)), 4::bigint,
          'one log row per first call');
select test.act_as('100');
select is(t7b.call(c.sql), r.result, c.action || ': replay returns identical result')
 from calls c join original_results r using (id) order by c.id;
select throws_ok(changed, 'P0001', 'REQUEST_ID_REUSED', action || ': changed parameters refused') from calls;
-- Equivalent numeric scales fingerprint identically.
select is(t7b.call(replace(sql, ',10,', ',10.0,')), r.result, c.action || ': numeric-scale replay')
 from calls c join original_results r using (id) where c.action <> 'set_item_count_setup';
select test.reset_role();
select is((select count(*) from activity_log a where a.action = c.action), r.logs,
          c.action || ': retries wrote no log') from calls c join original_results r using (id);
select is((select count(*) from rpc_requests where request_id in (select id from calls)), 4::bigint,
          'retries wrote no request rows');
select is((select row(conversion_rate, active, count_visible)::text from item_units
           where item_id = 'D-006' and unit_name = 'علبة'), '(10,t,f)', 'unit upsert stores all settings');

-- method checks -------------------------------------------------------------
select test.act_as('100');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-001',true,'containers',null)$$,
                 'P0001', 'QUANTITY_INVALID', 'containers require grams per base unit');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-001',true,'other',1)$$,
                 'P0001', 'ENTRIES_INVALID', 'unknown method refused');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'missing',true,'units',null)$$,
                 'P0001', 'ITEM_INVALID', 'unknown setup item refused');
select throws_ok(format($q$select set_item_count_setup(gen_random_uuid(),'D-001',true,'containers',%L)$q$, n),
                 'P0001', 'QUANTITY_INVALID', 'invalid net grams: ' || n)
 from (values ('0'), ('-1'), ('NaN'), ('Infinity'), ('1000000000001')) v(n);
select lives_ok($$select set_item_count_setup(gen_random_uuid(),'D-006',false,'containers',1000)$$,
                'owner can change method and counted flag');
select test.reset_role();
select is((select row(counted, count_method, net_grams_per_base_unit)::text from items where id='D-006'),
          '(f,containers,1000)', 'method settings persisted');
select is((select array_agg(count_method order by id) from items where id in ('D-001','D-002')),
          array['units','units'], 'original fixture methods unchanged');

-- unit rate change: purchase keeps its entered rate and ledger ---------------
select test.act_as('201');
select lives_ok($$select create_purchase('f7b00000-0000-4000-8000-000000000010','S-01',
 '[{"item_id":"D-001","quantity":2,"unit":"عبوة"}]')$$, 'purchase before rate change');
select test.act_as('100');
select lives_ok($$select set_item_unit('f7b00000-0000-4000-8000-000000000011','D-001','عبوة',800,true,true)$$,
                'owner changes current rate to 800');
select test.reset_role();
select is((select conversion_rate from item_units where item_id='D-001' and unit_name='عبوة'),
          800::numeric, 'catalogue rate changed');
select is((select row(l.unit_rate,l.base_quantity)::text from purchase_lines l join purchases p on p.id=l.purchase_id
           where p.request_id='f7b00000-0000-4000-8000-000000000010'), '(750,1500)',
          'stored purchase keeps rate 750 and 2 x 750 = 1500');
select is(test.balance('BR-01','D-001'), 1500::numeric, 'stored purchase ledger unchanged');
-- Existing deferred trigger is the authority, fired inside the assertion.
set constraints all immediate;
select test.act_as('100');
select throws_ok($$select set_item_unit(gen_random_uuid(),'D-001','مل',2,true,true)$$,
                 '23514', null, 'base unit rate protected');
select throws_ok($$select set_item_unit(gen_random_uuid(),'D-001','مل',1,false,true)$$,
                 '23514', null, 'base unit stays active');
select test.reset_role();
set constraints all deferred;

-- container and tare checks -------------------------------------------------
select test.act_as('100');
select throws_ok($$select set_item_container(gen_random_uuid(),'bad','missing','x',1,array['default'],true)$$,
                 'P0001', 'ITEM_INVALID', 'container item must exist');
select throws_ok(format($q$select set_item_container(gen_random_uuid(),'bad','D-004','x',1,%s,true)$q$, a),
                 'P0001', 'CONTAINER_INVALID', 'bad variant list: ' || a)
 from (values ('array[]::text[]'), ('array[''other'']'), ('array[null]::text[]'), ('null')) v(a);
select throws_ok(format($q$select set_item_container(gen_random_uuid(),'bad','D-004','x',%L,array['default'],true)$q$, n),
                 'P0001', 'QUANTITY_INVALID', 'invalid content: ' || n)
 from (values ('0'), ('-1'), ('NaN'), ('Infinity')) v(n);
select throws_ok($$select set_container_tare(gen_random_uuid(),'D-005-1L','glass_pump',20)$$,
                 'P0001', 'CONTAINER_INVALID', 'tare variant must belong to container');
select throws_ok($$select set_container_tare(gen_random_uuid(),'missing','default',20)$$,
                 'P0001', 'CONTAINER_INVALID', 'tare container must exist');
select throws_ok(format($q$select set_container_tare(gen_random_uuid(),'D-005-1L','default',%L)$q$, n),
                 'P0001', 'WEIGHT_INVALID', 'invalid tare: ' || n)
 from (values ('0'), ('-1'), ('NaN'), ('Infinity'), ('1000000000001')) v(n);
select test.reset_role();
select throws_ok($$insert into container_tares(container_id,variant,tare_grams)
                  values ('D-005-1L','glass_cap',20)$$, 'P0001', 'CONTAINER_INVALID', 'trigger protects direct tare writes');

-- tares hidden, reference data readable, clients cannot write or compute ------
select test.act_as('201');
select is((select count(*) from container_tares), 0::bigint, 'manager sees no tares');
select is((select count(*) from item_containers where id in ('D-004-1L','D-005-1L')), 2::bigint,
          'manager reads container reference data');
select throws_ok($$update item_containers set content_base_quantity=1 where id='D-004-1L'$$, '42501',
                 null, 'client cannot write containers');
select throws_ok($$insert into container_tares(container_id,variant,tare_grams) values ('D-004-1L','plastic_cap',200)$$,
                 '42501', null, 'client cannot write tares');
select throws_ok($$select app.compute_count_line(gen_random_uuid(),'D-004')$$, '42501', null,
                 'compute is not callable by clients');
select throws_ok($$select calc from count_lines$$, '42501', null,
                 'calc cannot leak tares through count_lines');
select test.act_as('100');
select is((select count(*) from container_tares where container_id in ('D-004-1L','D-005-1L')), 4::bigint,
          'owner reads exactly the four seeded tares');
select test.reset_role();
select ok(not has_function_privilege('anon', 'public.set_container_tare(uuid,text,text,numeric)', 'execute'),
          'anon cannot call setup');

-- compute: hand-built records, with exactly Task 8's stored entries shape -----
insert into counts(id,branch_id,period_month,status,revision) values
 ('c7b00000-0000-4000-8000-000000000001','BR-01','2026-01-01','draft',9),
 ('c7b00000-0000-4000-8000-000000000002','BR-01','2026-02-01','submitted',9),
 ('c7b00000-0000-4000-8000-000000000003','BR-01','2026-03-01','returned',9),
 ('c7b00000-0000-4000-8000-000000000004','BR-01','2026-04-01','approved',9);
insert into count_lines(count_id,item_id,state,base_quantity,revision,entries) values
 ('c7b00000-0000-4000-8000-000000000001','D-004','counted',0,7,
  '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":2,"closed_confirm":2,"open":2,"open_confirm":2,"weights":[{"grams":1100,"variant":"glass_pump"},{"grams":900,"variant":"plastic_pump"}]}]}'),
 ('c7b00000-0000-4000-8000-000000000001','D-005','counted',0,5,
  '{"packs":[{"unit":"كرتونة","quantity":2}],"containers":[{"container_id":"D-005-1L","closed":3,"closed_confirm":3,"open":2,"open_confirm":2,"weights":[{"grams":540.4,"variant":"default"},{"grams":290.2,"variant":"default"}]}]}');
create temporary table before_lines as select * from count_lines;
select app.compute_count_line('c7b00000-0000-4000-8000-000000000001','D-004');
select app.compute_count_line('c7b00000-0000-4000-8000-000000000001','D-005');
-- 2 x 1250 + (1100 - 620)/1 + (900 - 210)/1 = 3670 grams.
select is((select base_quantity from count_lines where item_id='D-004'), 3670::numeric, 'syrup hand computation');
-- 2 x 12 + 3 x 1 + (540.4 - 40)/1000 + (290.2 - 40)/1000 = 27.7506 -> 27.751.
select is((select base_quantity from count_lines where item_id='D-005'), 27.751::numeric, 'milk packs, divisor and rounding');
select is((select pending_setup from count_lines where item_id='D-004'), false, 'complete syrup setup');
select is((select calc->'packs' from count_lines where item_id='D-005'),
          '[{"unit":"كرتونة","rate":12}]'::jsonb, 'calc records pack rate');
select is((select calc->'containers' from count_lines where item_id='D-004'),
          '[{"container_id":"D-004-1L","content":1250,"tares":{"glass_pump":620,"plastic_pump":210}}]'::jsonb,
          'calc records content and the tares used');
select ok((select (calc->>'computed_at')::timestamptz between transaction_timestamp() and clock_timestamp()
           from count_lines where item_id='D-004'), 'calc records computation time');
select results_eq($$select item_id,entries,revision from count_lines order by item_id$$,
                  $$select item_id,entries,revision from before_lines order by item_id$$,
                  'compute preserves entries and revisions exactly');
create temporary table computed_syrup as select * from count_lines where item_id='D-004';

-- Missing plastic_cap tare: preserve readings, then resolve all open statuses.
update count_lines set entries=jsonb_set(entries,'{containers,0,weights,1,variant}','"plastic_cap"')
 where item_id='D-004';
select app.compute_count_line('c7b00000-0000-4000-8000-000000000001','D-004');
select is((select pending_setup from count_lines where item_id='D-004'), true, 'missing tare marks pending');
select is((select base_quantity from count_lines where item_id='D-004'), null::numeric, 'pending quantity is null');
select is((select entries from count_lines where item_id='D-004'),
          jsonb_set((select entries from before_lines where item_id='D-004'),'{containers,0,weights,1,variant}','"plastic_cap"'),
          'pending computation preserves original readings');
select is((select revision from count_lines where item_id='D-004'), 7, 'pending computation preserves revision');
insert into count_lines(count_id,item_id,state,base_quantity,pending_setup,revision,entries,calc)
 select c.id,l.item_id,l.state,l.base_quantity,l.pending_setup,l.revision,l.entries,l.calc
 from counts c cross join count_lines l
 where c.id <> l.count_id and c.status <> 'approved'
   and l.count_id='c7b00000-0000-4000-8000-000000000001' and l.item_id='D-004';
-- Approved line was fully computed with the original, complete readings.
insert into count_lines(count_id,item_id,state,base_quantity,pending_setup,revision,entries,calc)
 select 'c7b00000-0000-4000-8000-000000000004',item_id,state,base_quantity,pending_setup,revision,entries,calc
 from computed_syrup;
create temporary table approved_before as select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved';
select test.act_as('100');
select lives_ok($$select set_container_tare('f7b00000-0000-4000-8000-000000000020','D-004-1L','plastic_cap',200)$$,
                'owner fills missing tare');
select test.reset_role();
-- 2 x 1250 + (1100 - 620)/1 + (900 - 200)/1 = 3680, for draft/submitted/returned.
select is(l.base_quantity,3680::numeric,c.status || ': missing tare resolved to hand-computed 3680')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.pending_setup,false,c.status || ': no longer pending')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$, 'approved line unchanged byte for byte');
select app.compute_count_line('c7b00000-0000-4000-8000-000000000004','D-004');
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$, 'direct compute also leaves approved lines unchanged');
select is((select array_agg(revision order by id) from counts),array[9,9,9,9], 'no count revisions changed');
select is((select array_agg(revision order by count_id) from count_lines where item_id='D-004'),array[7,7,7,7],
          'eager recompute preserves line revisions');

-- Recompute on closed content; missing content can be imported and filled later.
select test.act_as('100');
select lives_ok($$select set_item_container('f7b00000-0000-4000-8000-000000000021','D-004-1L','D-004','عبوة 1 لتر',null,
 array['glass_pump','glass_cap','plastic_pump','plastic_cap'],true)$$, 'content may be unset');
select test.reset_role();
select is(l.pending_setup,true,c.status || ': missing content pending') from count_lines l join counts c on c.id=l.count_id
 where l.item_id='D-004' and c.status <> 'approved';
select is(l.base_quantity,null::numeric,c.status || ': missing content has no quantity') from count_lines l join counts c on c.id=l.count_id
 where l.item_id='D-004' and c.status <> 'approved';
select test.act_as('100');
select lives_ok($$select set_item_container('f7b00000-0000-4000-8000-000000000022','D-004-1L','D-004','عبوة 1 لتر',1300,
 array['glass_pump','glass_cap','plastic_pump','plastic_cap'],true)$$, 'owner fills closed content');
select test.reset_role();
-- 2 x 1300 + (1100 - 620)/1 + (900 - 200)/1 = 3780.
select is(l.base_quantity,3780::numeric,c.status || ': content recomputed to hand-computed 3780')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$, 'content change leaves approved line unchanged');
select is((select updated_by from container_tares where container_id='D-004-1L' and variant='plastic_cap'),
          (select id from app_users where employee_number='100'), 'tare records actor');
select ok((select updated_at between transaction_timestamp() and clock_timestamp() from container_tares
           where container_id='D-004-1L' and variant='plastic_cap'), 'tare records time');

-- State/quantity check must reject NULL for none (SQL CHECK accepts unknown).
select throws_ok($$update count_lines set state='none',base_quantity=null,pending_setup=false
                  where item_id='D-005'$$,'23514',null,'none requires an actual zero');
select throws_ok($$update count_lines set state='uncounted',base_quantity=null,pending_setup=true
                  where item_id='D-005'$$,'23514',null,'uncounted cannot be pending');
select throws_ok($$update count_lines set pending_setup=true where item_id='D-005'$$,
                 '23514',null,'counted quantity and pending flag must agree');

-- Review regressions: setup is allowed to outgrow the original saved readings.
-- Restore records between cases without rolling back pgTAP's assertion counter.
create temporary table review_lines as select * from count_lines;
delete from container_tares where container_id='D-004-1L' and variant='plastic_cap';
update count_lines l set entries=jsonb_set(l.entries,'{containers,0,weights,1,grams}','150')
 from counts c where c.id=l.count_id and c.status <> 'approved' and l.item_id='D-004';
select app.compute_count_line(c.id,'D-004') from counts c where c.status <> 'approved' order by c.id;
create temporary table saved_readings as
 select count_id,item_id,entries,revision from count_lines where item_id='D-004';
select is(l.pending_setup,true,c.status || ': missing tare is pending before owner sets it')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select test.act_as('100');
select lives_ok($$select set_container_tare('f7b00000-0000-4000-8000-000000000030','D-004-1L','plastic_cap',200)$$,
                'owner can set a tare above an existing reading');
select test.reset_role();
select is((select tare_grams from container_tares where container_id='D-004-1L' and variant='plastic_cap'),
          200::numeric, 'new tare persisted despite an older 150 g reading');
select is(l.pending_setup,true,c.status || ': below-current-tare reading remains pending')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.base_quantity,null::numeric,c.status || ': below-current-tare quantity is null')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
-- weight_index is zero-based, matching the JSON array index of the 150 g reading.
select is(l.calc->'problems','[{"container_id":"D-004-1L","weight_index":1,"reason":"below_tare"}]'::jsonb,
          c.status || ': calc identifies the below-tare reading')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select lives_ok(format($$select app.compute_count_line(%L,'D-004')$$,c.id),
                c.status || ': approval-style recompute does not raise for below-tare reading')
 from counts c where c.status <> 'approved';
select results_eq($$select count_id,item_id,entries,revision from count_lines where item_id='D-004' order by count_id$$,
                  $$select * from saved_readings order by count_id$$,'below-tare recompute preserves readings/revisions');
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$,'below-tare setup change preserves approved line');
-- Malformed readings must still raise rather than becoming a setup problem.
update count_lines set entries=jsonb_set(entries,'{containers,0,weights}','{}')
 where count_id='c7b00000-0000-4000-8000-000000000001' and item_id='D-004';
select throws_ok($$select app.compute_count_line('c7b00000-0000-4000-8000-000000000001','D-004')$$,
                 'P0001','ENTRIES_INVALID','malformed weights array still refused');
update count_lines l set (entries,base_quantity,pending_setup,calc,revision) =
 (b.entries,b.base_quantity,b.pending_setup,b.calc,b.revision)
 from review_lines b where l.count_id=b.count_id and l.item_id=b.item_id;
insert into container_tares(container_id,variant,tare_grams) values ('D-004-1L','plastic_cap',200)
 on conflict (container_id,variant) do update set tare_grams=excluded.tare_grams;
drop table saved_readings;

delete from container_tares where container_id='D-004-1L' and variant='plastic_cap';
select app.compute_count_line(c.id,'D-004') from counts c where c.status <> 'approved' order by c.id;
create temporary table saved_readings as
 select count_id,item_id,entries,revision from count_lines where item_id='D-004';
select test.act_as('100');
select lives_ok($$select set_item_container('f7b00000-0000-4000-8000-000000000031','D-004-1L','D-004','عبوة 1 لتر',1300,
 array['glass_pump','glass_cap','plastic_pump'],true)$$,'owner removes a variant used by a saved reading');
select test.reset_role();
select is((select variants from item_containers where id='D-004-1L'),
          array['glass_pump','glass_cap','plastic_pump'],'variant removal persisted');
select is(l.pending_setup,true,c.status || ': removed variant is pending')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.base_quantity,null::numeric,c.status || ': removed variant has null quantity')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.calc->'problems','[{"container_id":"D-004-1L","weight_index":1,"reason":"variant_removed"}]'::jsonb,
          c.status || ': calc identifies the removed variant')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select lives_ok(format($$select app.compute_count_line(%L,'D-004')$$,c.id),
                c.status || ': approval-style recompute does not raise for removed variant')
 from counts c where c.status <> 'approved';
select results_eq($$select count_id,item_id,entries,revision from count_lines where item_id='D-004' order by count_id$$,
                  $$select * from saved_readings order by count_id$$,'removed-variant recompute preserves readings/revisions');
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$,'variant removal preserves approved line');
update item_containers set variants=array['glass_pump','glass_cap','plastic_pump','plastic_cap'] where id='D-004-1L';
insert into container_tares(container_id,variant,tare_grams) values ('D-004-1L','plastic_cap',200);
update count_lines l set (entries,base_quantity,pending_setup,calc,revision) =
 (b.entries,b.base_quantity,b.pending_setup,b.calc,b.revision)
 from review_lines b where l.count_id=b.count_id and l.item_id=b.item_id;
drop table saved_readings;

-- Net grams can be missing after import; the owner's setup call resolves all
-- open statuses through the same ordered recompute helper as container changes.
update items set net_grams_per_base_unit=null where id='D-004';
select app.compute_count_line(c.id,'D-004') from counts c where c.status <> 'approved' order by c.id;
create temporary table saved_readings as
 select count_id,item_id,entries,revision from count_lines;
select is(l.pending_setup,true,c.status || ': missing net grams is pending')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.base_quantity,null::numeric,c.status || ': missing net grams has null quantity')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select test.act_as('100');
select lives_ok($$select set_item_count_setup('f7b00000-0000-4000-8000-000000000032','D-004',true,'containers',1)$$,
                'owner fills missing net grams');
select test.reset_role();
-- Current content is 1300: 2 x 1300 + (1100 - 620)/1 + (900 - 200)/1 = 3780.
select is(l.base_quantity,3780::numeric,c.status || ': net grams fill resolves to hand-computed 3780')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select is(l.pending_setup,false,c.status || ': net grams fill clears pending setup')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select test.act_as('100');
select lives_ok($$select set_item_count_setup('f7b00000-0000-4000-8000-000000000033','D-004',true,'containers',2)$$,
                'owner changes an existing net grams factor');
select test.reset_role();
-- 2 x 1300 + (1100 - 620)/2 + (900 - 200)/2 = 3190.
select is(l.base_quantity,3190::numeric,c.status || ': factor change recomputes to hand-computed 3190')
 from count_lines l join counts c on c.id=l.count_id where l.item_id='D-004' and c.status <> 'approved';
select results_eq($$select count_id,item_id,entries,revision from count_lines order by count_id,item_id$$,
                  $$select * from saved_readings order by count_id,item_id$$,'net grams recompute preserves readings/revisions');
-- D-005 is unrelated to this item's factor; it is not recomputed.
select is((select base_quantity from count_lines where item_id='D-005'),27.751::numeric,
          'item-based recompute leaves the other item unchanged'); -- 2x12 + 3 + 500.4/1000 + 250.2/1000.
select results_eq($$select l.* from count_lines l join counts c on c.id=l.count_id where c.status='approved'$$,
                  $$select * from approved_before$$,'net grams recompute preserves approved line');
update items set net_grams_per_base_unit=1 where id='D-004';
update count_lines l set (entries,base_quantity,pending_setup,calc,revision) =
 (b.entries,b.base_quantity,b.pending_setup,b.calc,b.revision)
 from review_lines b where l.count_id=b.count_id and l.item_id=b.item_id;
drop table saved_readings;

-- Guard each open status independently: only an approved count may outlive a
-- method/counting switch. An unchanged setup remains a valid logged no-op.
update counts set status='approved';
update counts set status='draft' where id='c7b00000-0000-4000-8000-000000000001';
select test.act_as('100');
select lives_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',true,'containers',1)$$,
                'same settings succeed with an open counted line');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',true,'units',null)$$,
                 'P0001','COUNT_LOCKED','draft counted line blocks a method change');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',false,'containers',1)$$,
                 'P0001','COUNT_LOCKED','draft counted line blocks a counted-flag change');
select test.reset_role();
update counts set status='submitted' where id='c7b00000-0000-4000-8000-000000000001';
select test.act_as('100');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',true,'units',null)$$,
                 'P0001','COUNT_LOCKED','submitted counted line blocks a method change');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',false,'containers',1)$$,
                 'P0001','COUNT_LOCKED','submitted counted line blocks a counted-flag change');
select test.reset_role();
update counts set status='returned' where id='c7b00000-0000-4000-8000-000000000001';
select test.act_as('100');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',true,'units',null)$$,
                 'P0001','COUNT_LOCKED','returned counted line blocks a method change');
select throws_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',false,'containers',1)$$,
                 'P0001','COUNT_LOCKED','returned counted line blocks a counted-flag change');
select test.reset_role();
select is((select row(counted,count_method,net_grams_per_base_unit)::text from items where id='D-004'),
          '(t,containers,1)','rejected switches leave setup unchanged');
create temporary table before_switch as select * from count_lines;
update counts set status='approved';
select test.act_as('100');
select lives_ok($$select set_item_count_setup(gen_random_uuid(),'D-004',false,'units',null)$$,
                'method and counted flag can change after approval');
select test.reset_role();
select is((select row(counted,count_method,net_grams_per_base_unit)::text from items where id='D-004'),
          '(f,units,)','post-approval switch persisted');
select results_eq($$select * from count_lines order by count_id,item_id$$,
                  $$select * from before_switch order by count_id,item_id$$,'post-approval switch leaves historical lines unchanged');

select * from finish();
rollback;
