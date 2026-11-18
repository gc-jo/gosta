begin;
select no_plan();

-- Task 8 only; returned/submitted states below are fixtures, not Task 9 RPCs.
create temporary table context (id uuid, frozen_since timestamptz);
create temporary table responses (name text primary key, result jsonb);
grant select, insert, update on context, responses to authenticated;

-- Authentication, roles, required request ids, and window validation.
set local role authenticated;
select throws_ok($$select start_count(gen_random_uuid())$$, 'P0001', 'NOT_AUTHENTICATED', 'session required');
select test.reset_role();
select test.act_as('201');
select throws_ok($$select open_count_window(gen_random_uuid(),'BR-01','2026-11-01')$$,
                 'P0001', 'FORBIDDEN', 'only owner opens windows');
select throws_ok($$select close_count_window(gen_random_uuid(),'BR-01','2026-11-01')$$,
                 'P0001', 'FORBIDDEN', 'only owner closes windows');
select throws_ok($$select discard_count(gen_random_uuid(),gen_random_uuid())$$,
                 'P0001', 'FORBIDDEN', 'only owner discards');
select throws_ok($$select start_count(null)$$, 'P0001', 'REQUEST_ID_REQUIRED', 'start needs request id');
select throws_ok($$select start_count(gen_random_uuid())$$, 'P0001', 'WINDOW_CLOSED', 'no window');
select test.act_as('100');
select throws_ok($$select start_count(gen_random_uuid())$$, 'P0001', 'FORBIDDEN', 'owner cannot start');
select throws_ok($$select save_count_line(gen_random_uuid(),'D-001',0,'none',null)$$,
                 'P0001', 'FORBIDDEN', 'owner cannot save');
select throws_ok($$select open_count_window(null,'BR-01','2026-11-01')$$,
                 'P0001', 'REQUEST_ID_REQUIRED', 'open needs request id');
select throws_ok($$select close_count_window(null,'BR-01','2026-11-01')$$,
                 'P0001', 'REQUEST_ID_REQUIRED', 'close needs request id');
select throws_ok($$select discard_count(null,gen_random_uuid())$$,
                 'P0001', 'REQUEST_ID_REQUIRED', 'discard needs request id');
select throws_ok(format('select open_count_window(gen_random_uuid(),%L,%L)', branch, month),
                 'P0001', 'BRANCH_INVALID', 'invalid branch/month: ' || coalesce(branch,'null') || '/' || coalesce(month,'null'))
from (values ('missing','2026-11-01'),('BR-09','2026-11-01'),('BR-01','2026-11-02'),
             ('BR-01',null),(null,'2026-11-01')) v(branch,month);
insert into responses values ('open',open_count_window('f8000000-0000-4000-8000-000000000001',' BR-01 ','2026-11-01'));
select throws_ok($$select open_count_window(gen_random_uuid(),'BR-01','2026-11-01')$$,
                 'P0001', 'WINDOW_EXISTS', 'duplicate open');
select test.reset_role();
select is((select status from count_windows where branch_id='BR-01' and period_month='2026-11-01'),
          'open', 'window stored');
select is((select count(*) from counts where branch_id='BR-01'), 0::bigint, 'opening does not create/freeze a count');

-- Explicit start creates exactly the four active counted fixture items.
select test.act_as('201');
insert into responses values ('start',start_count('f8000000-0000-4000-8000-000000000002'));
insert into context select (result->>'count_id')::uuid,(result->>'frozen_since')::timestamptz from responses where name='start';
insert into responses values ('start_again',start_count('f8000000-0000-4000-8000-000000000003'));
select is((select result from responses where name='start_again'),(select result from responses where name='start'),
          're-entry preserves count id, freeze and revision');
select throws_ok($$select create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]')$$,
                 'P0001', 'BRANCH_FROZEN', 'freeze blocks purchase before any save');
select test.reset_role();
select is((select row(branch_id,period_month,status,revision)::text from counts where id=(select id from context)),
          '(BR-01,2026-11-01,draft,0)', 'draft count stored at revision zero');
