-- Task 11: login_verify, login_attach_auth_user, login_register_session.
-- Everything runs after test.act_as_service() unless a step says otherwise. Owner steps (reset, deactivate,
-- create user) go through the real admin RPCs, acting as the owner, then switch back to the server role.
begin;
select plan(185);

-- test-local helpers (rolled back with the transaction) --------------------------------------
create schema t11;
grant usage on schema t11 to authenticated, service_role;

create function t11.uid(p_emp text) returns uuid language sql stable security definer set search_path = public as
$$ select id from app_users where employee_number = p_emp $$;
create function t11.authid(p_emp text) returns uuid language sql stable security definer set search_path = public as
$$ select auth_user_id from app_users where employee_number = p_emp $$;
create function t11.cv(p_emp text) returns int language sql stable security definer set search_path = public as
$$ select credential_version from app_users where employee_number = p_emp $$;
create function t11.fa(p_emp text) returns int language sql stable security definer set search_path = public as
$$ select failed_attempts from app_users where employee_number = p_emp $$;
create function t11.lu(p_emp text) returns timestamptz language sql stable security definer set search_path = public as
$$ select locked_until from app_users where employee_number = p_emp $$;
create function t11.nsess(p_emp text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;
create function t11.nlive(p_emp text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions s join app_users u on u.id = s.user_id
   where u.employee_number = p_emp and s.revoked_at is null $$;
create function t11.nsess_all() returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions $$;
create function t11.set_lu(p_emp text, p_at timestamptz) returns void language sql security definer set search_path = public as
$$ update app_users set locked_until = p_at where employee_number = p_emp $$;
-- the actions logged for one employee number, oldest first
create function t11.logs(p_emp text) returns text language sql stable security definer set search_path = public as
$$ select coalesce(string_agg(action, ',' order by at), '') from activity_log
   where action like 'LOGIN\_%' and details ->> 'employee_number' = p_emp $$;
create function t11.nlogs() returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from activity_log where action like 'LOGIN\_%' $$;

create function t11.sess_exp(p_id uuid) returns timestamptz language sql stable security definer set search_path = public as
$$ select expires_at from app_sessions where session_id = p_id $$;
create function t11.sess_user(p_id uuid) returns uuid language sql stable security definer set search_path = public as
$$ select user_id from app_sessions where session_id = p_id $$;
create function t11.sess_rev(p_id uuid) returns timestamptz language sql stable security definer set search_path = public as
$$ select revoked_at from app_sessions where session_id = p_id $$;
-- number of activity_log rows matching a where clause; details and user id of the one login row of an action and number
create function t11.lq(p_where text) returns bigint language plpgsql stable security definer set search_path = public as
$$ declare n bigint; begin execute 'select count(*) from activity_log where ' || p_where into n; return n; end $$;
create function t11.ldet(p_action text, p_emp text) returns jsonb language sql stable security definer set search_path = public as
$$ select details from activity_log where action = p_action and details ->> 'employee_number' = p_emp $$;
create function t11.luser(p_action text, p_emp text) returns uuid language sql stable security definer set search_path = public as
$$ select user_id from activity_log where action = p_action and details ->> 'employee_number' = p_emp $$;

create table t11.res (k text primary key, v jsonb);
create table t11.snap (k text primary key, v text);
grant all on t11.res, t11.snap to authenticated, service_role;
create function t11.snap(p_k text, p_v text) returns void language sql security definer set search_path = public as
$$ insert into t11.snap values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function t11.snapv(p_k text) returns text language sql stable security definer set search_path = public as
$$ select v from t11.snap where k = p_k $$;
create function t11.res(p_k text) returns jsonb language sql stable security definer set search_path = public as
$$ select v from t11.res where k = p_k $$;
-- call login_verify as the current role (service_role in these tests) and keep the answer under a key
create function t11.lv(p_k text, p_emp text, p_secret text) returns void language plpgsql as $$
begin
  insert into t11.res values (p_k, public.login_verify(p_emp, p_secret))
  on conflict (k) do update set v = excluded.v;
end;
$$;
-- 'ok' or the reason, for compact tests
create function t11.r(p_emp text, p_secret text) returns text language sql as
$$ select case when (r ->> 'ok')::boolean then 'ok' else r ->> 'reason' end from (select public.login_verify(p_emp, p_secret) as r) q $$;
-- the same call for its side effects only (no output)
create function t11.go(p_emp text, p_secret text) returns void language plpgsql as $$
begin
  perform public.login_verify(p_emp, p_secret);
end;
$$;
create function t11.inv() returns jsonb language sql immutable as
$$ select '{"ok": false, "reason": "invalid", "locked_until": null}'::jsonb $$;
-- act as a user with a chosen session id
create function t11.act_sess(p_emp text, p_session uuid) returns void language plpgsql as $$
declare v_auth uuid;
begin
  reset role;
  select auth_user_id into v_auth from app_users where employee_number = p_emp;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_auth, 'role', 'authenticated', 'session_id', p_session)::text, true);
  set local role authenticated;
