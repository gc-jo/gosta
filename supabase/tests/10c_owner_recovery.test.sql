-- Exercises the SQL of docs/runbooks/owner-account-recovery.md so the runbook cannot rot.
-- The statements below are copied from that file; only the placeholders PUT-NEW-PASSWORD-HERE and
-- PUT-NEW-NUMBER-HERE are replaced. If a statement there changes, change it here in the same commit.
-- Everything runs as postgres, like the dashboard's SQL editor (which bypasses the app's access rules);
-- the seeded owner is '100' with password 'correct horse battery'.
begin;
select plan(56);

create schema t12c;
create function t12c.owner_id() returns uuid language sql stable as $$ select id from app_users where role = 'owner' $$;
create function t12c.live() returns bigint language sql stable as
$$ select count(*) from app_sessions where user_id = t12c.owner_id() and revoked_at is null $$;
create function t12c.cv() returns int language sql stable as $$ select credential_version from app_users where role = 'owner' $$;
-- act as the owner's Auth user with an explicit session id, like 10b_owner_recheck.test.sql
create function t12c.act_sess(p_session uuid) returns void language plpgsql as $$
declare v_auth uuid;
begin
  reset role;
  select auth_user_id into v_auth from app_users where role = 'owner';
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_auth, 'role', 'authenticated', 'session_id', p_session)::text, true);
  set local role authenticated;
end;
$$;
grant usage on schema t12c to authenticated;
grant execute on all functions in schema t12c to authenticated;
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
-- The runbook's block is: begin; <7 statements>; commit;. The statements below are copied from it; only the placeholder
-- PUT-NEW-PASSWORD-HERE (inside the $pw$ literal of statement 2) is replaced, and the explicit begin/commit are
-- left out because they cannot be nested inside this file's own transaction.
-- WHAT THIS FILE PROVES: the behaviour of each statement inside the test transaction. It does NOT prove that a
-- failing statement aborts the whole block, nor the lock behaviour (a login in flight waits for statement 1): that is
-- proven on separate connections by supabase/tests-concurrency/owner_recovery_test.ts, which reads the block from the
-- runbook itself. Where a statement fails below, the real block would stop there and be rolled back.
-- two more live owner sessions, so "every prior session is revoked" means something; and a lock to be cleared
insert into app_sessions (session_id, user_id, expires_at)
values ('c0c0c0c0-0000-4000-8000-000000000001', t12c.owner_id(), clock_timestamp() + interval '7 days'),
       ('c0c0c0c0-0000-4000-8000-000000000002', t12c.owner_id(), clock_timestamp() + interval '7 days');
update app_users set failed_attempts = 3, locked_until = clock_timestamp() + interval '1 hour' where role = 'owner';
select is(t12c.live(), 3::bigint, 'three live owner sessions before the recovery');
create table t12c.before as select t12c.cv() as cv, (select auth_user_id from app_users where role = 'owner') as auth_id;
create table t12c.snap as
select (select secret_hash from app_user_secrets where user_id = t12c.owner_id()) as hash, t12c.cv() as cv, t12c.live() as live;
create function t12c.unchanged() returns boolean language sql stable as
$$ select (select secret_hash from app_user_secrets where user_id = t12c.owner_id()) = (select hash from t12c.snap)
      and t12c.cv() = (select cv from t12c.snap) and t12c.live() = (select live from t12c.snap) $$;

select lives_ok($q$
select id from app_users where role = 'owner' for update;
$q$, 'runbook 2 statement 1: lock the owner row');

-- the placeholder left in: the guard stops the block
select lives_ok($q$
select set_config('recovery.new_password', $pw$PUT-NEW-PASSWORD-HERE$pw$, true);
$q$, 'runbook 2 statement 2 with the placeholder left in');
select throws_ok($q$
do $guard$
begin
  if (select count(*) from app_users where role = 'owner') <> 1 then
    raise exception 'STOP: expected exactly one owner row. Nothing was changed.';
  end if;
  if current_setting('recovery.new_password') = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;
end
$guard$;
$q$, 'P0001', 'STOP: the placeholder was not replaced with a new password. Nothing was changed.', 'runbook 2 statement 3: the guard stops on the placeholder');
select is(t12c.unchanged(), true, 'nothing changed');

-- two owner rows: the guard stops the block
insert into app_users (employee_number, name, role) values ('90009999', 'second owner', 'owner');
select lives_ok($q$
select set_config('recovery.new_password', $pw$brand new owner pass 123$pw$, true);
$q$, 'runbook 2 statement 2 with a real password');
select throws_ok($q$
do $guard$
begin
  if (select count(*) from app_users where role = 'owner') <> 1 then
    raise exception 'STOP: expected exactly one owner row. Nothing was changed.';
  end if;
  if current_setting('recovery.new_password') = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;
end
$guard$;
$q$, 'P0001', 'STOP: expected exactly one owner row. Nothing was changed.', 'runbook 2 statement 3: the guard stops on two owner rows');
delete from app_users where employee_number = '90009999';
select is(t12c.unchanged(), true, 'nothing changed');

