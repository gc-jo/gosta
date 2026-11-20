begin;
select no_plan();

-- Task 9 scenarios use distinct months so committed-style ledger rows stay
-- insert-only; every count is started/saved through the actual Task 8 RPCs.
create schema t9;
grant usage on schema t9 to authenticated;
create temporary table review_cases (name text primary key, id uuid, frozen_at timestamptz);
create temporary table review_results (name text primary key, result jsonb);
grant select, insert, update on review_cases, review_results to authenticated;
create function t9.id(p_name text) returns uuid language sql stable as $$
  select id from pg_temp.review_cases where name=p_name
$$;
create function t9.fill(p_id uuid, p_syrup jsonb default null) returns void language plpgsql as $$
begin
  -- 1 x 9000 + 2 x 750 = 10500 ml; the other three items are explicit zeroes.
  perform save_count_line(p_id,'D-001',0,'counted','[{"unit":"كرتونة","quantity":1},{"unit":"عبوة","quantity":2}]');
  perform save_count_line(p_id,'D-002',0,'none',null);
  perform save_count_line(p_id,'D-004',0,case when p_syrup is null then 'none' else 'counted' end,p_syrup);
  perform save_count_line(p_id,'D-005',0,'none',null);
end;
$$;
create function t9.start(p_month date, p_complete boolean default true, p_syrup jsonb default null)
returns uuid language plpgsql as $$
declare v_month date; v_id uuid;
begin
  perform test.act_as('100');
  for v_month in select period_month from count_windows where branch_id='BR-01' and status='open' order by period_month loop
    perform close_count_window(gen_random_uuid(),'BR-01',v_month);
  end loop;
  perform open_count_window(gen_random_uuid(),'BR-01',p_month);
  perform test.act_as('201');
  v_id := (start_count(gen_random_uuid())->>'count_id')::uuid;
  if p_complete then perform t9.fill(v_id,p_syrup); end if;
  return v_id;
end;
$$;
create function t9.call(p_sql text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin execute p_sql into v_result; return v_result; end;
$$;
grant execute on function t9.id(text) to authenticated;
grant execute on function t9.fill(uuid,jsonb) to authenticated;
grant execute on function t9.start(date,boolean,jsonb) to authenticated;
grant execute on function t9.call(text) to authenticated;

-- Session/role guards, null request ids, incomplete submit, and frozen zero.
set local role authenticated;
select throws_ok($$select submit_count(gen_random_uuid(),gen_random_uuid(),0)$$,'P0001','NOT_AUTHENTICATED','submit requires session');
select throws_ok($$select review_count(gen_random_uuid(),gen_random_uuid(),'approve')$$,'P0001','NOT_AUTHENTICATED','review requires session');
select throws_ok($$select zero_branch_balance(gen_random_uuid(),'BR-01')$$,'P0001','NOT_AUTHENTICATED','zero requires session');
select throws_ok($$select count_line_calcs(gen_random_uuid())$$,'P0001','NOT_AUTHENTICATED','calcs requires session');
select test.reset_role();
insert into review_cases(name,id) values ('incomplete',t9.start('2026-01-01',false));
select save_count_line(t9.id('incomplete'),'D-001',0,'none',null);
select throws_ok($$select submit_count(null,t9.id('incomplete'),1)$$,'P0001','REQUEST_ID_REQUIRED','submit request id required');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('incomplete'),1)$$,'P0001','COUNT_INCOMPLETE','one of four items saved is incomplete');
select throws_ok($$select review_count(gen_random_uuid(),t9.id('incomplete'),'approve')$$,'P0001','FORBIDDEN','manager cannot review');
select throws_ok($$select zero_branch_balance(gen_random_uuid(),'BR-01')$$,'P0001','FORBIDDEN','manager cannot zero');
select throws_ok($$select count_line_calcs(t9.id('incomplete'))$$,'P0001','FORBIDDEN','201 cannot read calcs');
select test.act_as('100');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('incomplete'),1)$$,'P0001','FORBIDDEN','owner cannot submit');
select throws_ok($$select review_count(null,t9.id('incomplete'),'approve')$$,'P0001','REQUEST_ID_REQUIRED','review request id required');
select throws_ok($$select zero_branch_balance(null,'BR-01')$$,'P0001','REQUEST_ID_REQUIRED','zero request id required');
select throws_ok($$select review_count(gen_random_uuid(),t9.id('incomplete'),'approve')$$,'P0001','COUNT_NOT_SUBMITTED','approve unsubmitted');
select throws_ok($$select zero_branch_balance(gen_random_uuid(),'BR-01')$$,'P0001','BRANCH_FROZEN','zero while frozen');
select test.reset_role();
select is((select row(status,revision,submitted_at)::text from counts where id=t9.id('incomplete')),'(draft,1,)','failed submit leaves draft and revision');
select ok((select frozen_since is not null from counts where id=t9.id('incomplete')),'failed submit keeps freeze');
select is((select count(*) from count_lines where count_id=t9.id('incomplete') and state='uncounted'),3::bigint,'three unsaved lines preserved');
select is((select count(*) from stock_baselines where branch_id='BR-01'),0::bigint,'failed submit/approve/zero writes no baseline');
select test.act_as('100');
select discard_count(gen_random_uuid(),t9.id('incomplete'));

