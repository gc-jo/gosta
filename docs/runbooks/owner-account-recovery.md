# Owner account recovery

Use this when the owner cannot get into the app and has no session still signed in on any device. Everything here is done in the Supabase dashboard of the affected project (SQL editor), by whoever holds the Supabase account. Nothing here can be done from the app.

If the owner is still signed in on any device, none of this is needed: change the password from Settings in the app.

## 1. Locked out after wrong passwords

Five wrong passwords lock the account for 15 minutes. The lock ends by itself. To see it:

```sql
select employee_number, failed_attempts, locked_until
from app_users where role = 'owner';
```

To lift it now instead of waiting:

```sql
update app_users
set failed_attempts = 0, locked_until = null
where role = 'owner';
```

This does not change the password and does not end any session.

## 2. Password lost

Choose a new password of at least 12 characters and at most 72 bytes (an Arabic letter counts as 2 bytes). It is compared exactly as typed: Arabic and Latin digits are different characters. It must not contain control characters (tab, line break and the like), and it must not contain the three characters `$pw` anywhere (they would end the quoting early; the block then stops with a syntax error and changes nothing). Type it on the keyboard rather than pasting from a formatted document, and do not press Tab inside it: an editor may turn a tab into spaces, which would be a different password.

Type the new password **once**, in statement 2, between the two `$pw$` markers, replacing `PUT-NEW-PASSWORD-HERE`. Nothing between the markers needs escaping: quotes and backslashes are taken literally. Change nothing else.

First run the check query shown after the block and note the owner's `credential_version`.

Then run the whole block as one unit, exactly as written. It is a single transaction. Its first statement takes a lock on the owner's row. A login with the old password cannot get past the block: whichever of the two reaches the row first makes the other wait, and either way the old password's login ends up refused or, if it had already finished, ended by statement 6. Do not run the statements one at a time and do not remove or move the first one: without it a login in progress can leave a working session behind.

```sql
begin;

-- 1. lock the owner's row first; everything below happens under this lock
select id from app_users where role = 'owner' for update;

-- 2. the new password, typed once, between the two $pw$ markers
select set_config('recovery.new_password', $pw$PUT-NEW-PASSWORD-HERE$pw$, true);

-- 3. stop here unless there is exactly one owner and the placeholder was replaced
do $guard$
begin
  if (select count(*) from app_users where role = 'owner') <> 1 then
    raise exception 'STOP: expected exactly one owner row. Nothing was changed.';
  end if;
  if current_setting('recovery.new_password') = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;
end
$guard$;

-- 4. store the new password (refused, and the whole block undone, if it breaks the rules above)
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt(app.clean_secret('owner', current_setting('recovery.new_password')), extensions.gen_salt('bf', 10))
from app_users where role = 'owner'
on conflict (user_id) do update set secret_hash = excluded.secret_hash;

-- 5. invalidate logins in flight and clear any lock
update app_users
set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
where role = 'owner';

-- 6. end every existing owner session
update app_sessions
set revoked_at = clock_timestamp()
where user_id = (select id from app_users where role = 'owner') and revoked_at is null;

-- 7. record that this was done
select app.log_action((select id from app_users where role = 'owner'), 'OWNER_PASSWORD_RECOVERY', 'app_users', (select id::text from app_users where role = 'owner'), '{"via": "runbook"}'::jsonb);

commit;
```

**Seeing `COMMIT` is not proof, and the editor may not show it at all.** If any statement reports an error (including a line starting with `STOP:`), the password was **not** changed: run `rollback;` and start again. Statement 2 shows the password back in its result; that is expected. Before the block, and again after a run with no error, run this check query:

```sql
select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner';
```

After the block it must return exactly one row, with `live_sessions` = 0 and `credential_version` exactly one higher than the value you noted before the block. If the version did not change, the block did not take effect, whatever the editor displayed. Then sign in to the app with the new password and **change it again from Settings straight away**: the password you typed is kept in the dashboard's query history and may be written to the database's statement and error logs, whether the block succeeded or not.

What this does not touch: the owner's sign-ins at Supabase Auth itself are not ended. They are useless on their own, because every read and every action in the app checks the app's own session list, which statement 6 has just emptied. This holds as long as nothing is added to the project that trusts a Supabase Auth session without that check.

## 3. Someone keeps locking the owner out

The lock needs the owner's employee number. Give the owner a new one that is not guessable. Type it in Latin digits `0`–`9` only (an Arabic-digit number stored here could never be matched at login); leading zeros count, and it must not already belong to another user:

```sql
update app_users
set employee_number = 'PUT-NEW-NUMBER-HERE', failed_attempts = 0, locked_until = null
where role = 'owner';
```

The owner then signs in with the new number and the same password. Existing sessions keep working.

The statement above is all that is needed. The owner's Supabase Auth user still carries the old number in its internal email at this point; the login function notices on the owner's next sign-in and moves that email to the new number itself, which also frees the old number for reuse. Do not edit `auth.users` by hand. If that first sign-in with the new number fails with a server error, do not repeat the statement: check the function's log.

## What this runbook relies on

- There is exactly one row with `role = 'owner'`. Sections 1 and 3 act on every owner row; section 2 refuses to run unless there is exactly one. If the check query returns no row or more than one, stop: do not edit the statements to pick a row by number. That situation is outside this runbook and needs someone who can inspect the data first.
- The statements are run as the dashboard's database role, which bypasses the app's access rules. Do not run anything else there.
- **Not yet verified on a hosted project:** that the dashboard's SQL editor sends a pasted block as one request, and that its database role may call `app.clean_secret` and `app.log_action`. Both hold on the local stack used by the automated tests. Rehearse section 2 on the test project before launch (it is on the cutover checklist), and until then treat this procedure as tested locally only.
- These exact statements are exercised by automated tests: `supabase/tests/10c_owner_recovery.test.sql`, and for section 2 a two-connection test (`supabase/tests-concurrency/owner_recovery_test.ts`) that reads the SQL block straight from this file and proves a login verified before the recovery cannot keep a session after it. If a statement here is changed, run both.
