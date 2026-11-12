begin;
select plan(8);
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
select * from finish();
rollback;