end;
$$;
-- does any login log row carry the needle in its details?
create function t11.leak(p_needle text) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from activity_log a where a.action like 'LOGIN\_%' and position(p_needle in a.details::text) > 0) $$;
-- crypt calls so far in this transaction (needs track_functions = 'all', set below when the role may)
create function t11.crypt_calls() returns bigint language sql as
$$ select coalesce(sum(calls), 0)::bigint from pg_stat_xact_user_functions where funcname = 'crypt' and schemaname = 'extensions' $$;
-- one assertion: this login_verify call runs extensions.crypt exactly p_expected times (skipped when untracked)
create function t11.crypt_delta(p_desc text, p_emp text, p_secret text, p_expected bigint) returns setof text language plpgsql as $$
declare v_before bigint; v_after bigint;
begin
  perform set_config('t11.crypt_n', (coalesce(nullif(current_setting('t11.crypt_n', true), ''), '0')::int + 1)::text, true);
  if current_setting('t11.track', true) is distinct from '1' then
    return next skip(1, 'this role cannot set track_functions');
    return;
  end if;
  v_before := t11.crypt_calls();
  perform public.login_verify(p_emp, p_secret);
  v_after := t11.crypt_calls();
  return next is(v_after - v_before, p_expected, p_desc);
end;
$$;
grant execute on all functions in schema t11 to authenticated, service_role;

-- count extensions.crypt calls per login_verify call when this role may set track_functions (postgres on
-- Supabase is not a superuser; without the privilege the crypt-count assertions are skipped, not failed)
select set_config('t11.track', case when has_parameter_privilege(current_user, 'track_functions', 'set') then '1' else '0' end, true);
do $$ begin
  if current_setting('t11.track') = '1' then
    set local track_functions = 'all';
  end if;
end $$;

-- fixtures that no RPC can create (as postgres): a user without a secret row, a user whose
-- Auth row is already taken by another app user
insert into app_users (employee_number, name, role, branch_id) values
  ('208', 'no secret row', 'manager', 'BR-01'),
  ('209', 'auth row taken', 'manager', 'BR-01'),
  ('210', 'holds that auth row', 'manager', 'BR-01');
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt('9090', extensions.gen_salt('bf', 10)) from app_users where employee_number = '209';
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new, reauthentication_token)
values ('00000000-0000-0000-0000-000000000000', 'b1100000-0000-4000-8000-000000000209', 'authenticated', 'authenticated',
        '209@gosta.invalid', now(), '', '', '', '', '');
update app_users set auth_user_id = 'b1100000-0000-4000-8000-000000000209' where employee_number = '210';

-- users created through the real RPC, as the owner: leading zeros, and one without an Auth user
select test.act_as('100');
select lives_ok($$select admin_create_user('c1100000-0000-4000-8000-000000000001', '0204', 'leading zero', 'manager', 'BR-01', '4444')$$, 'setup: 0204 created (PIN 4444)');
select lives_ok($$select admin_create_user('c1100000-0000-4000-8000-000000000002', '204', 'no zero', 'manager', 'BR-01', '5555')$$, 'setup: 204 created (PIN 5555)');
select lives_ok($$select admin_create_user('c1100000-0000-4000-8000-000000000003', '206', 'repair me', 'manager', 'BR-02', '6666')$$, 'setup: 206 created (PIN 6666), no Auth user');

-- 1. privileges --------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'public.login_verify(text,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.login_verify(text,text)', 'execute')
      and not has_function_privilege('anon', 'public.login_verify(text,text)', 'execute'), 'login_verify: service_role only');
