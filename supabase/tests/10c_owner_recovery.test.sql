-- Exercises the SQL of docs/runbooks/owner-account-recovery.md so the runbook cannot rot.
-- The statements below are copied from that file; only the placeholders PUT-NEW-PASSWORD-HERE and
-- PUT-NEW-NUMBER-HERE are replaced. If a statement there changes, change it here in the same commit.
-- Everything runs as postgres, like the dashboard's SQL editor (which bypasses the app's access rules);
-- the seeded owner is '100' with password 'correct horse battery'.
begin;
select plan(29);

create schema t12c;
create function t12c.owner_id() returns uuid language sql stable as $$ select id from app_users where role = 'owner' $$;
create function t12c.live() returns bigint language sql stable as
$$ select count(*) from app_sessions where user_id = t12c.owner_id() and revoked_at is null $$;
create function t12c.cv() returns int language sql stable as $$ select credential_version from app_users where role = 'owner' $$;
create function t12c.lv(p_emp text, p_secret text) returns text language sql as
$$ select case when (r ->> 'ok')::boolean then 'ok' else r ->> 'reason' end from (select public.login_verify(p_emp, p_secret) as r) q $$;

select is((select count(*) from app_users where role = 'owner'), 1::bigint, 'exactly one owner row, as the runbook assumes');
select is(t12c.live(), 1::bigint, 'the owner starts with the one seeded live session');

-- 1. Locked out after wrong passwords -------------------------------------------------------------------
select is(t12c.lv('100', 'wrong 1'), 'invalid', 'wrong password 1');
select is(t12c.lv('100', 'wrong 2'), 'invalid', 'wrong password 2');
select is(t12c.lv('100', 'wrong 3'), 'invalid', 'wrong password 3');
select is(t12c.lv('100', 'wrong 4'), 'invalid', 'wrong password 4');
select is(t12c.lv('100', 'wrong 5'), 'locked', 'the fifth wrong password locks the owner');
select is(t12c.lv('100', 'correct horse battery'), 'locked', 'the right password is refused while locked');

select lives_ok($q$
select employee_number, failed_attempts, locked_until
from app_users where role = 'owner';
$q$, 'runbook 1: the inspection query runs');
select ok((select locked_until > clock_timestamp() from app_users where role = 'owner'), 'the lock is visible to that query');

select lives_ok($q$
update app_users
set failed_attempts = 0, locked_until = null
where role = 'owner';
$q$, 'runbook 1: the unlock statement runs');
select is((select locked_until is null and failed_attempts = 0 from app_users where role = 'owner'), true, 'lock and counter cleared');
select is(t12c.lv('100', 'correct horse battery'), 'ok', 'the owner logs in with the unchanged password');
select is(t12c.live(), 1::bigint, 'runbook 1 ended no session');

-- 2. Password lost --------------------------------------------------------------------------------------
-- two more live owner sessions, so "every prior session is revoked" means something
insert into app_sessions (session_id, user_id, expires_at)
values ('c0c0c0c0-0000-4000-8000-000000000001', t12c.owner_id(), clock_timestamp() + interval '7 days'),
       ('c0c0c0c0-0000-4000-8000-000000000002', t12c.owner_id(), clock_timestamp() + interval '7 days');
select is(t12c.live(), 3::bigint, 'three live owner sessions before the reset');
create table t12c.before as select t12c.cv() as cv;

select lives_ok($q$
update app_user_secrets
set secret_hash = extensions.crypt('brand new owner pass 123', extensions.gen_salt('bf', 10))
where user_id = (select id from app_users where role = 'owner');
$q$, 'runbook 2 statement 1: store the new password');
select lives_ok($q$
update app_sessions
set revoked_at = clock_timestamp()
where user_id = (select id from app_users where role = 'owner') and revoked_at is null;
$q$, 'runbook 2 statement 2: end every owner session');
select lives_ok($q$
update app_users
set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
where role = 'owner';
$q$, 'runbook 2 statement 3: advance the version');

select is(t12c.live(), 0::bigint, 'every prior owner session is revoked');
select is(t12c.cv(), (select cv + 1 from t12c.before), 'credential_version rose by 1');
select throws_ok(
  format($$select public.login_register_session(%L, 'c0c0c0c0-0000-4000-8000-000000000003', %s)$$, t12c.owner_id(), (select cv from t12c.before)),
  'P0001', 'USER_INVALID', 'a login verified before the reset cannot register a session');
select is((select count(*) from app_sessions where session_id = 'c0c0c0c0-0000-4000-8000-000000000003'), 0::bigint, 'and no session row appeared');
select is(t12c.lv('100', 'correct horse battery'), 'invalid', 'the old password is refused');
select is(t12c.lv('100', 'brand new owner pass 123'), 'ok', 'the new password logs in');
select lives_ok(
  format($$select public.login_register_session(%L, 'c0c0c0c0-0000-4000-8000-000000000004', %s)$$, t12c.owner_id(), t12c.cv()),
  'a login with the new version registers its session');

-- 3. Someone keeps locking the owner out ----------------------------------------------------------------
select lives_ok($q$
update app_users
set employee_number = '90001234', failed_attempts = 0, locked_until = null
where role = 'owner';
$q$, 'runbook 3: change the employee number');
select is(t12c.lv('90001234', 'brand new owner pass 123'), 'ok', 'the owner logs in with the new number');
select is(t12c.lv('100', 'brand new owner pass 123'), 'invalid', 'the old number no longer works');
select is(t12c.live(), 1::bigint, 'existing sessions keep working');
select * from finish();
rollback;
