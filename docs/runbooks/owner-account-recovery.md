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

Choose a new password of at least 12 characters and at most 72 bytes (an Arabic letter counts as 2 bytes). It is compared exactly as typed: Arabic and Latin digits are different characters. It must not contain control characters (tab, line break and the like); the statement below refuses such a password, and one that is too short or too long, and then changes nothing.

Run the whole block below as one unit, exactly as written, replacing only the placeholder. It is a single transaction. Its first statement takes a lock on the owner's row; a login that was already under way with the old password waits on that lock and is refused when the block commits, and a login that had already finished is ended by the block's last statement. Do not reorder the statements, do not run them one at a time, and do not remove the first one: without it a login in progress can leave a working session behind.

```sql
begin;

-- 1. lock the owner's row first; everything below happens under this lock
select id from app_users where role = 'owner' for update;

-- 2. store the new password (refused, and the block rolled back, if it breaks the rules above)
insert into app_user_secrets (user_id, secret_hash)
select id, extensions.crypt(app.clean_secret('owner', 'PUT-NEW-PASSWORD-HERE'), extensions.gen_salt('bf', 10))
from app_users where role = 'owner'
on conflict (user_id) do update set secret_hash = excluded.secret_hash;

-- 3. invalidate logins in flight and clear any lock
update app_users
set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
where role = 'owner';

-- 4. end every existing owner session
update app_sessions
set revoked_at = clock_timestamp()
where user_id = (select id from app_users where role = 'owner') and revoked_at is null;

commit;
```

If any statement reports an error, the password was **not** changed: run `rollback;` and start again. A successful run ends with `COMMIT`.

Then sign in to the app with the new password and **change it again from Settings straight away**: the password you typed above is kept in the dashboard's query history.

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

- There is exactly one row with `role = 'owner'`. If the first query returns more than one row, stop and identify the right one by `employee_number`; replace `where role = 'owner'` with `where employee_number = '…'` in every statement.
- The statements are run as the dashboard's database role, which bypasses the app's access rules. Do not run anything else there.
- These exact statements are exercised by automated tests: `supabase/tests/10c_owner_recovery.test.sql`, and for section 2 a two-connection test (`supabase/tests-concurrency/owner_recovery_test.ts`) that reads the SQL block straight from this file and proves a login verified before the recovery cannot keep a session after it. If a statement here is changed, run both.