select ok(has_function_privilege('service_role', 'public.login_attach_auth_user(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.login_attach_auth_user(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.login_attach_auth_user(uuid)', 'execute'), 'login_attach_auth_user: service_role only');
select ok(has_function_privilege('service_role', 'public.login_register_session(uuid,uuid,int)', 'execute')
      and not has_function_privilege('authenticated', 'public.login_register_session(uuid,uuid,int)', 'execute')
      and not has_function_privilege('anon', 'public.login_register_session(uuid,uuid,int)', 'execute'), 'login_register_session: service_role only');

select test.act_as('201');
select throws_ok($$select public.login_verify('201', '1111')$$, '42501', null, 'a signed-in manager cannot call login_verify');
select throws_ok($$select public.login_attach_auth_user(t11.uid('201'))$$, '42501', null, 'a signed-in manager cannot call login_attach_auth_user');
select throws_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000001', 0)$$, '42501', null, 'a signed-in manager cannot call login_register_session');
select test.act_as('100');
select throws_ok($$select public.login_verify('100', 'correct horse battery')$$, '42501', null, 'not even the owner can call login_verify from the client');
select test.reset_role();
set local role anon;
select throws_ok($$select public.login_verify('201', '1111')$$, '42501', null, 'anon cannot call login_verify');
select test.act_as_service();
select is(current_user::text, 'service_role', 'the server role is active');
select lives_ok($$select public.login_attach_auth_user(t11.uid('201'))$$, 'service_role can call a login function (deferred from Task 1)');

-- 2. ok, Arabic digits, shape, no session -----------------------------------------------------
select t11.snap('all0', t11.nsess_all()::text);
select t11.lv('ok201', '201', '1111');
select is(t11.res('ok201') ->> 'ok', 'true', 'ok: 201 / 1111');
select is((t11.res('ok201') ->> 'user_id')::uuid, t11.uid('201'), 'ok: user_id is the user');
select is((t11.res('ok201') ->> 'auth_user_id')::uuid, t11.authid('201'), 'ok: auth_user_id is the attached Auth user');
select is(t11.res('ok201') ->> 'employee_number', '201', 'ok: employee_number');
select is((t11.res('ok201') ->> 'credential_version')::int, t11.cv('201'), 'ok: credential_version is the current one');
select is((select array_agg(k order by k) from jsonb_object_keys(t11.res('ok201')) k),
          array['auth_user_id', 'credential_version', 'employee_number', 'ok', 'user_id'], 'ok: exactly these keys');
select is(t11.nsess_all()::text, t11.snapv('all0'), 'ok: login_verify creates no session');
select is(t11.r('٢٠١', '١١١١'), 'ok', 'Arabic-Indic digits, staff: number and PIN');
select is(t11.r('۲۰۱', '۱۱۱۱'), 'ok', 'Persian digits, staff');

-- 3. invalid: wrong, unknown, inactive, malformed ----------------------------------------------
select t11.lv('bad201', '201', '0000');
select is(t11.res('bad201'), t11.inv(), 'wrong PIN: exactly {ok false, reason invalid, locked_until null}');
select is(t11.fa('201'), 1, 'wrong PIN counts (1)');
select is(t11.r('999', '1111'), 'invalid', 'unknown number: invalid');
select t11.lv('unk', '999', '1111');
select is(t11.res('unk'), t11.inv(), 'unknown number: the same answer as a wrong PIN');
select t11.lv('inact', '299', '9999');
select is(t11.res('inact'), t11.inv(), 'inactive user with the right PIN: exactly the invalid answer');
select is(t11.fa('299'), 0, 'inactive user: nothing counted');
select is(t11.r('299', '0000'), 'invalid', 'inactive user with a wrong PIN: invalid');
select is(t11.fa('299'), 0, 'inactive user: still nothing counted');
select is(t11.r(null, '1111'), 'invalid', 'null number: invalid, no error');
select is(t11.r('abc', '1111'), 'invalid', 'non-digit number: invalid, no error');
select is(t11.r('', '1111'), 'invalid', 'empty number: invalid, no error');
select t11.lv('nosec', '208', '1111');
select is(t11.res('nosec'), t11.inv(), 'a user without a secret row: exactly the invalid answer');
select is(t11.fa('208'), 0, 'a user without a secret row: nothing to count against');
select is(t11.r('00201', '1111'), 'invalid', '00201 is not 201');

