begin;
select plan(14);

-- test-local helpers (rolled back with the transaction) ----------------------------------
create schema t20;
grant usage on schema t20 to authenticated;

create function t20.tid(p_req uuid) returns uuid language sql stable security definer set search_path = public as
$$ select id from transfers where request_id = p_req
   and from_branch in ('BR-01','BR-02','BR-14') and to_branch in ('BR-01','BR-02','BR-14') $$;

create function t20.tlid(p_req uuid, p_item text) returns uuid language sql stable security definer set search_path = public as
$$ select l.id from transfer_lines l join transfers t on t.id = l.transfer_id
   where t.request_id = p_req and l.item_id = p_item
     and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14') $$;

create function t20.plid(p_req uuid) returns uuid language sql stable security definer set search_path = public as
$$ select l.id from purchase_lines l join purchases p on p.id = l.purchase_id
   where p.request_id = p_req and p.branch_id in ('BR-01','BR-02','BR-14') $$;

grant execute on all functions in schema t20 to authenticated;

-- No stock seeding: sends allow negative balances and conservation ignores baselines.
-- Three warehouse sends: full receipt, short receipt, owner denial.
select test.act_as('301');
select public.send_transfer('e2000000-0000-4000-8000-000000000101', 'BR-01',
  '[{"item_id":"D-001","quantity":1,"unit":"كرتونة","cost_total":10},
    {"item_id":"D-002","quantity":3,"unit":"حبة","cost_total":1}]');
select public.send_transfer('e2000000-0000-4000-8000-000000000102', 'BR-01',
  '[{"item_id":"D-001","quantity":4,"unit":"عبوة","cost_total":8},
    {"item_id":"D-002","quantity":5,"unit":"حبة","cost_total":1}]');
select public.send_transfer('e2000000-0000-4000-8000-000000000103', 'BR-01',
  '[{"item_id":"D-001","quantity":2,"unit":"عبوة","cost_total":4},
    {"item_id":"D-002","quantity":2,"unit":"حبة","cost_total":1}]');

-- A same-unit receipt must retain the sent rate of 9000, despite the catalog change.
select test.reset_role();
update item_units set conversion_rate = 10000 where item_id = 'D-001' and unit_name = 'كرتونة';
select test.act_as('201');
select public.receive_transfer('e2000000-0000-4000-8000-000000000201',
  t20.tid('e2000000-0000-4000-8000-000000000101'),
  jsonb_build_array(
    jsonb_build_object('line_id', t20.tlid('e2000000-0000-4000-8000-000000000101', 'D-001'),
                      'quantity', 1, 'unit', 'كرتونة'),
    jsonb_build_object('line_id', t20.tlid('e2000000-0000-4000-8000-000000000101', 'D-002'),
                      'quantity', 3, 'unit', 'حبة')));
select public.receive_transfer('e2000000-0000-4000-8000-000000000202',
  t20.tid('e2000000-0000-4000-8000-000000000102'),
  jsonb_build_array(
    jsonb_build_object('line_id', t20.tlid('e2000000-0000-4000-8000-000000000102', 'D-001'),
                      'quantity', 3, 'unit', 'عبوة', 'diff_reason', 'count_error'),
    jsonb_build_object('line_id', t20.tlid('e2000000-0000-4000-8000-000000000102', 'D-002'),
                      'quantity', 0, 'unit', 'حبة', 'diff_reason', 'not_loaded')));

-- Leave both lines of this branch-to-branch send pending.
select public.send_transfer('e2000000-0000-4000-8000-000000000104', 'BR-02',
  '[{"item_id":"D-001","quantity":1,"unit":"عبوة"},
    {"item_id":"D-002","quantity":2,"unit":"حبة"}]');

-- Two purchases: the owner later changes one from 4 to 5 bottles and voids the other.
select public.create_purchase('e2000000-0000-4000-8000-000000000301', 'S-01',
  '[{"item_id":"D-001","quantity":4,"unit":"عبوة","cost_total":8}]');
select public.create_purchase('e2000000-0000-4000-8000-000000000302', 'S-01',
  '[{"item_id":"D-001","quantity":2,"unit":"عبوة","cost_total":4}]');

