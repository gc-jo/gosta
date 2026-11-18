-- Task 8: explicit start is the only count creation/freeze entry point.
-- Request lock -> branch lock -> count/line locks; all freeze stamps come
-- from lock_branches. Task 9's submit/review/zero RPCs are deliberately absent.
create function public.open_count_window(p_request_id uuid, p_branch_id text, p_period_month date)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_branch text := nullif(btrim(p_branch_id), '');
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_now timestamptz;
  v_status text;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  v_params := jsonb_build_object('branch_id', v_branch, 'period_month', p_period_month);
  v_replay := app.request_replay(p_request_id, 'open_count_window', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  v_now := app.lock_branches(v_branch);
  if p_period_month is null or not isfinite(p_period_month) or extract(day from p_period_month) <> 1
     or not exists (select 1 from branches b where b.id = v_branch and b.active) then
    raise exception 'BRANCH_INVALID';
  end if;
  select w.status into v_status from count_windows w
  where w.branch_id = v_branch and w.period_month = p_period_month for update;
  if v_status = 'open' then raise exception 'WINDOW_EXISTS'; end if;
  insert into count_windows (branch_id, period_month, status, opened_by, opened_at)
  values (v_branch, p_period_month, 'open', v_owner.id, v_now)
  on conflict (branch_id, period_month) do update
    set status = 'open', opened_by = excluded.opened_by, opened_at = excluded.opened_at,
        closed_by = null, closed_at = null;
  v_result := jsonb_build_object('branch_id', v_branch, 'period_month', p_period_month);
  perform app.log_action(v_owner.id, 'open_count_window', 'count_windows', v_branch, v_params);
  return app.request_store(p_request_id, 'open_count_window', v_owner.id, v_params, v_result);
end;
$$;

create function public.close_count_window(p_request_id uuid, p_branch_id text, p_period_month date)
returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_branch text := nullif(btrim(p_branch_id), '');
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_now timestamptz;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  v_params := jsonb_build_object('branch_id', v_branch, 'period_month', p_period_month);
  v_replay := app.request_replay(p_request_id, 'close_count_window', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  v_now := app.lock_branches(v_branch);
  perform 1 from count_windows w
  where w.branch_id = v_branch and w.period_month = p_period_month for update;
  update count_windows set status = 'closed', closed_by = v_owner.id, closed_at = v_now
  where branch_id = v_branch and period_month = p_period_month and status <> 'closed';
  v_result := jsonb_build_object('branch_id', v_branch, 'period_month', p_period_month);
  perform app.log_action(v_owner.id, 'close_count_window', 'count_windows', v_branch, v_params);
  return app.request_store(p_request_id, 'close_count_window', v_owner.id, v_params, v_result);
end;
$$;

create function public.start_count(p_request_id uuid) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users := app.require_role('manager', 'distributor');
  v_params jsonb := jsonb_build_object();
  v_replay jsonb;
  v_result jsonb;
  v_now timestamptz;
  v_count counts;
  v_month date;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  v_replay := app.request_replay(p_request_id, 'start_count', v_user.id, v_params);
  if v_replay is not null then return v_replay; end if;
  v_now := app.lock_branches(v_user.branch_id);
  perform app.require_feature(v_user.branch_id, 'count');
  select c.* into v_count from counts c
  where c.branch_id = v_user.branch_id and c.status in ('draft', 'returned')
  order by c.id limit 1 for update;
  if found then
    if v_count.status = 'returned' and v_count.frozen_since is null then
      update counts set frozen_since = v_now where id = v_count.id returning * into v_count;
    end if;
  else
    select w.period_month into v_month from count_windows w
    where w.branch_id = v_user.branch_id and w.status = 'open'
    order by w.period_month desc limit 1 for update;
    if not found then raise exception 'WINDOW_CLOSED'; end if;
    perform 1 from counts c where c.branch_id = v_user.branch_id and c.period_month = v_month
    order by c.id for update;
    if found then raise exception 'COUNT_LOCKED'; end if;
    insert into counts (branch_id, period_month, frozen_since)
    values (v_user.branch_id, v_month, v_now) returning * into v_count;
    insert into count_lines (count_id, item_id)
    select v_count.id, i.id from items i where i.active and i.counted order by i.id;
  end if;
  v_result := jsonb_build_object('count_id', v_count.id, 'frozen_since', v_count.frozen_since, 'revision', v_count.revision);
  perform app.log_action(v_user.id, 'start_count', 'counts', v_count.id::text, v_params);
  return app.request_store(p_request_id, 'start_count', v_user.id, v_params, v_result);
end;
$$;

create function public.save_count_line(p_count_id uuid, p_item_id text, p_expected_revision int,
  p_state text, p_entries jsonb) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_user app_users := app.require_role('manager', 'distributor');
  v_item_id text := nullif(btrim(p_item_id), '');
  v_state text := nullif(btrim(p_state), '');
  v_branch text;
  v_count counts;
  v_line count_lines;
  v_item items;
  v_entry jsonb;
  v_weight jsonb;
  v_packs jsonb;
  v_entries jsonb;
  v_unit text;
  v_seen_units text[] := '{}';
  v_seen_containers text[] := '{}';
  v_container item_containers;
  v_qty numeric;
  v_rate numeric;
  v_closed numeric;
  v_open numeric;
  v_closed_confirm numeric;
  v_open_confirm numeric;
  v_grams numeric;
  v_tare numeric;
  v_total numeric := 0;
  v_calc jsonb := '[]';
  v_counted int;
  v_line_total int;
begin
  -- This first read locates the branch only. All mutable count state is read
  -- again under its row lock, after the branch lock protecting its freeze.
  select c.branch_id into v_branch from counts c where c.id = p_count_id;
  perform app.lock_branches(v_branch);
  select c.* into v_count from counts c where c.id = p_count_id for update;
  if not found then raise exception 'COUNT_NOT_OPEN'; end if;
  if v_count.branch_id <> v_user.branch_id then raise exception 'FORBIDDEN'; end if;
  if v_count.status not in ('draft', 'returned') then raise exception 'COUNT_LOCKED'; end if;
  if v_count.frozen_since is null then raise exception 'COUNT_NOT_STARTED'; end if;
  select l.* into v_line from count_lines l
  where l.count_id = p_count_id and l.item_id = v_item_id for update;
  if not found then raise exception 'ITEM_INVALID'; end if;
  if v_count.status = 'returned' and not v_line.needs_recount then raise exception 'COUNT_LOCKED'; end if;
  if p_expected_revision is distinct from v_line.revision then raise exception 'STALE_WRITE'; end if;
  if v_state is null or v_state not in ('counted', 'none', 'uncounted') then raise exception 'ENTRIES_INVALID'; end if;
  select i.* into v_item from items i where i.id = v_item_id;
  if v_state = 'none' then
    if p_entries is not null and p_entries <> '[]'::jsonb then raise exception 'ENTRIES_INVALID'; end if;
    v_entries := '[]';
  elsif v_state = 'uncounted' then
    v_entries := '{}';
    v_total := null;
  else
    v_entries := p_entries;
    if v_item.count_method = 'units' then
      if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'ENTRIES_INVALID'; end if;
      if jsonb_array_length(p_entries) = 0 then raise exception 'ENTRIES_INVALID'; end if;
      v_packs := p_entries;
    else
      if jsonb_typeof(p_entries) is distinct from 'object'
         or jsonb_typeof(p_entries->'packs') is distinct from 'array'
         or jsonb_typeof(p_entries->'containers') is distinct from 'array' then
        raise exception 'ENTRIES_INVALID';
      end if;
      if jsonb_array_length(p_entries->'containers') = 0 then raise exception 'ENTRIES_INVALID'; end if;
      v_packs := p_entries->'packs';
    end if;
    for v_entry in select value from jsonb_array_elements(v_packs) loop
      if jsonb_typeof(v_entry) is distinct from 'object'
         or jsonb_typeof(v_entry->'unit') is distinct from 'string' then raise exception 'ENTRIES_INVALID'; end if;
      v_unit := v_entry->>'unit';
      if v_unit = any(v_seen_units) or not exists (
        select 1 from item_units u where u.item_id = v_item_id and u.unit_name = v_unit and u.active and u.count_visible
      ) then raise exception 'ENTRIES_INVALID'; end if;
      v_seen_units := array_append(v_seen_units, v_unit);
      begin
        v_qty := app.check_quantity(app.safe_numeric(v_entry->>'quantity', 'ENTRIES_INVALID'), true);
      exception when sqlstate 'P0001' then
        if sqlerrm = 'QUANTITY_INVALID' then raise exception 'ENTRIES_INVALID'; end if;
        raise;
      end;
      if v_qty <> trunc(v_qty) then raise exception 'ENTRIES_INVALID'; end if;
      v_rate := app.check_quantity(app.unit_rate(v_item_id, v_unit, true), false);
      if v_item.count_method = 'units' then
        v_total := v_total + v_qty * v_rate;
        v_calc := v_calc || jsonb_build_array(jsonb_build_object('unit', v_unit, 'rate', v_rate));
      end if;
    end loop;
    if v_item.count_method = 'containers' then
      for v_entry in select value from jsonb_array_elements(p_entries->'containers') loop
        if jsonb_typeof(v_entry) is distinct from 'object'
           or jsonb_typeof(v_entry->'container_id') is distinct from 'string' then raise exception 'CONTAINER_INVALID'; end if;
        select c.* into v_container from item_containers c
        where c.id = v_entry->>'container_id' and c.item_id = v_item_id and c.active;
        if not found or v_container.id = any(v_seen_containers) then raise exception 'CONTAINER_INVALID'; end if;
        v_seen_containers := array_append(v_seen_containers, v_container.id);
        begin
          v_closed := app.check_quantity(app.safe_numeric(v_entry->>'closed', 'ENTRIES_INVALID'), true);
          v_open := app.check_quantity(app.safe_numeric(v_entry->>'open', 'ENTRIES_INVALID'), true);
          v_closed_confirm := app.check_quantity(app.safe_numeric(v_entry->>'closed_confirm', 'ENTRIES_INVALID'), true);
          v_open_confirm := app.check_quantity(app.safe_numeric(v_entry->>'open_confirm', 'ENTRIES_INVALID'), true);
        exception when sqlstate 'P0001' then
          if sqlerrm = 'QUANTITY_INVALID' then raise exception 'ENTRIES_INVALID'; end if;
          raise;
        end;
        if v_closed <> trunc(v_closed) or v_open <> trunc(v_open)
           or v_closed <> v_closed_confirm or v_open <> v_open_confirm
           or jsonb_typeof(v_entry->'weights') is distinct from 'array' then raise exception 'ENTRIES_INVALID'; end if;
        if jsonb_array_length(v_entry->'weights') <> v_open then raise exception 'ENTRIES_INVALID'; end if;
        for v_weight in select value from jsonb_array_elements(v_entry->'weights') loop
          if jsonb_typeof(v_weight) is distinct from 'object'
             or not coalesce((v_weight->>'variant') = any(v_container.variants), false) then
            raise exception 'CONTAINER_INVALID';
          end if;
          begin
            v_grams := app.check_quantity(app.safe_numeric(v_weight->>'grams', 'WEIGHT_INVALID'), false);
          exception when sqlstate 'P0001' then
            if sqlerrm = 'QUANTITY_INVALID' then raise exception 'WEIGHT_INVALID'; end if;
            raise;
          end;
          select t.tare_grams into v_tare from container_tares t
          where t.container_id = v_container.id and t.variant = v_weight->>'variant';
          if v_tare is not null and v_grams < app.check_quantity(v_tare, false) then raise exception 'WEIGHT_BELOW_TARE'; end if;
        end loop;
      end loop;
    end if;
  end if;
  update count_lines
  set state = v_state, entries = v_entries, revision = revision + 1,
      -- Satisfy quantity_state while compute_count_line fills a containers line.
      base_quantity = case when v_state = 'counted' and v_item.count_method = 'containers' then null else v_total end,
      pending_setup = (v_state = 'counted' and v_item.count_method = 'containers'),
      calc = case when v_state = 'counted' and v_item.count_method = 'units'
                  then jsonb_build_object('packs', v_calc) else null end
  where count_id = p_count_id and item_id = v_item_id;
  if v_state = 'counted' and v_item.count_method = 'containers' then
    perform app.compute_count_line(p_count_id, v_item_id);
  end if;
  update counts set revision = revision + 1 where id = p_count_id returning * into v_count;
  select l.* into v_line from count_lines l where l.count_id = p_count_id and l.item_id = v_item_id;
  select count(*) filter (where l.state <> 'uncounted'), count(*) into v_counted, v_line_total
  from count_lines l where l.count_id = p_count_id;
  perform app.log_action(v_user.id, 'save_count_line', 'counts', p_count_id::text,
    jsonb_build_object('item_id', v_item_id, 'state', v_state, 'line_revision', v_line.revision));
  return jsonb_build_object('base_quantity', v_line.base_quantity, 'line_revision', v_line.revision,
    'count_revision', v_count.revision, 'counted', v_counted, 'total', v_line_total, 'pending_setup', v_line.pending_setup);
end;
$$;

create function public.discard_count(p_request_id uuid, p_count_id uuid) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_branch text;
  v_count counts;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  v_params := jsonb_build_object('count_id', p_count_id);
  v_replay := app.request_replay(p_request_id, 'discard_count', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  select c.branch_id into v_branch from counts c where c.id = p_count_id;
  perform app.lock_branches(v_branch);
  select c.* into v_count from counts c where c.id = p_count_id for update;
  if not found or v_count.status not in ('draft', 'returned') then raise exception 'COUNT_NOT_OPEN'; end if;
  perform 1 from count_lines l where l.count_id = p_count_id order by l.item_id for update;
  delete from count_lines where count_id = p_count_id;
  delete from counts where id = p_count_id;
  v_result := jsonb_build_object('count_id', p_count_id);
  perform app.log_action(v_owner.id, 'discard_count', 'counts', p_count_id::text, v_params);
  return app.request_store(p_request_id, 'discard_count', v_owner.id, v_params, v_result);
end;
$$;

revoke all on function public.open_count_window(uuid, text, date) from public, anon, authenticated;
revoke all on function public.close_count_window(uuid, text, date) from public, anon, authenticated;
revoke all on function public.start_count(uuid) from public, anon, authenticated;
revoke all on function public.save_count_line(uuid, text, int, text, jsonb) from public, anon, authenticated;
revoke all on function public.discard_count(uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_count_window(uuid, text, date) to authenticated;
grant execute on function public.close_count_window(uuid, text, date) to authenticated;
grant execute on function public.start_count(uuid) to authenticated;
grant execute on function public.save_count_line(uuid, text, int, text, jsonb) to authenticated;
grant execute on function public.discard_count(uuid, uuid) to authenticated;
