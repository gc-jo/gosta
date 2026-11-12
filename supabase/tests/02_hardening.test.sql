begin;
select plan(19);

-- numeric accepts NaN and +-Infinity; the finite checks must refuse them
select throws_ok(format($q$insert into item_units values ('D-001','x' || %L,%L,true)$q$, v, v), '23514',
  null, 'item_units.conversion_rate refuses ' || v)
from (values ('NaN'), ('Infinity'), ('-Infinity')) as t(v);

select is(app.is_finite(0), true, 'is_finite(0)');
select is(app.is_finite(-1.5), true, 'is_finite(-1.5)');
select is(app.is_finite(9000), true, 'is_finite(9000)');
select is(app.is_finite('NaN'::numeric), false, 'is_finite(NaN)');
select is(app.is_finite('Infinity'::numeric), false, 'is_finite(Infinity)');
select is(app.is_finite('-Infinity'::numeric), false, 'is_finite(-Infinity)');
select is(app.is_finite(null), null, 'is_finite(null) is null');

-- parents for the line tables
insert into transfers(id, request_id, from_branch, to_branch, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), 'BR-14', 'BR-01',
          (select id from app_users where employee_number = '301'));
insert into purchases(id, request_id, branch_id, supplier_id, created_by)
  values ('aaaaaaaa-0000-4000-8000-000000000002', gen_random_uuid(), 'BR-01', 'S-01',
          (select id from app_users where employee_number = '201'));

select throws_ok(format($q$insert into stock_movements(branch_id,item_id,base_quantity,kind,ref_table,ref_id,occurred_at)
  values ('BR-01','D-001',%L,'purchase_in','purchase_lines',gen_random_uuid(),now())$q$, v), '23514',
  null, 'stock_movements.base_quantity refuses ' || v)
from (values ('NaN'), ('Infinity')) as t(v);

select throws_ok(format($q$insert into stock_baselines(branch_id,item_id,base_quantity,effective_at,source)
  values ('BR-01','D-001',%L,now(),'count')$q$, v), '23514',
  null, 'stock_baselines.base_quantity refuses ' || v)
from (values ('NaN'), ('Infinity')) as t(v);

select throws_ok(format($q$insert into purchase_lines(purchase_id,item_id,quantity,unit,unit_rate,base_quantity)
  values ('aaaaaaaa-0000-4000-8000-000000000002','D-001',%L,'مل',1,%L)$q$, v, v), '23514',
  null, 'purchase_lines.quantity refuses ' || v)
from (values ('NaN'), ('Infinity')) as t(v);

select throws_ok(format($q$insert into transfer_lines(transfer_id,item_id,quantity,unit,unit_rate,base_quantity,cost_total)
  values ('aaaaaaaa-0000-4000-8000-000000000001','D-001',1,'مل',1,1,%L)$q$, v), '23514',
  null, 'transfer_lines.cost_total refuses ' || v)
from (values ('NaN'), ('Infinity')) as t(v);

-- every numeric column in public has a constraint named <table>_<column>_finite
select is_empty($$
  select c.table_name || '.' || c.column_name
  from information_schema.columns c
  join information_schema.tables t using (table_schema, table_name)
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type = 'numeric'
    and not exists (
      select 1 from pg_constraint k
      where k.conrelid = format('public.%I', c.table_name)::regclass
        and k.conname = c.table_name || '_' || c.column_name || '_finite'
        and pg_get_constraintdef(k.oid) like '%is_finite%')
$$, 'every numeric column has its named finite check');

select * from finish();
rollback;
