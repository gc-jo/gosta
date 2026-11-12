-- Hardening of the reference schema (0001 is frozen; changes land here).

-- True for every ordinary number, false for NaN, Infinity and -Infinity,
-- null for null (so a check using it passes on null, like any check).
create function app.is_finite(p_value numeric) returns boolean
language sql immutable as $$
  select p_value - p_value = 0
$$;

alter table item_units
  add constraint item_units_conversion_rate_finite check (app.is_finite(conversion_rate));

-- Same rule as in 0001, now safe under concurrency. The rule is checked per
-- transaction at commit, so two transactions that are each valid alone could
-- together break it (one repoints items.base_unit to another rate-1 unit while
-- the other changes that unit's rate). Locking the item row first makes the second
-- transaction wait; once it resumes, its check sees the first one's committed change.
create or replace function app.check_item_base_unit() returns trigger
language plpgsql
set search_path = app, public, extensions, pg_temp as $$
declare
  v_key     text := case tg_table_name when 'items' then 'id' else 'item_id' end;
  v_item_id text;
begin
  -- Check the row's item both before and after the change (a key may move).
  -- distinct + order by: when two items are involved they are locked in a fixed order.
  for v_item_id in
    select distinct x
    from unnest(array[
      case when tg_op <> 'INSERT' then to_jsonb(old) ->> v_key end,
      case when tg_op <> 'DELETE' then to_jsonb(new) ->> v_key end
    ]) as t(x)
    where x is not null
    order by x
  loop
    perform 1 from public.items i where i.id = v_item_id for update;
    if exists (select 1 from public.items i where i.id = v_item_id)
       and not exists (
         select 1
         from public.items i
         join public.item_units u
           on u.item_id = i.id and u.unit_name = i.base_unit
          and u.conversion_rate = 1 and u.active
         where i.id = v_item_id
       ) then
      raise exception 'item % must have an active base unit in item_units with conversion_rate 1', v_item_id
        using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;
