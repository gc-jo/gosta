-- Transfer RPCs: send_transfer, receive_transfer, owner_resolve_transfer_line.
-- Every RPC follows the lock order of the plan: require_role -> normalise parameters ->
-- request_replay -> read immutable parents -> ONE lock_branches (v_now) -> row locks ordered by id ->
-- validate against current state -> write with v_now -> log_action -> request_store.
-- No function here reads the balances view: balances are shown, never used to block.

-- Internal: text -> numeric that reports a bad value as the given error code, never as a cast error.
-- NaN and Infinity convert fine here; app.check_quantity / app.check_cost reject them afterwards.
create function app.safe_numeric(p_text text, p_code text) returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if p_text is null then
    return null;
  end if;
  return p_text::numeric;
exception when data_exception then
  raise exception '%', p_code;
end;
$$;

-- Internal: text -> uuid, null when the text is not a uuid.
create function app.safe_uuid(p_text text) returns uuid
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  return p_text::uuid;
exception when data_exception then
  return null;
end;
$$;

-- Internal, shared by receive_transfer and the owner's accept / edit_accept: receives ONE pending
-- line. The caller already holds the destination branch lock (p_now comes from it) and the row lock
-- on the line. Same unit as sent -> the line's stored unit_rate (whatever the catalog says today);
-- another unit -> its current active rate. Writes the final line state, transfer_in at the
-- destination (none when 0) and transfer_adjust at the source (none when 0) dated at the send time.
create function app.receive_transfer_line(p_line_id uuid, p_quantity numeric, p_unit text, p_diff_reason text,
                                          p_note text, p_user_id uuid, p_now timestamptz, p_by_owner boolean)
returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_line  transfer_lines;
  v_t     transfers;
  v_rate  numeric;
  v_rbase numeric;
  v_diff  boolean;
  v_cost  numeric;
begin
  select l.* into v_line from transfer_lines l where l.id = p_line_id;
  if v_line.id is null or v_line.status <> 'pending' then
    raise exception 'LINE_NOT_PENDING';
  end if;
  select t.* into v_t from transfers t where t.id = v_line.transfer_id;

  v_rate := case when p_unit = v_line.unit then v_line.unit_rate
                 else app.unit_rate(v_line.item_id, p_unit) end;
  v_rbase := p_quantity * v_rate;
  v_diff := v_rbase <> v_line.base_quantity;
  if v_diff and (p_diff_reason is null or p_diff_reason not in ('overloaded', 'count_error', 'not_loaded')) then
    raise exception 'DIFF_REASON_REQUIRED';
  end if;
  -- an unchanged quantity keeps the cost exactly; a changed one is scaled and rounded to 3 places
  v_cost := case when v_line.cost_total is not null and v_diff
                 then round(v_line.cost_total * v_rbase / v_line.base_quantity, 3)
                 else v_line.cost_total end;

  update transfer_lines
  set status = 'received', received_quantity = p_quantity, received_unit = p_unit,
      received_unit_rate = v_rate, received_base_quantity = p_quantity * v_rate,
      diff_reason = case when v_diff then p_diff_reason else null end,
      note = p_note, cost_total = v_cost,
      resolved_by = p_user_id, resolved_at = p_now, resolved_by_owner = p_by_owner
  where id = p_line_id;

  if v_rbase > 0 then
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_t.to_branch, v_line.item_id, v_rbase, 'transfer_in', 'transfer_lines', p_line_id, p_now, p_user_id);
  end if;
  if v_line.base_quantity - v_rbase <> 0 then
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_t.from_branch, v_line.item_id, v_line.base_quantity - v_rbase, 'transfer_adjust',
            'transfer_lines', p_line_id, v_t.created_at, p_user_id);
  end if;
end;
$$;

