begin;
select plan(72);  -- the brief's 29 assertions plus additions; never drop one
-- client-visible
select test.act_as('201');
select is(app.session_ok(), true); select is(app.my_branch(), 'BR-01'); select is(app.my_role(), 'manager');
select throws_ok('select app.current_app_user()', '42501', null, 'internal helper is not callable by clients');
select throws_ok($$select app.request_store(gen_random_uuid(),'x',gen_random_uuid(),'{}','{}')$$, '42501');
select throws_ok($$select app.log_action(null,'x','x','x','{}')$$, '42501');
select test.reset_role();
select test.expire_session('201'); select test.act_as('201');
select is(app.session_ok(), false, 'expired session'); select is(app.my_branch(), null);
select test.act_as('299'); select is(app.session_ok(), false, 'inactive user');
select test.reset_role();
update app_sessions set revoked_at = clock_timestamp() where user_id = (select id from app_users where employee_number='202');
select test.act_as('202'); select is(app.session_ok(), false, 'revoked session');
select test.reset_role();
-- internal, as postgres
select is(app.unit_rate('D-001','عبوة'), 750::numeric);
select throws_ok($$select app.unit_rate('D-001','حبة')$$, 'UNIT_INVALID');
select throws_ok($$select app.unit_rate('D-003','غم')$$, 'ITEM_INVALID');
select throws_ok($$select app.check_quantity(0, false)$$, 'QUANTITY_INVALID');
select is(app.check_quantity(0, true), 0::numeric); select is(app.check_quantity(2.5, false), 2.5::numeric);
select throws_ok($$select app.check_quantity(null, true)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity(-1, true)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('NaN', false)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('Infinity', false)$$, 'QUANTITY_INVALID');
select throws_ok($$select app.check_quantity('-Infinity', true)$$, 'QUANTITY_INVALID');
select is(app.check_cost(null), null::numeric); select is(app.check_cost(0), 0::numeric);
select throws_ok($$select app.check_cost('NaN')$$, 'COST_INVALID');
select throws_ok($$select app.check_cost('Infinity')$$, 'COST_INVALID');
select throws_ok($$select app.check_cost(-0.01)$$, 'COST_INVALID');
select throws_ok($$select app.require_feature('BR-15','send')$$, 'FEATURE_HIDDEN');
select is(app.normalize_digits('٢٠١'), '201');
-- replay: same values replay, changed values are refused
select app.request_store('00000000-0000-0000-0000-000000000001','r', (select id from app_users where employee_number='201'), '{"q":2}', '{"ok":1}');
select throws_ok($$select app.request_replay('00000000-0000-0000-0000-000000000001','r',(select id from app_users where employee_number='201'),'{"q":3}')$$, 'REQUEST_ID_REUSED');

-- additions ---------------------------------------------------------------
-- session claims set by hand, as postgres
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select auth_user_id from app_users where employee_number='203'),
  'role', 'authenticated',
  'session_id', (select session_id from app_sessions where user_id = (select id from app_users where employee_number='203')))::text, true);
select is((app.current_app_user()).employee_number, '203', 'current_app_user returns the caller row');
select is(app.my_role(), 'manager', 'my_role with hand-set claims');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select auth_user_id from app_users where employee_number='203'), 'session_id', 'not-a-uuid')::text, true);
select is(app.session_ok(), false, 'malformed session claim: false, not a cast error');
select throws_ok('select app.current_app_user()', 'P0001', 'NOT_AUTHENTICATED', 'malformed session claim');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select auth_user_id from app_users where employee_number='203'))::text, true);
select is(app.session_ok(), false, 'missing session claim');
select throws_ok('select app.current_app_user()', 'P0001', 'NOT_AUTHENTICATED', 'missing session claim');
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select auth_user_id from app_users where employee_number='202'),
  'session_id', (select session_id from app_sessions where user_id = (select id from app_users where employee_number='203')))::text, true);
select is(app.session_ok(), false, 'session belonging to another user');
select set_config('request.jwt.claims', '', true);
select is(app.session_ok(), false, 'no claims at all');
select is(app.my_role(), null, 'no claims: my_role null');
select throws_ok('select app.current_app_user()', 'P0001', 'NOT_AUTHENTICATED', 'no claims at all');

-- require_role returns the caller row, raises FORBIDDEN otherwise
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select auth_user_id from app_users where employee_number='301'),
  'session_id', (select session_id from app_sessions where user_id = (select id from app_users where employee_number='301')))::text, true);
select is((app.require_role('distributor','owner')).employee_number, '301', 'require_role returns the user row');
select throws_ok($$select app.require_role('manager','owner')$$, 'FORBIDDEN');
select set_config('request.jwt.claims', '', true);
select throws_ok($$select app.require_role('manager')$$, 'P0001', 'NOT_AUTHENTICATED', 'require_role without a session');

-- require_feature: visible features pass
select lives_ok($$select app.require_feature('BR-01','send')$$, 'visible feature passes');