-- Stale summary, timestamp order, submission unfreezes, post-submit movement.
insert into review_cases(name,id) values ('ordered',t9.start('2026-02-01'));
update review_cases set frozen_at=(select frozen_since from counts where id=t9.id('ordered')) where name='ordered';
-- plan line 658 says revision 2; stale since Task 7b added D-004/D-005.
select is((select revision from counts where id=t9.id('ordered')),4,'four successful line saves give count revision 4');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('ordered'),1)$$,'P0001','STALE_WRITE','submit stale summary');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('ordered'),null)$$,'P0001','STALE_WRITE','null revision cannot submit');
select test.act_as('202');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('ordered'),4)$$,'P0001','FORBIDDEN','other branch cannot submit');
select test.act_as('201');
select is((select row(status,revision,submitted_at)::text from counts where id=t9.id('ordered')),'(draft,4,)','stale/foreign submissions changed no count state');
insert into review_results values ('submit_ordered',submit_count('f9000000-0000-4000-8000-000000000001',t9.id('ordered'),4));
select is((select status from counts where id=t9.id('ordered')),'submitted','submit stores status');
select ok((select frozen_since is null from counts where id=t9.id('ordered')),'submit lifts freeze');
select is((select submitted_at from counts where id=t9.id('ordered')),
          (select (result->>'submitted_at')::timestamptz from review_results where name='submit_ordered'),'stored submit timestamp equals response');
select is((select submitted_by from counts where id=t9.id('ordered')),
          (select id from app_users where employee_number='201'),'submit stores manager identity');
select is((select count(*) from count_lines l join counts c on c.id=l.count_id
           where c.id=t9.id('ordered') and l.effective_at=c.submitted_at and not l.needs_recount),4::bigint,
          'all four first-round lines receive exactly submitted_at');
select throws_ok($$select save_count_line(t9.id('ordered'),'D-001',1,'none',null)$$,'P0001','COUNT_LOCKED','submitted count cannot autosave');
insert into review_results values ('purchase_ordered',create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]'));
select test.reset_role();
select ok((select m.occurred_at > c.submitted_at and c.submitted_at > x.frozen_at
 from counts c join review_cases x on x.id=c.id
 join purchases p on p.id=(select (result->>'purchase_id')::uuid from review_results where name='purchase_ordered')
 join purchase_lines l on l.purchase_id=p.id join stock_movements m on m.ref_id=l.id and m.kind='purchase_in'
 where x.name='ordered'),'purchase movement > submit > original freeze within one transaction');
