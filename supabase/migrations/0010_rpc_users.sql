-- User administration: admin_create_user, admin_set_secret, admin_set_user_active, admin_unlock_user,
-- set_branch_feature, and logout. Owner only, except logout (any signed-in role).
-- Numbered 0010 on purpose: 0009 (inventory counts) is paused and will be added later.
-- Order in every owner RPC: require_role -> request id -> normalise and validate parameters (no database
-- state, no secret in v_params) -> request_replay -> (secret RPCs: stored result only for the same secret)
-- -> row lock on the target -> validate against state -> write -> log_action -> request_store.
-- A secret is hashed only as crypt(clean_secret(...), gen_salt('bf', 10)) and only after clean_secret passed.

-- Hardening of 0005 helper (follow-up; 0005 itself is not edited).
-- Same signature, attributes and behaviour as in 0005, plus one rule: a secret longer than 72 bytes never
-- matches. bcrypt reads only the first 72 bytes, so the stored verifier alone would accept a 73-byte string
-- whose first 72 bytes equal the original. RPCs also call clean_secret first; this is the second guard.
-- create or replace keeps the existing (closed) privileges.
create or replace function app.request_secret_ok(p_request_id uuid, p_secret text) returns boolean
language sql stable security definer
set search_path = app, public, extensions, pg_temp as $$
  select coalesce(
    (select octet_length(p_secret) <= 72 and extensions.crypt(p_secret, r.secret_verifier) = r.secret_verifier
     from rpc_requests r where r.request_id = p_request_id and r.secret_verifier is not null),
    false)
$$;

-- Contract: returns the secret in the form that is hashed. Raises SECRET_WEAK / SECRET_TOO_LONG / USER_INVALID.
-- Order: null -> SECRET_WEAK. owner: octet_length > 72 -> SECRET_TOO_LONG (bytes, checked first: bcrypt silently
-- reads only the first 72 bytes), then char_length < 12 -> SECRET_WEAK; returned exactly as given (no
-- normalisation, no trimming). manager/distributor: normalize_digits, then not exactly 4 ASCII digits ->
-- SECRET_WEAK (so a long staff PIN is weak, never too long). Any other role (or null) -> USER_INVALID.
-- Never puts the secret in a message.
create function app.clean_secret(p_role text, p_secret text) returns text
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
    if char_length(p_secret) < 12 then
      raise exception 'SECRET_WEAK';
    end if;
    return p_secret;
  end if;
  v_pin := app.normalize_digits(p_secret);
  if v_pin !~ '^[0-9]{4}$' then
    raise exception 'SECRET_WEAK';
  end if;
  return v_pin;
end;
$$;

-- Contract: sets revoked_at = clock_timestamp() on every unrevoked session of the user, except
-- p_except_session (null excepts nothing). Raises nothing. Callers hold the user's row lock.
create function app.revoke_sessions(p_user_id uuid, p_except_session uuid default null) returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  update app_sessions s
  set revoked_at = clock_timestamp()
  where s.user_id = p_user_id and s.revoked_at is null
    and s.session_id is distinct from p_except_session;
end;
$$;

-- admin_create_user -------------------------------------------------------------------------------
-- First call: inserts app_users (auth_user_id null, version 0) and app_user_secrets. Replay: nothing.
create function public.admin_create_user(p_request_id uuid, p_employee_number text, p_name text, p_role text,
                                         p_branch_id text, p_secret text) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner  app_users := app.require_role('owner');
  v_number text;
  v_name   text;
  v_branch text;
  v_clean  text;
  v_params jsonb;
  v_replay jsonb;
  v_id     uuid;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  v_number := nullif(btrim(app.normalize_digits(p_employee_number)), '');
  v_name   := nullif(btrim(p_name), '');
  v_branch := nullif(btrim(p_branch_id), '');
  if v_number is null or v_number !~ '^[0-9]+$' or v_name is null
     or p_role is null or p_role not in ('manager', 'distributor') or v_branch is null then
    raise exception 'USER_INVALID';
  end if;
  v_clean  := app.clean_secret(p_role, p_secret);
  v_params := jsonb_build_object('employee_number', v_number, 'name', v_name, 'role', p_role, 'branch_id', v_branch);

  v_replay := app.request_replay(p_request_id, 'admin_create_user', v_owner.id, v_params);
  if v_replay is not null then
    if app.request_secret_ok(p_request_id, v_clean) then
      return v_replay;
    end if;
    raise exception 'REQUEST_ID_REUSED';
  end if;

  if not exists (select 1 from branches b where b.id = v_branch and b.active) then
    raise exception 'USER_INVALID';
  end if;
  insert into app_users (employee_number, name, role, branch_id)
  values (v_number, v_name, p_role, v_branch)
  on conflict (employee_number) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'EMPLOYEE_NUMBER_TAKEN';
  end if;
  insert into app_user_secrets (user_id, secret_hash)
  values (v_id, extensions.crypt(v_clean, extensions.gen_salt('bf', 10)));

  v_result := jsonb_build_object('user_id', v_id);
  perform app.log_action(v_owner.id, 'admin_create_user', 'app_users', v_id::text,
                         jsonb_build_object('employee_number', v_number, 'role', p_role, 'branch_id', v_branch));
  return app.request_store(p_request_id, 'admin_create_user', v_owner.id, v_params, v_result, v_clean);
