-- Follow-up to 0010 (which is not edited): admin_set_secret rechecks the caller's session after the row lock.
-- Same signature, return type, attributes, grant and body as in 0010, plus one statement
-- (perform app.current_app_user();) straight after the select ... for update on the target row. Without it, a
-- request from owner session S1 that was already waiting on the owner's row lock goes on to change the
-- password although session S2, which held the lock, has just revoked S1. create or replace keeps the existing
-- grant to authenticated; none is added here.

create or replace function public.admin_set_secret(p_request_id uuid, p_user_id uuid, p_secret text) returns jsonb
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
  -- Recheck the caller's session now that the row lock is held. require_role above ran BEFORE the wait for this
  -- lock; when the owner changes their own password from another session, that session revokes this one under
  -- this very lock, so a request that was already waiting must not go on to write. Each statement of a
  -- plpgsql function takes a fresh snapshot (READ COMMITTED), so this sees the revocation committed by the
  -- transaction we waited for. Volatile on purpose: a plain perform, never a cached earlier result.
  perform app.current_app_user();
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