select test.act_as('100');
select review_count(gen_random_uuid(),t9.id('ordered'),'approve');
-- 10500 counted + 1 x 750 purchased after submission = 11250 ml.
select is(test.balance('BR-01','D-001'),11250::numeric,'movement after submit remains above baseline');

-- A purchase of 9000 before the next count is replaced by the new baseline.
select test.act_as('201');
select create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"كرتونة","quantity":1}]');
insert into review_cases(name,id) values ('baseline',t9.start('2026-03-01'));
insert into review_results values ('submit_baseline',submit_count(gen_random_uuid(),t9.id('baseline'),4));
select test.act_as('100');
insert into review_results values ('approve_baseline',review_count('f9000000-0000-4000-8000-000000000002',t9.id('baseline'),'approve'));
select test.reset_role();
-- 1 x 9000 + 2 x 750 = 10500; the earlier 9000 purchase is superseded.
select is(test.balance('BR-01','D-001'),10500::numeric,'approval replaces all pre-count movements');
-- Two original items + D-004/D-005 = four count baselines.
-- Task 7b added D-004/D-005: baseline count is 4, not the original 2.
select is((select count(*) from stock_baselines where source='count' and ref_id=t9.id('baseline')),4::bigint,'one baseline per count line');
select is((select base_quantity from stock_baselines where ref_id=t9.id('baseline') and item_id='D-002'),0::numeric,'none creates zero baseline');
select is(test.balance('BR-01','D-002'),0::numeric,'none baseline makes cups balance zero');
select is((select count(*) from stock_baselines b join count_lines l on l.count_id=b.ref_id and l.item_id=b.item_id
           join counts c on c.id=b.ref_id where b.ref_id=t9.id('baseline') and b.branch_id=c.branch_id
           and b.base_quantity=l.base_quantity and b.effective_at=l.effective_at and b.effective_at=c.submitted_at
           and b.created_by=(select id from app_users where employee_number='100')),4::bigint,'all baseline quantities, authors and exact times match stored lines');
select is((select status from counts where id=t9.id('baseline')),'approved','approval stored');
select ok((select reviewed_at > submitted_at and reviewed_by=(select id from app_users where employee_number='100')
           from counts where id=t9.id('baseline')),'approval records owner and later review time');

-- Selective return: validation failures leave every row untouched.
insert into review_cases(name,id) values ('recount',t9.start('2026-04-01'));
insert into review_results values ('submit_recount_first',submit_count(gen_random_uuid(),t9.id('recount'),4));
select test.reset_role();
create temporary table recount_before as select to_jsonb(l) as value from count_lines l where count_id=t9.id('recount');
create temporary table recount_count_before as select to_jsonb(c) as value from counts c where id=t9.id('recount');
select test.act_as('100');
select throws_ok(format('select review_count(gen_random_uuid(),t9.id(''recount''),''return'',null,%L)',note),
                 'P0001','NOTE_REQUIRED','return requires nonblank note') from (values (null::text),(''),('   ')) v(note);
select throws_ok($$select review_count(gen_random_uuid(),t9.id('recount'),'return',array['D-001','D-006'],'recount')$$,
                 'P0001','ITEM_INVALID','return validates every selected item before writing');
select throws_ok($$select review_count(gen_random_uuid(),t9.id('recount'),'return',array[]::text[],'recount')$$,
                 'P0001','ITEM_INVALID','empty return selection is invalid');
select throws_ok($$select review_count(gen_random_uuid(),t9.id('recount'),'return',array[null]::text[],'recount')$$,
                 'P0001','ITEM_INVALID','null selected item is invalid');
select throws_ok($$select review_count(gen_random_uuid(),t9.id('recount'),'other')$$,'P0001','FORBIDDEN','unknown review action refused');
select test.reset_role();
select results_eq($$select to_jsonb(l) from count_lines l where count_id=t9.id('recount') order by item_id$$,
                  $$select value from recount_before order by (value->>'item_id') collate "C"$$,'invalid returns change no line');
