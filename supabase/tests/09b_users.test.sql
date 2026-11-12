begin;
select plan(235);

-- test-local helpers (rolled back with the transaction) ----------------------------------
create schema t10;
grant usage on schema t10 to authenticated;

create function t10.uid(p_emp text) returns uuid language sql stable security definer set search_path = public as
$$ select id from app_users where employee_number = p_emp $$;

create function t10.cv(p_emp text) returns int language sql stable security definer set search_path = public as
$$ select credential_version from app_users where employee_number = p_emp $$;

create function t10.hash(p_emp text) returns text language sql stable security definer set search_path = public, extensions as
$$ select s.secret_hash from app_user_secrets s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;

-- true when the stored hash of the user matches the given secret
create function t10.hm(p_emp text, p_secret text) returns boolean language sql stable security definer set search_path = public, extensions as
$$ select extensions.crypt(p_secret, s.secret_hash) = s.secret_hash
   from app_user_secrets s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;

-- sessions of the user that carry revoked_at / all sessions of the user
create function t10.nrev(p_emp text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions s join app_users u on u.id = s.user_id where u.employee_number = p_emp and s.revoked_at is not null $$;

create function t10.nall(p_emp text) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from app_sessions s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;

-- every session of the user with its revocation timestamp, in a stable order
create function t10.revts(p_emp text) returns text language sql stable security definer set search_path = public as
$$ select string_agg(s.session_id::text || '=' || coalesce(s.revoked_at::text, '-'), ',' order by s.session_id)
   from app_sessions s join app_users u on u.id = s.user_id where u.employee_number = p_emp $$;

create function t10.is_revoked(p_session uuid) returns boolean language sql stable security definer set search_path = public as
$$ select revoked_at is not null from app_sessions where session_id = p_session $$;

create function t10.stored(p_req uuid) returns jsonb language sql stable security definer set search_path = public as
$$ select result from rpc_requests where request_id = p_req $$;

create function t10.nreq(p_req uuid) returns bigint language sql stable security definer set search_path = public as
$$ select count(*) from rpc_requests where request_id = p_req $$;

-- fingerprint of everything these RPCs can write: a refused call or a replay must leave it identical
create function t10.world() returns text language sql stable security definer set search_path = public as
$$ select concat_ws('|',
     (select count(*) from rpc_requests), (select count(*) from activity_log), (select count(*) from app_users),
     (select count(*) from app_user_secrets), (select count(*) from app_sessions), (select count(*) from branch_features),
     (select md5(string_agg(user_id::text || secret_hash, ',' order by user_id)) from app_user_secrets),
     (select md5(string_agg(session_id::text || coalesce(revoked_at::text, '-'), ',' order by session_id)) from app_sessions),
     (select md5(string_agg(concat_ws('/', id, active, failed_attempts, locked_until, credential_version), ',' order by id)) from app_users),
     (select md5(string_agg(branch_id || feature_key || visible, ',' order by branch_id, feature_key)) from branch_features)) $$;

create table t10.snap (k text primary key, v text);
create function t10.snap(p_k text, p_v text) returns void language sql security definer set search_path = public as
$$ insert into t10.snap values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function t10.snapv(p_k text) returns text language sql stable security definer set search_path = public as
$$ select v from t10.snap where k = p_k $$;

-- does the needle appear in any stored trace of a request or of the activity log?
-- (uuids are removed from the JSON first: a random uuid can contain any four digits)
create function t10.leak_json(p_needle text) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from rpc_requests r
        where position(p_needle in regexp_replace(r.result::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g')) > 0)
       or exists (select 1 from activity_log a
        where position(p_needle in regexp_replace(a.details::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g')) > 0) $$;

-- every column of every request row, and the activity log, searched for a distinctive needle
create function t10.leak_any(p_needle text) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from rpc_requests r where position(p_needle in r::text) > 0)
       or exists (select 1 from activity_log a where position(p_needle in a::text) > 0) $$;

-- act as a user with a chosen session id (test.act_as always uses the first session of the user)
create function t10.act_sess(p_emp text, p_session uuid) returns void language plpgsql as $$
declare v_auth uuid;
begin
  reset role;
  select auth_user_id into v_auth from app_users where employee_number = p_emp;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_auth, 'role', 'authenticated', 'session_id', p_session)::text, true);
  set local role authenticated;
end;
$$;

create function t10.new_session(p_emp text, p_session uuid) returns void language sql security definer set search_path = public as
$$ insert into app_sessions (session_id, user_id, expires_at)
   select p_session, id, clock_timestamp() + interval '7 days' from app_users where employee_number = p_emp $$;

grant execute on all functions in schema t10 to authenticated;

-- a second owner row, to reach the "owner row that is not the caller's own" rules
insert into app_users (employee_number, name, role) values ('101', 'owner two', 'owner');
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt('another long password', extensions.gen_salt('bf', 10)) from app_users where employee_number = '101';


-- 1. app.clean_secret, unit-tested as postgres -----------------------------------------------
select is(app.clean_secret('manager', '1234'), '1234', 'manager PIN 1234 is clean');
select is(app.clean_secret('distributor', '٥٥٥٥'), '5555', 'distributor Arabic-Indic digits become ASCII');
select is(app.clean_secret('manager', '۱۲۳۴'), '1234', 'Persian digits become ASCII');
select throws_ok($$select app.clean_secret('manager', '12345')$$, 'P0001', 'SECRET_WEAK', 'five digits');
select throws_ok($$select app.clean_secret('manager', '123')$$, 'P0001', 'SECRET_WEAK', 'three digits');
select throws_ok($$select app.clean_secret('manager', '12a4')$$, 'P0001', 'SECRET_WEAK', 'a letter');
select throws_ok($$select app.clean_secret('manager', '')$$, 'P0001', 'SECRET_WEAK', 'empty');
select throws_ok($$select app.clean_secret('manager', null)$$, 'P0001', 'SECRET_WEAK', 'null');
select throws_ok($$select app.clean_secret('manager', ' 1111')$$, 'P0001', 'SECRET_WEAK', 'leading space is not trimmed');
select throws_ok($$select app.clean_secret('manager', E'1111\n')$$, 'P0001', 'SECRET_WEAK', 'trailing newline');
select throws_ok($$select app.clean_secret('manager', repeat('1', 200))$$, 'P0001', 'SECRET_WEAK', 'a 200-digit staff PIN is weak (the 4-digit rule bounds it)');
select throws_ok($$select app.clean_secret('owner', 'short')$$, 'P0001', 'SECRET_WEAK', 'owner: short');
select throws_ok($$select app.clean_secret('owner', 'elevenchars')$$, 'P0001', 'SECRET_WEAK', 'owner: 11 characters');
select is(app.clean_secret('owner', '123456789012'), '123456789012', 'owner: 12 characters pass');
select is(app.clean_secret('owner', '  spaced pass  '), '  spaced pass  ', 'owner secret is returned exactly as given');
select is(app.clean_secret('owner', repeat('٥', 12)), repeat('٥', 12), 'owner secret is not digit-normalised');
select throws_ok($$select app.clean_secret('owner', repeat('ب', 6))$$, 'P0001', 'SECRET_WEAK', 'owner: 6 Arabic letters are 12 bytes but 6 characters: weak');
select throws_ok($$select app.clean_secret('owner', null)$$, 'P0001', 'SECRET_WEAK', 'owner: null');
select is(app.clean_secret('owner', repeat('x', 72)), repeat('x', 72), 'owner: 72 ASCII bytes accepted');
select throws_ok($$select app.clean_secret('owner', repeat('x', 73))$$, 'P0001', 'SECRET_TOO_LONG', 'owner: 73 ASCII bytes');
select is(app.clean_secret('owner', repeat('ب', 36)), repeat('ب', 36), 'owner: 36 Arabic letters (72 bytes) accepted');
select is((octet_length(repeat('ب', 37)), char_length(repeat('ب', 37)))::text, '(74,37)', '37 Arabic letters are 74 bytes and 37 characters');
select throws_ok($$select app.clean_secret('owner', repeat('ب', 37))$$, 'P0001', 'SECRET_TOO_LONG', 'owner: 37 Arabic letters (74 bytes, 37 characters)');
select throws_ok($$select app.clean_secret('owner', repeat('x', 200))$$, 'P0001', 'SECRET_TOO_LONG', 'owner: 200 bytes');
select throws_ok($$select app.clean_secret('cashier', '1111')$$, 'P0001', 'USER_INVALID', 'unknown role');
select throws_ok($$select app.clean_secret(null, '1111')$$, 'P0001', 'USER_INVALID', 'null role');
select ok(not has_function_privilege('authenticated', 'app.clean_secret(text,text)', 'execute')
      and not has_function_privilege('anon', 'app.clean_secret(text,text)', 'execute')
      and not has_function_privilege('authenticated', 'app.revoke_sessions(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'app.revoke_sessions(uuid,uuid)', 'execute'), 'clients cannot call the two internal helpers');
select ok((select extensions.crypt(repeat('x', 73), h) = h from (select extensions.crypt(repeat('x', 72), extensions.gen_salt('bf', 10)) as h) q),
  'why the limit exists: bcrypt truncates, a 73-byte string matches the hash of its first 72 bytes');
select ok((select extensions.crypt(repeat('x', 71), h) <> h from (select extensions.crypt(repeat('x', 72), extensions.gen_salt('bf', 10)) as h) q),
  'but byte 72 does count: 71 bytes do not match');

-- 2. privileges, role gate, request id -----------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.admin_create_user(uuid,text,text,text,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.admin_set_secret(uuid,uuid,text)', 'execute')
      and has_function_privilege('authenticated', 'public.admin_set_user_active(uuid,uuid,boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.admin_unlock_user(uuid,uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.set_branch_feature(uuid,text,text,boolean)', 'execute')
      and has_function_privilege('authenticated', 'public.logout()', 'execute'), 'authenticated may call the six entry points');
select ok(not has_function_privilege('anon', 'public.admin_create_user(uuid,text,text,text,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.admin_set_secret(uuid,uuid,text)', 'execute')
      and not has_function_privilege('anon', 'public.admin_set_user_active(uuid,uuid,boolean)', 'execute')
      and not has_function_privilege('anon', 'public.admin_unlock_user(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.set_branch_feature(uuid,text,text,boolean)', 'execute')
      and not has_function_privilege('anon', 'public.logout()', 'execute'), 'anon may not');

select t10.snap('w0', t10.world());
select test.act_as('201');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000001', '250', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'FORBIDDEN', 'manager: create user');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000002', t10.uid('202'), '1234')$$, 'P0001', 'FORBIDDEN', 'manager: set secret');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000003', t10.uid('202'), false)$$, 'P0001', 'FORBIDDEN', 'manager: set active');
select throws_ok($$select public.admin_unlock_user('f1000000-0000-4000-8000-000000000004', t10.uid('202'))$$, 'P0001', 'FORBIDDEN', 'manager: unlock');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000005', 'BR-01', 'purchase', false)$$, 'P0001', 'FORBIDDEN', 'manager: feature');
select test.act_as('301');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000001', '250', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'FORBIDDEN', 'distributor: create user');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000002', t10.uid('201'), '1234')$$, 'P0001', 'FORBIDDEN', 'distributor: set secret');
select test.act_as('100');
select throws_ok($$select public.admin_create_user(null, '250', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'REQUEST_ID_REQUIRED', 'create: request id required');
select throws_ok($$select public.admin_set_secret(null, t10.uid('201'), '1234')$$, 'P0001', 'REQUEST_ID_REQUIRED', 'set secret: request id required');
select throws_ok($$select public.admin_set_user_active(null, t10.uid('201'), false)$$, 'P0001', 'REQUEST_ID_REQUIRED', 'set active: request id required');
select throws_ok($$select public.admin_unlock_user(null, t10.uid('201'))$$, 'P0001', 'REQUEST_ID_REQUIRED', 'unlock: request id required');
select throws_ok($$select public.set_branch_feature(null, 'BR-01', 'purchase', false)$$, 'P0001', 'REQUEST_ID_REQUIRED', 'feature: request id required');
select test.reset_role();
select is(t10.world(), t10.snapv('w0'), 'role refusals and missing request ids wrote nothing');

-- 3. admin_create_user ------------------------------------------------------------------------------
select test.act_as('100');
select lives_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000101', '204', 'مدير 4', 'manager', 'BR-02', '4444')$$, 'owner creates 204 manager BR-02');
select lives_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000102', '205', '  مدير 5  ', 'manager', 'BR-01', '٥٥٥٥')$$, 'owner creates 205 with an Arabic-digit PIN');
select lives_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000103', '٢٠٦', 'موزع 6', 'distributor', 'BR-14', '6666')$$, 'owner creates a distributor with an Arabic-digit employee number');
select test.reset_role();
select is((select concat_ws('|', role, branch_id, active, auth_user_id is null, credential_version, failed_attempts, name)
           from app_users where employee_number = '204'), 'manager|BR-02|t|t|0|0|مدير 4', 'row 204: role, branch, active, no auth user yet, version 0');
select ok(t10.hash('204') is not null and t10.hash('204') <> '4444' and t10.hm('204', '4444') and not t10.hm('204', '4445'), 'hash exists, is not the PIN, matches 4444');
select is(t10.stored('f1000000-0000-4000-8000-000000000101'), jsonb_build_object('user_id', t10.uid('204')), 'stored result is exactly {user_id}');
select is((select concat_ws('|', rpc_name, user_id = t10.uid('100'), secret_verifier is not null) from rpc_requests where request_id = 'f1000000-0000-4000-8000-000000000101'), 'admin_create_user|t|t', 'request row: rpc, owner, verifier present');
select is((select count(*) from activity_log where action = 'admin_create_user' and user_id = t10.uid('100') and entity_table = 'app_users' and entity_id = t10.uid('204')::text), 1::bigint, 'activity logged once');
select ok(t10.hm('205', '5555') and not t10.hm('205', '٥٥٥٥'), 'Arabic-digit PIN is stored in its ASCII form');
select is((select name from app_users where employee_number = '205'), 'مدير 5', 'name is trimmed');
select is((select concat_ws('|', employee_number, role, branch_id) from app_users where id = (t10.stored('f1000000-0000-4000-8000-000000000103') ->> 'user_id')::uuid), '206|distributor|BR-14', 'Arabic-digit employee number stored as ASCII');

select t10.snap('w3', t10.world());
select test.act_as('100');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', 'BR-01', '12345')$$, 'P0001', 'SECRET_WEAK', 'five-digit PIN');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', 'BR-01', '12a4')$$, 'P0001', 'SECRET_WEAK', 'PIN with a letter');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', 'BR-01', null)$$, 'P0001', 'SECRET_WEAK', 'null PIN');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'distributor', 'BR-14', repeat('9', 100))$$, 'P0001', 'SECRET_WEAK', 'long PIN');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '201', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'EMPLOYEE_NUMBER_TAKEN', 'duplicate employee number');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '٢٠١', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'EMPLOYEE_NUMBER_TAKEN', 'duplicate employee number in Arabic digits');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'owner', null, 'long enough password')$$, 'P0001', 'USER_INVALID', 'role owner is refused (no branch)');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'owner', 'BR-01', 'long enough password')$$, 'P0001', 'USER_INVALID', 'role owner is refused (with branch)');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'cashier', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'unknown role');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', null, 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'null role');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', null, '1234')$$, 'P0001', 'USER_INVALID', 'manager without a branch');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', 'BR-99', '1234')$$, 'P0001', 'USER_INVALID', 'unknown branch');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', 'x', 'manager', 'BR-09', '1234')$$, 'P0001', 'USER_INVALID', 'inactive branch');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', '   ', 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'blank name');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '250', null, 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'null name');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', 'abc', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'employee number with letters');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'blank employee number');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', null, 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'null employee number');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000111', '12 3', 'x', 'manager', 'BR-01', '1234')$$, 'P0001', 'USER_INVALID', 'employee number with a space inside');
select test.reset_role();
select is(t10.world(), t10.snapv('w3'), 'no refused create stored a user, secret, request or log row');