-- 4. bcrypt boundary for staff, null, counted ---------------------------------------------------
select t11.lv('long201', '201', repeat('1', 200));
select is(t11.res('long201'), t11.inv(), '200-byte secret for staff: invalid, no error');
select is(t11.fa('201'), 2, 'the 200-byte secret counted as a failed attempt');
select t11.lv('null201', '201', null);
select is(t11.res('null201'), t11.inv(), 'null secret: invalid, no error');
select is(t11.fa('201'), 3, 'a null secret counts as a failed attempt');
select is(t11.r('201', repeat('١', 100)), 'invalid', '100 Arabic digits (100 bytes once cleaned): invalid');
select is(t11.fa('201'), 4, 'counted (4)');
select is(t11.r('201', '1111'), 'ok', 'four wrong then the right PIN: ok');
select is(t11.fa('201'), 0, 'the counter is back to 0');
select is(t11.lu('201'), null, 'and not locked');

-- 5. lockout (202, PIN 2222) ---------------------------------------------------------------------
select is(t11.r('202', '1'), 'invalid', 'lockout: wrong 1');
select is(t11.r('202', '2'), 'invalid', 'lockout: wrong 2');
select is(t11.r('202', '3'), 'invalid', 'lockout: wrong 3');
select is(t11.r('202', '4'), 'invalid', 'lockout: wrong 4');
select is(t11.fa('202'), 4, 'four failures counted');
select t11.lv('lock5', '202', '5');
select is(t11.res('lock5') ->> 'reason', 'locked', 'the fifth wrong attempt answers locked');
select is((t11.res('lock5') ->> 'ok')::boolean, false, 'locked: ok is false');
select ok((t11.res('lock5') ->> 'locked_until')::timestamptz between clock_timestamp() + interval '14 minutes 55 seconds'
                                                                  and clock_timestamp() + interval '15 minutes', 'locked_until is about 15 minutes ahead');
select is((t11.res('lock5') ->> 'locked_until')::timestamptz, t11.lu('202'), 'the answer carries the stored locked_until');
select is(t11.fa('202'), 0, 'the counter is reset when the lock is set');
select t11.snap('lu202', t11.lu('202')::text);
select t11.lv('lockedright', '202', '2222');
select is(t11.res('lockedright') ->> 'reason', 'locked', 'the right PIN while locked: locked');
select is((t11.res('lockedright') ->> 'locked_until')::timestamptz, t11.lu('202'), 'locked answer carries the same locked_until');
select is(t11.fa('202'), 0, 'a locked attempt does not count');
select is(t11.r('202', '٢٢٢٢'), 'locked', 'Arabic digits while locked: locked');
select is(t11.r('202', '0'), 'locked', 'a wrong PIN while locked: locked');
select is(t11.fa('202'), 0, 'still 0 after locked attempts');
select is(t11.lu('202')::text, t11.snapv('lu202'), 'a locked response does not extend the lock');
select is(t11.logs('202'), 'LOGIN_FAILED,LOGIN_FAILED,LOGIN_FAILED,LOGIN_FAILED,LOGIN_LOCKED,LOGIN_LOCKED,LOGIN_LOCKED,LOGIN_LOCKED',
          'log: four failures, the locking attempt, three locked attempts');
select * from t11.crypt_delta('locked: no crypt at all', '202', '2222', 0);
select t11.set_lu('202', clock_timestamp() - interval '1 second');
select is(t11.r('202', '2222'), 'ok', 'the lock has expired: the right PIN logs in');
select is(t11.lu('202'), null, 'success clears locked_until');
select is(t11.fa('202'), 0, 'success keeps the counter at 0');
-- a counter that restarted after the lock: five more wrong attempts lock again
select t11.set_lu('202', clock_timestamp() - interval '1 second');
select is(t11.r('202', '9'), 'invalid', 'after an expired lock a wrong PIN counts from 1');
select is(t11.fa('202'), 1, 'counter 1');
select is(t11.r('202', '2222'), 'ok', 'right PIN resets it');
select is(t11.fa('202'), 0, 'counter 0');

-- 6. success resets the counter (301, PIN 3333): four wrong, one right, four wrong -> not locked ----
select t11.go('301', 'a'); select t11.go('301', 'b'); select t11.go('301', 'c'); select t11.go('301', 'd');
select is(t11.fa('301'), 4, 'counter at 4');
select is(t11.r('301', '3333'), 'ok', 'one right');
select t11.go('301', 'a'); select t11.go('301', 'b'); select t11.go('301', 'c'); select t11.go('301', 'd');
select is(t11.fa('301'), 4, 'four wrong again: 4, not 8');
select is(t11.lu('301'), null, 'not locked');
select is(t11.r('301', '3333'), 'ok', 'and the right PIN still works');

