begin;
-- pgTAP is test tooling and is deliberately not created by any migration.
create extension if not exists pgtap with schema extensions;
select plan(5);
select has_extension('pgcrypto'); select has_extension('pgtap'); select has_schema('app');
create function public.probe_pub() returns int language sql as 'select 1';
create function app.probe_app() returns int language sql as 'select 1';
select ok(not has_function_privilege('authenticated', 'public.probe_pub()', 'execute')
      and not has_function_privilege('anon', 'public.probe_pub()', 'execute'), 'new public functions are closed');
select ok(not has_function_privilege('authenticated', 'app.probe_app()', 'execute'), 'new app functions are closed');
select * from finish();
rollback;
