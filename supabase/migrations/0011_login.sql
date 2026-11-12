-- Login verification: login_verify, login_attach_auth_user, login_register_session.
-- Server-only (service_role): the Edge Function calls them, clients never do.
-- Order inside login_verify: normalise number -> row lock on the user -> (inactive | locked | secret) ->
-- counter -> log. Exactly one extensions.crypt runs on every path that reaches the secret check, against the
-- real hash or against a fixed dummy hash, so timing reveals neither existence nor a rejected shape.

-- login_attach_auth_user -------------------------------------------------------------------------------
-- Row-locks the app user. If auth_user_id is null, looks up auth.users by <employee_number>@gosta.invalid and
-- sets it when found (and not already held by another app user). Never overwrites a non-null auth_user_id.
-- Returns the row's auth_user_id; null when there is none or the user id is unknown or null.
create function public.login_attach_auth_user(p_user_id uuid) returns uuid
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users;
  v_auth uuid;
begin
  if p_user_id is null then
    return null;
  end if;
  select u.* into v_user from app_users u where u.id = p_user_id for update;
  if v_user.id is null then
    return null;
  end if;
  if v_user.auth_user_id is not null then
    return v_user.auth_user_id;
  end if;
  select a.id into v_auth from auth.users a where a.email = v_user.employee_number || '@gosta.invalid' limit 1;
  if v_auth is null or exists (select 1 from app_users o where o.auth_user_id = v_auth) then
    return null;  -- no Auth user yet, or that Auth user already belongs to another app user
  end if;
  update app_users set auth_user_id = v_auth where id = v_user.id;
  return v_auth;
end;
$$;

-- login_verify -------------------------------------------------------------------------------------------
-- Never raises for a bad credential. Answers
--   {"ok": true, "user_id", "auth_user_id" (may be null), "employee_number", "credential_version"}
--   {"ok": false, "reason": "invalid" | "locked", "locked_until": timestamptz | null}
-- The employee number is normalised with normalize_digits and compared as text: leading zeros count.
-- Staff secrets are normalised the way they were stored (normalize_digits); an owner password is compared
-- exactly as typed. A null secret, or one over 72 bytes after that, is a wrong secret and never reaches
-- crypt against the real hash (bcrypt reads only the first 72 bytes).
-- Paths (one activity_log row each, details = the number only, never anything derived from the secret):
--   unknown / non-digit / null number     dummy crypt, no counter           LOGIN_FAILED (user_id null)
--   inactive user                         dummy crypt, no counter           LOGIN_FAILED
--   locked_until in the future            no crypt, no counter, no change   LOGIN_LOCKED
--   no secret row                         dummy crypt, no counter           LOGIN_FAILED
--   null / over-72-byte secret            dummy crypt, counter + 1          LOGIN_FAILED, or LOGIN_LOCKED on the 5th
--   wrong secret                          real crypt,  counter + 1          LOGIN_FAILED, or LOGIN_LOCKED on the 5th
--   right secret                          real crypt,  counter 0, unlocked  LOGIN_OK
create function public.login_verify(p_employee_number text, p_secret text) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  c_dummy constant text := '$2a$10$SLzXDiZ4WSsygwm7dDVGx.jDm0S5OEjzuVjqMxTibCmqbWRz963DW';
  v_number text := app.normalize_digits(p_employee_number);
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

  -- the same cleaning as when the secret was stored (clean_secret), without raising
  if p_secret is null then
    v_secret := null;
  elsif v_user.role = 'owner' then
    v_secret := p_secret;
  else
    v_secret := app.normalize_digits(p_secret);
  end if;

  if v_secret is null or octet_length(v_secret) > 72 then
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

-- login_register_session -----------------------------------------------------------------------------------
-- Called after Supabase Auth has issued a session for a verified login. Takes the same row lock as
-- admin_set_secret and admin_set_user_active, so a login is either registered before a reset or deactivation
-- (and revoked by it) or refused after it. Every argument must be present: a null version would otherwise
-- compare as "unknown" and slip past <>. Raises USER_INVALID for any null, a missing or inactive user, a stale
-- version, and a session id that already belongs to another user. An id already registered for the same
-- user is left as it is.
create function public.login_register_session(p_user_id uuid, p_session_id uuid, p_credential_version int)
returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users;
  v_rows int;
begin
  if p_user_id is null or p_session_id is null or p_credential_version is null then
    raise exception 'USER_INVALID';
  end if;
  select u.* into v_user from app_users u where u.id = p_user_id for update;
  if v_user.id is null or not v_user.active or v_user.credential_version <> p_credential_version then
    raise exception 'USER_INVALID';
  end if;
  insert into app_sessions (session_id, user_id, expires_at)
  values (p_session_id, p_user_id, clock_timestamp() + interval '7 days')
  on conflict (session_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 and exists (select 1 from app_sessions s where s.session_id = p_session_id and s.user_id <> p_user_id) then
    raise exception 'USER_INVALID';
  end if;
end;
$$;

grant execute on function public.login_verify(text, text) to service_role;
grant execute on function public.login_attach_auth_user(uuid) to service_role;
grant execute on function public.login_register_session(uuid, uuid, int) to service_role;