-- 7. owner: exact comparison -----------------------------------------------------------------
select is(t11.r('100', 'correct horse battery'), 'ok', 'owner: the seeded password');
select is(t11.r('100', '1111'), 'invalid', 'owner: a PIN is not the password');
select t11.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select lives_ok($$select admin_set_secret('c1100000-0000-4000-8000-000000000011', t11.uid('100'), 'كلمة سر ١٢٣٤٥٦')$$, 'owner password set to Arabic text with Arabic digits');
select test.act_as_service();
select is(t11.r('100', 'كلمة سر ١٢٣٤٥٦'), 'ok', 'owner: that exact string logs in');
select is(t11.r('100', 'كلمة سر 123456'), 'invalid', 'owner: the same with Latin digits does NOT (no normalisation)');
select is(t11.r('100', 'correct horse battery'), 'invalid', 'owner: the old password is dead');

-- 8. bcrypt boundary for the owner ----------------------------------------------------------------
select t11.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select lives_ok($$select admin_set_secret('c1100000-0000-4000-8000-000000000012', t11.uid('100'), repeat('ب', 36))$$, 'owner password set to 36 Arabic letters');
select test.act_as_service();
select is(octet_length(repeat('ب', 36)), 72, 'that password is exactly 72 bytes');
select is(t11.r('100', repeat('ب', 36)), 'ok', '72-byte owner password P: ok');
select is(t11.r('100', repeat('ب', 36) || 'x'), 'invalid', 'P || x (73 bytes, first 72 identical): invalid');
select is(t11.fa('100'), 1, 'and it counted as a failed attempt');
select is(t11.r('100', repeat('ب', 36)), 'ok', 'P still logs in');
select is(t11.r('100', repeat('ب', 37)), 'invalid', 'P plus another letter (74 bytes): invalid');
select t11.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select lives_ok($$select admin_set_secret('c1100000-0000-4000-8000-000000000013', t11.uid('100'), repeat('x', 72))$$, 'owner password set to 72 ASCII characters');
select test.act_as_service();
select is(t11.r('100', repeat('x', 72)), 'ok', '72 ASCII bytes: ok');
select is(t11.r('100', repeat('x', 73)), 'invalid', '73 ASCII bytes: invalid');
select is(t11.r('100', repeat('x', 200)), 'invalid', '200 bytes: invalid');
select is(t11.r('100', repeat('x', 72)), 'ok', 'and 72 bytes is still ok');
select t11.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select lives_ok($$select admin_set_secret('c1100000-0000-4000-8000-000000000014', t11.uid('100'), 'a plain owner password')$$, 'owner password set to a plain one');
select test.act_as_service();
select is(t11.r('100', 'a plain owner password'), 'ok', 'owner: plain password ok');
select is(t11.r('100', ' a plain owner password'), 'invalid', 'owner: a leading space is not trimmed');
select is(t11.r('100', 'a plain owner password '), 'invalid', 'owner: a trailing space is not trimmed');
select is(t11.r('100', 'A plain owner password'), 'invalid', 'owner: case counts');
select is(t11.r('100', 'a plain owner password'), 'ok', 'owner: and the exact one still logs in');

-- 9. leading zeros --------------------------------------------------------------------------------
select t11.lv('z0204', '0204', '4444');
select is(t11.res('z0204') ->> 'ok', 'true', '0204 logs in with its own PIN');
select is((t11.res('z0204') ->> 'user_id')::uuid, t11.uid('0204'), '... as the user 0204');
select is(t11.res('z0204') ->> 'employee_number', '0204', '... and the answer says 0204');
select t11.lv('z204', '204', '5555');
select is(t11.res('z204') ->> 'ok', 'true', '204 logs in with its own PIN');
select is((t11.res('z204') ->> 'user_id')::uuid, t11.uid('204'), '... as the user 204');
select is(t11.res('z204') ->> 'employee_number', '204', '... and the answer says 204');
select isnt(t11.uid('0204'), t11.uid('204'), 'they are different users');
select is(t11.r('204', '4444'), 'invalid', 'login_verify(204, PIN of 0204): invalid');
select is(t11.r('0204', '5555'), 'invalid', 'login_verify(0204, PIN of 204): invalid');
select is((public.login_verify('٠٢٠٤', '٤٤٤٤') ->> 'user_id')::uuid, t11.uid('0204'), 'Arabic digits 0204 log in as 0204');
select is((public.login_verify('٢٠٤', '٥٥٥٥') ->> 'user_id')::uuid, t11.uid('204'), 'Arabic digits 204 log in as 204');
select is(t11.r('00204', '4444'), 'invalid', '00204 is neither');