end;
$$;

-- admin_set_secret ----------------------------------------------------------------------------------
-- First call: new hash, failed_attempts 0, locked_until null, credential_version + 1, sessions of the target
-- revoked (the calling session excepted when the owner changes their own password). Replay: nothing.
-- An owner row other than the caller's own is refused (FORBIDDEN).
-- Resetting to the value the user already has is still a real change (version + 1, sessions revoked):
-- a reset is the owner's revoke-everything action.
create function public.admin_set_secret(p_request_id uuid, p_user_id uuid, p_secret text) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner  app_users := app.require_role('owner');
  v_role   text;
  v_clean  text;
  v_params jsonb;
  v_replay jsonb;
  v_target app_users;
  v_version int;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  select u.role into v_role from app_users u where u.id = p_user_id;
  if v_role is null then
    raise exception 'USER_INVALID';
  end if;
  if v_role = 'owner' and p_user_id <> v_owner.id then
    raise exception 'FORBIDDEN';
  end if;
  v_clean  := app.clean_secret(v_role, p_secret);   -- the role of the TARGET
  v_params := jsonb_build_object('user_id', p_user_id);

  v_replay := app.request_replay(p_request_id, 'admin_set_secret', v_owner.id, v_params);
  if v_replay is not null then
    if app.request_secret_ok(p_request_id, v_clean) then
      return v_replay;
    end if;
    raise exception 'REQUEST_ID_REUSED';
  end if;

  select u.* into v_target from app_users u where u.id = p_user_id for update;
  if v_target.id is null then
    raise exception 'USER_INVALID';
  end if;
  insert into app_user_secrets (user_id, secret_hash)
  values (p_user_id, extensions.crypt(v_clean, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;
  update app_users
  set failed_attempts = 0, locked_until = null, credential_version = credential_version + 1
  where id = p_user_id
  returning credential_version into v_version;
  perform app.revoke_sessions(p_user_id,
    case when p_user_id = v_owner.id then (auth.jwt() ->> 'session_id')::uuid end);

  v_result := jsonb_build_object('user_id', p_user_id);
  perform app.log_action(v_owner.id, 'admin_set_secret', 'app_users', p_user_id::text,
                         jsonb_build_object('credential_version', v_version));
  return app.request_store(p_request_id, 'admin_set_secret', v_owner.id, v_params, v_result, v_clean);
end;
$$;

-- admin_set_user_active -------------------------------------------------------------------------------
-- Deactivation: active false, sessions revoked, credential_version + 1. Activation: active true only.
-- Setting the value the user already has changes nothing (still logged). The caller cannot deactivate
-- themselves; an owner row other than the caller's own is refused (FORBIDDEN).
create function public.admin_set_user_active(p_request_id uuid, p_user_id uuid, p_active boolean) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner  app_users := app.require_role('owner');
  v_params jsonb;
  v_replay jsonb;
  v_target app_users;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  if p_user_id is null or p_active is null or (p_user_id = v_owner.id and not p_active) then
    raise exception 'USER_INVALID';
  end if;
  v_params := jsonb_build_object('user_id', p_user_id, 'active', p_active);

  v_replay := app.request_replay(p_request_id, 'admin_set_user_active', v_owner.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  select u.* into v_target from app_users u where u.id = p_user_id for update;
  if v_target.id is null then
    raise exception 'USER_INVALID';
  end if;
  if v_target.role = 'owner' and v_target.id <> v_owner.id then
    raise exception 'FORBIDDEN';
  end if;
  if v_target.active is distinct from p_active then
    if p_active then
      update app_users set active = true where id = p_user_id;
    else
      update app_users set active = false, credential_version = credential_version + 1 where id = p_user_id;
      perform app.revoke_sessions(p_user_id);
    end if;
  end if;

  v_result := jsonb_build_object('user_id', p_user_id, 'active', p_active);
  perform app.log_action(v_owner.id, 'admin_set_user_active', 'app_users', p_user_id::text,
                         jsonb_build_object('active', p_active));
  return app.request_store(p_request_id, 'admin_set_user_active', v_owner.id, v_params, v_result);
end;
$$;

-- admin_unlock_user -----------------------------------------------------------------------------------
-- failed_attempts 0, locked_until null. No version or session change. Another owner's row -> FORBIDDEN.
create function public.admin_unlock_user(p_request_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner  app_users := app.require_role('owner');
  v_params jsonb;
  v_replay jsonb;
  v_target app_users;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  if p_user_id is null then
    raise exception 'USER_INVALID';
  end if;
  v_params := jsonb_build_object('user_id', p_user_id);

  v_replay := app.request_replay(p_request_id, 'admin_unlock_user', v_owner.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  select u.* into v_target from app_users u where u.id = p_user_id for update;
  if v_target.id is null then
    raise exception 'USER_INVALID';
  end if;
  if v_target.role = 'owner' and v_target.id <> v_owner.id then
    raise exception 'FORBIDDEN';
  end if;
  update app_users set failed_attempts = 0, locked_until = null where id = p_user_id;

  v_result := jsonb_build_object('user_id', p_user_id);
  perform app.log_action(v_owner.id, 'admin_unlock_user', 'app_users', p_user_id::text, '{}'::jsonb);
  return app.request_store(p_request_id, 'admin_unlock_user', v_owner.id, v_params, v_result);
end;
$$;

-- set_branch_feature ----------------------------------------------------------------------------------
-- Upserts branch_features(branch, feature) = visible. Unknown or inactive branch -> BRANCH_INVALID; a key
-- outside receive/send/purchase/count/balance, or a null visible -> FEATURE_INVALID (checked first).
create function public.set_branch_feature(p_request_id uuid, p_branch_id text, p_feature_key text, p_visible boolean)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner  app_users := app.require_role('owner');
  v_branch text := nullif(btrim(p_branch_id), '');
  v_key    text := btrim(p_feature_key);
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  if v_key is null or v_key not in ('receive', 'send', 'purchase', 'count', 'balance') or p_visible is null then
    raise exception 'FEATURE_INVALID';
  end if;
  v_params := jsonb_build_object('branch_id', v_branch, 'feature_key', v_key, 'visible', p_visible);

  v_replay := app.request_replay(p_request_id, 'set_branch_feature', v_owner.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  if v_branch is null or not exists (select 1 from branches b where b.id = v_branch and b.active) then
    raise exception 'BRANCH_INVALID';
  end if;
  insert into branch_features (branch_id, feature_key, visible)
  values (v_branch, v_key, p_visible)
  on conflict (branch_id, feature_key) do update set visible = excluded.visible;

  v_result := jsonb_build_object('branch_id', v_branch, 'feature_key', v_key, 'visible', p_visible);
  perform app.log_action(v_owner.id, 'set_branch_feature', 'branch_features', v_branch || '/' || v_key,
                         jsonb_build_object('visible', p_visible));
  return app.request_store(p_request_id, 'set_branch_feature', v_owner.id, v_params, v_result);
end;
$$;

-- logout ------------------------------------------------------------------------------------------------
-- Any signed-in role. Revokes the current session row only; an invalid session raises NOT_AUTHENTICATED.
create function public.logout() returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users := app.current_app_user();
begin
  update app_sessions
  set revoked_at = clock_timestamp()
  where session_id = (auth.jwt() ->> 'session_id')::uuid and user_id = v_user.id and revoked_at is null;
end;
$$;

grant execute on function public.admin_create_user(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.admin_set_secret(uuid, uuid, text) to authenticated;
grant execute on function public.admin_set_user_active(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_unlock_user(uuid, uuid) to authenticated;
grant execute on function public.set_branch_feature(uuid, text, text, boolean) to authenticated;
grant execute on function public.logout() to authenticated;