-- replay of a create
select test.act_as('100');
select is(public.admin_create_user('f1000000-0000-4000-8000-000000000101', '204', 'مدير 4', 'manager', 'BR-02', '4444'), t10.stored('f1000000-0000-4000-8000-000000000101'), 'replay (same id, same values) returns the stored result');
select is(public.admin_create_user('f1000000-0000-4000-8000-000000000102', '205', 'مدير 5', 'manager', 'BR-01', '5555'), t10.stored('f1000000-0000-4000-8000-000000000102'), 'replay with ASCII digits and an untrimmed name is the same request');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000101', '204', 'مدير 4', 'manager', 'BR-02', '4445')$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other PIN');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000101', '204', 'اسم آخر', 'manager', 'BR-02', '4444')$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other name');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000101', '204', 'مدير 4', 'manager', 'BR-01', '4444')$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other branch');
select test.reset_role();
select is(t10.world(), t10.snapv('w3'), 'replays and reuse refusals wrote nothing');

-- 4. feature toggle (before 201 is revoked) -----------------------------------------------------
select test.act_as('100');
select lives_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000401', 'BR-01', 'purchase', false)$$, 'owner hides purchase for BR-01');
select test.reset_role();
select is((select visible from branch_features where branch_id = 'BR-01' and feature_key = 'purchase'), false, 'row updated');
select is(t10.stored('f1000000-0000-4000-8000-000000000401'), jsonb_build_object('branch_id', 'BR-01', 'feature_key', 'purchase', 'visible', false), 'stored result');
select is((select count(*) from activity_log where action = 'set_branch_feature' and entity_id = 'BR-01/purchase'), 1::bigint, 'logged');
select test.act_as('201');
select throws_ok($$select public.create_purchase('f1000000-0000-4000-8000-000000000491', 'S-01', jsonb_build_array(jsonb_build_object('item_id', 'D-001', 'quantity', 1, 'unit', 'عبوة')))$$, 'P0001', 'FEATURE_HIDDEN', 'BR-01 manager cannot purchase while hidden');
select test.act_as('100');
select lives_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000402', 'BR-01', 'purchase', true)$$, 'owner shows it again');
select test.act_as('201');
select lives_ok($$select public.create_purchase('f1000000-0000-4000-8000-000000000491', 'S-01', jsonb_build_array(jsonb_build_object('item_id', 'D-001', 'quantity', 1, 'unit', 'عبوة')))$$, 'purchase works again');
select test.reset_role();
select is((select count(*) from branch_features where branch_id = 'BR-01' and feature_key = 'purchase'), 1::bigint, 'still one row (upsert)');
delete from branch_features where branch_id = 'BR-02' and feature_key = 'balance';
select test.act_as('100');
select lives_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000403', 'BR-02', 'balance', false)$$, 'upsert inserts a missing row');
select test.reset_role();
select is((select visible from branch_features where branch_id = 'BR-02' and feature_key = 'balance'), false, 'inserted row hidden');
select t10.snap('w4', t10.world());
select test.act_as('100');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-99', 'purchase', false)$$, 'P0001', 'BRANCH_INVALID', 'unknown branch');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-09', 'purchase', false)$$, 'P0001', 'BRANCH_INVALID', 'inactive branch');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', null, 'purchase', false)$$, 'P0001', 'BRANCH_INVALID', 'null branch');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-01', 'bogus', false)$$, 'P0001', 'FEATURE_INVALID', 'unknown feature');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-01', null, false)$$, 'P0001', 'FEATURE_INVALID', 'null feature');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-01', '', false)$$, 'P0001', 'FEATURE_INVALID', 'blank feature');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-01', 'Purchase', false)$$, 'P0001', 'FEATURE_INVALID', 'wrong case');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000411', 'BR-01', 'purchase', null)$$, 'P0001', 'FEATURE_INVALID', 'null visible');
select is(public.set_branch_feature('f1000000-0000-4000-8000-000000000402', 'BR-01', 'purchase', true), t10.stored('f1000000-0000-4000-8000-000000000402'), 'replay returns the stored result');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000402', 'BR-01', 'purchase', false)$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other value');
select throws_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000402', 'BR-01', 'send', true)$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other feature');
select lives_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000412', 'BR-01', 'send', false)$$, 'toggle send off');
select lives_ok($$select public.set_branch_feature('f1000000-0000-4000-8000-000000000413', 'BR-01', 'send', true)$$, 'toggle send on');
select test.reset_role();
select t10.snap('w4b', t10.world());
select test.act_as('100');
select is(public.set_branch_feature('f1000000-0000-4000-8000-000000000412', 'BR-01', 'send', false), t10.stored('f1000000-0000-4000-8000-000000000412'), 'replay of an older toggle returns its stored result');
select test.reset_role();
select is(t10.world(), t10.snapv('w4b'), 'the replay did not re-apply the old toggle');
select is((select visible from branch_features where branch_id = 'BR-01' and feature_key = 'send'), true, 'send is still visible');
select is((select count(*) from rpc_requests where request_id = 'f1000000-0000-4000-8000-000000000411'), 0::bigint, 'refused toggles left no request row');

