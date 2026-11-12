-- Insert-only ledger, activity log, request replay table and the balances view.
-- RLS and grants come later.

-- Raises the code IMMUTABLE_ROW (SQLSTATE P0001, like every other error code).
create function app.forbid_update_delete() returns trigger
language plpgsql
set search_path = app, public, extensions, pg_temp as $$
begin
  raise exception 'IMMUTABLE_ROW';
end;
$$;

-- stock_movements --------------------------------------------------------
create table stock_movements (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null references branches (id),
  item_id       text not null references items (id),
  base_quantity numeric not null,
  kind          text not null,
  ref_table     text not null,
  ref_id        uuid not null,
  occurred_at   timestamptz not null,
  created_by    uuid null references app_users (id),
  created_at    timestamptz not null default clock_timestamp(),
  constraint stock_movements_kind_valid check (kind in
    ('transfer_out', 'transfer_in', 'transfer_adjust', 'purchase_in', 'purchase_adjust')),
  constraint stock_movements_base_quantity_finite check (app.is_finite(base_quantity))
);
create index stock_movements_branch_item_occurred_idx
  on stock_movements (branch_id, item_id, occurred_at);
create trigger stock_movements_insert_only
  before update or delete on stock_movements
  for each row execute function app.forbid_update_delete();

-- stock_baselines --------------------------------------------------------
create table stock_baselines (
  id            uuid primary key default gen_random_uuid(),
  branch_id     text not null references branches (id),
  item_id       text not null references items (id),
  base_quantity numeric not null,
  effective_at  timestamptz not null,
  source        text not null,
  ref_id        uuid null,
  created_by    uuid null references app_users (id),
  constraint stock_baselines_source_valid check (source in ('count', 'owner_zero')),
  constraint stock_baselines_base_quantity_finite check (app.is_finite(base_quantity))
);
create index stock_baselines_branch_item_effective_idx
  on stock_baselines (branch_id, item_id, effective_at desc);
create trigger stock_baselines_insert_only
  before update or delete on stock_baselines
  for each row execute function app.forbid_update_delete();

-- activity_log -----------------------------------------------------------
create table activity_log (
  id           uuid primary key default gen_random_uuid(),
  at           timestamptz not null default clock_timestamp(),
  user_id      uuid null references app_users (id),
  action       text not null,
  entity_table text null,
  entity_id    text null,
  details      jsonb not null default '{}'::jsonb,
  constraint activity_log_action_not_blank check (btrim(action) <> '')
);
create trigger activity_log_insert_only
  before update or delete on activity_log
  for each row execute function app.forbid_update_delete();

create trigger purchase_line_history_insert_only
  before update or delete on purchase_line_history
  for each row execute function app.forbid_update_delete();

-- rpc_requests -----------------------------------------------------------
create table rpc_requests (
  request_id      uuid primary key,
  rpc_name        text not null,
  user_id         uuid not null,
  request_hash    text not null,
  secret_verifier text null,
  result          jsonb not null,
  created_at      timestamptz not null default clock_timestamp()
);

-- balances ---------------------------------------------------------------
-- columns: branch_id, item_id, base_quantity, baseline_at (null = never counted)
-- base_quantity = latest baseline's quantity (0 if none)
--               + sum of movements occurring after that baseline's effective_at
--                 (all movements when there is no baseline)
-- "latest" = greatest effective_at, ties broken by greatest id
create view balances with (security_invoker = true) as
select b.id as branch_id,
       i.id as item_id,
       coalesce(bl.base_quantity, 0) + coalesce((
         select sum(m.base_quantity)
         from stock_movements m
         where m.branch_id = b.id and m.item_id = i.id
           and (bl.effective_at is null or m.occurred_at > bl.effective_at)
       ), 0) as base_quantity,
       bl.effective_at as baseline_at
from branches b
cross join items i
left join lateral (
  select s.base_quantity, s.effective_at
  from stock_baselines s
  where s.branch_id = b.id and s.item_id = i.id
  order by s.effective_at desc, s.id desc
  limit 1
) bl on true
where b.active and i.active;