select ok((select c.frozen_since is not null and c.frozen_since=x.frozen_since from counts c join context x on x.id=c.id),
          'stored freeze equals returned start timestamp');
select is((select array_agg(item_id order by item_id) from count_lines where count_id=(select id from context)),
          array['D-001','D-002','D-004','D-005'], 'inactive D-003 and excluded D-006 have no line');
select is((select count(*) from count_lines where count_id=(select id from context)
            and state='uncounted' and revision=0 and base_quantity is null and not pending_setup),
          4::bigint, 'all four lines initially uncounted, non-pending, revision zero');

-- Save, stale different payload, and stale identical duplicate.
select test.act_as('201');
insert into responses values ('save_units',save_count_line((select id from context),'D-001',0,'counted',
 '[{"unit":"كرتونة","quantity":1},{"unit":"عبوة","quantity":2}]'));
-- 1 x 9000 + 2 x 750 = 10500; 1 saved line out of the 4 initial lines.
-- plan line 602 says total = 2; stale since Task 7b added D-004/D-005.
select is((select result from responses where name='save_units'),
 '{"base_quantity":10500,"line_revision":1,"count_revision":1,"counted":1,"total":4,"pending_setup":false}'::jsonb,
 'save response includes all progress and revision fields');
select test.reset_role();
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines
           where count_id=(select id from context) and item_id='D-001'), '(counted,10500,1,f)',
          'stored units: 1 x 9000 + 2 x 750 = 10500');
select is((select entries from count_lines where count_id=(select id from context) and item_id='D-001'),
 '[{"unit":"كرتونة","quantity":1},{"unit":"عبوة","quantity":2}]'::jsonb, 'unit entries preserved');
select ok((select calc @> '{"packs":[{"unit":"كرتونة","rate":9000},{"unit":"عبوة","rate":750}]}'
           from count_lines where count_id=(select id from context) and item_id='D-001'), 'unit calc records current rates');
select is((select revision from counts where id=(select id from context)),1,'count revision persisted');
select test.act_as('201');
insert into responses values ('save_newer',save_count_line((select id from context),'D-001',1,'counted','[{"unit":"عبوة","quantity":12}]'));
select throws_ok($$select save_count_line((select id from context),'D-001',1,'counted','[{"unit":"عبوة","quantity":10}]')$$,
                 'P0001','STALE_WRITE','late different save rejected');
select throws_ok($$select save_count_line((select id from context),'D-001',1,'counted','[{"unit":"عبوة","quantity":12}]')$$,
                 'P0001','STALE_WRITE','identical duplicate also rejected');
select test.reset_role();
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines
           where count_id=(select id from context) and item_id='D-001'), '(counted,9000,2,f)',
          'stale saves leave 12 x 750 = 9000 at revision 2');
select is((select entries from count_lines where count_id=(select id from context) and item_id='D-001'),
          '[{"unit":"عبوة","quantity":12}]'::jsonb,'newer entries survive stale saves');
select is((select revision from counts where id=(select id from context)),2,'stale saves do not bump count revision');

-- none counts toward progress; invalid unit inputs must leave stored rows alone.
select test.act_as('201');
insert into responses values ('save_none',save_count_line((select id from context),'D-002',0,'none',null));
select is((select result->>'counted' from responses where name='save_none'),'2','none is counted: one units + one none = 2');
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines
           where count_id=(select id from context) and item_id='D-002'), '(none,0,1,f)', 'none stores explicit zero');
select test.reset_role();
create temporary table before_invalid as select to_jsonb(l) as line from count_lines l where count_id=(select id from context);
create temporary table before_count as select to_jsonb(c) as value from counts c where id=(select id from context);
select test.act_as('201');
select throws_ok(format('select save_count_line((select id from context),''D-001'',2,''counted'',%L::jsonb)', entries),
                 'P0001', 'ENTRIES_INVALID', label)
