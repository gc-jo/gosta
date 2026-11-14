-- Exercises the SQL of docs/runbooks/owner-account-recovery.md so the runbook cannot rot.
-- The statements below are copied from that file; only the placeholders PUT-NEW-PASSWORD-HERE and
-- PUT-NEW-NUMBER-HERE are replaced. If a statement there changes, change it here in the same commit.
-- Everything runs as postgres, like the dashboard's SQL editor (which bypasses the app's access rules);
-- the seeded owner is '100' with password 'correct horse battery'.
begin;
select plan(49);

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
-- The runbook's block is: begin; <ONE do $recovery$ statement>; commit;. The do statement below is copied from it;
-- only the placeholder PUT-NEW-PASSWORD-HERE (inside the $pw$ literal) is replaced. The explicit begin/commit are left out
-- because they cannot be nested inside this file's own transaction. The two-connection test
-- supabase/tests-concurrency/owner_recovery_test.ts reads the block from the runbook itself and proves the begin..commit
-- form, the lock behaviour and every client mode; this file proves what the statement does and refuses.
-- Where a case fails, the statement is atomic: a raised error undoes everything it did (asserted as "unchanged").
-- two more live owner sessions, so "every prior session is revoked" means something; and a lock to be cleared
insert into app_sessions (session_id, user_id, expires_at)
values ('c0c0c0c0-0000-4000-8000-000000000001', t12c.owner_id(), clock_timestamp() + interval '7 days'),
       ('c0c0c0c0-0000-4000-8000-000000000002', t12c.owner_id(), clock_timestamp() + interval '7 days');
update app_users set failed_attempts = 3, locked_until = clock_timestamp() + interval '1 hour' where role = 'owner';
select is(t12c.live(), 3::bigint, 'three live owner sessions before the recovery');
create table t12c.before as select t12c.cv() as cv, (select auth_user_id from app_users where role = 'owner') as auth_id;
create table t12c.snap as
select (select secret_hash from app_user_secrets where user_id = t12c.owner_id()) as hash, t12c.cv() as cv, t12c.live() as live,
       failed_attempts as fa, locked_until as lu,
       (select count(*) from activity_log where action = 'OWNER_PASSWORD_RECOVERY') as audits
from app_users where role = 'owner';
create function t12c.unchanged() returns boolean language sql stable as
$$ select (select secret_hash from app_user_secrets where user_id = t12c.owner_id()) = (select hash from t12c.snap)
      and t12c.cv() = (select cv from t12c.snap) and t12c.live() = (select live from t12c.snap)
      and (select failed_attempts from app_users where role = 'owner') = (select fa from t12c.snap)
      and (select locked_until from app_users where role = 'owner') is not distinct from (select lu from t12c.snap)
      and (select count(*) from activity_log where action = 'OWNER_PASSWORD_RECOVERY') = (select audits from t12c.snap) $$;

-- the placeholder left in
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$PUT-NEW-PASSWORD-HERE$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'STOP: the placeholder was not replaced with a new password. Nothing was changed.', 'the placeholder stops the recovery');
select is(t12c.unchanged(), true, 'placeholder: nothing changed (hash, version, sessions, lock fields, audit rows)');

-- two owner rows
insert into app_users (employee_number, name, role) values ('90009999', 'second owner', 'owner');
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$brand new owner pass 123$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'STOP: expected exactly one owner row, found 2. Nothing was changed.', 'two owner rows stop the recovery');
delete from app_users where employee_number = '90009999';
select is(t12c.unchanged(), true, 'two owners: nothing changed');

-- zero owner rows (the owner made a manager for the moment: role and branch change together, as the constraint demands)
update app_users set role = 'manager', branch_id = 'BR-01' where employee_number = '100';
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$brand new owner pass 123$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'STOP: expected exactly one owner row, found 0. Nothing was changed.', 'zero owner rows stop the recovery');
update app_users set role = 'owner', branch_id = null where employee_number = '100';
select is(t12c.unchanged(), true, 'zero owners: nothing changed');

-- a too-short password, a password over 72 bytes and a password with a control character (a tab)
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$too short$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'SECRET_WEAK', 'a too-short password is refused');
select is(t12c.unchanged(), true, 'too short: nothing changed');
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'SECRET_TOO_LONG', 'a password over 72 bytes is refused');
select is(t12c.unchanged(), true, 'too long: nothing changed');
select throws_ok($q$
do $recovery$
declare
  v_new   text := $pw$brand new	owner pass 123$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'P0001', 'SECRET_INVALID', 'a password with a control character is refused');
select is(t12c.unchanged(), true, 'control character: nothing changed');

-- the real run
select lives_ok($q$
do $recovery$
declare
  v_new   text := $pw$brand new owner pass 123$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;
$q$, 'runbook 2: the recovery statement runs');
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
select is((select count(*) from activity_log where action = 'OWNER_PASSWORD_RECOVERY'), (select audits + 1 from t12c.snap), 'exactly one OWNER_PASSWORD_RECOVERY row was added');
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
