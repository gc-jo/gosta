-- Cap only unknown-user failures; real-user logging and existing login_verify grants are preserved.
create index activity_log_unknown_login_failed_at_idx on activity_log (at)
where action = 'LOGIN_FAILED' and user_id is null;

create or replace function public.login_verify(p_employee_number text, p_secret text) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  c_dummy constant text := '$2a$10$SLzXDiZ4WSsygwm7dDVGx.jDm0S5OEjzuVjqMxTibCmqbWRz963DW';
  v_number text := app.normalize_digits(btrim(p_employee_number));  -- spaces only, like admin_create_user; zeros stay
  v_log    text;
  v_user   app_users;
  v_hash   text;
  v_secret text;
  v_ok     boolean;
  v_locked timestamptz;
  v_auth   uuid;
begin
  if v_number is not null and v_number !~ '^[0-9]+$' then
    v_number := null;
  end if;
  -- what is logged: a digit string (bounded) or null; free text typed into the wrong field is never stored
  v_log := left(v_number, 64);

  if v_number is not null then
    select u.* into v_user from app_users u where u.employee_number = v_number for update;
  end if;

  if v_user.id is null or not v_user.active then
    perform extensions.crypt(coalesce(p_secret, ''), c_dummy);
    -- shortcut: approximate cap (two simultaneous requests can both pass the count), raise it if real traffic ever reaches it.
    if v_user.id is not null or (select count(*) from activity_log
                                where action = 'LOGIN_FAILED' and user_id is null
                                  and at > clock_timestamp() - interval '10 minutes') < 100 then
      perform app.log_action(v_user.id, 'LOGIN_FAILED', 'app_users', v_user.id::text,
                             jsonb_build_object('employee_number', v_log));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'locked_until', null);
  end if;

  if v_user.locked_until is not null and v_user.locked_until > clock_timestamp() then
    perform app.log_action(v_user.id, 'LOGIN_LOCKED', 'app_users', v_user.id::text,
                           jsonb_build_object('employee_number', v_log));
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', v_user.locked_until);
  end if;

  select s.secret_hash into v_hash from app_user_secrets s where s.user_id = v_user.id;
  if v_hash is null then
    perform extensions.crypt(coalesce(p_secret, ''), c_dummy);
    perform app.log_action(v_user.id, 'LOGIN_FAILED', 'app_users', v_user.id::text,
                           jsonb_build_object('employee_number', v_log));
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'locked_until', null);
  end if;

  -- Mirrors app.clean_secret (as redefined above in 0013) by hand, without raising. The two MUST change together: staff secrets go
  -- through app.normalize_digits, an owner password is used exactly as typed, and the limit is 72 bytes
  -- (bcrypt reads no more). If clean_secret's rules change, change this block in the same migration.
  if p_secret is null then
    v_secret := null;
  elsif v_user.role = 'owner' then
    v_secret := p_secret;
  else
    v_secret := app.normalize_digits(p_secret);
  end if;

  -- (0013) a control character (U+0001-U+001F, U+007F-U+009F; NUL cannot occur in text) makes the secret a wrong
  -- secret, like an over-length one: app.clean_secret refuses such a secret at set time, so it can never match.
  if v_secret is null or octet_length(v_secret) > 72 or v_secret ~ '[\u0001-\u001f\u007f-\u009f]' then
    perform extensions.crypt('', c_dummy);   -- keeps the timing; the real hash never sees this value
    v_ok := false;
  else
    v_ok := extensions.crypt(v_secret, v_hash) = v_hash;
  end if;

  if v_ok then
    update app_users set failed_attempts = 0, locked_until = null where id = v_user.id;
    v_auth := public.login_attach_auth_user(v_user.id);
    perform app.log_action(v_user.id, 'LOGIN_OK', 'app_users', v_user.id::text,
                           jsonb_build_object('employee_number', v_log));
    return jsonb_build_object('ok', true, 'user_id', v_user.id, 'auth_user_id', v_auth,
                              'employee_number', v_user.employee_number,
                              'credential_version', v_user.credential_version);
  end if;

  if v_user.failed_attempts + 1 >= 5 then
    v_locked := clock_timestamp() + interval '15 minutes';
    update app_users set failed_attempts = 0, locked_until = v_locked where id = v_user.id;
    perform app.log_action(v_user.id, 'LOGIN_LOCKED', 'app_users', v_user.id::text,
                           jsonb_build_object('employee_number', v_log));
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', v_locked);
  end if;
  update app_users set failed_attempts = v_user.failed_attempts + 1 where id = v_user.id;
  perform app.log_action(v_user.id, 'LOGIN_FAILED', 'app_users', v_user.id::text,
                         jsonb_build_object('employee_number', v_log));
  return jsonb_build_object('ok', false, 'reason', 'invalid', 'locked_until', null);
end;
$$;