-- 5. admin_set_secret: revocation of 201 -----------------------------------------------------------
update app_users set failed_attempts = 3, locked_until = clock_timestamp() + interval '1 hour' where employee_number = '201';
select t10.snap('w5', t10.world());
select t10.snap('rev202', t10.revts('202'));
select test.act_as('100');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000501', t10.uid('201'), '12345')$$, 'P0001', 'SECRET_WEAK', 'weak PIN refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000501', t10.uid('201'), null)$$, 'P0001', 'SECRET_WEAK', 'null secret refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000501', gen_random_uuid(), '1234')$$, 'P0001', 'USER_INVALID', 'unknown user');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000501', null, '1234')$$, 'P0001', 'USER_INVALID', 'null user');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000501', t10.uid('101'), 'a long enough password')$$, 'P0001', 'FORBIDDEN', 'another owner row is refused');
select test.reset_role();
select is(t10.world(), t10.snapv('w5'), 'refused calls changed nothing: no hash, version or session change');
select is(t10.cv('201'), 0, 'version still 0 after refusals');
select test.act_as('100');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000502', t10.uid('201'), '8888')$$, 'owner resets 201');
select test.reset_role();
select is(t10.cv('201'), 1, 'credential_version +1');
select ok(t10.nall('201') >= 1 and t10.nrev('201') = t10.nall('201'), 'every session of 201 is revoked');
select ok(t10.hm('201', '8888') and not t10.hm('201', '1111'), 'new PIN stored, old one gone');
select is((select concat_ws('|', failed_attempts, locked_until is null) from app_users where employee_number = '201'), '0|t', 'lockout cleared');
select is(t10.stored('f1000000-0000-4000-8000-000000000502'), jsonb_build_object('user_id', t10.uid('201')), 'stored result is {user_id}');
select is(t10.revts('202'), t10.snapv('rev202'), 'another user''s sessions untouched');
select ok(t10.nrev('100') = 0 and t10.nrev('301') = 0, 'owner and distributor sessions untouched');
select test.act_as('201');
select ok(not app.session_ok(), 'revoked session is not ok');
select throws_ok($$select public.send_transfer('f1000000-0000-4000-8000-000000000591', 'BR-01', '[]'::jsonb)$$, 'P0001', 'NOT_AUTHENTICATED', 'RPC refused');
select test.reset_role();
select t10.new_session('201', '5e5e5e5e-0000-4000-8000-0000000002a1');
select t10.act_sess('201', '5e5e5e5e-0000-4000-8000-0000000002a1');
select ok(app.session_ok(), 'a new session (a later login) is accepted');
select t10.act_sess('201', '5e5e5e5e-0000-4000-8000-000000000201');
select ok(not app.session_ok(), 'the old session stays refused');
select test.reset_role();

