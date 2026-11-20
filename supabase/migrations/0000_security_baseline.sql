-- Security baseline: functions are closed by default.
-- Anything created later in public or app is executable only by its owner
-- (and service_role where granted) until a migration grants it explicitly.

create extension if not exists pgcrypto with schema extensions;

create schema app;
grant usage on schema app to authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema app
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;