select is((select to_jsonb(c) from counts c where id=t9.id('recount')),(select value from recount_count_before),'invalid returns change no count');
select test.act_as('100');
insert into review_results values ('return_selected',review_count('f9000000-0000-4000-8000-000000000003',t9.id('recount'),'return',array['D-001'],'  recount syrup  '));
select test.reset_role();
select is((select row(state,base_quantity,revision,needs_recount,pending_setup)::text from count_lines
           where count_id=t9.id('recount') and item_id='D-001'),'(uncounted,,2,t,f)','selected line cleared and revision incremented');
select ok((select entries in ('{}'::jsonb,'[]'::jsonb) and calc is null from count_lines
           where count_id=t9.id('recount') and item_id='D-001'),'selected entries and obsolete calc cleared');
select results_eq($$select to_jsonb(l) from count_lines l where count_id=t9.id('recount') and item_id<>'D-001' order by item_id$$,
                  $$select value from recount_before where value->>'item_id'<>'D-001' order by (value->>'item_id') collate "C"$$,'unselected rows unchanged');
select is((select row(status,frozen_since)::text from counts where id=t9.id('recount')),
          '(returned,)','return remains unfrozen');
select is((select review_note from counts where id=t9.id('recount')),'recount syrup','return normalizes note');
select test.act_as('201');
select throws_ok($$select save_count_line(t9.id('recount'),'D-001',2,'none',null)$$,'P0001','COUNT_NOT_STARTED','save cannot start returned count');
select throws_ok($$select submit_count(gen_random_uuid(),t9.id('recount'),4)$$,'P0001','COUNT_NOT_STARTED','recount must explicitly start before submit');
select create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]');
select test.act_as('301');
insert into review_results values ('send_cups',send_transfer(gen_random_uuid(),'BR-01','[{"item_id":"D-002","quantity":5,"unit":"حبة","cost_total":5}]'));
select test.act_as('201');
select receive_transfer(gen_random_uuid(),(select (result->>'transfer_id')::uuid from review_results where name='send_cups'),
 (select jsonb_agg(jsonb_build_object('line_id',id,'quantity',5,'unit','حبة')) from transfer_lines
  where transfer_id=(select (result->>'transfer_id')::uuid from review_results where name='send_cups')));
select start_count(gen_random_uuid());
select ok((select frozen_since > submitted_at from counts where id=t9.id('recount')),'explicit recount freezes after first submit');
select throws_ok($$select save_count_line(t9.id('recount'),'D-002',1,'none',null)$$,'P0001','COUNT_LOCKED','only marked lines can be recounted');
select save_count_line(t9.id('recount'),'D-001',2,'counted','[{"unit":"عبوة","quantity":12}]');
select is((select revision from counts where id=t9.id('recount')),5,'four original saves plus one recount save = revision 5');
insert into review_results values ('submit_recount_second',submit_count(gen_random_uuid(),t9.id('recount'),5));
select test.reset_role();
select is((select effective_at from count_lines where count_id=t9.id('recount') and item_id='D-001'),
          (select (result->>'submitted_at')::timestamptz from review_results where name='submit_recount_second'),'selected line uses resubmit time');
select is((select effective_at from count_lines where count_id=t9.id('recount') and item_id='D-002'),
          (select (result->>'submitted_at')::timestamptz from review_results where name='submit_recount_first'),'unselected cups retain first submit time');
select is((select count(*) from count_lines where count_id=t9.id('recount') and needs_recount),0::bigint,'resubmit clears recount flags');
select test.act_as('100');
select review_count(gen_random_uuid(),t9.id('recount'),'approve');
-- Recount 12 x 750 = 9000 replaces the intervening 750 ml purchase.
select is(test.balance('BR-01','D-001'),9000::numeric,'recount baseline supersedes intervening purchase');
-- Original cups count 0 + 5 x 1 received after its first submit = 5 pieces.
select is(test.balance('BR-01','D-002'),5::numeric,'untouched item retains intervening real transfer receipt');
select test.reset_role();
select is((select count(*) from stock_baselines b join count_lines l on l.count_id=b.ref_id and l.item_id=b.item_id
           where b.ref_id=t9.id('recount') and b.effective_at=l.effective_at),4::bigint,'recount approval preserves every line-specific effective time');

