-- Migration 0013 / plan rule (ad): one rule for which characters a secret may contain. No control characters
-- (Unicode category Cc: U+0000-U+001F and U+007F-U+009F) when a secret is set (app.clean_secret) and when it
-- is checked (public.login_verify). NUL (U+0000) cannot exist in a Postgres text value, so it is not tested here;
-- it is covered at the login function and through PostgREST in the Deno tests (JSON "\u0000" is refused there).
begin;
select plan(46);

create schema t13;
grant usage on schema t13 to service_role;
-- 'ok' or the error message of clean_secret
create function t13.cs(p_role text, p_secret text) returns text language plpgsql as $$
begin
  perform app.clean_secret(p_role, p_secret);
  return 'ok';
exception when others then
  return sqlerrm;
end;
$$;
create function t13.fa(p_emp text) returns int language sql stable as $$ select failed_attempts from app_users where employee_number = p_emp $$;
create function t13.nlog(p_emp text) returns bigint language sql stable as
$$ select count(*) from activity_log where action = 'LOGIN_FAILED' and details ->> 'employee_number' = p_emp $$;
create function t13.crypt_calls() returns bigint language sql as
$$ select coalesce(sum(calls), 0)::bigint from pg_stat_xact_user_functions where funcname = 'crypt' and schemaname = 'extensions' $$;
create function t13.lv(p_emp text, p_secret text) returns text language sql as
$$ select case when (r ->> 'ok')::boolean then 'ok' else r ->> 'reason' end from (select public.login_verify(p_emp, p_secret) as r) q $$;

-- 1. set time, owner: every control code point is refused, in the documented order --------------------------------
select is((select count(*) from generate_series(1, 31) n where t13.cs('owner', 'abcdefghijk' || chr(n) || 'lm') = 'SECRET_INVALID'),
          31::bigint, 'owner: U+0001..U+001F all SECRET_INVALID');
select is((select count(*) from generate_series(127, 159) n where t13.cs('owner', 'abcdefghijk' || chr(n) || 'lm') = 'SECRET_INVALID'),
          33::bigint, 'owner: U+007F..U+009F all SECRET_INVALID');
select is(t13.cs('owner', 'abcdefghijk' || chr(9)  || 'lm'), 'SECRET_INVALID', 'owner: tab');
select is(t13.cs('owner', 'abcdefghijk' || chr(10) || 'lm'), 'SECRET_INVALID', 'owner: line feed');
select is(t13.cs('owner', 'abcdefghijk' || chr(13) || 'lm'), 'SECRET_INVALID', 'owner: carriage return');
select is(t13.cs('owner', 'abcdefghijk' || chr(31) || 'lm'), 'SECRET_INVALID', 'owner: U+001F');
select is(t13.cs('owner', 'abcdefghijk' || chr(127) || 'lm'), 'SECRET_INVALID', 'owner: DEL');
select is(t13.cs('owner', 'abcdefghijk' || chr(133) || 'lm'), 'SECRET_INVALID', 'owner: U+0085');
select is(t13.cs('owner', 'abcdefghijk' || chr(159) || 'lm'), 'SECRET_INVALID', 'owner: U+009F');
select is(t13.cs('owner', 'abc' || chr(9)), 'SECRET_INVALID', 'owner: control character beats "too short"');
select is(t13.cs('owner', repeat('a', 73) || chr(9)), 'SECRET_TOO_LONG', 'owner: "too long" beats control character');
select is(t13.cs('owner', null), 'SECRET_WEAK', 'owner: null stays SECRET_WEAK');
select is(t13.cs('owner', 'short one'), 'SECRET_WEAK', 'owner: short stays SECRET_WEAK');

-- 2. set time, owner: boundaries that must pass unchanged -----------------------------------------------------------
select is(t13.cs('owner', 'abcde fghijk lm'), 'ok', 'owner: space (U+0020) is allowed');
select is(t13.cs('owner', 'abcdefghijk' || chr(160) || 'lm'), 'ok', 'owner: U+00A0 is allowed');
select is(t13.cs('owner', 'abcdefghijk' || chr(128512) || 'lm'), 'ok', 'owner: an emoji is allowed');
select is(t13.cs('owner', 'abcdefghijk"\lm'), 'ok', 'owner: double quote and backslash are allowed');
select is(app.clean_secret('owner', 'كلمة المرور العربية ١٢٣'), 'كلمة المرور العربية ١٢٣', 'owner: Arabic letters and Arabic-Indic digits pass unchanged');
select is(app.clean_secret('owner', 'abcde fghijk lm'), 'abcde fghijk lm', 'owner: returned exactly as given');

