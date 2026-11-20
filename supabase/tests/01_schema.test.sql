begin;
select plan(9);
select has_table('branches'); select has_table('app_user_secrets'); select has_table('app_sessions');
select hasnt_column('app_users', 'session_expires_at');
select throws_ok($$insert into item_units values ('D-999','مل',1,true)$$, '23503');          -- unit for a missing item
select throws_ok($$insert into item_units values ('D-001','برميل',0,true)$$, '23514');        -- rate must be > 0
select throws_ok($$insert into branches(id,name_ar,kind,active) values ('BR-77','x','BR-11',true)$$, '23514');
select throws_ok($$insert into app_users(employee_number,name,role,branch_id) values ('900','x','owner','BR-01')$$, '23514');
select is((select count(*) from app_users u join app_sessions s on s.user_id = u.id), 7::bigint, 'seven seeded users with a session');
select * from finish();
rollback;
