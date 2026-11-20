-- Migration 0014: cap only unknown-user LOGIN_FAILED rows; real-user audit logs stay uncapped.
begin;
select plan(14);

create schema t14;
grant usage on schema t14 to service_role;
create table t14.res (k text primary key, v jsonb);
grant all on t14.res to service_role;

-- Old log rows must not consume the ten-minute allowance. All counts below use a starting snapshot.
insert into activity_log (at, user_id, action)
values (clock_timestamp() - interval '11 minutes', null, 'LOGIN_FAILED');
create table t14.snap as
select
  (select count(*) from activity_log where action = 'LOGIN_FAILED' and user_id is null) as unknown_failed,
  (select count(*) from activity_log where action = 'LOGIN_FAILED' and user_id is null
     and at > clock_timestamp() - interval '10 minutes') as w,
  (select count(*) from activity_log where action = 'LOGIN_FAILED'
     and user_id = (select id from app_users where employee_number = '301')) as real_failed,
  (select count(*) from activity_log where action = 'LOGIN_FAILED'
     and user_id = (select id from app_users where employee_number = '299')) as inactive_failed,
  (select count(*) from activity_log where action = 'LOGIN_OK'
     and user_id = (select id from app_users where employee_number = '301')) as real_ok;
grant select on t14.snap to service_role;

select has_index('public', 'activity_log', 'activity_log_unknown_login_failed_at_idx',
                 'unknown login failures have a partial index');
select ok(has_function_privilege('service_role', 'public.login_verify(text,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.login_verify(text,text)', 'execute')
      and not has_function_privilege('anon', 'public.login_verify(text,text)', 'execute'),
          'login_verify keeps its service-role-only grants');

select test.act_as_service();
insert into t14.res
select 'unknown-' || n, public.login_verify((9000000 + n)::text, '0000')
from generate_series(1, 150) n;
select is((select count(*) from t14.res), 150::bigint, 'all 150 distinct unknown numbers were called');
select is((select count(*) from t14.res
           where v = '{"ok": false, "reason": "invalid", "locked_until": null}'::jsonb),
          150::bigint, 'every unknown login returns the same invalid response');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED' and user_id is null)
          - (select unknown_failed from t14.snap),
          (select greatest(0, 100 - w) from t14.snap), '150 unknown logins fill only the remaining allowance');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED' and user_id is null
           and at > clock_timestamp() - interval '10 minutes'),
          (select greatest(w, 100) from t14.snap), 'unknown failures in the window reach the cap or keep the higher starting count');

insert into t14.res values
  ('non-digit', public.login_verify('not a number', '0000')),
  ('null', public.login_verify(null, '0000'));
select is((select count(*) from t14.res where k in ('non-digit', 'null')
           and v = '{"ok": false, "reason": "invalid", "locked_until": null}'::jsonb),
          2::bigint, 'non-digit and null numbers still return invalid at the cap');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED' and user_id is null)
          - (select unknown_failed from t14.snap),
          (select greatest(0, 100 - w) from t14.snap), 'non-digit and null numbers add no rows at the cap');

insert into t14.res
select 'wrong-' || n, public.login_verify('301', '0000') from generate_series(1, 3) n;
select is((select count(*) from t14.res where k like 'wrong-%'
           and v = '{"ok": false, "reason": "invalid", "locked_until": null}'::jsonb),
          3::bigint, 'real-user wrong PINs still return invalid at the cap');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED'
           and user_id = (select id from app_users where employee_number = '301'))
          - (select real_failed from t14.snap),
          3::bigint, 'every real-user failure is logged with its user_id at the cap');

insert into t14.res
select 'inactive-' || n, public.login_verify('299', '9999') from generate_series(1, 2) n;
select is((select count(*) from t14.res where k like 'inactive-%'
           and v = '{"ok": false, "reason": "invalid", "locked_until": null}'::jsonb),
          2::bigint, 'inactive-user logins still return invalid at the cap');
select is((select count(*) from activity_log where action = 'LOGIN_FAILED'
           and user_id = (select id from app_users where employee_number = '299'))
          - (select inactive_failed from t14.snap),
          2::bigint, 'inactive-user failures remain uncapped with their user_id');

insert into t14.res values ('correct', public.login_verify('301', '3333'));
select ok((select (v ->> 'ok')::boolean
                  and (v ->> 'user_id')::uuid = (select id from app_users where employee_number = '301')
           from t14.res where k = 'correct'), 'correct login still succeeds at the cap');
select is((select count(*) from activity_log where action = 'LOGIN_OK'
           and user_id = (select id from app_users where employee_number = '301'))
          - (select real_ok from t14.snap),
          1::bigint, 'correct login is logged as LOGIN_OK at the cap');

select * from finish();
rollback;
