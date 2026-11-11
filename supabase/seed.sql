-- Test fixtures and helpers. Applied by `supabase db reset` after all migrations.
-- Schema `test` lives here, never in a migration.
begin;

-- branches -------------------------------------------------------------
insert into branches (id, name_ar, kind, active) values
  ('BR-01', 'فرع 1',     'branch',    true),
  ('BR-02', 'فرع 2',     'branch',    true),
  ('BR-03', 'فرع 3',     'branch',    true),
  ('BR-14', 'المستودع',  'warehouse', true),
  ('BR-15', 'التالف',    'waste',     true),
  ('BR-09', 'فرع 9',     'branch',    false);

-- items and units (the base-unit check is deferred to commit) ------------
insert into items (id, name_ar, base_unit, item_type, sort_order, active) values
  ('D-001', 'سيروب',   'مل',  'syrup',  1, true),
  ('D-002', 'أكواب',   'حبة', 'cups',   2, true),
  ('D-003', 'باودر',   'غم',  'powder', 3, false);

insert into item_units (item_id, unit_name, conversion_rate, active) values
  ('D-001', 'مل',     1,    true),
  ('D-001', 'عبوة',   750,  true),
  ('D-001', 'كرتونة', 9000, true),
  ('D-002', 'حبة',    1,    true),
  ('D-002', 'كرتونة', 1000, true),
  ('D-003', 'غم',     1,    true);

-- suppliers ------------------------------------------------------------
insert into suppliers (id, name_ar, phone, active) values
  ('S-01', 'مورد 1', null, true),
  ('S-02', 'مورد 2', null, false);

insert into supplier_items (supplier_id, item_id, active) values
  ('S-01', 'D-001', true),
  ('S-02', 'D-002', true);

insert into allowed_local_purchases (branch_id, item_id, active) values
  ('BR-01', 'D-001', true),
  ('BR-03', 'D-001', true),
  ('BR-14', 'D-001', true);

-- every (branch, feature) visible, except BR-15: send and purchase hidden
insert into branch_features (branch_id, feature_key, visible)
select b.id, f.k, not (b.id = 'BR-15' and f.k in ('send', 'purchase'))
from branches b
cross join (values ('receive'), ('send'), ('purchase'), ('count'), ('balance')) as f(k);

-- users: auth.users row, app_users row, secret, one 7-day session --------
-- Fixed ids are derived from the employee number so they are stable:
--   auth user  b0000000-0000-4000-8000-000000000<emp>
--   session    5e5e5e5e-0000-4000-8000-000000000<emp>   (emp zero-padded to 12 digits)
create temporary table seed_users (
  emp text, name text, role text, branch_id text, secret text, active boolean
) on commit drop;
insert into seed_users values
  ('100', 'المالك',     'owner',       null,    'correct horse battery', true),
  ('201', 'مدير 1',     'manager',     'BR-01', '1111', true),
  ('202', 'مدير 2',     'manager',     'BR-02', '2222', true),
  ('203', 'مدير 3',     'manager',     'BR-03', '0303', true),
  ('301', 'موزع',       'distributor', 'BR-14', '3333', true),
  ('215', 'مدير التالف', 'manager',     'BR-15', '1515', true),
  ('299', 'مدير موقوف', 'manager',     'BR-01', '9999', false);

-- String token columns are set to '' (not NULL) so GoTrue can read the rows.
insert into auth.users (
  instance_id, id, aud, role, email, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new, reauthentication_token
)
select '00000000-0000-0000-0000-000000000000'::uuid,
       ('b0000000-0000-4000-8000-' || lpad(emp, 12, '0'))::uuid,
       'authenticated', 'authenticated', emp || '@gosta.invalid', now(),
       '', '', '', '', ''
from seed_users;

insert into app_users (auth_user_id, employee_number, name, role, branch_id, active)
select ('b0000000-0000-4000-8000-' || lpad(emp, 12, '0'))::uuid, emp, name, role, branch_id, active
from seed_users;

insert into app_user_secrets (user_id, secret_hash)
select u.id, extensions.crypt(s.secret, extensions.gen_salt('bf', 10))
from seed_users s join app_users u on u.employee_number = s.emp;

insert into app_sessions (session_id, user_id, expires_at)
select ('5e5e5e5e-0000-4000-8000-' || lpad(s.emp, 12, '0'))::uuid, u.id,
       clock_timestamp() + interval '7 days'
from seed_users s join app_users u on u.employee_number = s.emp;

-- test helpers -----------------------------------------------------------
create schema test;
grant usage on schema test to anon, authenticated, service_role;

create function test.reset_role() returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function test.act_as(p_employee_number text) returns void
language plpgsql as $$
declare
  v_auth_user_id uuid;
  v_session_id   uuid;
begin
  reset role;  -- look the user up as the owner role even when already acting as someone
  select u.auth_user_id, s.session_id into v_auth_user_id, v_session_id
  from app_users u
  join app_sessions s on s.user_id = u.id
  where u.employee_number = p_employee_number;
  if v_auth_user_id is null then
    raise exception 'test.act_as: no seeded user with a session for employee %', p_employee_number;
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_auth_user_id, 'role', 'authenticated', 'session_id', v_session_id)::text,
    true);
  set local role authenticated;
end;
$$;

create function test.act_as_service() returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end;
$$;

create function test.expire_session(p_employee_number text) returns void
language sql as $$
  update app_sessions s
  set expires_at = clock_timestamp() - interval '1 second'
  from app_users u
  where s.user_id = u.id and u.employee_number = p_employee_number;
$$;

grant execute on all functions in schema test to anon, authenticated, service_role;

commit;
