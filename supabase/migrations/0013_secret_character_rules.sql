-- One rule for which characters a secret may contain (plan rule (ad)): no control characters, Unicode category Cc,
-- i.e. U+0000-U+001F and U+007F-U+009F, when a secret is set (app.clean_secret) and when it is checked
-- (public.login_verify); the login Edge Function applies the same ranges. NUL (U+0000) cannot exist in a
-- Postgres text value, so the regex class starts at U+0001; a NUL can only arrive as an error before this point.
-- Both functions are create or replace with the same signatures, attributes and (existing) grants as in 0010 / 0011;
-- only the control-character rule is added. No grant changes.

-- app.clean_secret: same as 0010 plus SECRET_INVALID (new error code).
-- Owner: null -> SECRET_WEAK; > 72 bytes -> SECRET_TOO_LONG; control character -> SECRET_INVALID; < 12 chars -> SECRET_WEAK.
-- Staff: normalize_digits, then control character -> SECRET_INVALID, then not exactly 4 ASCII digits -> SECRET_WEAK.
create or replace function app.clean_secret(p_role text, p_secret text) returns text
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_pin text;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'distributor') then
    raise exception 'USER_INVALID';
  end if;
  if p_secret is null then
    raise exception 'SECRET_WEAK';
  end if;
  if p_role = 'owner' then
    if octet_length(p_secret) > 72 then
      raise exception 'SECRET_TOO_LONG';
    end if;
    if p_secret ~ '[\u0001-\u001f\u007f-\u009f]' then
      raise exception 'SECRET_INVALID';
    end if;
    if char_length(p_secret) < 12 then
      raise exception 'SECRET_WEAK';
    end if;
    return p_secret;
  end if;
  v_pin := app.normalize_digits(p_secret);
  if v_pin ~ '[\u0001-\u001f\u007f-\u009f]' then
    raise exception 'SECRET_INVALID';
  end if;
  if v_pin !~ '^[0-9]{4}$' then
    raise exception 'SECRET_WEAK';
  end if;
  return v_pin;
end;
$$;

-- public.login_verify: the 0011 body, with one added condition (marked "(0013)" below).
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
    perform app.log_action(v_user.id, 'LOGIN_FAILED', 'app_users', v_user.id::text,
                           jsonb_build_object('employee_number', v_log));
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

  -- Mirrors app.clean_secret (0010) by hand, without raising. The two MUST change together: staff secrets go
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