-- Full return, including a pending line, and abandoned recount discard.
insert into review_cases(name,id) values ('abandoned',t9.start('2026-05-01',true,
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":0,"closed_confirm":0,"open":1,"open_confirm":1,"weights":[{"grams":700,"variant":"plastic_cap"}]}]}'));
select submit_count(gen_random_uuid(),t9.id('abandoned'),4);
select test.act_as('100');
select review_count(gen_random_uuid(),t9.id('abandoned'),'return',null,'whole count');
select test.reset_role();
select is((select count(*) from count_lines where count_id=t9.id('abandoned') and state='uncounted'
           and base_quantity is null and not pending_setup and needs_recount and revision=2),4::bigint,
          'full return clears all four lines including pending setup');
select test.act_as('201');
select start_count(gen_random_uuid());
select test.act_as('100');
select discard_count(gen_random_uuid(),t9.id('abandoned'));
select test.reset_role();
select is((select count(*) from counts where id=t9.id('abandoned')),0::bigint,'abandoned recount count deleted');
select is((select count(*) from count_lines where count_id=t9.id('abandoned')),0::bigint,'abandoned recount lines deleted');
select is((select count(*) from counts where branch_id='BR-01' and frozen_since is not null),0::bigint,'abandoned recount no longer freezes branch');

-- Month rollover does not strand November drafts; submitted discard refused.
insert into review_cases(name,id) values ('rollover',t9.start('2026-11-01',false));
select test.act_as('100');
select close_count_window(gen_random_uuid(),'BR-01','2026-11-01');
select open_count_window(gen_random_uuid(),'BR-01','2026-12-01');
select test.act_as('201');
select t9.fill(t9.id('rollover'));
select submit_count(gen_random_uuid(),t9.id('rollover'),4);
select is((select row(period_month,status,frozen_since)::text from counts where id=t9.id('rollover')),
          '(2026-11-01,submitted,)','closed November count can still save and submit');
select test.act_as('100');
select throws_ok($$select discard_count(gen_random_uuid(),t9.id('rollover'))$$,'P0001','COUNT_NOT_OPEN','cannot discard submitted count');

-- Pending setup submits, blocks approval atomically, then a tare unblocks it.
insert into review_cases(name,id) values ('pending',t9.start('2027-01-01',true,
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":0,"closed_confirm":0,"open":1,"open_confirm":1,"weights":[{"grams":700,"variant":"plastic_cap"}]}]}'));
insert into review_results values ('submit_pending',submit_count(gen_random_uuid(),t9.id('pending'),4));
select test.reset_role();
create temporary table pending_lines as select to_jsonb(l) as value from count_lines l where count_id=t9.id('pending');
create temporary table pending_count as select to_jsonb(c) as value from counts c where id=t9.id('pending');
create temporary table pending_logs as select count(*) as n from activity_log where action='review_count';
select is((select row(state,base_quantity,pending_setup)::text from count_lines where count_id=t9.id('pending') and item_id='D-004'),
          '(counted,,t)','pending line remains counted with null quantity after submit');
select test.act_as('100');
select throws_ok($$select review_count('f9000000-0000-4000-8000-000000000004',t9.id('pending'),'approve')$$,
                 'P0001','SETUP_INCOMPLETE','pending setup blocks approval');
select test.reset_role();
select is((select count(*) from stock_baselines where ref_id=t9.id('pending')),0::bigint,'failed approval writes no baseline');
select is((select to_jsonb(c) from counts c where id=t9.id('pending')),(select value from pending_count),'failed approval leaves submitted count untouched');
select results_eq($$select to_jsonb(l) from count_lines l where count_id=t9.id('pending') order by item_id$$,
                  $$select value from pending_lines order by (value->>'item_id') collate "C"$$,'failed approval rolls back even computed_at changes');
select is((select count(*) from rpc_requests where request_id='f9000000-0000-4000-8000-000000000004'),0::bigint,'failed approval stores no request result');
select is((select count(*) from activity_log where action='review_count'),(select n from pending_logs),'failed approval logs nothing');
select test.act_as('100');
select set_container_tare(gen_random_uuid(),'D-004-1L','plastic_cap',200);
select review_count('f9000000-0000-4000-8000-000000000004',t9.id('pending'),'approve');
select test.reset_role();
-- No closed containers; (700 - 200)/1 = 500 grams.
select is((select base_quantity from stock_baselines where ref_id=t9.id('pending') and item_id='D-004'),500::numeric,'new tare unblocks hand-computed baseline');
select is(test.balance('BR-01','D-004'),500::numeric,'pending count balance after approval');

-- Approval must recompute EVERY containers line, even if eager setup recompute
-- missed it. Restore old materialized values as postgres to model that state.
insert into review_cases(name,id) values ('current_setup',t9.start('2027-02-01',true,
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":2,"closed_confirm":2,"open":2,"open_confirm":2,"weights":[{"grams":1000,"variant":"glass_pump"},{"grams":700,"variant":"plastic_pump"}]}]}'));
select save_count_line(t9.id('current_setup'),'D-005',1,'counted',
 '{"packs":[{"unit":"كرتونة","quantity":1}],"containers":[{"container_id":"D-005-1L","closed":3,"closed_confirm":3,"open":1,"open_confirm":1,"weights":[{"grams":640,"variant":"default"}]}]}');
select submit_count(gen_random_uuid(),t9.id('current_setup'),5);
select test.reset_role();
create temporary table old_setup_lines as select * from count_lines where count_id=t9.id('current_setup') and item_id in ('D-004','D-005');
select test.act_as('100');
select set_container_tare(gen_random_uuid(),'D-004-1L','glass_pump',600);
select set_item_count_setup(gen_random_uuid(),'D-005',true,'containers',2000);
select test.reset_role();
update count_lines l set base_quantity=o.base_quantity,calc=o.calc from old_setup_lines o
 where l.count_id=o.count_id and l.item_id=o.item_id;
select test.act_as('100');
select review_count(gen_random_uuid(),t9.id('current_setup'),'approve');
select test.reset_role();
create temporary table approved_lines as select to_jsonb(l) as value from count_lines l where count_id=t9.id('current_setup');
create temporary table approved_baselines as select to_jsonb(b) as value from stock_baselines b where ref_id=t9.id('current_setup');
create temporary table calcs_logs_before as select count(*) as n from activity_log;
select test.act_as('100');
insert into review_results values ('owner_calcs',count_line_calcs(t9.id('current_setup')));
select ok((select result->'D-004' @> '{"containers":[{"container_id":"D-004-1L","tares":{"glass_pump":600,"plastic_pump":210}}]}'
           from review_results where name='owner_calcs'),'owner calcs RPC exposes approved tares');
select is(count_line_calcs('ffffffff-ffff-4fff-8fff-ffffffffffff'),'{}'::jsonb,'unknown count has empty calcs object');
select throws_ok($$select calc from count_lines$$,'42501',null,'owner still has no direct calc grant');
select test.act_as('201');
select throws_ok($$select count_line_calcs(t9.id('current_setup'))$$,'P0001','FORBIDDEN','201 cannot call owner calcs RPC');
select test.reset_role();
select is((select count(*) from activity_log),(select n from calcs_logs_before),'read-only calcs RPC writes no log');
-- 2 x 1250 + (1000 - 600) + (700 - 210) = 3390 grams.
select is((select base_quantity from stock_baselines where ref_id=t9.id('current_setup') and item_id='D-004'),3390::numeric,'approval uses current glass tare, not stale 3370');
-- 1 x 12 + 3 x 1 + (640 - 40)/2000 = 15.3 bottles.
select is((select base_quantity from stock_baselines where ref_id=t9.id('current_setup') and item_id='D-005'),15.3::numeric,'approval also recomputes milk, not stale 15.6');
select results_eq($$select item_id,entries,revision,effective_at from count_lines where count_id=t9.id('current_setup') and item_id in ('D-004','D-005') order by item_id$$,
                  $$select item_id,entries,revision,effective_at from old_setup_lines order by item_id$$,'approval preserves entries, revisions and effective times');
select is((select result from review_results where name='owner_calcs'),
          (select jsonb_object_agg(item_id,calc) from count_lines where count_id=t9.id('current_setup')),'calcs response maps every line and exactly its stored calc');
select test.act_as('100');
select set_container_tare(gen_random_uuid(),'D-004-1L','glass_pump',640);
select set_item_container(gen_random_uuid(),'D-004-1L','D-004','عبوة 1 لتر',1300,
 array['glass_pump','glass_cap','plastic_pump','plastic_cap'],true);
select test.reset_role();
select results_eq($$select to_jsonb(l) from count_lines l where count_id=t9.id('current_setup') order by item_id$$,
                  $$select value from approved_lines order by (value->>'item_id') collate "C"$$,'approved lines and calc never recomputed after tare/content edits');
select results_eq($$select to_jsonb(b) from stock_baselines b where ref_id=t9.id('current_setup') order by item_id$$,
                  $$select value from approved_baselines order by (value->>'item_id') collate "C"$$,'approved baselines unchanged after setup edits');

-- Owner zero covers every ACTIVE item, including excluded-from-count D-006.
select test.act_as('201');
insert into review_results values ('purchase_before_zero',create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]'));
select test.act_as('100');
select throws_ok($$select zero_branch_balance(gen_random_uuid(),'missing')$$,'P0001','BRANCH_INVALID','zero validates branch');
select throws_ok($$select zero_branch_balance(gen_random_uuid(),'BR-09')$$,'P0001','BRANCH_INVALID','zero validates active branch');
insert into review_results values ('zero',zero_branch_balance('f9000000-0000-4000-8000-000000000005',' BR-01 '));
-- D-001, D-002, D-004, D-005, D-006 are active: five zero baselines.
-- Task 7b fixtures: D-004/D-005 add two zeroed items; D-006 is also active despite counted=false.
select is((select result from review_results where name='zero'),'{"branch_id":"BR-01","items":5}'::jsonb,'zero response counts all five active items');
select test.reset_role();
select is((select array_agg(item_id order by item_id) from stock_baselines where branch_id='BR-01' and source='owner_zero'),
          array['D-001','D-002','D-004','D-005','D-006'],'zero creates exactly the active-item set');
select is((select count(distinct effective_at) from stock_baselines where branch_id='BR-01' and source='owner_zero'),1::bigint,'zero uses one branch-lock timestamp');
select is((select count(*) from stock_baselines where branch_id='BR-01' and source='owner_zero' and base_quantity=0
           and created_by=(select id from app_users where employee_number='100')),5::bigint,'zero baselines store zero and owner');
select ok((select bool_and(b.effective_at > m.occurred_at) from stock_baselines b cross join stock_movements m
           join purchase_lines l on l.id=m.ref_id
           where b.source='owner_zero' and b.branch_id='BR-01' and m.kind='purchase_in'
           and l.purchase_id=(select (result->>'purchase_id')::uuid from review_results where name='purchase_before_zero')),
          'zero timestamp follows pre-zero purchase movement');
select is(test.balance('BR-01',id),0::numeric,'zero balance: ' || id) from items where active order by id;
select test.act_as('201');
select create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]');
-- Zero baseline + 1 x 750 after zero = 750 ml.
select is(test.balance('BR-01','D-001'),750::numeric,'later purchase adds above zero baseline');

-- Replay, changed payload/user/RPC, normalized optional note, and logs.
select test.reset_role();
create temporary table replay_calls (id uuid, employee text, sql text, changed text);
insert into replay_calls values
 ('f9000000-0000-4000-8000-000000000001','201',
 $$select submit_count('f9000000-0000-4000-8000-000000000001',t9.id('ordered'),4)$$,
 $$select submit_count('f9000000-0000-4000-8000-000000000001',t9.id('ordered'),3)$$),
 ('f9000000-0000-4000-8000-000000000002','100',
 $$select review_count('f9000000-0000-4000-8000-000000000002',t9.id('baseline'),'approve',null,'   ')$$,
 $$select review_count('f9000000-0000-4000-8000-000000000002',t9.id('baseline'),'return',null,'different')$$),
 ('f9000000-0000-4000-8000-000000000003','100',
 $$select review_count('f9000000-0000-4000-8000-000000000003',t9.id('recount'),'return',array['D-001'],'recount syrup')$$,
 $$select review_count('f9000000-0000-4000-8000-000000000003',t9.id('recount'),'return',array['D-002'],'recount syrup')$$),
 ('f9000000-0000-4000-8000-000000000005','100',
 $$select zero_branch_balance('f9000000-0000-4000-8000-000000000005','BR-01')$$,
 $$select zero_branch_balance('f9000000-0000-4000-8000-000000000005','BR-02')$$);
create temporary table replay_before as select r.*, (select count(*) from activity_log a where a.action=r.rpc_name) as logs
 from rpc_requests r join replay_calls c on c.id=r.request_id;
create temporary table all_baselines_before as select count(*) as n from stock_baselines;
grant select on replay_calls,replay_before to authenticated;
select test.act_as('201');
select is(t9.call(c.sql),b.result,'submit replay after approval is identical') from replay_calls c join replay_before b on b.request_id=c.id where employee='201';
select throws_ok(changed,'P0001','REQUEST_ID_REUSED','submit changed revision refused') from replay_calls where employee='201';
select test.act_as('202');
select throws_ok($$select submit_count('f9000000-0000-4000-8000-000000000001',t9.id('ordered'),4)$$,'P0001','REQUEST_ID_REUSED','submit request cannot be reused by other user');
select test.act_as('100');
select is(t9.call(c.sql),b.result,b.rpc_name || ': identical normalized replay') from replay_calls c join replay_before b on b.request_id=c.id where employee='100';
select throws_ok(changed,'P0001','REQUEST_ID_REUSED','changed review/zero payload refused') from replay_calls where employee='100';
select throws_ok($$select review_count('f9000000-0000-4000-8000-000000000005',t9.id('baseline'),'approve')$$,'P0001','REQUEST_ID_REUSED','request cannot change RPC');
select test.reset_role();
select is((select count(*) from replay_before),4::bigint,'all replay test requests stored');
select is((select count(*) from activity_log where action='submit_count' and entity_id=t9.id('ordered')::text),1::bigint,'submit logs its first call exactly once');
select is((select count(*) from activity_log where action='review_count' and entity_id=t9.id('baseline')::text),1::bigint,'approval logs its first call exactly once');
select is((select count(*) from activity_log where action='zero_branch_balance' and entity_id='BR-01'),1::bigint,'zero logs its first call exactly once');
select is((select count(*) from activity_log a where a.action=b.rpc_name),b.logs,b.rpc_name || ': replay logs no duplicate') from replay_before b;
select is((select count(*) from stock_baselines),(select n from all_baselines_before),'replays write no duplicate baselines');
select is((select status from counts where id=t9.id('recount')),'approved','old return replay cannot reopen approved count');
select is(test.balance('BR-01','D-001'),750::numeric,'zero replay cannot erase later purchase');
select ok(p.prosecdef and p.proconfig @> array['search_path=app, public, extensions, pg_temp'],p.proname || ': definer and safe search path')
 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('submit_count','review_count','zero_branch_balance','count_line_calcs');
select ok(has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute'),p.proname || ': explicit authenticated-only grant')
 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('submit_count','review_count','zero_branch_balance','count_line_calcs');
select * from finish();
rollback;
