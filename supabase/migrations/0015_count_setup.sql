-- Count setup (spec 8.1). No count lifecycle RPCs are introduced here.
alter table items
  add column counted boolean not null default true,
  add column count_method text not null default 'units',
  add column net_grams_per_base_unit numeric null,
  add constraint items_count_method_valid check (count_method in ('units', 'containers')),
  add constraint items_net_grams_per_base_unit_positive check (net_grams_per_base_unit > 0),
  add constraint items_net_grams_per_base_unit_finite check (app.is_finite(net_grams_per_base_unit));
alter table item_units add column count_visible boolean not null default true;

create table item_containers (
  id                    text primary key,
  item_id               text not null references items (id),
  name_ar               text not null,
  content_base_quantity numeric null,
  variants              text[] not null default '{default}',
  active                boolean not null default true,
  constraint item_containers_id_not_blank check (btrim(id) <> ''),
  constraint item_containers_name_ar_not_blank check (btrim(name_ar) <> ''),
  constraint item_containers_content_base_quantity_positive check (content_base_quantity > 0),
  constraint item_containers_content_base_quantity_finite check (app.is_finite(content_base_quantity)),
  constraint item_containers_variants_valid check (
    cardinality(variants) > 0 and array_ndims(variants) = 1
    and array_position(variants, null) is null
    and variants <@ array['default','glass_pump','glass_cap','plastic_pump','plastic_cap'])
);
create index item_containers_item_id_idx on item_containers (item_id);

create table container_tares (
  container_id text not null references item_containers (id),
  variant      text not null,
  tare_grams   numeric not null,
  updated_by   uuid null references app_users (id),
  updated_at   timestamptz not null default clock_timestamp(),
  constraint container_tares_pk primary key (container_id, variant),
  constraint container_tares_tare_grams_positive check (tare_grams > 0),
  constraint container_tares_tare_grams_finite check (app.is_finite(tare_grams))
);

create function app.check_container_tare_variant() returns trigger
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
begin
  perform 1 from item_containers c
  where c.id = new.container_id and new.variant = any(c.variants) for share;
  if not found then
    raise exception 'CONTAINER_INVALID';
  end if;
  return new;
end;
$$;
create trigger container_tares_variant_valid before insert or update on container_tares
  for each row execute function app.check_container_tare_variant();

alter table count_lines
  add column pending_setup boolean not null default false,
  add column calc jsonb null,
  drop constraint count_lines_uncounted_has_no_quantity,
  add constraint count_lines_quantity_state check (
    case state
      when 'uncounted' then base_quantity is null and not pending_setup
      when 'none' then base_quantity is not null and base_quantity = 0 and not pending_setup
      when 'counted' then (base_quantity is null) = pending_setup
      else false
    end);

alter table item_containers enable row level security;
alter table container_tares enable row level security;
revoke all on item_containers, container_tares from public, anon, authenticated;
grant select on items, item_units, item_containers, container_tares to authenticated;
create policy item_containers_select on item_containers for select to authenticated
  using ((select app.session_ok()));
create policy container_tares_select on container_tares for select to authenticated
  using ((select app.session_ok()) and (select app.my_role()) = 'owner');
-- calc contains empty weights. A table-wide SELECT would expose them through
-- count_lines even though container_tares itself is owner-only.
revoke select on count_lines from authenticated;
grant select (count_id, item_id, state, entries, base_quantity, needs_recount,
              revision, effective_at, pending_setup) on count_lines to authenticated;

-- Recompute only mutable containers lines. The parent lock also serializes with
-- future saves/reviews; approved records and all entered values stay untouched.
create function app.compute_count_line(p_count_id uuid, p_item_id text) returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_status text;
  v_line count_lines;
  v_item items;
  v_entry jsonb;
  v_weight jsonb;
  v_weight_index bigint;
  v_container item_containers;
  v_quantity numeric;
  v_rate numeric;
  v_closed numeric;
  v_open numeric;
  v_grams numeric;
  v_tare numeric;
  v_factor numeric;
  v_total numeric := 0;
  v_pending boolean := false;
  v_packs jsonb := '[]';
  v_containers jsonb := '[]';
  v_tares jsonb;
  v_problems jsonb := '[]';