-- lock_branches
select ok(app.lock_branches('BR-02','BR-01','BR-02') is not null, 'duplicates and unsorted ids are accepted');
select ok(app.lock_branches(variadic '{}'::text[]) is not null and app.lock_branches(variadic null::text[]) is not null, 'empty or null list returns a timestamp');
select ok(app.lock_branches('BR-01') > now(), 'returns clock_timestamp, later than the transaction start');

-- require_not_frozen
select lives_ok($$select app.require_not_frozen('BR-02')$$, 'unfrozen branch passes');
select test.freeze('BR-02');
select throws_ok($$select app.require_not_frozen('BR-02')$$, 'BRANCH_FROZEN');
select lives_ok($$select app.require_not_frozen('BR-01')$$, 'other branch unaffected');

-- unit_rate with p_allow_inactive
select is(app.unit_rate('D-003','غم', true), 1::numeric, 'inactive item allowed when asked');
select throws_ok($$select app.unit_rate('D-999','غم', true)$$, 'P0001', 'ITEM_INVALID', 'missing item still invalid');
update item_units set active = false where item_id = 'D-001' and unit_name = 'كرتونة';
select throws_ok($$select app.unit_rate('D-001','كرتونة')$$, 'P0001', 'UNIT_INVALID', 'inactive unit refused by default');
select is(app.unit_rate('D-001','كرتونة', true), 9000::numeric, 'inactive unit allowed when asked');

-- request_replay / request_store / request_secret_ok / log_action
select is(app.request_replay('00000000-0000-0000-0000-000000000001','r',(select id from app_users where employee_number='201'),'{"q":2}'),
          '{"ok":1}'::jsonb, 'identical params replay the stored result');
select is(app.request_replay('00000000-0000-0000-0000-0000000000ff','r',(select id from app_users where employee_number='201'),'{"q":2}'),
          null::jsonb, 'unknown request id: null');
select throws_ok($$select app.request_replay('00000000-0000-0000-0000-000000000001','other',(select id from app_users where employee_number='201'),'{"q":2}')$$, 'P0001', 'REQUEST_ID_REUSED', 'different rpc name');
select throws_ok($$select app.request_replay('00000000-0000-0000-0000-000000000001','r',(select id from app_users where employee_number='202'),'{"q":2}')$$, 'P0001', 'REQUEST_ID_REUSED', 'different user');
select is(app.request_store('00000000-0000-0000-0000-000000000002','r2',(select id from app_users where employee_number='201'),'{"n":1}','{"done":true}','s3cret-value'),
          '{"done":true}'::jsonb, 'request_store returns the result');
select is(app.request_secret_ok('00000000-0000-0000-0000-000000000002','s3cret-value'), true, 'secret verifies');
select is(app.request_secret_ok('00000000-0000-0000-0000-000000000002','wrong'), false, 'wrong secret');
select is(app.request_secret_ok('00000000-0000-0000-0000-000000000001','s3cret-value'), false, 'request stored without a secret');
select is(app.request_secret_ok('00000000-0000-0000-0000-0000000000ff','s3cret-value'), false, 'unknown request');
select ok((select secret_verifier like '$2_$10$%' from rpc_requests where request_id='00000000-0000-0000-0000-000000000002'), 'bcrypt verifier, cost 10');
select ok((select not (to_jsonb(r)::text like '%s3cret-value%') from rpc_requests r where request_id='00000000-0000-0000-0000-000000000002'), 'plain secret is stored nowhere in the row');
select is((select request_hash from rpc_requests where request_id='00000000-0000-0000-0000-000000000001'),
          encode(digest('r:' || '{"q":2}'::jsonb::text, 'sha256'), 'hex'), 'request_hash formula');
select app.log_action((select id from app_users where employee_number='201'), 'test_action', 'items', 'D-001', '{"k":1}');
select is((select details from activity_log where action='test_action'), '{"k":1}'::jsonb, 'log_action writes a row');
select is((select user_id from activity_log where action='test_action'), (select id from app_users where employee_number='201'), 'log_action records the user');

-- normalize_digits
select is(app.normalize_digits('۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩ ab'), '0123456789 0123456789 ab', 'both digit sets');
select is(app.normalize_digits(null), null, 'null passes through');

-- privileges: only the three RLS helpers are executable by clients
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}')
           from pg_proc p where p.pronamespace = 'app'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')),
          array['my_branch','my_role','session_ok'], 'authenticated may execute exactly the three RLS helpers');
select is((select count(*) from pg_proc p where p.pronamespace = 'app'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
          0::bigint, 'anon may execute nothing in app');
select is((select count(*) from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname in
            ('current_app_user','session_ok','my_role','my_branch','require_role','require_feature','lock_branches','require_not_frozen',
             'unit_rate','check_quantity','check_cost','request_replay','request_store','request_secret_ok','log_action','normalize_digits')
            and p.prosecdef and p.proconfig @> array['search_path=app, public, extensions, pg_temp']),
          16::bigint, 'all sixteen helpers are security definer with the fixed search_path');
select * from finish();
rollback;
