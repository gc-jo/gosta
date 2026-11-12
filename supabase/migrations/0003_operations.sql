-- Operational tables: transfers, purchases, counts.
-- Enumerations are text + named check constraints. Every numeric column
-- carries a named finite check (NaN and +-Infinity are valid numerics).
-- RLS and grants come later; nothing here is reachable by client roles yet.

-- transfers ------------------------------------------------------------
create table transfers (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null unique,
  from_branch text not null references branches (id),
  to_branch   text not null references branches (id),
  created_by  uuid not null references app_users (id),
  created_at  timestamptz not null default clock_timestamp()
);

create table transfer_lines (
  id                     uuid primary key default gen_random_uuid(),
  transfer_id            uuid not null references transfers (id),
  item_id                text not null references items (id),
  quantity               numeric not null,
  unit                   text not null,
  unit_rate              numeric not null,
  base_quantity          numeric not null,
  cost_total             numeric null,
  status                 text not null default 'pending',
  received_quantity      numeric null,
  received_unit          text null,
  received_unit_rate     numeric null,
  received_base_quantity numeric null,
  diff_reason            text null,
  note                   text null,
  resolved_by            uuid null references app_users (id),
  resolved_at            timestamptz null,
  resolved_by_owner      boolean not null default false,
  constraint transfer_lines_quantity_positive check (quantity > 0),
  constraint transfer_lines_unit_rate_positive check (unit_rate > 0),
  constraint transfer_lines_base_quantity_product check (base_quantity = quantity * unit_rate),
  constraint transfer_lines_cost_total_not_negative check (cost_total >= 0),
  constraint transfer_lines_received_quantity_not_negative check (received_quantity >= 0),
  constraint transfer_lines_status_valid check (status in ('pending', 'received', 'denied')),
  constraint transfer_lines_diff_reason_valid
    check (diff_reason in ('overloaded', 'count_error', 'not_loaded')),
  constraint transfer_lines_received_consistent check (
    case status
      when 'received' then
        received_quantity is not null and received_unit is not null
        and received_unit_rate is not null and received_base_quantity is not null
        and received_base_quantity = received_quantity * received_unit_rate
      when 'pending' then
        received_quantity is null and received_unit is null
        and received_unit_rate is null and received_base_quantity is null
      else true
    end),
  constraint transfer_lines_quantity_finite check (app.is_finite(quantity)),
  constraint transfer_lines_unit_rate_finite check (app.is_finite(unit_rate)),
  constraint transfer_lines_base_quantity_finite check (app.is_finite(base_quantity)),
  constraint transfer_lines_cost_total_finite check (app.is_finite(cost_total)),
  constraint transfer_lines_received_quantity_finite check (app.is_finite(received_quantity)),
  constraint transfer_lines_received_unit_rate_finite check (app.is_finite(received_unit_rate)),
  constraint transfer_lines_received_base_quantity_finite check (app.is_finite(received_base_quantity))
);
create index transfer_lines_transfer_id_idx on transfer_lines (transfer_id);

-- purchases ------------------------------------------------------------
create table purchases (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null unique,
  branch_id   text not null references branches (id),
  supplier_id text not null references suppliers (id),
  created_by  uuid not null references app_users (id),
  created_at  timestamptz not null default clock_timestamp()
);

create table purchase_lines (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references purchases (id),
  item_id       text not null references items (id),
  quantity      numeric not null,
  unit          text not null,
  unit_rate     numeric not null,
  base_quantity numeric not null,
  cost_total    numeric null,
  voided_at     timestamptz null,
  voided_by     uuid null references app_users (id),
  constraint purchase_lines_quantity_positive check (quantity > 0),
  constraint purchase_lines_unit_rate_positive check (unit_rate > 0),
  constraint purchase_lines_base_quantity_product check (base_quantity = quantity * unit_rate),
  constraint purchase_lines_cost_total_not_negative check (cost_total >= 0),
  constraint purchase_lines_void_pair check ((voided_at is null) = (voided_by is null)),
  constraint purchase_lines_quantity_finite check (app.is_finite(quantity)),
  constraint purchase_lines_unit_rate_finite check (app.is_finite(unit_rate)),
  constraint purchase_lines_base_quantity_finite check (app.is_finite(base_quantity)),
  constraint purchase_lines_cost_total_finite check (app.is_finite(cost_total))
);
create index purchase_lines_purchase_id_idx on purchase_lines (purchase_id);

-- insert-only (trigger attached in 0004)
create table purchase_line_history (
  id               uuid primary key default gen_random_uuid(),
  purchase_line_id uuid not null references purchase_lines (id),
  changed_by       uuid not null references app_users (id),
  changed_at       timestamptz not null default clock_timestamp(),
  action           text not null,
  old_values       jsonb not null,
  constraint purchase_line_history_action_valid check (action in ('edit', 'void'))
);
create index purchase_line_history_line_idx on purchase_line_history (purchase_line_id);

-- counts ---------------------------------------------------------------
create table count_windows (
  branch_id    text not null references branches (id),
  period_month date not null,
  status       text not null default 'open',
  opened_by    uuid null references app_users (id),
  opened_at    timestamptz not null default clock_timestamp(),
  closed_by    uuid null references app_users (id),
  closed_at    timestamptz null,
  constraint count_windows_pk primary key (branch_id, period_month),
  constraint count_windows_period_month_first_day
    check (period_month = date_trunc('month', period_month)::date),
  constraint count_windows_status_valid check (status in ('open', 'closed'))
);

create table counts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    text not null references branches (id),
  period_month date not null,
  status       text not null default 'draft',
  submitted_by uuid null references app_users (id),
  submitted_at timestamptz null,
  reviewed_by  uuid null references app_users (id),
  reviewed_at  timestamptz null,
  review_note  text null,
  frozen_since timestamptz null,
  revision     int not null default 0,
  constraint counts_branch_period_key unique (branch_id, period_month),
  constraint counts_period_month_first_day
    check (period_month = date_trunc('month', period_month)::date),
  constraint counts_status_valid check (status in ('draft', 'submitted', 'returned', 'approved')),
  constraint counts_frozen_only_while_open
    check (frozen_since is null or status in ('draft', 'returned'))
);

create table count_lines (
  count_id      uuid not null references counts (id),
  item_id       text not null references items (id),
  state         text not null default 'uncounted',
  entries       jsonb not null default '{}'::jsonb,
  base_quantity numeric null,
  needs_recount boolean not null default false,
  revision      int not null default 0,
  effective_at  timestamptz null,
  constraint count_lines_pk primary key (count_id, item_id),
  constraint count_lines_state_valid check (state in ('uncounted', 'counted', 'none')),
  constraint count_lines_uncounted_has_no_quantity check ((state = 'uncounted') = (base_quantity is null)),
  constraint count_lines_base_quantity_finite check (app.is_finite(base_quantity))
);
