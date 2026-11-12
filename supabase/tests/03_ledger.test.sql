begin;
select plan(13);
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

-- truncate is blocked as well
select throws_ok($$truncate stock_movements$$, 'P0001', 'IMMUTABLE_ROW', 'truncate stock_movements is refused');
select throws_ok($$truncate stock_baselines$$, 'P0001', 'IMMUTABLE_ROW', 'truncate stock_baselines is refused');

-- test.balance reads the true ledger even when called as a branch manager
insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-02','D-001',123,'purchase_in','purchase_lines',gen_random_uuid(),'2026-11-01 10:00+03');
select test.act_as('201');
select is(test.balance('BR-02','D-001'), 123::numeric, 'test.balance sees the real ledger while acting as a manager');
select test.reset_role();

-- same effective_at: the baseline written last wins
insert into stock_baselines(branch_id,item_id,base_quantity,effective_at,source)
  values ('BR-03','D-001',100,'2026-11-05 10:00+03','count');
insert into stock_baselines(branch_id,item_id,base_quantity,effective_at,source)
  values ('BR-03','D-001',200,'2026-11-05 10:00+03','count');
select is(test.balance('BR-03','D-001'), 200::numeric, 'baseline tie on effective_at: latest written wins');

-- a denied line cannot carry received values
insert into transfers(id, request_id, from_branch, to_branch, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'BR-14', 'BR-01',
          (select id from app_users where employee_number = '301'));
select throws_like($$insert into transfer_lines(transfer_id,item_id,quantity,unit,unit_rate,base_quantity,status,received_quantity)
  values ('aaaaaaaa-0000-4000-8000-000000000001','D-001',1,'مل',1,1,'denied',1)$$,
  '%transfer_lines_received_consistent%', 'a denied line with a received quantity is refused');

select * from finish();
rollback;