begin
  select c.status into v_status from counts c where c.id = p_count_id for update;
  if not found then raise exception 'COUNT_NOT_OPEN'; end if;
  if v_status = 'approved' then return; end if;
  select l.* into v_line from count_lines l
  where l.count_id = p_count_id and l.item_id = p_item_id for update;
  if not found or v_line.state <> 'counted' then return; end if;
  select i.* into v_item from items i where i.id = p_item_id;
  if v_item.count_method <> 'containers' then return; end if;
  if v_item.net_grams_per_base_unit is null then
    v_pending := true;
  else
    v_factor := app.check_quantity(v_item.net_grams_per_base_unit, false);
  end if;
  if jsonb_typeof(v_line.entries) is distinct from 'object'
     or jsonb_typeof(v_line.entries->'packs') is distinct from 'array'
     or jsonb_typeof(v_line.entries->'containers') is distinct from 'array'
     or jsonb_array_length(v_line.entries->'containers') = 0 then
    raise exception 'ENTRIES_INVALID';
  end if;
  for v_entry in select value from jsonb_array_elements(v_line.entries->'packs') loop
    v_quantity := app.check_quantity(app.safe_numeric(v_entry->>'quantity', 'QUANTITY_INVALID'), true);
    if v_quantity <> trunc(v_quantity) then raise exception 'ENTRIES_INVALID'; end if;
    -- A previously saved entry can still use a unit that is now inactive.
    v_rate := app.check_quantity(app.unit_rate(p_item_id, v_entry->>'unit', true), false);
    v_total := v_total + v_quantity * v_rate;
    v_packs := v_packs || jsonb_build_array(jsonb_build_object('unit', v_entry->>'unit', 'rate', v_rate));
  end loop;
  for v_entry in select value from jsonb_array_elements(v_line.entries->'containers') loop
    select c.* into v_container from item_containers c
    where c.id = v_entry->>'container_id' and c.item_id = p_item_id;
    if not found then raise exception 'CONTAINER_INVALID'; end if;
    v_closed := app.check_quantity(app.safe_numeric(v_entry->>'closed', 'QUANTITY_INVALID'), true);
    v_open := app.check_quantity(app.safe_numeric(v_entry->>'open', 'QUANTITY_INVALID'), true);
    if v_closed <> trunc(v_closed) or v_open <> trunc(v_open)
       or jsonb_typeof(v_entry->'weights') is distinct from 'array' then
      raise exception 'ENTRIES_INVALID';
    end if;
    if jsonb_array_length(v_entry->'weights') <> v_open then raise exception 'ENTRIES_INVALID'; end if;
    if v_container.content_base_quantity is null then
      v_pending := true;
    else
      v_total := v_total + v_closed * app.check_quantity(v_container.content_base_quantity, false);
    end if;
    v_tares := '{}';
    -- Zero-based indexes identify the original reading without rewriting it.
    for v_weight, v_weight_index in
      select value, ordinality - 1 from jsonb_array_elements(v_entry->'weights') with ordinality
    loop
      if jsonb_typeof(v_weight) is distinct from 'object'
         or jsonb_typeof(v_weight->'variant') is distinct from 'string' then
        raise exception 'ENTRIES_INVALID';
      end if;
      begin
        v_grams := app.check_quantity(app.safe_numeric(v_weight->>'grams', 'WEIGHT_INVALID'), false);
      exception when sqlstate 'P0001' then
        if sqlerrm = 'QUANTITY_INVALID' then raise exception 'WEIGHT_INVALID'; end if;
        raise;
      end;
      -- A valid saved reading can become incompatible with newer setup. Keep
      -- that conflict pending for review instead of refusing the setup change.
      if not ((v_weight->>'variant') = any(v_container.variants)) then
        v_pending := true;
        v_problems := v_problems || jsonb_build_array(jsonb_build_object(
          'container_id', v_container.id, 'weight_index', v_weight_index, 'reason', 'variant_removed'));
        continue;
      end if;
      select t.tare_grams into v_tare from container_tares t
      where t.container_id = v_container.id and t.variant = v_weight->>'variant';
      if v_tare is null then
        v_pending := true;
      else
        v_tare := app.check_quantity(v_tare, false);
        if v_grams < v_tare then
          v_pending := true;
          v_problems := v_problems || jsonb_build_array(jsonb_build_object(
            'container_id', v_container.id, 'weight_index', v_weight_index, 'reason', 'below_tare'));
        else
          v_total := v_total + (v_grams - v_tare) / v_factor;
        end if;
        v_tares := v_tares || jsonb_build_object(v_weight->>'variant', v_tare);
      end if;
    end loop;
    v_containers := v_containers || jsonb_build_array(jsonb_build_object(
      'container_id', v_container.id, 'content', v_container.content_base_quantity, 'tares', v_tares));
  end loop;
  update count_lines
  set base_quantity = case when v_pending then null else round(v_total, 3) end,
      pending_setup = v_pending,
      calc = jsonb_build_object('computed_at', clock_timestamp(), 'packs', v_packs,
                               'containers', v_containers, 'problems', v_problems)
  where count_id = p_count_id and item_id = p_item_id;