-- 10. attach ---------------------------------------------------------------------------------------
select is(t11.authid('206'), null, 'attach: 206 starts without an Auth user');
select is(t11.r('206', '6666'), 'ok', 'attach: 206 can log in without an Auth user');
select t11.lv('a206', '206', '6666');
select is(t11.res('a206') -> 'auth_user_id', 'null'::jsonb, 'attach: auth_user_id is null while no Auth user exists');
select test.reset_role();
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new, reauthentication_token)
values ('00000000-0000-0000-0000-000000000000', 'b1100000-0000-4000-8000-000000000206', 'authenticated', 'authenticated',
        '206@gosta.invalid', now(), '', '', '', '', '');
select test.act_as_service();
select t11.lv('b206', '206', '6666');
select is((t11.res('b206') ->> 'auth_user_id')::uuid, 'b1100000-0000-4000-8000-000000000206'::uuid, 'attach repairs: login_verify attached the Auth user');
select is(t11.authid('206'), 'b1100000-0000-4000-8000-000000000206'::uuid, 'attach repairs: stored on the app user');
select t11.lv('c206', '206', '6666');
select is(t11.res('c206') -> 'auth_user_id', t11.res('b206') -> 'auth_user_id', 'attach is stable on repeat');
select is(public.login_attach_auth_user(t11.uid('206')), 'b1100000-0000-4000-8000-000000000206'::uuid, 'login_attach_auth_user twice: same id');
select is(public.login_attach_auth_user(t11.uid('206')), 'b1100000-0000-4000-8000-000000000206'::uuid, 'login_attach_auth_user again: same id');
-- a second Auth row for the same email can never replace the attached one
select test.reset_role();
update auth.users set email = 'moved-206@gosta.invalid' where id = 'b1100000-0000-4000-8000-000000000206';
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new, reauthentication_token)
values ('00000000-0000-0000-0000-000000000000', 'b1100000-0000-4000-8000-000000000999', 'authenticated', 'authenticated',
        '206@gosta.invalid', now(), '', '', '', '', '');
select test.act_as_service();
select is(public.login_attach_auth_user(t11.uid('206')), 'b1100000-0000-4000-8000-000000000206'::uuid, 'never re-pointed to a second Auth row');
select is(t11.authid('206'), 'b1100000-0000-4000-8000-000000000206'::uuid, 'the stored id did not change');
select is((public.login_verify('206', '6666') ->> 'auth_user_id')::uuid, 'b1100000-0000-4000-8000-000000000206'::uuid, 'login_verify still reports the original');
select is(public.login_attach_auth_user('d1100000-0000-4000-8000-0000000000ff'), null, 'unknown user id: null');
select is(public.login_attach_auth_user(null), null, 'null user id: null');
select is(public.login_attach_auth_user(t11.uid('201')), t11.authid('201'), 'a seeded user: its own Auth id');
select is(t11.r('209', '9090'), 'ok', 'an Auth row already held by another app user: login still works');
select is(t11.authid('209'), null, '... and it is not taken from the other user');
select is(t11.authid('210'), 'b1100000-0000-4000-8000-000000000209'::uuid, '... the other user keeps it');

-- 11. register_session ---------------------------------------------------------------------------
select t11.lv('r201', '201', '1111');
select t11.snap('n201', t11.nsess('201')::text);
select lives_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000001', (t11.res('r201') ->> 'credential_version')::int)$$, 'register: the verified version registers');
select is(t11.nsess('201')::text, (t11.snapv('n201')::int + 1)::text, 'register: one new session row');
select ok(t11.sess_exp('5e5e0011-0000-4000-8000-000000000001')
          between clock_timestamp() + interval '6 days 23 hours 59 minutes' and clock_timestamp() + interval '7 days', 'register: expires in 7 days');