select test.act_as('100');
select public.owner_resolve_transfer_line('e2000000-0000-4000-8000-000000000203',
  t20.tlid('e2000000-0000-4000-8000-000000000103', 'D-001'), 'deny');
select public.owner_resolve_transfer_line('e2000000-0000-4000-8000-000000000204',
  t20.tlid('e2000000-0000-4000-8000-000000000103', 'D-002'), 'deny');
select public.edit_purchase_line('e2000000-0000-4000-8000-000000000401',
  t20.plid('e2000000-0000-4000-8000-000000000301'), 5, 'عبوة', 10);
select public.void_purchase_line('e2000000-0000-4000-8000-000000000402',
  t20.plid('e2000000-0000-4000-8000-000000000302'));
select test.reset_role();

-- Full BR-01 count, including weighed syrup; approval replaces earlier stock
-- without changing the insert-only movements checked below.
create temporary table count_scenario (id uuid);
grant select, insert on count_scenario to authenticated;
select test.act_as('100');
select public.open_count_window('e2000000-0000-4000-8000-000000000501','BR-01','2026-11-01');
select test.act_as('201');
insert into count_scenario select (public.start_count('e2000000-0000-4000-8000-000000000502')->>'count_id')::uuid;
select public.save_count_line((select id from count_scenario),'D-001',0,'counted','[{"unit":"عبوة","quantity":14}]');
select public.save_count_line((select id from count_scenario),'D-002',0,'none',null);
select public.save_count_line((select id from count_scenario),'D-004',0,'counted',
 '{"packs":[],"containers":[{"container_id":"D-004-1L","closed":2,"closed_confirm":2,"open":2,"open_confirm":2,"weights":[{"grams":1000,"variant":"glass_pump"},{"grams":700,"variant":"plastic_pump"}]}]}');
select public.save_count_line((select id from count_scenario),'D-005',0,'none',null);
select public.submit_count('e2000000-0000-4000-8000-000000000503',(select id from count_scenario),4);
select test.act_as('100');
select public.review_count('e2000000-0000-4000-8000-000000000504',(select id from count_scenario),'approve');

-- A new arrival after the count must add above its baselines, including a
-- containers item's gram balance. These are real sends/receipts, not inserts.
select test.act_as('301');
select public.send_transfer('e2000000-0000-4000-8000-000000000105','BR-01',
 '[{"item_id":"D-001","quantity":1,"unit":"عبوة","cost_total":2},
   {"item_id":"D-004","quantity":10,"unit":"غم","cost_total":1}]');
select test.act_as('201');
select public.receive_transfer('e2000000-0000-4000-8000-000000000205',
 t20.tid('e2000000-0000-4000-8000-000000000105'),
 jsonb_build_array(
   jsonb_build_object('line_id',t20.tlid('e2000000-0000-4000-8000-000000000105','D-001'),'quantity',1,'unit','عبوة'),
   jsonb_build_object('line_id',t20.tlid('e2000000-0000-4000-8000-000000000105','D-004'),'quantity',10,'unit','غم')));
select test.reset_role();

-- Pin the scenario so no-op owner corrections cannot pass the reconciliation checks.
select is(
  (select string_agg(s.line, ';' order by s.request_id, s.item_id)
   from (
     select t.request_id, l.item_id,
       concat_ws('|', right(t.request_id::text, 3), l.item_id, l.status,
                 coalesce(trim_scale(l.received_base_quantity)::text, '~')) as line
     from transfer_lines l join transfers t on t.id = l.transfer_id
     where t.request_id in ('e2000000-0000-4000-8000-000000000101', 'e2000000-0000-4000-8000-000000000102',
                            'e2000000-0000-4000-8000-000000000103', 'e2000000-0000-4000-8000-000000000104')
       and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')
     union all
     select p.request_id, l.item_id,
       concat_ws('|', right(p.request_id::text, 3), l.item_id, trim_scale(l.base_quantity),
                 (l.voided_at is not null)::text)
     from purchase_lines l join purchases p on p.id = l.purchase_id
     where p.request_id in ('e2000000-0000-4000-8000-000000000301', 'e2000000-0000-4000-8000-000000000302')
       and p.branch_id in ('BR-01','BR-02','BR-14')
   ) s),
  '101|D-001|received|9000;101|D-002|received|3;'
  || '102|D-001|received|2250;102|D-002|received|0;'
  || '103|D-001|denied|~;103|D-002|denied|~;'
  || '104|D-001|pending|~;104|D-002|pending|~;'
  || '301|D-001|3750|false;302|D-001|1500|true',
  'scenario ends with the intended transfer receipts, denials, pending lines, purchase edit and void');