-- replay of the reset
select t10.snap('w5b', t10.world());
select t10.snap('h201', t10.hash('201'));
select test.act_as('100');
select is(public.admin_set_secret('f1000000-0000-4000-8000-000000000502', t10.uid('201'), '8888'), t10.stored('f1000000-0000-4000-8000-000000000502'), 'replay returns the same result');
select is(public.admin_set_secret('f1000000-0000-4000-8000-000000000502', t10.uid('201'), '٨٨٨٨'), t10.stored('f1000000-0000-4000-8000-000000000502'), 'replay with Arabic digits is the same secret');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000502', t10.uid('201'), '9999')$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other PIN');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000502', t10.uid('202'), '8888')$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other user');
select test.reset_role();
select is(t10.world(), t10.snapv('w5b'), 'replay and reuse refusals changed nothing (no new hash, version or revocation)');
select is(t10.hash('201'), t10.snapv('h201'), 'stored hash is byte-identical');
select ok(t10.hm('201', '8888') and not t10.hm('201', '9999'), 'stored PIN is still the first one');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-0000000002a1'), false, 'the new session was not revoked by the replay');

-- 6. owner changes own password: calling session survives ------------------------------------------
select t10.new_session('100', '5e5e5e5e-0000-4000-8000-0000000001a2');
select test.act_as('100');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000601', t10.uid('100'), 'canary-pass-9137-zq')$$, 'owner sets own password');
select ok(app.session_ok(), 'the calling session still works');
select lives_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000602', t10.uid('202'), true)$$, 'and can still call RPCs');
select test.reset_role();
select is(t10.cv('100'), 1, 'owner version +1');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-000000000100'), false, 'calling session not revoked');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-0000000001a2'), true, 'the owner''s other session is revoked');
select ok(t10.hm('100', 'canary-pass-9137-zq') and not t10.hm('100', 'correct horse battery'), 'owner hash replaced');