select is(t11.sess_user('5e5e0011-0000-4000-8000-000000000001'), t11.uid('201'), 'register: the row belongs to the user');
select is(t11.sess_rev('5e5e0011-0000-4000-8000-000000000001'), null, 'register: not revoked');
select lives_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000001', t11.cv('201'))$$, 'register: the same session id again is a no-op');
select is(t11.nsess('201')::text, (t11.snapv('n201')::int + 1)::text, 'register: still one new row');
select throws_ok($$select public.login_register_session(t11.uid('202'), '5e5e0011-0000-4000-8000-000000000001', t11.cv('202'))$$, 'P0001', 'USER_INVALID', 'register: a session id that belongs to another user');
select is(t11.sess_user('5e5e0011-0000-4000-8000-000000000001'), t11.uid('201'), 'register: and it stayed with the first user');
select throws_ok($$select public.login_register_session(t11.uid('299'), '5e5e0011-0000-4000-8000-000000000002', t11.cv('299'))$$, 'P0001', 'USER_INVALID', 'register: inactive user 299');
select throws_ok($$select public.login_register_session('d1100000-0000-4000-8000-0000000000ff', '5e5e0011-0000-4000-8000-000000000002', 0)$$, 'P0001', 'USER_INVALID', 'register: unknown user');
select is(t11.nsess('299')::text, '1', 'register: 299 got no new session');

-- 12. missing / stale credential version, null arguments -------------------------------------------
select t11.snap('allv', t11.nsess_all()::text);
select throws_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000003', null)$$, 'P0001', 'USER_INVALID', 'null version');
select throws_ok($$select public.login_register_session(null, '5e5e0011-0000-4000-8000-000000000003', t11.cv('201'))$$, 'P0001', 'USER_INVALID', 'null user id');
select throws_ok($$select public.login_register_session(t11.uid('201'), null, t11.cv('201'))$$, 'P0001', 'USER_INVALID', 'null session id');
select throws_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000003', t11.cv('201') - 1)$$, 'P0001', 'USER_INVALID', 'version one lower');
select throws_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000003', t11.cv('201') + 1)$$, 'P0001', 'USER_INVALID', 'version one higher');
select is(t11.nsess_all()::text, t11.snapv('allv'), 'none of the five created a session row');

-- 13. login in flight during a reset (201) ---------------------------------------------------------
select t11.lv('fl1', '201', '1111');
select test.act_as('100');
select lives_ok($$select admin_set_secret('c1100000-0000-4000-8000-000000000021', t11.uid('201'), '7777')$$, 'owner resets 201 to 7777');
select test.act_as_service();
select throws_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000004', (t11.res('fl1') ->> 'credential_version')::int)$$, 'P0001', 'USER_INVALID', 'reset in flight: the old version is refused');
select is(t11.nlive('201'), 0::bigint, 'reset in flight: 201 has no unrevoked session');
select is(t11.r('201', '1111'), 'invalid', 'the old PIN is dead');
select is(t11.r('201', '7777'), 'ok', 'the new PIN logs in');
select lives_ok($$select public.login_register_session(t11.uid('201'), '5e5e0011-0000-4000-8000-000000000005', t11.cv('201'))$$, 'the new version registers');
select is(t11.nlive('201'), 1::bigint, 'exactly the new session is live');

-- 14. login in flight during a deactivation (215) ------------------------------------------------------
select t11.lv('fl2', '215', '1515');
select test.act_as('100');
select lives_ok($$select admin_set_user_active('c1100000-0000-4000-8000-000000000022', t11.uid('215'), false)$$, 'owner deactivates 215');
select test.act_as_service();
select throws_ok($$select public.login_register_session(t11.uid('215'), '5e5e0011-0000-4000-8000-000000000006', (t11.res('fl2') ->> 'credential_version')::int)$$, 'P0001', 'USER_INVALID', 'deactivation in flight: refused');
select is(t11.nlive('215'), 0::bigint, 'deactivation in flight: 215 has no unrevoked session');
select is(t11.r('215', '1515'), 'invalid', 'a deactivated user cannot log in');

-- 15. logging ----------------------------------------------------------------------------------------------
select t11.snap('nl0', t11.nlogs()::text);
select is(t11.r('203', '0303'), 'ok', 'log: right PIN');
select is(t11.r('203', 'nope'), 'invalid', 'log: wrong PIN');
select is(t11.r('٢٠٣', '0303'), 'ok', 'log: Arabic digits');
select is(t11.nlogs()::text, (t11.snapv('nl0')::int + 3)::text, 'log: exactly one row per call');
select is(t11.logs('203'), 'LOGIN_OK,LOGIN_FAILED,LOGIN_OK', 'log: the actions, in order, under the normalised number');
select is(t11.ldet('LOGIN_FAILED', '203'),
          '{"employee_number": "203"}'::jsonb, 'log: details hold the number and nothing else');
