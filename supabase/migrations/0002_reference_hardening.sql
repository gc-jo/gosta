-- Hardening of the reference schema (0001 is frozen; changes land here).

-- True for every ordinary number, false for NaN, Infinity and -Infinity,
-- null for null (so a check using it passes on null, like any check).
create function app.is_finite(p_value numeric) returns boolean
language sql immutable as $$
  select p_value - p_value = 0
$$;