-- 7. bcrypt boundary through admin_set_secret on the owner's own row ----------------------------------
select test.act_as('100');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000701', t10.uid('100'), repeat('x', 72))$$, '72 ASCII bytes accepted');
select test.reset_role();
select ok(t10.hm('100', repeat('x', 72)), 'stored hash matches the 72-byte password');
select ok(not t10.hm('100', repeat('x', 71) || 'y'), 'and not the same string with the last (72nd) character changed: all 72 bytes count');
select is(t10.cv('100'), 2, 'version +1 for the accepted 72-byte password');
select t10.snap('w7', t10.world());
select test.act_as('100');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000702', t10.uid('100'), repeat('x', 73))$$, 'P0001', 'SECRET_TOO_LONG', '73 ASCII bytes refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000702', t10.uid('100'), repeat('ب', 37))$$, 'P0001', 'SECRET_TOO_LONG', '37 Arabic letters (74 bytes) refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000702', t10.uid('100'), 'short')$$, 'P0001', 'SECRET_WEAK', 'owner: short refused');
select test.reset_role();
select is(t10.world(), t10.snapv('w7'), 'refusals stored nothing: hash, version, sessions and request rows unchanged');
select is(t10.nreq('f1000000-0000-4000-8000-000000000702'), 0::bigint, 'no request row for a refused secret');
select ok(t10.hm('100', repeat('x', 72)), 'hash still the 72-byte one');
select test.act_as('100');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000703', t10.uid('100'), repeat('ب', 36))$$, '36 Arabic letters (72 bytes) accepted');
select test.reset_role();
select ok(t10.hm('100', repeat('ب', 36)) and not t10.hm('100', repeat('ب', 35) || 'ت'), 'all 36 Arabic letters count');
select is(t10.cv('100'), 3, 'version +1 again');

