-- Migration 0012: admin_set_secret rechecks the caller's session after the target row lock.
-- The race itself needs two connections (tests-concurrency/owner_password_test.ts). Here: the function
-- still behaves as before for a normal self-change and for a staff target, keeps its attributes and grant,
-- and the recheck sits between the row lock and the first write.
begin;
select plan(21);

create schema t12;
grant usage on schema t12 to authenticated;
create function t12.uid(p_emp text) returns uuid language sql stable security definer set search_path = public as
$$ select id from app_users where employee_number = p_emp $$;
create function t12.cv(p_emp text) returns int language sql stable security definer set search_path = public as
$$ select credential_version from app_users where employee_number = p_emp $$;
create function t12.hm(p_emp text, p_secret text) returns boolean language sql stable security definer set search_path = public, extensions as
$$ select extensions.crypt(p_secret, s.secret_hash) = s.secret_hash
   from app_user_secrets s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;
create function t12.nlive(p_emp text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions s join app_users u on u.id = s.user_id where u.employee_number = p_emp and s.revoked_at is null $$;
create function t12.live(p_session uuid) returns boolean language sql stable security definer set search_path = public as
$$ select revoked_at is null from app_sessions where session_id = p_session $$;
create function t12.nreq(p_req uuid) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from rpc_requests where request_id = p_req $$;
create function t12.new_session(p_emp text, p_session uuid) returns void language sql security definer set search_path = public as
$$ insert into app_sessions (session_id, user_id, expires_at)
   select p_session, id, clock_timestamp() + interval '7 days' from app_users where employee_number = p_emp $$;
create function t12.act_sess(p_emp text, p_session uuid) returns void language plpgsql as $$
declare v_auth uuid;
begin
  reset role;
  select auth_user_id into v_auth from app_users where employee_number = p_emp;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_auth, 'role', 'authenticated', 'session_id', p_session)::text, true);
  set local role authenticated;
end;
$$;
grant execute on all functions in schema t12 to authenticated;

-- attributes and grant are those of 0010
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.admin_set_secret(uuid,uuid,text)'::regprocedure), 'admin_set_secret is still security definer');
select is((select p.proconfig from pg_proc p where p.oid = 'public.admin_set_secret(uuid,uuid,text)'::regprocedure),
          array['search_path=app, public, extensions, pg_temp'], 'search_path unchanged, pg_temp last');
select is((select l.lanname::text from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.admin_set_secret(uuid,uuid,text)'::regprocedure), 'plpgsql', 'language plpgsql');
select ok(has_function_privilege('authenticated', 'public.admin_set_secret(uuid,uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.admin_set_secret(uuid,uuid,text)', 'execute'), 'grant unchanged: authenticated yes, anon no');
select ok((select position('perform app.current_app_user()' in p.prosrc) > position('for update' in p.prosrc)
              and position('for update' in p.prosrc) > 0
              and position('perform app.current_app_user()' in p.prosrc) < position('insert into app_user_secrets' in p.prosrc)
           from pg_proc p where p.oid = 'public.admin_set_secret(uuid,uuid,text)'::regprocedure),
   'the session recheck sits after the row lock and before the first write');

-- a normal self-change from the seeded owner session
select t12.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select lives_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000001', t12.uid('100'), 'self change one 1')$$, 'owner changes their own password');
select ok(t12.hm('100', 'self change one 1'), 'self change: the new password is stored');
select is(t12.cv('100'), 1, 'self change: credential_version 1');
select ok(t12.live('5e5e5e5e-0000-4000-8000-000000000100'), 'self change: the calling session survives');
select lives_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000001', t12.uid('100'), 'self change one 1')$$, 'replay of the same request');
select is(t12.cv('100'), 1, 'replay: no second change');
select is(t12.nreq('c1200000-0000-4000-8000-000000000001'), 1::bigint, 'replay: one stored request');

-- a second owner session S2 changes the password: S1 is revoked, S2 lives, and S1 is then refused
select t12.new_session('100', '5e5e0012-0000-4000-8000-000000000002');
select t12.act_sess('100', '5e5e0012-0000-4000-8000-000000000002');
select lives_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000002', t12.uid('100'), 'self change two 2')$$, 'owner changes their password from session S2');
select ok(t12.live('5e5e0012-0000-4000-8000-000000000002') and not t12.live('5e5e5e5e-0000-4000-8000-000000000100'), 'S2 live, S1 revoked');
select t12.act_sess('100', '5e5e5e5e-0000-4000-8000-000000000100');
select throws_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000003', t12.uid('100'), 'self change three 3')$$, 'P0001', 'NOT_AUTHENTICATED', 'the revoked S1 is refused');
select ok(t12.hm('100', 'self change two 2') and t12.cv('100') = 2, 'and nothing changed: still the password of S2, version 2');

-- a staff target
select t12.act_sess('100', '5e5e0012-0000-4000-8000-000000000002');
select lives_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000004', t12.uid('201'), '٧٧٧٧')$$, 'owner resets a staff PIN (Arabic digits)');
select ok(t12.hm('201', '7777'), 'staff target: the cleaned PIN is stored');
select is(t12.cv('201'), 1, 'staff target: credential_version 1');
select is(t12.nlive('201'), 0::bigint, 'staff target: every session of the user is revoked');
select test.act_as('202');
select throws_ok($$select admin_set_secret('c1200000-0000-4000-8000-000000000005', t12.uid('201'), '8888')$$, 'P0001', 'FORBIDDEN', 'a manager still cannot call it');

select * from finish();
rollback;