-- a too-short password and a password with a control character (a tab) pass the guard and are refused by statement 4
select lives_ok($q$
select set_config('recovery.new_password', $pw$too short$pw$, true);
$q$, 'statement 2 with a short password');
select lives_ok($q$
do $guard$
begin
  if (select count(*) from app_users where role = 'owner') <> 1 then
    raise exception 'STOP: expected exactly one owner row. Nothing was changed.';
  end if;
  if current_setting('recovery.new_password') = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;
end
$guard$;
$q$, 'runbook 2 statement 3: the guard accepts a short password (statement 4 refuses it)');
select throws_ok($q$
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt(app.clean_secret('owner', current_setting('recovery.new_password')), extensions.gen_salt('bf', 10))
from app_users where role = 'owner'
on conflict (user_id) do update set secret_hash = excluded.secret_hash;
$q$, 'P0001', 'SECRET_WEAK', 'runbook 2 statement 4: a too-short password is refused');
select is(t12c.unchanged(), true, 'nothing changed');
select lives_ok($q$
select set_config('recovery.new_password', $pw$brand new	owner pass 123$pw$, true);
$q$, 'statement 2 with a tab in the password');
select throws_ok($q$
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt(app.clean_secret('owner', current_setting('recovery.new_password')), extensions.gen_salt('bf', 10))
from app_users where role = 'owner'
on conflict (user_id) do update set secret_hash = excluded.secret_hash;
$q$, 'P0001', 'SECRET_INVALID', 'runbook 2 statement 4: a password with a control character is refused');
select is(t12c.unchanged(), true, 'nothing changed');

-- the real run
select lives_ok($q$
select set_config('recovery.new_password', $pw$brand new owner pass 123$pw$, true);
$q$, 'runbook 2 statement 2: the new password');
select lives_ok($q$
do $guard$
begin
  if (select count(*) from app_users where role = 'owner') <> 1 then
    raise exception 'STOP: expected exactly one owner row. Nothing was changed.';
  end if;
  if current_setting('recovery.new_password') = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;
end
$guard$;
$q$, 'runbook 2 statement 3: the guard passes');
select lives_ok($q$
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt(app.clean_secret('owner', current_setting('recovery.new_password')), extensions.gen_salt('bf', 10))
from app_users where role = 'owner'
on conflict (user_id) do update set secret_hash = excluded.secret_hash;
$q$, 'runbook 2 statement 4: store the new password');
select lives_ok($q$
update app_users
set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
where role = 'owner';
$q$, 'runbook 2 statement 5: advance the version');
select lives_ok($q$
update app_sessions
set revoked_at = clock_timestamp()
where user_id = (select id from app_users where role = 'owner') and revoked_at is null;
$q$, 'runbook 2 statement 6: end every owner session');
select lives_ok($q$
select app.log_action((select id from app_users where role = 'owner'), 'OWNER_PASSWORD_RECOVERY', 'app_users', (select id::text from app_users where role = 'owner'), '{"via": "runbook"}'::jsonb);
$q$, 'runbook 2 statement 7: record the recovery');

select lives_ok($q$
select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner';
$q$, 'runbook 2: the verification query runs');
select is((select count(*) from (select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner') q), 1::bigint, 'the verification query returns exactly one row');
select is((select live_sessions from (select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner') q), 0::bigint, 'with live_sessions = 0');
select is((select credential_version from (select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner') q), (select cv + 1 from t12c.before), 'and credential_version one higher');
select is((select locked_until is null and failed_attempts = 0 from app_users where role = 'owner'), true, 'the lock and the counter are cleared');
select is((select count(*) from activity_log where action = 'OWNER_PASSWORD_RECOVERY' and user_id = t12c.owner_id()), 1::bigint, 'one OWNER_PASSWORD_RECOVERY row is logged for the owner');
select isnt((select secret_hash from app_user_secrets where user_id = t12c.owner_id()), (select hash from t12c.snap), 'the stored hash changed');
select is(t12c.live(), 0::bigint, 'every prior owner session is revoked');
select is(t12c.cv(), (select cv + 1 from t12c.before), 'credential_version rose by 1');
select throws_ok(
  format($$select public.login_register_session(%L, 'c0c0c0c0-0000-4000-8000-000000000003', %s)$$, t12c.owner_id(), (select cv from t12c.before)),
  'P0001', 'USER_INVALID', 'a login verified before the recovery cannot register a session');
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
select is((select auth_user_id from app_users where role = 'owner'), (select auth_id from t12c.before), 'the statement left auth_user_id unchanged');
select is(t12c.live(), 1::bigint, 'one live owner session exists (the one registered in section 2)');
select t12c.act_sess('c0c0c0c0-0000-4000-8000-000000000004');
select is((select app.session_ok()), true, 'that existing session still passes app.session_ok() after the number change');
select t12c.act_sess('c0c0c0c0-0000-4000-8000-000000000001');
select is((select app.session_ok()), false, 'a session revoked in section 2 stays refused (control)');
reset role;
select * from finish();
rollback;