-- 8. secret replay after a later change (203) -----------------------------------------------------------
select test.act_as('100');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000801', t10.uid('203'), '1111')$$, 'A sets 203 to 1111');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000802', t10.uid('203'), '2222')$$, 'B sets 203 to 2222');
select test.reset_role();
select is(t10.cv('203'), 2, 'two real changes, version 2');
select ok(t10.hm('203', '2222') and not t10.hm('203', '1111'), 'hash matches 2222');
select t10.snap('w8', t10.world());
select t10.snap('h203', t10.hash('203'));
select test.act_as('100');
select is(public.admin_set_secret('f1000000-0000-4000-8000-000000000801', t10.uid('203'), '1111'), t10.stored('f1000000-0000-4000-8000-000000000801'), 'retry A with 1111 returns A''s stored result');
select is(public.admin_set_secret('f1000000-0000-4000-8000-000000000801', t10.uid('203'), '١١١١'), t10.stored('f1000000-0000-4000-8000-000000000801'), 'retry A with Arabic digits too');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000801', t10.uid('203'), '2222')$$, 'P0001', 'REQUEST_ID_REUSED', 'A with 2222 (the current PIN) is refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000801', t10.uid('203'), '3333')$$, 'P0001', 'REQUEST_ID_REUSED', 'A with 3333 is refused');
select throws_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000802', t10.uid('203'), '1111')$$, 'P0001', 'REQUEST_ID_REUSED', 'B with 1111 is refused');
select is(public.admin_set_secret('f1000000-0000-4000-8000-000000000802', t10.uid('203'), '2222'), t10.stored('f1000000-0000-4000-8000-000000000802'), 'B with 2222 returns its result');
select test.reset_role();
select is(t10.world(), t10.snapv('w8'), 'nothing changed, no new revocation timestamps');
select is(t10.hash('203'), t10.snapv('h203'), 'hash byte-identical');
select ok(t10.hm('203', '2222') and not t10.hm('203', '1111'), 'hash STILL matches 2222 and not 1111');
select is(t10.cv('203'), 2, 'version unchanged by the retries');