from (values ('[]','blank is not zero'),
 ('[{"unit":"عبوة","quantity":1},{"unit":"عبوة","quantity":2}]','duplicate unit'),
 ('[{"unit":"عبوة","quantity":1.5}]','whole units required'),
 ('[{"unit":"missing","quantity":1}]','unit belongs to item'),
 ('{}','units require array')) v(entries,label);
select throws_ok($$select save_count_line((select id from context),'D-001',null,'none',null)$$,
                 'P0001','STALE_WRITE','null revision never overwrites');
select throws_ok($$select save_count_line((select id from context),'D-001',2,'other',null)$$,
                 'P0001','ENTRIES_INVALID','unknown state');
select throws_ok($$select save_count_line((select id from context),'D-002',1,'none','[{"unit":"حبة","quantity":1}]')$$,
                 'P0001','ENTRIES_INVALID','none refuses entries');
select test.act_as('202');
select throws_ok($$select save_count_line((select id from context),'D-001',2,'none',null)$$,
                 'P0001','FORBIDDEN','other branch');
select test.reset_role();
select results_eq($$select to_jsonb(l) from count_lines l where count_id=(select id from context) order by item_id$$,
                  $$select line from before_invalid order by line->>'item_id'$$, 'invalid/stale/foreign saves change no line');
select is((select to_jsonb(c) from counts c where id=(select id from context)),(select value from before_count),
          'invalid saves preserve count revision and freeze');

-- Hidden/inactive units and undo. Catalogue setup is changed through Task 7b.
select test.act_as('100');
select set_item_unit(gen_random_uuid(),'D-001','كرتونة',9000,true,false);
select test.act_as('201');
select throws_ok($$select save_count_line((select id from context),'D-001',2,'counted','[{"unit":"كرتونة","quantity":1}]')$$,
                 'P0001','ENTRIES_INVALID','hidden unit refused');
insert into responses values ('save_visible',save_count_line((select id from context),'D-001',2,'counted','[{"unit":"عبوة","quantity":1}]'));
select is((select base_quantity from count_lines where count_id=(select id from context) and item_id='D-001'),
          750::numeric,'visible bottle works: 1 x 750 = 750');
select test.act_as('100');
select set_item_unit(gen_random_uuid(),'D-001','كرتونة',9000,false,true);
select test.act_as('201');
select throws_ok($$select save_count_line((select id from context),'D-001',3,'counted','[{"unit":"كرتونة","quantity":1}]')$$,
                 'P0001','ENTRIES_INVALID','inactive unit refused');
insert into responses values ('save_undo',save_count_line((select id from context),'D-001',3,'uncounted','[{"ignored":true}]'));
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines
           where count_id=(select id from context) and item_id='D-001'), '(uncounted,,4,f)', 'undo clears quantity and pending flag');
select ok((select entries in ('{}'::jsonb,'[]'::jsonb) from count_lines
           where count_id=(select id from context) and item_id='D-001'),'undo clears entries');
select is((select frozen_since from counts where id=(select id from context)),(select frozen_since from context), 'undo keeps original freeze');
select is((select result->>'counted' from responses where name='save_undo'),'1','undo removes one completed line');

