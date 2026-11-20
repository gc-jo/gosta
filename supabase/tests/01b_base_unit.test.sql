begin;
select plan(8);
-- Fire the deferred base-unit trigger at each statement instead of at commit.
set constraints all immediate;

select throws_ok($$insert into items values ('D-801','x','مل','syrup',0,true)$$, '23514',
  null, 'item with no unit row is refused');

select throws_ok($$
  with i as (insert into items values ('D-802','x','مل','syrup',0,true))
  insert into item_units values ('D-802','مل',2,true)$$, '23514',
  null, 'base unit row with rate other than 1 is refused');

select throws_ok($$delete from item_units where item_id = 'D-001' and unit_name = 'مل'$$, '23514',
  null, 'deleting the base unit row is refused');

select throws_ok($$update items set base_unit = 'برميل' where id = 'D-001'$$, '23514',
  null, 'repointing base_unit to a missing unit is refused');

select throws_ok($$update item_units set conversion_rate = 2 where item_id = 'D-001' and unit_name = 'مل'$$, '23514',
  null, 'changing the base unit rate away from 1 is refused');

select throws_ok($$update item_units set active = false where item_id = 'D-001' and unit_name = 'مل'$$, '23514',
  null, 'deactivating the base unit row is refused');

set constraints all deferred;
select lives_ok($$
  insert into items values ('D-803','x','مل','syrup',0,true);
  insert into item_units values ('D-803','مل',1,true);
  set constraints all immediate;$$,
  'item inserted together with its rate-1 base unit row succeeds');

select lives_ok($$insert into item_units values ('D-001','قارورة',500,true)$$,
  'adding a second non-base unit to an existing item succeeds');

select * from finish();
rollback;