-- same shape for create
select test.act_as('100');
select lives_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000811', '207', 'مدير 7', 'manager', 'BR-01', '1234')$$, 'create 207 with 1234');
select lives_ok($$select public.admin_set_secret('f1000000-0000-4000-8000-000000000812', t10.uid('207'), '9999')$$, 'then change its PIN to 9999');
select test.reset_role();
select t10.snap('w8c', t10.world());
select test.act_as('100');
select is(public.admin_create_user('f1000000-0000-4000-8000-000000000811', '207', 'مدير 7', 'manager', 'BR-01', '1234'), t10.stored('f1000000-0000-4000-8000-000000000811'), 'retry of the create returns the stored result');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000811', '207', 'مدير 7', 'manager', 'BR-01', '9999')$$, 'P0001', 'REQUEST_ID_REUSED', 'create id with the current PIN is refused');
select throws_ok($$select public.admin_create_user('f1000000-0000-4000-8000-000000000811', '207', 'مدير 7', 'manager', 'BR-01', '4321')$$, 'P0001', 'REQUEST_ID_REUSED', 'create id with another PIN is refused');
select test.reset_role();
select is(t10.world(), t10.snapv('w8c'), 'create retries changed nothing');
select ok(t10.hm('207', '9999') and not t10.hm('207', '1234') and t10.cv('207') = 1, 'hash still 9999, version still 1');

-- 9. deactivation (301) ----------------------------------------------------------------------------------
select t10.snap('rev202b', t10.revts('202'));
select test.act_as('100');
select lives_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000901', t10.uid('301'), false)$$, 'owner deactivates 301');
select test.reset_role();
select is((select active from app_users where employee_number = '301'), false, 'inactive');
select is(t10.cv('301'), 1, 'credential_version +1 on deactivation');
select ok(t10.nall('301') >= 1 and t10.nrev('301') = t10.nall('301'), 'every session of 301 revoked');
select is(t10.stored('f1000000-0000-4000-8000-000000000901'), jsonb_build_object('user_id', t10.uid('301'), 'active', false), 'stored result');
select is(t10.revts('202'), t10.snapv('rev202b'), 'another user''s sessions untouched');
select test.act_as('301');
select ok(not app.session_ok(), 'deactivated user: session not ok');
select throws_ok($$select public.send_transfer('f1000000-0000-4000-8000-000000000991', 'BR-01', '[]'::jsonb)$$, 'P0001', 'NOT_AUTHENTICATED', 'send_transfer refused');
select test.reset_role();
select t10.new_session('301', '5e5e5e5e-0000-4000-8000-0000000002b1');
select t10.act_sess('301', '5e5e5e5e-0000-4000-8000-0000000002b1');
select ok(not app.session_ok(), 'a new session of an inactive user is refused');
select test.reset_role();
select t10.snap('w9', t10.world());
select test.act_as('100');
select is(public.admin_set_user_active('f1000000-0000-4000-8000-000000000901', t10.uid('301'), false), t10.stored('f1000000-0000-4000-8000-000000000901'), 'replay returns the stored result');
select lives_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000902', t10.uid('301'), false)$$, 'deactivating an already inactive user succeeds');
select test.reset_role();
select is(t10.cv('301'), 1, 'version not bumped again');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-0000000002b1'), false, 'no extra revocation');
select test.act_as('100');
select lives_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000903', t10.uid('301'), true)$$, 'owner activates 301');
select test.reset_role();
select is((select active from app_users where employee_number = '301'), true, 'active again');
select is(t10.cv('301'), 1, 'activation does not change the version');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-000000000301'), true, 'old session stays revoked');
select t10.act_sess('301', '5e5e5e5e-0000-4000-8000-0000000002b1');
select ok(app.session_ok(), 'the session created meanwhile works now');
select t10.act_sess('301', '5e5e5e5e-0000-4000-8000-000000000301');
select ok(not app.session_ok(), 'the old one is still refused');
select test.reset_role();
select t10.snap('w9b', t10.world());
select test.act_as('100');
select is(public.admin_set_user_active('f1000000-0000-4000-8000-000000000901', t10.uid('301'), false), t10.stored('f1000000-0000-4000-8000-000000000901'), 'replay of the deactivation after reactivation returns the stored result');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000901', t10.uid('301'), true)$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other value');
select test.reset_role();
select is(t10.world(), t10.snapv('w9b'), 'the replay did not deactivate again');
-- the seeded inactive user 299: deactivating it again is a no-op
select t10.snap('w9c', t10.world());
select test.act_as('100');
select lives_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000904', t10.uid('299'), false)$$, 'deactivating inactive 299');
select test.reset_role();
select ok(t10.cv('299') = 0 and t10.nrev('299') = 0, 'no version bump and no revocation for a no-op deactivation');
-- refusals
select t10.snap('w9d', t10.world());
select test.act_as('100');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000911', t10.uid('100'), false)$$, 'P0001', 'USER_INVALID', 'owner cannot deactivate themselves');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000911', gen_random_uuid(), false)$$, 'P0001', 'USER_INVALID', 'unknown user');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000911', null, false)$$, 'P0001', 'USER_INVALID', 'null user');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000911', t10.uid('201'), null)$$, 'P0001', 'USER_INVALID', 'null active');
select throws_ok($$select public.admin_set_user_active('f1000000-0000-4000-8000-000000000911', t10.uid('101'), false)$$, 'P0001', 'FORBIDDEN', 'another owner row is refused');
select test.reset_role();
select is(t10.world(), t10.snapv('w9d'), 'refusals changed nothing');
select ok((select active from app_users where employee_number = '100'), 'owner still active');