-- Containers: every invalid payload is refused before anything is stored.
create temporary table syrup (entries jsonb);
insert into syrup values ('{"packs":[],"containers":[{"container_id":"D-004-1L","closed":2,"closed_confirm":2,"open":2,"open_confirm":2,"weights":[{"grams":1000,"variant":"glass_pump"},{"grams":700,"variant":"plastic_pump"}]}]}');
grant select on syrup to authenticated;
select test.reset_role();
create temporary table bad_containers (label text, code text, entries jsonb);
insert into bad_containers
select label,code,jsonb_set(s.entries,path,replacement) from syrup s cross join (values
 ('closed confirmation mismatch','ENTRIES_INVALID','{containers,0,closed_confirm}'::text[],'3'::jsonb),
 ('open confirmation mismatch','ENTRIES_INVALID','{containers,0,open_confirm}'::text[],'3'::jsonb),
 ('fractional closed','ENTRIES_INVALID','{containers,0,closed}'::text[],'1.5'::jsonb),
 ('weights count','ENTRIES_INVALID','{containers,0,weights}'::text[],'[{"grams":1000,"variant":"glass_pump"}]'::jsonb),
 ('below tare','WEIGHT_BELOW_TARE','{containers,0,weights,0,grams}'::text[],'500'::jsonb),
 ('unknown variant','CONTAINER_INVALID','{containers,0,weights,0,variant}'::text[],'"glass_lid"'::jsonb),
 ('other item container','CONTAINER_INVALID','{containers,0,container_id}'::text[],'"D-005-1L"'::jsonb),
 ('unknown container','CONTAINER_INVALID','{containers,0,container_id}'::text[],'"missing"'::jsonb),
 ('zero weight','WEIGHT_INVALID','{containers,0,weights,0,grams}'::text[],'0'::jsonb),
 ('negative weight','WEIGHT_INVALID','{containers,0,weights,0,grams}'::text[],'-1'::jsonb),
 ('nonfinite weight','WEIGHT_INVALID','{containers,0,weights,0,grams}'::text[],'"NaN"'::jsonb),
 ('infinite weight','WEIGHT_INVALID','{containers,0,weights,0,grams}'::text[],'"Infinity"'::jsonb),
 ('oversized weight','WEIGHT_INVALID','{containers,0,weights,0,grams}'::text[],'1000000000001'::jsonb),
 ('no containers','ENTRIES_INVALID','{containers}'::text[],'[]'::jsonb),
 ('duplicate pack','ENTRIES_INVALID','{packs}'::text[],'[{"unit":"غم","quantity":1},{"unit":"غم","quantity":2}]'::jsonb)
) v(label,code,path,replacement);
insert into bad_containers select 'duplicate container','CONTAINER_INVALID',
 jsonb_set(entries,'{containers}',(entries->'containers') || (entries->'containers')) from syrup;
grant select on bad_containers to authenticated;
create temporary table before_containers as select to_jsonb(l) as line from count_lines l where count_id=(select id from context);
select test.act_as('201');
select throws_ok(format('select save_count_line((select id from context),''D-004'',0,''counted'',%L::jsonb)',entries),
                 'P0001',code,label) from bad_containers;
select test.reset_role();
select results_eq($$select to_jsonb(l) from count_lines l where count_id=(select id from context) order by item_id$$,
                  $$select line from before_containers order by line->>'item_id'$$,'all invalid container saves leave rows untouched');
select is((select revision from counts where id=(select id from context)),5,'invalid containers leave count revision 5 (five successful saves)');
select test.act_as('201');
insert into responses values ('save_syrup',save_count_line((select id from context),'D-004',0,'counted',(select entries from syrup)));
select test.reset_role();
-- 2 x 1250 + (1000 - 620) + (700 - 210) = 3370 grams.
select is((select base_quantity from count_lines where count_id=(select id from context) and item_id='D-004'),3370::numeric,'syrup hand computation');
select is((select row(state,revision,pending_setup)::text from count_lines where count_id=(select id from context) and item_id='D-004'),
          '(counted,1,f)','syrup stored counted, not pending');
select is((select entries from count_lines where count_id=(select id from context) and item_id='D-004'),(select entries from syrup),'syrup readings unchanged');
select ok((select calc @> '{"containers":[{"container_id":"D-004-1L","tares":{"glass_pump":620,"plastic_pump":210}}]}'
           from count_lines where count_id=(select id from context) and item_id='D-004'),'server calc records both tares');

