-- Internal helpers every RPC calls. Error codes are raised as the message text
-- (SQLSTATE P0001, like every other code in this schema).
-- Only session_ok, my_role and my_branch are granted to authenticated (for RLS);
-- everything else stays closed by the default privileges set in 0000.

-- Contract: the active app_users row whose Supabase user and live session match the
-- JWT. Raises NOT_AUTHENTICATED for a missing/malformed claim, unknown or inactive user,
-- or a missing, other-user, revoked or expired session.
create function app.current_app_user() returns app_users
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_uid     uuid;
  v_claim   text;
  v_session uuid;
  v_user    app_users;
begin
  -- A malformed sub or claims setting must end in NOT_AUTHENTICATED, never a cast error.
  begin
    v_uid   := auth.uid();
    v_claim := auth.jwt() ->> 'session_id';
  exception when invalid_text_representation then
    raise exception 'NOT_AUTHENTICATED';
  end;
  if v_uid is null or v_claim is null
     or v_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  v_session := v_claim::uuid;

  select u.* into v_user
  from app_users u
  where u.auth_user_id = v_uid and u.active
    and exists (
      select 1 from app_sessions s
      where s.session_id = v_session and s.user_id = u.id
        and s.revoked_at is null and clock_timestamp() < s.expires_at);
  if v_user.id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  return v_user;
end;
$$;

-- Contract: true when current_app_user() would succeed, false in every other case
-- (never raises; granted to authenticated for RLS).
create function app.session_ok() returns boolean
language plpgsql stable security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  perform app.current_app_user();
  return true;
exception when raise_exception then
  return false;  -- only NOT_AUTHENTICATED can be raised above
end;
$$;

-- Contract: the caller's role, null without a valid session (granted to authenticated for RLS).
create function app.my_role() returns text
language plpgsql stable security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  return (app.current_app_user()).role;
exception when raise_exception then
  return null;
end;
$$;

-- Contract: the caller's branch id, null without a valid session or for the owner
-- (granted to authenticated for RLS).
create function app.my_branch() returns text
language plpgsql stable security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  return (app.current_app_user()).branch_id;
exception when raise_exception then
  return null;
end;
$$;

-- Contract: returns the caller's row when its role is listed. Raises NOT_AUTHENTICATED or FORBIDDEN.
create function app.require_role(variadic p_roles text[]) returns app_users
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users := app.current_app_user();
begin
  if v_user.role is null or not (v_user.role = any (p_roles)) then
    raise exception 'FORBIDDEN';
  end if;
  return v_user;
end;
$$;

-- Contract: raises FEATURE_HIDDEN when the branch has the feature switched off
-- (a missing branch_features row means visible).
create function app.require_feature(p_branch_id text, p_feature_key text) returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if exists (select 1 from branch_features f
             where f.branch_id = p_branch_id and f.feature_key = p_feature_key and not f.visible) then
    raise exception 'FEATURE_HIDDEN';
  end if;
end;
$$;

-- Contract: takes one transaction-level advisory lock per distinct branch id, in ascending
-- order, then returns clock_timestamp(). An empty or null list locks nothing. Raises nothing.
create function app.lock_branches(variadic p_branch_ids text[]) returns timestamptz
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_id text;
begin
  for v_id in
    select distinct b collate "C" as b from unnest(p_branch_ids) as t(b) where b is not null order by b
  loop
    perform pg_advisory_xact_lock(hashtextextended('branch:' || v_id, 0));
  end loop;
  return clock_timestamp();
end;
$$;

-- Contract: raises BRANCH_FROZEN when any count of the branch has frozen_since set.
-- Takes no lock itself: callers must already hold the branch lock (lock_branches).
create function app.require_not_frozen(p_branch_id text) returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if exists (select 1 from counts c where c.branch_id = p_branch_id and c.frozen_since is not null) then
    raise exception 'BRANCH_FROZEN';
  end if;
end;
$$;

-- Contract: conversion rate of (item, unit). Raises ITEM_INVALID (item missing, or inactive
-- unless p_allow_inactive) and UNIT_INVALID (no such unit, or inactive unless p_allow_inactive).
-- p_allow_inactive = true exists for receipts of things sent before a deactivation: it accepts an
-- inactive item and an inactive unit row, but a missing item or unit is still invalid.
create function app.unit_rate(p_item_id text, p_unit text, p_allow_inactive boolean default false)
returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_item_active boolean;
  v_rate        numeric;
  v_unit_active boolean;