-- 1. Conservation across the three branches, independently for both items.
select is(
  (select coalesce(sum(base_quantity), 0) from stock_movements
   where item_id = 'D-001' and branch_id in ('BR-01','BR-02','BR-14')),
  (select coalesce(sum(l.base_quantity), 0) from purchase_lines l join purchases p on p.id = l.purchase_id
   where l.item_id = 'D-001' and l.voided_at is null and p.branch_id in ('BR-01','BR-02','BR-14'))
  - (select coalesce(sum(l.base_quantity), 0) from transfer_lines l join transfers t on t.id = l.transfer_id
     where l.item_id = 'D-001' and l.status = 'pending'
       and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')),
  'D-001: ledger total equals non-voided purchases minus pending sends');
select is(
  (select coalesce(sum(base_quantity), 0) from stock_movements
   where item_id = 'D-002' and branch_id in ('BR-01','BR-02','BR-14')),
  (select coalesce(sum(l.base_quantity), 0) from purchase_lines l join purchases p on p.id = l.purchase_id
   where l.item_id = 'D-002' and l.voided_at is null and p.branch_id in ('BR-01','BR-02','BR-14'))
  - (select coalesce(sum(l.base_quantity), 0) from transfer_lines l join transfers t on t.id = l.transfer_id
     where l.item_id = 'D-002' and l.status = 'pending'
       and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')),
  'D-002: ledger total equals non-voided purchases minus pending sends');

-- 2. Check cardinality as well as quantity, including the zero receipt.
select is_empty($$
  select l.id from transfer_lines l join transfers t on t.id = l.transfer_id
  left join stock_movements m on m.ref_table = 'transfer_lines' and m.ref_id = l.id
    and m.kind = 'transfer_in' and m.branch_id in ('BR-01','BR-02','BR-14')
  where l.status = 'received'
    and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')
  group by l.id
  having count(m.id) <> case when l.received_base_quantity = 0 then 0 else 1 end
     or coalesce(sum(m.base_quantity), 0) is distinct from l.received_base_quantity
$$, 'every received line has one matching transfer_in, or none for zero received');

-- 3. Source movements include the original send and any receipt/denial adjustment.
select is_empty($$
  select l.id from transfer_lines l join transfers t on t.id = l.transfer_id
  left join stock_movements m on m.ref_table = 'transfer_lines' and m.ref_id = l.id
    and m.branch_id = t.from_branch and m.branch_id in ('BR-01','BR-02','BR-14')
  where t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')
  group by l.id
  having coalesce(sum(m.base_quantity), 0) is distinct from
    case l.status when 'received' then -l.received_base_quantity
                  when 'denied' then 0 else -l.base_quantity end
$$, 'every transfer line has the correct net source effect for its status');

-- 4. Purchase corrections reconcile to the current line, preserving voided history.
select is_empty($$
  select l.id from purchase_lines l join purchases p on p.id = l.purchase_id
  left join stock_movements m on m.ref_table = 'purchase_lines' and m.ref_id = l.id
    and m.branch_id in ('BR-01','BR-02','BR-14')
  where p.branch_id in ('BR-01','BR-02','BR-14')
  group by l.id
  having coalesce(sum(m.base_quantity), 0) is distinct from
    case when l.voided_at is null then l.base_quantity else 0 end
$$, 'every purchase line nets to its base quantity, or zero when voided');

-- 5. Resolve both supported movement reference types; unknown types also fail.
select is_empty($$
  select m.id from stock_movements m
  left join transfer_lines t on m.ref_table = 'transfer_lines' and t.id = m.ref_id
  left join purchase_lines p on m.ref_table = 'purchase_lines' and p.id = m.ref_id
  where m.branch_id in ('BR-01','BR-02','BR-14') and t.id is null and p.id is null
$$, 'every stock movement refers to an existing transfer or purchase line');

-- 6. A missing receipt also fails: NULL is not the expected numeric zero.
select is(
  (select l.received_base_quantity - l.base_quantity
   from transfer_lines l join transfers t on t.id = l.transfer_id
   where t.request_id = 'e2000000-0000-4000-8000-000000000101' and l.item_id = 'D-001'
     and l.status = 'received'
     and t.from_branch in ('BR-01','BR-02','BR-14') and t.to_branch in ('BR-01','BR-02','BR-14')),
  0::numeric, 'received as sent retains exactly the sent base quantity after the rate change');

-- Count scenario checks; the original eight assertions above are unchanged.
select is(
 (select row(c.status,c.frozen_since,c.revision)::text from counts c join count_scenario s on s.id=c.id where c.branch_id='BR-01'),
 '(approved,,4)','count is approved at revision four and is unfrozen');
-- D-001: 14 x 750 = 10500 ml. D-004: 2 x 1250 + (1000-620) + (700-210) = 3370 g.
-- D-002 and D-005 explicitly none = 0, not uncounted.
select is(
 (select string_agg(concat_ws('|',l.item_id,l.state,trim_scale(l.base_quantity),l.pending_setup::text),';' order by l.item_id)
  from count_lines l join counts c on c.id=l.count_id join count_scenario s on s.id=c.id where c.branch_id='BR-01'),
 'D-001|counted|10500|false;D-002|none|0|false;D-004|counted|3370|false;D-005|none|0|false',
 'stored count includes exact unit and weighed-container quantities');
select is(
 (select count(*) from stock_baselines b join count_scenario s on s.id=b.ref_id
  join count_lines l on l.count_id=s.id and l.item_id=b.item_id join counts c on c.id=s.id
  where b.branch_id='BR-01' and b.source='count' and b.base_quantity=l.base_quantity
    and b.effective_at=l.effective_at and l.effective_at=c.submitted_at
    and b.created_by=(select id from app_users where employee_number='100')),
 4::bigint,'approval writes all four baselines with the exact per-line cutoff and owner');
select ok(
 (select bool_and(m.occurred_at > l.effective_at)
  from transfer_lines tl join transfers t on t.id=tl.transfer_id
  join stock_movements m on m.ref_table='transfer_lines' and m.ref_id=tl.id and m.kind='transfer_in'
  join count_lines l on l.item_id=tl.item_id join count_scenario s on s.id=l.count_id
  where t.request_id='e2000000-0000-4000-8000-000000000105' and m.branch_id='BR-01'
    and t.from_branch='BR-14' and t.to_branch='BR-01'),
 'post-count receipt movements follow the corresponding count cutoffs');

-- balances requires real session claims, including for its owner-facing reads.
select test.act_as('100');
-- D-001: 10500 + 1 x 750 = 11250 ml; D-004: 3370 + 10 x 1 = 3380 g; the two none lines stay zero.
select is(
 (select string_agg(concat_ws('|',b.item_id,trim_scale(b.base_quantity)),';' order by b.item_id)
  from balances b join count_lines l on l.item_id=b.item_id join count_scenario s on s.id=l.count_id where b.branch_id='BR-01'),
 'D-001|11250;D-002|0;D-004|3380;D-005|0',
 'balances include the post-count arrival above the hand-computed quantities');

-- Task 14 assertion 6: independently sum the raw movements after each stored
-- line cutoff. The expected side uses neither stock_baselines nor test.balance.
select is_empty($$
 select l.item_id from count_lines l join count_scenario s on s.id=l.count_id
 join counts c on c.id=s.id and c.branch_id='BR-01'
 left join balances b on b.branch_id=c.branch_id and b.item_id=l.item_id
 where b.base_quantity is distinct from l.base_quantity + coalesce((
   select sum(m.base_quantity) from stock_movements m
   where m.branch_id='BR-01' and m.item_id=l.item_id and m.occurred_at > l.effective_at),0)
    or b.baseline_at is distinct from l.effective_at
$$,'BR-01 balances equal approved count plus independently summed later movements per line');
select test.reset_role();

select * from finish();
rollback;