-- Zero open containers needs zero weights. Missing tare saves without revealing it.
select test.act_as('201');
insert into responses values ('save_closed',save_count_line((select id from context),'D-004',1,'counted',
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":2,"closed_confirm":2,"open":0,"open_confirm":0,"weights":[]}]}'));
select is((select base_quantity from count_lines where count_id=(select id from context) and item_id='D-004'),2500::numeric,
          'zero open accepted: 2 x 1250 = 2500');
insert into responses values ('save_pending',save_count_line((select id from context),'D-004',2,'counted',
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":0,"closed_confirm":0,"open":1,"open_confirm":1,"weights":[{"grams":700,"variant":"plastic_cap"}]}]}'));
select test.reset_role();
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines where count_id=(select id from context) and item_id='D-004'),
          '(counted,,3,t)','missing tare stored counted and pending with null quantity');
select is((select entries from count_lines where count_id=(select id from context) and item_id='D-004'),
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":0,"closed_confirm":0,"open":1,"open_confirm":1,"weights":[{"grams":700,"variant":"plastic_cap"}]}]}'::jsonb,
 'pending readings exactly preserved');
select is((select result->'base_quantity' from responses where name='save_pending'),'null'::jsonb,'pending response has null quantity');
select is((select result->'pending_setup' from responses where name='save_pending'),'true'::jsonb,'pending response flag');
select test.act_as('201');
insert into responses values ('save_milk',save_count_line((select id from context),'D-005',0,'counted',
 '{"packs":[{"unit":"كرتونة","quantity":1}],"containers":[{"container_id":"D-005-1L","closed":3,"closed_confirm":3,"open":1,"open_confirm":1,"weights":[{"grams":640,"variant":"default"}]}]}'));
select test.reset_role();
-- 1 x 12 + 3 x 1 + (640 - 40)/1000 = 15.6 bottles.
select is((select base_quantity from count_lines where count_id=(select id from context) and item_id='D-005'),15.6::numeric,'milk hand computation');
select is((select row(state,revision,pending_setup)::text from count_lines where count_id=(select id from context) and item_id='D-005'),
          '(counted,1,f)','milk persisted');
select is((select entries from count_lines where count_id=(select id from context) and item_id='D-005'),
 '{"packs":[{"unit":"كرتونة","quantity":1}],"containers":[{"container_id":"D-005-1L","closed":3,"closed_confirm":3,"open":1,"open_confirm":1,"weights":[{"grams":640,"variant":"default"}]}]}'::jsonb,'milk readings preserved');
select is((select revision from counts where id=(select id from context)),9,'nine successful saves increment count revision nine times');

-- No tare leak: exact key allowlists on every employee RPC response, not a
-- search for a single key spelling; nested objects would fail these shapes.
select test.act_as('201');
select is((select array_agg(k order by k collate "C") from jsonb_object_keys(result) k),
          array['base_quantity','count_revision','counted','line_revision','pending_setup','total'],name || ': save response keys')
from responses where name like 'save_%';
select ok(jsonb_typeof(result->'base_quantity') in ('number','null')
          and jsonb_typeof(result->'pending_setup')='boolean'
          and jsonb_typeof(result->'line_revision')='number'
          and jsonb_typeof(result->'count_revision')='number'
          and jsonb_typeof(result->'counted')='number'
          and result->'total'='4'::jsonb,name || ': only scalar response values, total four')
from responses where name like 'save_%';
select is((select array_agg(k order by k collate "C") from jsonb_object_keys(result) k),
          array['count_id','frozen_since','revision'],name || ': start response keys')
from responses where name like 'start%';
select is((select count(*) from container_tares),0::bigint,'201 reads zero tare rows');
select throws_ok($$select calc from count_lines$$,'42501',null,'201 cannot read calc');
select throws_ok($$select * from count_lines$$,'42501',null,'table-wide SELECT cannot bypass calc restriction');

-- Closing does not strand an existing draft, even after another month opens.
select test.act_as('100');
insert into responses values ('close',close_count_window('f8000000-0000-4000-8000-000000000004','BR-01','2026-11-01'));
select test.reset_role();
select is((select status from count_windows where branch_id='BR-01' and period_month='2026-11-01'),'closed','window closed');
select is((select frozen_since from counts where id=(select id from context)),(select frozen_since from context),'close preserves freeze');
select test.act_as('201');
insert into responses values ('save_after_close',save_count_line((select id from context),'D-002',1,'none','[]'));
select is((select revision from counts where id=(select id from context)),10,'save works after close');
select test.act_as('100');
insert into responses values ('discard',discard_count('f8000000-0000-4000-8000-000000000005',(select id from context)));
select test.reset_role();
select is((select count(*) from counts where id=(select id from context)),0::bigint,'discard deletes count and lifts freeze');
select is((select count(*) from count_lines where count_id=(select id from context)),0::bigint,'discard deletes all lines');
select test.act_as('201');
select throws_ok($$select save_count_line((select id from context),'D-001',4,'counted','[{"unit":"عبوة","quantity":1}]')$$,
                 'P0001','COUNT_NOT_OPEN','late save after discard');
select lives_ok($$select create_purchase(gen_random_uuid(),'S-01','[{"item_id":"D-001","unit":"عبوة","quantity":1}]')$$,
                'purchase succeeds after discard');
select test.reset_role();
select is((select count(*) from counts where branch_id='BR-01'),0::bigint,'late save never recreates count');

-- All request-id RPCs replay without new logs, including after later changes.
create temporary table replay_calls (action text, id uuid, sql text, changed text);
insert into replay_calls values
 ('open_count_window','f8000000-0000-4000-8000-000000000001',
 $$select open_count_window('f8000000-0000-4000-8000-000000000001','BR-01','2026-11-01')$$,
 $$select open_count_window('f8000000-0000-4000-8000-000000000001','BR-02','2026-11-01')$$),
 ('close_count_window','f8000000-0000-4000-8000-000000000004',
 $$select close_count_window('f8000000-0000-4000-8000-000000000004','BR-01','2026-11-01')$$,
 $$select close_count_window('f8000000-0000-4000-8000-000000000004','BR-01','2026-12-01')$$),
 ('start_count','f8000000-0000-4000-8000-000000000002',
 $$select start_count('f8000000-0000-4000-8000-000000000002')$$,
 $$select close_count_window('f8000000-0000-4000-8000-000000000002','BR-01','2026-11-01')$$);
insert into replay_calls select 'discard_count','f8000000-0000-4000-8000-000000000005',
 format('select discard_count(''f8000000-0000-4000-8000-000000000005'',%L)',id),
 $$select discard_count('f8000000-0000-4000-8000-000000000005','ffffffff-ffff-4fff-8fff-ffffffffffff')$$ from context;
create temporary table replay_before as select r.*, (select count(*) from activity_log a where a.action=r.rpc_name) as logs
 from rpc_requests r join replay_calls c on c.id=r.request_id;
grant select on replay_calls,replay_before to authenticated;
create schema t8;
grant usage on schema t8 to authenticated;
create function t8.call(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin execute p_sql into v; return v; end;
$$;
grant execute on function t8.call(text) to authenticated;
select test.act_as('100');
select is(t8.call(c.sql),b.result,c.action || ': replay identical result')
 from replay_calls c join replay_before b on b.request_id=c.id where c.action<>'start_count';
select throws_ok(changed,'P0001','REQUEST_ID_REUSED',action || ': changed parameters/RPC refused') from replay_calls;
select test.act_as('201');
select is(t8.call(c.sql),b.result,'start: replay after discard returns original result')
 from replay_calls c join replay_before b on b.request_id=c.id where c.action='start_count';
select test.act_as('202');
select throws_ok($$select start_count('f8000000-0000-4000-8000-000000000002')$$,'P0001','REQUEST_ID_REUSED','replay refuses other user');
select test.reset_role();
select is((select count(*) from activity_log a where a.action=b.rpc_name),b.logs,b.rpc_name || ': one log per first call') from replay_before b;
select is((select count(*) from replay_before),4::bigint,'all four replayable RPCs stored a result');
select is((select count(*) from counts where branch_id='BR-01'),0::bigint,'start replay does not recreate discarded count');

-- Reopen a closed window; latest open month is selected on a fresh start.
select test.act_as('100');
select lives_ok($$select open_count_window(gen_random_uuid(),'BR-01','2026-11-01')$$,'closed window reopens');
select lives_ok($$select open_count_window(gen_random_uuid(),'BR-01','2026-12-01')$$,'later window opens');
select test.act_as('201');
update context set id=(start_count(gen_random_uuid())->>'count_id')::uuid;
select is((select period_month from counts where id=(select id from context)),'2026-12-01'::date,'latest open window selected');

-- Returned count must explicitly start; only marked lines may then change.
select test.reset_role();
update counts set status='returned',frozen_since=null where id=(select id from context);
update count_lines set needs_recount=(item_id='D-001') where count_id=(select id from context);
select test.act_as('201');
select throws_ok($$select save_count_line((select id from context),'D-001',0,'none',null)$$,
                 'P0001','COUNT_NOT_STARTED','returned save before start');
select ok((select frozen_since is null from counts where id=(select id from context)),'save cannot start returned freeze');
insert into responses values ('start_returned',start_count(gen_random_uuid()));
select is((select result->>'count_id' from responses where name='start_returned'),(select id::text from context),'start returns same returned count');
select ok((select frozen_since is not null from counts where id=(select id from context)),'explicit recount starts freeze');
select throws_ok($$select save_count_line((select id from context),'D-002',0,'none',null)$$,
                 'P0001','COUNT_LOCKED','unmarked returned line locked');
insert into responses values ('save_returned',save_count_line((select id from context),'D-001',0,'none',null));
select is((select row(state,base_quantity,revision,pending_setup)::text from count_lines
           where count_id=(select id from context) and item_id='D-001'),'(none,0,1,f)','marked returned line saved');
select test.act_as('100');
select lives_ok($$select discard_count(gen_random_uuid(),(select id from context))$$,'owner discards returned count');
select test.reset_role();
select is((select count(*) from counts where id=(select id from context)),0::bigint,'returned discard removes whole count');

-- Submitted/approved counts cannot restart, save or discard. No Task 9 functions.
insert into counts(branch_id,period_month,status) values ('BR-01','2026-12-01','submitted');
update context set id=(select id from counts where branch_id='BR-01' and period_month='2026-12-01');
select test.act_as('201');
select throws_ok($$select start_count(gen_random_uuid())$$,'P0001','COUNT_LOCKED','submitted count cannot restart');
select throws_ok($$select save_count_line((select id from context),'D-001',0,'none',null)$$,'P0001','COUNT_LOCKED','submitted count cannot save');
select test.act_as('100');
select throws_ok($$select discard_count(gen_random_uuid(),(select id from context))$$,'P0001','COUNT_NOT_OPEN','submitted count cannot discard');
select test.reset_role();
update counts set status='approved' where id=(select id from context);
select test.act_as('201');
select throws_ok($$select start_count(gen_random_uuid())$$,'P0001','COUNT_LOCKED','approved count cannot restart');
select test.reset_role();

-- Distributor path and hidden count feature.
update branch_features set visible=false where branch_id='BR-02' and feature_key='count';
select test.act_as('202');
select throws_ok($$select start_count(gen_random_uuid())$$,'P0001','FEATURE_HIDDEN','hidden count feature');
select test.act_as('100');
select open_count_window(gen_random_uuid(),'BR-14','2026-11-01');
select test.act_as('301');
update context set id=(start_count(gen_random_uuid())->>'count_id')::uuid;
select lives_ok($$select save_count_line((select id from context),'D-002',0,'none',null)$$,'distributor can start and save own count');
select test.reset_role();
select ok(not has_function_privilege('anon',p.oid,'execute'),p.proname || ': anon cannot execute')
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('open_count_window','close_count_window','start_count','save_count_line','discard_count');
select * from finish();
rollback;