end;
$$;

-- Container changes and item net-grams changes share one ordered lock loop.
-- A null container selects all counted lines of p_item_id instead.
create function app.recompute_container_lines(p_container_id text, p_item_id text default null) returns void
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_count_id uuid;
  v_item_id text;
  v_match jsonb := jsonb_build_object('containers', jsonb_build_array(jsonb_build_object('container_id', p_container_id)));
begin
  for v_count_id in
    select c.id from counts c
    where c.status in ('draft','submitted','returned') and exists (
      select 1 from count_lines l where l.count_id = c.id and l.state = 'counted'
        and (p_item_id is null or l.item_id = p_item_id)
        and (p_container_id is null or l.entries @> v_match))
    order by c.id for update
  loop
    for v_item_id in
      select l.item_id from count_lines l
      where l.count_id = v_count_id and l.state = 'counted'
        and (p_item_id is null or l.item_id = p_item_id)
        and (p_container_id is null or l.entries @> v_match) order by l.item_id
    loop
      perform app.compute_count_line(v_count_id, v_item_id);
    end loop;
  end loop;
end;
$$;

-- Owner RPCs: role -> required id -> normalize -> replay -> row locks -> write
-- -> log -> store. They change neither branch freezes nor stock ledger rows.
create function public.set_item_count_setup(p_request_id uuid, p_item_id text, p_counted boolean,
  p_count_method text, p_net_grams_per_base_unit numeric) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_item text := nullif(btrim(p_item_id), '');
  v_method text := nullif(btrim(p_count_method), '');
  v_net numeric;
  v_old items;
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if p_counted is null or v_method is null or v_method not in ('units','containers') then
    raise exception 'ENTRIES_INVALID';
  end if;
  if v_method = 'containers' or p_net_grams_per_base_unit is not null then
    v_net := trim_scale(app.check_quantity(p_net_grams_per_base_unit, false));
  end if;
  v_params := jsonb_build_object('item_id', v_item, 'counted', p_counted,
    'count_method', v_method, 'net_grams_per_base_unit', v_net);
  v_replay := app.request_replay(p_request_id, 'set_item_count_setup', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  select i.* into v_old from items i where i.id = v_item for update;
  if not found then raise exception 'ITEM_INVALID'; end if;
  if v_old.count_method is distinct from v_method or v_old.counted is distinct from p_counted then
    perform 1 from counts c
    where c.status in ('draft','submitted','returned') and exists (
      select 1 from count_lines l where l.count_id = c.id and l.item_id = v_item and l.state = 'counted')
    order by c.id for update;
    if found then raise exception 'COUNT_LOCKED'; end if;
  end if;
  update items set counted = p_counted, count_method = v_method, net_grams_per_base_unit = v_net where id = v_item;
  if v_old.net_grams_per_base_unit is distinct from v_net then
    perform app.recompute_container_lines(null, v_item);
  end if;
  v_result := jsonb_build_object('item_id', v_item);
  perform app.log_action(v_owner.id, 'set_item_count_setup', 'items', v_item, v_params);
  return app.request_store(p_request_id, 'set_item_count_setup', v_owner.id, v_params, v_result);
end;
$$;

create function public.set_item_unit(p_request_id uuid, p_item_id text, p_unit text,
  p_conversion_rate numeric, p_active boolean, p_count_visible boolean) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_item text := nullif(btrim(p_item_id), '');
  v_unit text := nullif(btrim(p_unit), '');
  v_rate numeric;
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if v_unit is null or p_active is null or p_count_visible is null then raise exception 'UNIT_INVALID'; end if;
  v_rate := trim_scale(app.check_quantity(p_conversion_rate, false));
  v_params := jsonb_build_object('item_id', v_item, 'unit', v_unit, 'conversion_rate', v_rate,
    'active', p_active, 'count_visible', p_count_visible);
  v_replay := app.request_replay(p_request_id, 'set_item_unit', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  -- Same parent lock as the deferred base-unit trigger; does not block FK checks.
  perform 1 from items i where i.id = v_item for no key update;
  if not found then raise exception 'ITEM_INVALID'; end if;
  perform 1 from item_units u where u.item_id = v_item and u.unit_name = v_unit for update;
  insert into item_units (item_id, unit_name, conversion_rate, active, count_visible)
  values (v_item, v_unit, v_rate, p_active, p_count_visible)
  on conflict (item_id, unit_name) do update
    set conversion_rate = excluded.conversion_rate, active = excluded.active, count_visible = excluded.count_visible;
  v_result := jsonb_build_object('item_id', v_item, 'unit', v_unit);
  perform app.log_action(v_owner.id, 'set_item_unit', 'item_units', v_item, v_params);
  return app.request_store(p_request_id, 'set_item_unit', v_owner.id, v_params, v_result);
end;
$$;

create function public.set_item_container(p_request_id uuid, p_container_id text, p_item_id text,
  p_name_ar text, p_content_base_quantity numeric, p_variants text[], p_active boolean) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_id text := nullif(btrim(p_container_id), '');
  v_item text := nullif(btrim(p_item_id), '');
  v_name text := nullif(btrim(p_name_ar), '');
  v_content numeric;
  v_old item_containers;
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  if v_id is null or v_name is null or p_active is null or p_variants is null
     or cardinality(p_variants) = 0 or array_ndims(p_variants) <> 1
     or array_position(p_variants, null) is not null
     or not (p_variants <@ array['default','glass_pump','glass_cap','plastic_pump','plastic_cap']) then
    raise exception 'CONTAINER_INVALID';
  end if;
  if p_content_base_quantity is not null then
    v_content := trim_scale(app.check_quantity(p_content_base_quantity, false));
  end if;
  v_params := jsonb_build_object('container_id', v_id, 'item_id', v_item, 'name_ar', v_name,
    'content_base_quantity', v_content, 'variants', p_variants, 'active', p_active);
  v_replay := app.request_replay(p_request_id, 'set_item_container', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  perform 1 from items i where i.id = v_item for no key update;
  if not found then raise exception 'ITEM_INVALID'; end if;
  select c.* into v_old from item_containers c where c.id = v_id for update;
  if (found and v_old.item_id <> v_item) or exists (
    select 1 from container_tares t where t.container_id = v_id and not (t.variant = any(p_variants))) then
    raise exception 'CONTAINER_INVALID';
  end if;
  insert into item_containers (id, item_id, name_ar, content_base_quantity, variants, active)
  values (v_id, v_item, v_name, v_content, p_variants, p_active)
  on conflict (id) do update set name_ar = excluded.name_ar, content_base_quantity = excluded.content_base_quantity,
    variants = excluded.variants, active = excluded.active;
  if v_old.content_base_quantity is distinct from v_content or v_old.variants is distinct from p_variants then
    perform app.recompute_container_lines(v_id);
  end if;
  v_result := jsonb_build_object('container_id', v_id);
  perform app.log_action(v_owner.id, 'set_item_container', 'item_containers', v_id, v_params);
  return app.request_store(p_request_id, 'set_item_container', v_owner.id, v_params, v_result);
end;
$$;

create function public.set_container_tare(p_request_id uuid, p_container_id text,
  p_variant text, p_tare_grams numeric) returns jsonb
language plpgsql security definer
set search_path = app, public, extensions, pg_temp as $$
declare
  v_owner app_users := app.require_role('owner');
  v_id text := nullif(btrim(p_container_id), '');
  v_variant text := nullif(btrim(p_variant), '');
  v_tare numeric;
  v_container item_containers;
  v_params jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if p_request_id is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
  begin
    v_tare := trim_scale(app.check_quantity(p_tare_grams, false));
  exception when sqlstate 'P0001' then
    if sqlerrm = 'QUANTITY_INVALID' then raise exception 'WEIGHT_INVALID'; end if;
    raise;
  end;
  v_params := jsonb_build_object('container_id', v_id, 'variant', v_variant, 'tare_grams', v_tare);
  v_replay := app.request_replay(p_request_id, 'set_container_tare', v_owner.id, v_params);
  if v_replay is not null then return v_replay; end if;
  select c.* into v_container from item_containers c where c.id = v_id for update;
  if not found or not coalesce(v_variant = any(v_container.variants), false) then
    raise exception 'CONTAINER_INVALID';
  end if;
  perform 1 from container_tares t where t.container_id = v_id and t.variant = v_variant for update;
  insert into container_tares (container_id, variant, tare_grams, updated_by, updated_at)
  values (v_id, v_variant, v_tare, v_owner.id, clock_timestamp())
  on conflict (container_id, variant) do update
    set tare_grams = excluded.tare_grams, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform app.recompute_container_lines(v_id);
  v_result := jsonb_build_object('container_id', v_id, 'variant', v_variant);
  perform app.log_action(v_owner.id, 'set_container_tare', 'container_tares', v_id, v_params);
  return app.request_store(p_request_id, 'set_container_tare', v_owner.id, v_params, v_result);
end;
$$;

revoke all on function app.check_container_tare_variant() from public, anon, authenticated;
revoke all on function app.compute_count_line(uuid, text) from public, anon, authenticated;
revoke all on function app.recompute_container_lines(text, text) from public, anon, authenticated;
revoke all on function public.set_item_count_setup(uuid, text, boolean, text, numeric) from public, anon, authenticated;
revoke all on function public.set_item_unit(uuid, text, text, numeric, boolean, boolean) from public, anon, authenticated;
revoke all on function public.set_item_container(uuid, text, text, text, numeric, text[], boolean) from public, anon, authenticated;
revoke all on function public.set_container_tare(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function public.set_item_count_setup(uuid, text, boolean, text, numeric) to authenticated;
grant execute on function public.set_item_unit(uuid, text, text, numeric, boolean, boolean) to authenticated;
grant execute on function public.set_item_container(uuid, text, text, text, numeric, text[], boolean) to authenticated;
grant execute on function public.set_container_tare(uuid, text, text, numeric) to authenticated;
