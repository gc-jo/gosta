-- Reference data (owner-managed), users, secrets and sessions.
-- Enumerations are text + named check constraints, not Postgres enums.
-- RLS and grants come later; nothing here is reachable by client roles yet.

-- branches -------------------------------------------------------------
create table branches (
  id      text primary key,
  name_ar text not null,
  kind    text not null,
  active  boolean not null default true,
  constraint branches_name_ar_not_blank check (btrim(name_ar) <> ''),
  constraint branches_kind_valid check (kind in ('branch', 'warehouse', 'waste'))
);

-- items ----------------------------------------------------------------
create table items (
  id         text primary key,
  name_ar    text not null,
  base_unit  text not null,
  item_type  text not null,
  sort_order int not null default 0,
  active     boolean not null default true,
  constraint items_name_ar_not_blank check (btrim(name_ar) <> ''),
  constraint items_base_unit_not_blank check (btrim(base_unit) <> ''),
  constraint items_item_type_valid
    check (item_type in ('syrup', 'puree', 'powder', 'sauce', 'cups', 'mixed'))
);

-- item_units -----------------------------------------------------------
create table item_units (
  item_id         text not null references items (id),
  unit_name       text not null,
  conversion_rate numeric not null,
  active          boolean not null default true,
  constraint item_units_pk primary key (item_id, unit_name),
  constraint item_units_unit_name_not_blank check (btrim(unit_name) <> ''),
  constraint item_units_rate_positive check (conversion_rate > 0)
);

-- Every item's base unit must exist in item_units with rate 1.
-- Deferred so an item and its units can be inserted in either order
-- within one transaction.
create function app.check_item_base_unit() returns trigger
language plpgsql as $$
declare
  v_key     text := case tg_table_name when 'items' then 'id' else 'item_id' end;
  v_item_id text;
begin
  -- Check the row's item both before and after the change (a key may move).
  for v_item_id in
    select distinct x
    from unnest(array[
      case when tg_op <> 'INSERT' then to_jsonb(old) ->> v_key end,
      case when tg_op <> 'DELETE' then to_jsonb(new) ->> v_key end
    ]) as t(x)
    where x is not null
  loop
    if exists (select 1 from items i where i.id = v_item_id)
       and not exists (
         select 1
         from items i
         join item_units u
           on u.item_id = i.id and u.unit_name = i.base_unit and u.conversion_rate = 1
         where i.id = v_item_id
       ) then
      raise exception 'item % must have its base unit in item_units with conversion_rate 1', v_item_id
        using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;

create constraint trigger items_base_unit_exists
  after insert or update of base_unit on items
  deferrable initially deferred
  for each row execute function app.check_item_base_unit();

create constraint trigger item_units_base_unit_exists
  after insert or update or delete on item_units
  deferrable initially deferred
  for each row execute function app.check_item_base_unit();

-- suppliers ------------------------------------------------------------
create table suppliers (
  id      text primary key,
  name_ar text not null,
  phone   text null,
  active  boolean not null default true,
  constraint suppliers_name_ar_not_blank check (btrim(name_ar) <> '')
);

create table supplier_items (
  supplier_id text not null references suppliers (id),
  item_id     text not null references items (id),
  active      boolean not null default true,
  constraint supplier_items_pk primary key (supplier_id, item_id)
);

-- branch-level configuration -------------------------------------------
create table allowed_local_purchases (
  branch_id text not null references branches (id),
  item_id   text not null references items (id),
  active    boolean not null default true,
  constraint allowed_local_purchases_pk primary key (branch_id, item_id)
);

-- A missing row means the feature is visible.
create table branch_features (
  branch_id   text not null references branches (id),
  feature_key text not null,
  visible     boolean not null default true,
  constraint branch_features_pk primary key (branch_id, feature_key),
  constraint branch_features_key_valid
    check (feature_key in ('receive', 'send', 'purchase', 'count', 'balance'))
);

-- users, secrets, sessions ---------------------------------------------
create table app_users (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid unique null references auth.users (id),
  employee_number    text not null,
  name               text not null,
  role               text not null,
  branch_id          text null references branches (id),
  active             boolean not null default true,
  failed_attempts    int not null default 0,
  locked_until       timestamptz null,
  credential_version int not null default 0,
  constraint app_users_employee_number_key unique (employee_number),
  constraint app_users_employee_number_digits check (employee_number ~ '^[0-9]+$'),
  constraint app_users_name_not_blank check (btrim(name) <> ''),
  constraint app_users_role_valid check (role in ('manager', 'distributor', 'owner')),
  constraint app_users_owner_has_no_branch check ((role = 'owner') = (branch_id is null))
);

create table app_user_secrets (
  user_id     uuid primary key references app_users (id),
  secret_hash text not null
);

-- One row per login. session_id is the Supabase Auth session id.
create table app_sessions (
  session_id uuid primary key,
  user_id    uuid not null references app_users (id),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz null
);

create index app_sessions_user_id_idx on app_sessions (user_id);