-- 3. set time, staff -------------------------------------------------------------------------------------------------
select is(t13.cs('manager', '12' || chr(9) || '4'), 'SECRET_INVALID', 'staff: tab inside a PIN');
select is(t13.cs('manager', '1234' || chr(133)), 'SECRET_INVALID', 'staff: U+0085 after four digits');
select is(t13.cs('distributor', chr(127) || '123'), 'SECRET_INVALID', 'staff: DEL');
select is(t13.cs('manager', chr(9)), 'SECRET_INVALID', 'staff: only a control character');
select is(t13.cs('manager', '12345'), 'SECRET_WEAK', 'staff: five digits stay SECRET_WEAK');
select is(t13.cs('manager', '12a4'), 'SECRET_WEAK', 'staff: a letter stays SECRET_WEAK');
select is(app.clean_secret('manager', '١٢٣٤'), '1234', 'staff: Arabic-Indic digits are still normalised');
select is(app.clean_secret('manager', '0303'), '0303', 'staff: leading zeros stay');

-- 4. check time: login_verify ---------------------------------------------------------------------------------------
select set_config('t13.track', case when has_parameter_privilege(current_user, 'track_functions', 'set') then '1' else '0' end, true);
do $$ begin
  if current_setting('t13.track') = '1' then set local track_functions = 'all'; end if;
end $$;

select is(t13.fa('202'), 0, 'staff user 202 starts with no failed attempts');
select is(t13.lv('202', '2222' || chr(9)), 'invalid', 'staff: the right PIN plus a tab is a wrong secret');
select is(t13.fa('202'), 1, 'it counted towards the lockout');
select is(t13.nlog('202'), 1::bigint, 'and logged LOGIN_FAILED');
select is(t13.lv('202', '2222'), 'ok', 'the right PIN still logs in afterwards');
select is(t13.fa('202'), 0, 'and resets the counter');
select is(t13.lv('202', chr(133) || '2222'), 'invalid', 'staff: U+0085 in front is a wrong secret');
select is(t13.lv('202', '22' || chr(127) || '22'), 'invalid', 'staff: DEL inside is a wrong secret');
select is(t13.lv('100', 'correct horse battery' || chr(9)), 'invalid', 'owner: the right password plus a tab is a wrong secret');
select is(t13.lv('100', 'correct horse battery'), 'ok', 'owner: the right password logs in');
select is(t13.lv('100', 'correct' || chr(10) || 'horse battery'), 'invalid', 'owner: a line feed inside is a wrong secret');
select is(t13.lv('100', 'correct horse ' || chr(128512) || 'battery'), 'invalid', 'owner: an emoji changes the password (not control, simply wrong)');
-- crypt count: a control-character secret runs exactly one crypt (the dummy), like an over-length secret
create function t13.crypt_delta(p_secret text) returns setof text language plpgsql as $$
declare v_before bigint;
begin
  if current_setting('t13.track', true) is distinct from '1' then
    return next skip(1, 'this role cannot set track_functions');
    return;
  end if;
  v_before := t13.crypt_calls();
  perform public.login_verify('203', p_secret);
  return next is(t13.crypt_calls() - v_before, 1::bigint, 'a control-character secret runs exactly one crypt call');
end;
$$;
select * from t13.crypt_delta('0303' || chr(9));
select is(t13.lv('203', '0303'), 'ok', 'user 203 still logs in with the right PIN');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED' and details ->> 'employee_number' = '203'), 1::bigint, 'the control-character attempt on 203 was logged');

-- a stored verifier of a secret that contains a control character (set before the rule existed, or by hand) must
-- never be matched: the submitted secret is refused before it is compared (this is what separates the check in
-- login_verify from the plain "wrong secret" outcome)
update app_user_secrets set secret_hash = extensions.crypt('1515' || chr(9), extensions.gen_salt('bf', 4))
where user_id = (select id from app_users where employee_number = '215');
select is(t13.lv('215', '1515' || chr(9)), 'invalid', 'staff: a legacy hash of a control-character PIN is never matched');
update app_user_secrets set secret_hash = extensions.crypt('legacy pass' || chr(9) || 'word!', extensions.gen_salt('bf', 4))
where user_id = (select id from app_users where role = 'owner');
select is(t13.lv('100', 'legacy pass' || chr(9) || 'word!'), 'invalid', 'owner: a legacy hash of a control-character password is never matched');
select is(t13.fa('215'), 1, 'the staff attempt was counted');
select is(t13.fa('100'), 3, 'the owner attempt was counted (third wrong attempt since the last good login)');
select * from finish();
rollback;