select is(t11.luser('LOGIN_FAILED', '203'), t11.uid('203'), 'log: user_id is the matched user');
select t11.go('888', 'zzzz'); select t11.go('٨٨٨', 'zzzz');
select is(t11.logs('888'), 'LOGIN_FAILED,LOGIN_FAILED', 'log: unknown number logged as LOGIN_FAILED under the normalised number');
select is(t11.lq($q$action = 'LOGIN_FAILED' and details ->> 'employee_number' = '888' and user_id is null$q$), 2::bigint, 'log: user_id is null for an unknown number');
select t11.snap('nn0', t11.lq($q$action = 'LOGIN_FAILED' and details = '{"employee_number": null}'::jsonb and user_id is null$q$)::text);
select t11.go(null, 'zzzz');
select is(t11.lq($q$action = 'LOGIN_FAILED' and details = '{"employee_number": null}'::jsonb and user_id is null$q$)::text, (t11.snapv('nn0')::int + 1)::text, 'log: a null number is logged too (number null, user_id null)');
select t11.go('abc-typed-into-the-number-field', 'zzzz');
select is(t11.lq($q$action = 'LOGIN_FAILED' and details = '{"employee_number": null}'::jsonb and user_id is null$q$)::text, (t11.snapv('nn0')::int + 2)::text, 'log: text that is not a number is never stored (null instead)');
select is(t11.leak('abc-typed'), false, 'log: the free text is nowhere in the log');
select is(t11.logs('215'), 'LOGIN_OK,LOGIN_FAILED', 'log: an inactive user is LOGIN_FAILED');
select ok(not (t11.leak('1111') or t11.leak('0000') or t11.leak('2222') or t11.leak('3333') or t11.leak('4444') or t11.leak('5555')
            or t11.leak('6666') or t11.leak('7777') or t11.leak('9090') or t11.leak('0303') or t11.leak('1515')
            or t11.leak('zzzz') or t11.leak('nope') or t11.leak('correct horse') or t11.leak('كلمة') or t11.leak('plain owner')
            or t11.leak(repeat('1', 200)) or t11.leak(repeat('x', 72)) or t11.leak('ببب')), 'log: no submitted secret appears in any login log row');
select is(t11.lq($q$action like 'LOGIN\_%' and details - 'employee_number' <> '{}'::jsonb$q$), 0::bigint, 'log: details never hold any key but employee_number');

-- 16. whitespace around the number (spaces only; zeros stay) ----------------------------------------------
select t11.lv('sp201', ' 201 ', '7777');
select is(t11.res('sp201') ->> 'employee_number', '201', 'surrounding spaces are trimmed: " 201 " logs in as 201');
select t11.lv('sp0204', ' 0204 ', '4444');
select is((t11.res('sp0204') ->> 'user_id')::uuid, t11.uid('0204'), '" 0204 " logs in as 0204, not as 204');
select is(t11.r('2 01', '7777'), 'invalid', 'a number with an inner space is invalid');
select is(t11.r(' 204 ', '4444'), 'invalid', '" 204 " is 204: the zeros of 0204 are not borrowed');

-- 17. every path that reaches the secret check runs extensions.crypt exactly once (0 when locked, above) ---
select * from t11.crypt_delta('crypt count: unknown number (dummy hash)', '999', '1111', 1);
select * from t11.crypt_delta('crypt count: inactive user (dummy hash)', '299', '9999', 1);
select * from t11.crypt_delta('crypt count: user without a secret row (dummy hash)', '208', '1111', 1);
select * from t11.crypt_delta('crypt count: staff secret over 72 bytes (dummy hash, never the real one)', '203', repeat('1', 200), 1);
select * from t11.crypt_delta('crypt count: null secret (dummy hash)', '203', null, 1);
select * from t11.crypt_delta('crypt count: wrong secret (real hash)', '203', '0000', 1);
select * from t11.crypt_delta('crypt count: right secret (real hash)', '203', '0303', 1);
select * from t11.crypt_delta('crypt count: null number (dummy hash)', null, '0303', 1);

-- visible in the CI log: did the crypt-count assertions run or were they skipped?
select diag('track_functions: ' || coalesce(nullif(current_setting('t11.crypt_n', true), ''), '0') || ' crypt-count assertions '
            || case when current_setting('t11.track', true) = '1' then 'RAN' else 'were SKIPPED (this role cannot set track_functions)' end);
select * from finish();
rollback;