begin
  select i.active into v_item_active from items i where i.id = p_item_id;
  if not found or (not v_item_active and not coalesce(p_allow_inactive, false)) then
    raise exception 'ITEM_INVALID';
  end if;
  select u.conversion_rate, u.active into v_rate, v_unit_active
  from item_units u where u.item_id = p_item_id and u.unit_name = p_unit;
  if not found or (not v_unit_active and not coalesce(p_allow_inactive, false)) then
    raise exception 'UNIT_INVALID';
  end if;
  return v_rate;
end;
$$;

-- Contract: returns p_quantity. Raises QUANTITY_INVALID for null, NaN, +/-Infinity, negative,
-- or zero when not allowed. The finite test comes first because NaN > 0 is true in Postgres.
create function app.check_quantity(p_quantity numeric, p_allow_zero boolean) returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if p_quantity is null or not app.is_finite(p_quantity)
     or p_quantity < 0 or (p_quantity = 0 and not coalesce(p_allow_zero, false)) then
    raise exception 'QUANTITY_INVALID';
  end if;
  return p_quantity;
end;
$$;

-- Contract: returns p_cost (null passes through). Raises COST_INVALID for NaN, +/-Infinity or negative.
create function app.check_cost(p_cost numeric) returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if p_cost is not null and (not app.is_finite(p_cost) or p_cost < 0) then
    raise exception 'COST_INVALID';
  end if;
  return p_cost;
end;
$$;

-- Contract: takes the request-id advisory lock, then returns the stored result for the same
-- (rpc_name, user_id, params), null for an unknown request id. Raises REQUEST_ID_REUSED when the
-- id exists with a different rpc name, user or params. jsonb::text is already canonical.
create function app.request_replay(p_request_id uuid, p_rpc_name text, p_user_id uuid, p_params jsonb)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_row  rpc_requests;
  v_hash text := encode(digest(p_rpc_name || ':' || p_params::text, 'sha256'), 'hex');
begin
  perform pg_advisory_xact_lock(hashtextextended('req:' || p_request_id, 0));
  select r.* into v_row from rpc_requests r where r.request_id = p_request_id;
  if v_row.request_id is null then
    return null;
  end if;
  if v_row.rpc_name = p_rpc_name and v_row.user_id = p_user_id and v_row.request_hash = v_hash then
    return v_row.result;
  end if;
  raise exception 'REQUEST_ID_REUSED';
end;
$$;

-- Contract: records the request and returns p_result. With p_secret, also stores a bcrypt
-- verifier that never changes afterwards; the secret itself is stored nowhere.
-- Raises a unique violation if the request id already exists (callers run request_replay first).
create function app.request_store(p_request_id uuid, p_rpc_name text, p_user_id uuid, p_params jsonb,
                                  p_result jsonb, p_secret text default null)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  insert into rpc_requests (request_id, rpc_name, user_id, request_hash, secret_verifier, result)
  values (p_request_id, p_rpc_name, p_user_id,
          encode(digest(p_rpc_name || ':' || p_params::text, 'sha256'), 'hex'),
          case when p_secret is null then null else crypt(p_secret, gen_salt('bf', 10)) end,
          p_result);
  return p_result;
end;
$$;

-- Contract: true when p_secret matches the verifier stored for that request; false for a wrong
-- secret, an unknown request, or a request stored without a secret.
create function app.request_secret_ok(p_request_id uuid, p_secret text) returns boolean
language sql stable security definer
set search_path = app, public, extensions, pg_temp as $$
  select coalesce(
    (select crypt(p_secret, r.secret_verifier) = r.secret_verifier
     from rpc_requests r where r.request_id = p_request_id and r.secret_verifier is not null),
    false)
$$;

-- Contract: appends an activity_log row stamped with clock_timestamp(). Raises nothing of its own.
create function app.log_action(p_user_id uuid, p_action text, p_entity_table text, p_entity_id text,
                               p_details jsonb)
returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  insert into activity_log (at, user_id, action, entity_table, entity_id, details)
  values (clock_timestamp(), p_user_id, p_action, p_entity_table, p_entity_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

-- Contract: maps Arabic-Indic and Persian digits to 0-9; null in, null out.
create function app.normalize_digits(p text) returns text
language sql immutable security definer
set search_path = app, public, extensions, pg_temp as $$
  select translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')
$$;

-- The only helpers clients may call (RLS policies use them).
grant execute on function app.session_ok() to authenticated;
grant execute on function app.my_role() to authenticated;
grant execute on function app.my_branch() to authenticated;