-- 10. unlock (215) ---------------------------------------------------------------------------------------------
update app_users set failed_attempts = 5, locked_until = clock_timestamp() + interval '15 minutes' where employee_number = '215';
select t10.snap('rev215', t10.revts('215'));
select t10.snap('h215', t10.hash('215'));
select test.act_as('100');
select lives_ok($$select public.admin_unlock_user('f1000000-0000-4000-8000-000000001001', t10.uid('215'))$$, 'owner unlocks 215');
select test.reset_role();
select is((select concat_ws('|', failed_attempts, locked_until is null, active, credential_version) from app_users where employee_number = '215'), '0|t|t|0', 'attempts cleared, version unchanged');
select is(t10.revts('215'), t10.snapv('rev215'), 'sessions untouched');
select is(t10.hash('215'), t10.snapv('h215'), 'hash untouched');
select is(t10.stored('f1000000-0000-4000-8000-000000001001'), jsonb_build_object('user_id', t10.uid('215')), 'stored result');
update app_users set failed_attempts = 2 where employee_number = '215';
select t10.snap('w10', t10.world());
select test.act_as('100');
select is(public.admin_unlock_user('f1000000-0000-4000-8000-000000001001', t10.uid('215')), t10.stored('f1000000-0000-4000-8000-000000001001'), 'replay returns the stored result');
select throws_ok($$select public.admin_unlock_user('f1000000-0000-4000-8000-000000001001', t10.uid('202'))$$, 'P0001', 'REQUEST_ID_REUSED', 'same id, other user');
select throws_ok($$select public.admin_unlock_user('f1000000-0000-4000-8000-000000001002', gen_random_uuid())$$, 'P0001', 'USER_INVALID', 'unknown user');
select throws_ok($$select public.admin_unlock_user('f1000000-0000-4000-8000-000000001002', null)$$, 'P0001', 'USER_INVALID', 'null user');
select test.reset_role();
select is(t10.world(), t10.snapv('w10'), 'replay did not unlock again; refusals changed nothing');

-- 11. logout -----------------------------------------------------------------------------------------------------
select t10.new_session('202', '5e5e5e5e-0000-4000-8000-0000000002b2');
select t10.snap('rev215b', t10.revts('215'));
select test.act_as('202');
select lives_ok($$select logout()$$, 'manager logs out');
select ok(not app.session_ok(), 'the current session is revoked');
select throws_ok($$select logout()$$, 'P0001', 'NOT_AUTHENTICATED', 'logging out twice is refused');
select test.reset_role();
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-000000000202'), true, 'seeded session carries revoked_at');
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-0000000002b2'), false, 'the second session of the same user is not revoked');
select t10.act_sess('202', '5e5e5e5e-0000-4000-8000-0000000002b2');
select ok(app.session_ok() and app.my_role() = 'manager', 'the second session still works');
select test.reset_role();
select is(t10.revts('215'), t10.snapv('rev215b'), 'other users unaffected');
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok($$select logout()$$, 'P0001', 'NOT_AUTHENTICATED', 'no session: NOT_AUTHENTICATED');
select test.reset_role();

-- 12. nothing leaked -------------------------------------------------------------------------------------------------
select ok(not t10.leak_any('canary-pass-9137-zq'), 'the owner password appears in no request row column and no activity row');
select ok(not t10.leak_json('4444'), 'no result or activity details contains 4444');
select ok(not t10.leak_json('5555') and not t10.leak_json('9999') and not t10.leak_json('8888'), 'nor any other PIN');
select is((select request_hash from rpc_requests where request_id = 'f1000000-0000-4000-8000-000000000101'),
          encode(extensions.digest('admin_create_user:' || jsonb_build_object('employee_number', '204', 'name', 'مدير 4', 'role', 'manager', 'branch_id', 'BR-02')::text, 'sha256'), 'hex'),
          'the request hash is computed from the parameters without the secret');
select is((select request_hash from rpc_requests where request_id = 'f1000000-0000-4000-8000-000000000502'),
          encode(extensions.digest('admin_set_secret:' || jsonb_build_object('user_id', t10.uid('201'))::text, 'sha256'), 'hex'),
          'set_secret request hash has no secret in it');
select ok((select secret_verifier <> '4444' and secret_verifier like '$2_$10$%' and extensions.crypt('4444', secret_verifier) = secret_verifier
           from rpc_requests where request_id = 'f1000000-0000-4000-8000-000000000101'), 'verifier is a bcrypt hash of the PIN, not the PIN');
select is((select count(*) from rpc_requests where secret_verifier is not null),
          (select count(*) from rpc_requests where rpc_name in ('admin_create_user', 'admin_set_secret')), 'only the two secret RPCs keep a verifier');

-- 13. the owner can log out too (last: it ends the owner session) -------------------------------------------------------
select test.act_as('100');
select lives_ok($$select logout()$$, 'owner logs out');
select ok(not app.session_ok(), 'owner session is revoked');
select test.reset_role();
select is(t10.is_revoked('5e5e5e5e-0000-4000-8000-000000000100'), true, 'owner seeded session carries revoked_at');

select * from finish();
rollback;