-- send_transfer --------------------------------------------------------------------------------
create function public.send_transfer(p_request_id uuid, p_to_branch text, p_lines jsonb) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user   app_users := app.require_role('manager', 'distributor');
  v_lines  jsonb := '[]'::jsonb;
  v_e      jsonb;
  v_item   text;
  v_unit   text;
  v_qty    numeric;
  v_cost   numeric;
  v_params jsonb;
  v_replay jsonb;
  v_from   text := v_user.branch_id;
  v_now    timestamptz;
  v_tid    uuid;
  v_lid    uuid;
  v_rate   numeric;
  v_result jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'LINES_EMPTY';
  end if;
  if p_to_branch is null then
    raise exception 'BRANCH_INVALID';
  end if;
  -- rebuild the lines from typed, normalised values: 2, 2.0 and 2.00 hash the same; unknown keys are dropped
  for v_e in select e.value from jsonb_array_elements(p_lines) e loop
    if jsonb_typeof(v_e) <> 'object' then
      raise exception 'ITEM_INVALID';
    end if;
    v_item := v_e ->> 'item_id';
    if v_item is null then raise exception 'ITEM_INVALID'; end if;
    v_unit := v_e ->> 'unit';
    if v_unit is null then raise exception 'UNIT_INVALID'; end if;
    v_qty := trim_scale(app.check_quantity(app.safe_numeric(v_e ->> 'quantity', 'QUANTITY_INVALID'), false));
    v_cost := trim_scale(app.check_cost(app.safe_numeric(v_e ->> 'cost_total', 'COST_INVALID')));
    if v_cost is null and v_user.role = 'distributor' then
      raise exception 'COST_REQUIRED';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'item_id', v_item, 'unit', v_unit, 'quantity', v_qty, 'cost_total', v_cost));
  end loop;
  v_params := jsonb_build_object('to_branch', p_to_branch, 'lines', v_lines);

  v_replay := app.request_replay(p_request_id, 'send_transfer', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  v_now := app.lock_branches(v_from);          -- the destination is neither frozen-checked nor changed
  perform app.require_feature(v_from, 'send');
  perform app.require_not_frozen(v_from);
  if p_to_branch = v_from
     or not exists (select 1 from branches b where b.id = p_to_branch and b.active) then
    raise exception 'BRANCH_INVALID';
  end if;

  insert into transfers (request_id, from_branch, to_branch, created_by, created_at)
  values (p_request_id, v_from, p_to_branch, v_user.id, v_now)
  returning id into v_tid;

  for v_e in select e.value from jsonb_array_elements(v_lines) e loop
    v_rate := app.unit_rate(v_e ->> 'item_id', v_e ->> 'unit');
    v_qty := (v_e ->> 'quantity')::numeric;
    insert into transfer_lines (transfer_id, item_id, quantity, unit, unit_rate, base_quantity, cost_total)
    values (v_tid, v_e ->> 'item_id', v_qty, v_e ->> 'unit', v_rate, v_qty * v_rate,
            (v_e ->> 'cost_total')::numeric)
    returning id into v_lid;
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_from, v_e ->> 'item_id', -(v_qty * v_rate), 'transfer_out', 'transfer_lines', v_lid, v_now, v_user.id);
  end loop;

  v_result := jsonb_build_object('transfer_id', v_tid);
  perform app.log_action(v_user.id, 'send_transfer', 'transfers', v_tid::text,
    jsonb_build_object('to_branch', p_to_branch, 'lines', jsonb_array_length(v_lines)));
  return app.request_store(p_request_id, 'send_transfer', v_user.id, v_params, v_result);
end;
$$;

