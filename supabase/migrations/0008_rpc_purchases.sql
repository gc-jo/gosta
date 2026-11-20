-- Purchase RPCs: create_purchase, edit_purchase_line, void_purchase_line.
-- Same lock order as the transfer RPCs: require_role -> request id -> normalise parameters ->
-- request_replay -> locks -> validate against current state -> write -> log_action -> request_store.
-- Owner corrections (edit, void) take only the row lock of the line: they are dated in the past
-- (at the purchase's created_at) and are allowed while the branch is frozen.
-- No function here reads the balances view: balances are shown, never used to block.

-- Hardening of 0005 helpers (follow-up; 0005 itself is not edited).
-- Same signatures, attributes and behaviour as in 0005, plus one rule each: a value above 10^12 is
-- refused. Every quantity and cost any RPC accepts goes through these two helpers, so bounding them
-- keeps "quantity x rate" far from numeric overflow (SQLSTATE 22003) in all RPCs at once, including
-- the frozen transfer RPCs. create or replace keeps the existing (closed) privileges.
create or replace function app.check_quantity(p_quantity numeric, p_allow_zero boolean) returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if p_quantity is null or not app.is_finite(p_quantity)
     or p_quantity < 0 or (p_quantity = 0 and not coalesce(p_allow_zero, false))
     or p_quantity > 1000000000000 then
    raise exception 'QUANTITY_INVALID';
  end if;
  return p_quantity;
end;
$$;

create or replace function app.check_cost(p_cost numeric) returns numeric
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  if p_cost is not null and (not app.is_finite(p_cost) or p_cost < 0 or p_cost > 1000000000000) then
    raise exception 'COST_INVALID';
  end if;
  return p_cost;
end;
$$;

-- Internal, shared by edit and void: changes ONE purchase line. The line row lock is the first thing
-- taken; every value the change is based on is read after it. Unknown line -> FORBIDDEN (existence is
-- not revealed, same convention as an unknown transfer); voided line -> LINE_VOIDED.
--   edit: same unit as stored -> the line's stored unit_rate is kept whatever the catalog says today and
--         whether or not the unit is still active; another unit -> its current active rate, stored on the line.
--         A call that changes nothing writes nothing.
--   void: the line keeps quantity, unit and base_quantity; voided_at / voided_by remove it from stock.
-- Writes one purchase_line_history row (the five values BEFORE the change, numbers as JSON numbers,
-- changed_at = clock_timestamp() after the lock) and one purchase_adjust of (new base - old base; a void
-- is -old base) at the line's branch, dated at the purchase's created_at, none when the difference is 0.
create function app.purchase_line_change(p_line_id uuid, p_action text, p_quantity numeric, p_unit text,
                                         p_cost numeric, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_line     purchase_lines;
  v_p        purchases;
  v_at       timestamptz;
  v_rate     numeric;
  v_new_base numeric;
begin
  if p_action is null or p_action not in ('edit', 'void') then
    raise exception 'FORBIDDEN';
  end if;
  select l.* into v_line from purchase_lines l where l.id = p_line_id for update;
  if v_line.id is null then
    raise exception 'FORBIDDEN';
  end if;
  if v_line.voided_at is not null then
    raise exception 'LINE_VOIDED';
  end if;
  select p.* into v_p from purchases p where p.id = v_line.purchase_id;
  v_at := clock_timestamp();                -- taken after the row lock

  if p_action = 'edit' then
    v_rate := case when p_unit = v_line.unit then v_line.unit_rate
                   else app.unit_rate(v_line.item_id, p_unit) end;
    begin
      v_new_base := p_quantity * v_rate;
    exception when numeric_value_out_of_range then
      raise exception 'QUANTITY_INVALID';
    end;
    if p_quantity = v_line.quantity and p_unit = v_line.unit and p_cost is not distinct from v_line.cost_total then
      return;                               -- nothing changes: no history, no movement
    end if;
  else
    v_new_base := 0;
  end if;

  insert into purchase_line_history (purchase_line_id, changed_by, changed_at, action, old_values)
  values (p_line_id, p_user_id, v_at, p_action, jsonb_build_object(
    'quantity', trim_scale(v_line.quantity), 'unit', v_line.unit, 'unit_rate', trim_scale(v_line.unit_rate),
    'base_quantity', trim_scale(v_line.base_quantity), 'cost_total', trim_scale(v_line.cost_total)));

  if p_action = 'edit' then
    update purchase_lines
    set quantity = p_quantity, unit = p_unit, unit_rate = v_rate, base_quantity = v_new_base, cost_total = p_cost
    where id = p_line_id;
  else
    update purchase_lines set voided_at = v_at, voided_by = p_user_id where id = p_line_id;
  end if;

  if v_new_base - v_line.base_quantity <> 0 then
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_p.branch_id, v_line.item_id, v_new_base - v_line.base_quantity, 'purchase_adjust',
            'purchase_lines', p_line_id, v_p.created_at, p_user_id);
  end if;
end;
$$;

-- create_purchase ------------------------------------------------------------------------------
create function public.create_purchase(p_request_id uuid, p_supplier_id text, p_lines jsonb) returns jsonb
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
  v_branch text := v_user.branch_id;
  v_now    timestamptz;
  v_pid    uuid;
  v_lid    uuid;
  v_rate   numeric;
  v_base   numeric;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'LINES_EMPTY';
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
  v_params := jsonb_build_object('supplier_id', p_supplier_id, 'lines', v_lines);

  v_replay := app.request_replay(p_request_id, 'create_purchase', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  v_now := app.lock_branches(v_branch);
  perform app.require_feature(v_branch, 'purchase');
  perform app.require_not_frozen(v_branch);
  if p_supplier_id is null
     or not exists (select 1 from suppliers s where s.id = p_supplier_id and s.active) then
    raise exception 'SUPPLIER_INVALID';
  end if;

  insert into purchases (request_id, branch_id, supplier_id, created_by, created_at)
  values (p_request_id, v_branch, p_supplier_id, v_user.id, v_now)
  returning id into v_pid;

  for v_e in select e.value from jsonb_array_elements(v_lines) e loop
    v_item := v_e ->> 'item_id';
    v_rate := app.unit_rate(v_item, v_e ->> 'unit');       -- ITEM_INVALID / UNIT_INVALID come first
    if not exists (select 1 from supplier_items si
                   where si.supplier_id = p_supplier_id and si.item_id = v_item and si.active)
       or not exists (select 1 from allowed_local_purchases a
                      where a.branch_id = v_branch and a.item_id = v_item and a.active) then
      raise exception 'ITEM_NOT_ALLOWED';
    end if;
    v_qty := (v_e ->> 'quantity')::numeric;
    begin
      v_base := v_qty * v_rate;
    exception when numeric_value_out_of_range then
      raise exception 'QUANTITY_INVALID';
    end;
    insert into purchase_lines (purchase_id, item_id, quantity, unit, unit_rate, base_quantity, cost_total)
    values (v_pid, v_item, v_qty, v_e ->> 'unit', v_rate, v_base, (v_e ->> 'cost_total')::numeric)
    returning id into v_lid;
    insert into stock_movements (branch_id, item_id, base_quantity, kind, ref_table, ref_id, occurred_at, created_by)
    values (v_branch, v_item, v_base, 'purchase_in', 'purchase_lines', v_lid, v_now, v_user.id);
  end loop;

  v_result := jsonb_build_object('purchase_id', v_pid);
  perform app.log_action(v_user.id, 'create_purchase', 'purchases', v_pid::text,
    jsonb_build_object('supplier_id', p_supplier_id, 'lines', jsonb_array_length(v_lines)));
  return app.request_store(p_request_id, 'create_purchase', v_user.id, v_params, v_result);
end;
$$;

-- edit_purchase_line ---------------------------------------------------------------------------
create function public.edit_purchase_line(p_request_id uuid, p_line_id uuid, p_quantity numeric, p_unit text,
                                          p_cost_total numeric)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user   app_users := app.require_role('owner');
  v_qty    numeric;
  v_cost   numeric;
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  v_qty := trim_scale(app.check_quantity(p_quantity, false));
  if p_unit is null then
    raise exception 'UNIT_INVALID';
  end if;
  v_cost := trim_scale(app.check_cost(p_cost_total));      -- null clears the cost; no scaling on edit
  v_params := jsonb_build_object('line_id', p_line_id, 'quantity', v_qty, 'unit', p_unit, 'cost_total', v_cost);

  v_replay := app.request_replay(p_request_id, 'edit_purchase_line', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  perform app.purchase_line_change(p_line_id, 'edit', v_qty, p_unit, v_cost, v_user.id);

  -- A no-op edit (nothing changed) writes no history and no movement, but it is still a call: it is
  -- logged and its request id is stored (the activity log records calls, not only changes).

  v_result := jsonb_build_object('line_id', p_line_id);
  perform app.log_action(v_user.id, 'edit_purchase_line', 'purchase_lines', p_line_id::text,
    jsonb_build_object('quantity', v_qty, 'unit', p_unit, 'cost_total', v_cost));
  return app.request_store(p_request_id, 'edit_purchase_line', v_user.id, v_params, v_result);
end;
$$;

-- void_purchase_line ---------------------------------------------------------------------------
create function public.void_purchase_line(p_request_id uuid, p_line_id uuid) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user   app_users := app.require_role('owner');
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;
  v_params := jsonb_build_object('line_id', p_line_id);

  v_replay := app.request_replay(p_request_id, 'void_purchase_line', v_user.id, v_params);
  if v_replay is not null then
    return v_replay;
  end if;

  perform app.purchase_line_change(p_line_id, 'void', null, null, null, v_user.id);

  v_result := jsonb_build_object('line_id', p_line_id);
  perform app.log_action(v_user.id, 'void_purchase_line', 'purchase_lines', p_line_id::text, '{}'::jsonb);
  return app.request_store(p_request_id, 'void_purchase_line', v_user.id, v_params, v_result);
end;
$$;

grant execute on function public.create_purchase(uuid, text, jsonb) to authenticated;
grant execute on function public.edit_purchase_line(uuid, uuid, numeric, text, numeric) to authenticated;
grant execute on function public.void_purchase_line(uuid, uuid) to authenticated;
