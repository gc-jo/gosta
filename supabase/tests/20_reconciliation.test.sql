-- shortcut: no count scenario or count assertion yet, add them when Tasks 8 and 9 land.
begin;
select plan(8);

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

select * from finish();
rollback;