-- receive_transfer -----------------------------------------------------------------------------
create function public.receive_transfer(p_request_id uuid, p_transfer_id uuid, p_lines jsonb) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user    app_users := app.require_role('manager', 'distributor');
  v_lines   jsonb := '[]'::jsonb;
  v_e       jsonb;
  v_lid     uuid;
  v_unit    text;
  v_qty     numeric;
  v_reason  text;
  v_params  jsonb;
  v_replay  jsonb;
  v_t       transfers;
  v_now     timestamptz;
  v_pending uuid[];
  v_given   uuid[];
  v_n       int := 0;
  v_result  jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'LINES_EMPTY';
  end if;
  for v_e in select e.value from jsonb_array_elements(p_lines) e loop
    if jsonb_typeof(v_e) <> 'object' then
      raise exception 'LINES_INCOMPLETE';
    end if;
    v_lid := app.safe_uuid(v_e ->> 'line_id');
    if v_lid is null then raise exception 'LINES_INCOMPLETE'; end if;
    v_unit := v_e ->> 'unit';
    if v_unit is null then raise exception 'UNIT_INVALID'; end if;
    v_qty := trim_scale(app.check_quantity(app.safe_numeric(v_e ->> 'quantity', 'QUANTITY_INVALID'), true));
    v_reason := v_e ->> 'diff_reason';
    if v_reason is not null and v_reason not in ('overloaded', 'count_error', 'not_loaded') then
      raise exception 'DIFF_REASON_REQUIRED';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_id', v_lid, 'quantity', v_qty, 'unit', v_unit, 'diff_reason', v_reason,
      'note', nullif(btrim(v_e ->> 'note'), '')));
  end loop;
  v_params := jsonb_build_object('transfer_id', p_transfer_id, 'lines', v_lines);

  v_replay := app.request_replay(p_request_id, 'receive_transfer', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  -- from_branch / to_branch never change, so reading them before the lock is safe
  select t.* into v_t from transfers t where t.id = p_transfer_id;
  if v_t.id is null or v_user.branch_id is distinct from v_t.to_branch then
    raise exception 'FORBIDDEN';
  end if;

  v_now := app.lock_branches(v_t.to_branch);
  perform app.require_feature(v_t.to_branch, 'receive');
  perform app.require_not_frozen(v_t.to_branch);

  perform 1 from transfer_lines l where l.transfer_id = p_transfer_id order by l.id for update;
  select coalesce(array_agg(l.id order by l.id), '{}'::uuid[]) into v_pending
  from transfer_lines l where l.transfer_id = p_transfer_id and l.status = 'pending';
  if cardinality(v_pending) = 0 then
    raise exception 'LINE_NOT_PENDING';
  end if;
  select coalesce(array_agg((e.value ->> 'line_id')::uuid order by (e.value ->> 'line_id')::uuid), '{}'::uuid[])
  into v_given from jsonb_array_elements(v_lines) e;
  if v_given is distinct from v_pending then      -- duplicates, unknown or missing ids
    raise exception 'LINES_INCOMPLETE';
  end if;

  for v_e in select e.value from jsonb_array_elements(v_lines) e order by (e.value ->> 'line_id')::uuid loop
    perform app.receive_transfer_line((v_e ->> 'line_id')::uuid, (v_e ->> 'quantity')::numeric, v_e ->> 'unit',
                                      v_e ->> 'diff_reason', v_e ->> 'note', v_user.id, v_now, false);
    v_n := v_n + 1;
  end loop;

  v_result := jsonb_build_object('transfer_id', p_transfer_id, 'received', v_n);
  perform app.log_action(v_user.id, 'receive_transfer', 'transfers', p_transfer_id::text,
    jsonb_build_object('lines', v_n));
  return app.request_store(p_request_id, 'receive_transfer', v_user.id, v_params, v_result);
end;
$$;

-- owner_resolve_transfer_line ------------------------------------------------------------------
create function public.owner_resolve_transfer_line(p_request_id uuid, p_line_id uuid, p_action text,
                                                   p_quantity numeric default null, p_unit text default null)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user     app_users := app.require_role('owner');
  v_qty      numeric;
  v_unit     text;
  v_params   jsonb;
  v_replay   jsonb;
  v_tid      uuid;
  v_t        transfers;
  v_line     transfer_lines;
  v_now      timestamptz;
  v_rate     numeric;
  v_new_base numeric;
  v_status   text;
begin
  -- A bad action is a programming error of the caller, not a state problem: FORBIDDEN.
  -- (No new error code is introduced for it.)
  if p_action is null or p_action not in ('accept', 'deny', 'edit_accept') then
    raise exception 'FORBIDDEN';
  end if;
  if p_action = 'edit_accept' then
    v_qty := trim_scale(app.check_quantity(p_quantity, false));
    if p_unit is null then raise exception 'UNIT_INVALID'; end if;
    v_unit := p_unit;
  end if;                                   -- accept / deny ignore quantity and unit
  v_params := jsonb_build_object('line_id', p_line_id, 'action', p_action, 'quantity', v_qty, 'unit', v_unit);

  v_replay := app.request_replay(p_request_id, 'owner_resolve_transfer_line', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  select l.transfer_id into v_tid from transfer_lines l where l.id = p_line_id;   -- immutable
  if v_tid is null then
    raise exception 'LINE_NOT_PENDING';
  end if;
  select t.* into v_t from transfers t where t.id = v_tid;

  if p_action = 'deny' then
    v_now := clock_timestamp();             -- no branch lock: nothing is dated "now" in a branch's stock
    select l.* into v_line from transfer_lines l where l.id = p_line_id for update;
    if v_line.status <> 'pending' then
      raise exception 'LINE_NOT_PENDING';
    end if;
    update transfer_lines
    set status = 'denied', resolved_by = v_user.id, resolved_at = v_now, resolved_by_owner = true
    where id = p_line_id;
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_t.from_branch, v_line.item_id, v_line.base_quantity, 'transfer_adjust', 'transfer_lines',
            p_line_id, v_t.created_at, v_user.id);
    v_status := 'denied';
  else
    v_now := app.lock_branches(v_t.to_branch);
    perform app.require_not_frozen(v_t.to_branch);
    select l.* into v_line from transfer_lines l where l.id = p_line_id for update;
    if v_line.status <> 'pending' then
      raise exception 'LINE_NOT_PENDING';
    end if;
    if p_action = 'edit_accept' then
      -- edit conversion rule: same unit keeps the stored rate; another unit uses its current active rate
      v_rate := case when v_unit = v_line.unit then v_line.unit_rate
                     else app.unit_rate(v_line.item_id, v_unit) end;
      v_new_base := v_qty * v_rate;
      if v_new_base <> v_line.base_quantity then
        insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
        values (v_t.from_branch, v_line.item_id, v_line.base_quantity - v_new_base, 'transfer_adjust',
                'transfer_lines', p_line_id, v_t.created_at, v_user.id);
      end if;
      update transfer_lines
      set quantity = v_qty, unit = v_unit, unit_rate = v_rate, base_quantity = v_qty * v_rate,
          cost_total = case when cost_total is not null and v_new_base <> base_quantity
                            then round(cost_total * v_new_base / base_quantity, 3) else cost_total end
      where id = p_line_id;
      v_line.quantity := v_qty;
      v_line.unit := v_unit;
    end if;
    perform app.receive_transfer_line(p_line_id, v_line.quantity, v_line.unit, null, null, v_user.id, v_now, true);
    v_status := 'received';
  end if;

  perform app.log_action(v_user.id, 'owner_resolve_transfer_line', 'transfer_lines', p_line_id::text,
    jsonb_build_object('action', p_action, 'transfer_id', v_tid));
  return app.request_store(p_request_id, 'owner_resolve_transfer_line', v_user.id, v_params,
    jsonb_build_object('line_id', p_line_id, 'status', v_status));
end;
$$;

grant execute on function public.send_transfer(uuid, text, jsonb) to authenticated;
grant execute on function public.receive_transfer(uuid, uuid, jsonb) to authenticated;
grant execute on function public.owner_resolve_transfer_line(uuid, uuid, text, numeric, text) to authenticated;
