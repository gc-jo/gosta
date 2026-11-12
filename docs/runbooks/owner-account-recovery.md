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

Choose a new password of at least 12 characters and at most 72 bytes (an Arabic letter counts as 2 bytes). It is compared exactly as typed: Arabic and Latin digits are different characters.

```sql
-- 1. store the new password
update app_user_secrets
set secret_hash = extensions.crypt('PUT-NEW-PASSWORD-HERE', extensions.gen_salt('bf', 10))
where user_id = (select id from app_users where role = 'owner');

-- 2. end every existing owner session, clear any lock, and invalidate logins in flight
update app_sessions
set revoked_at = clock_timestamp()
where user_id = (select id from app_users where role = 'owner') and revoked_at is null;

update app_users
set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
where role = 'owner';
```

Then sign in to the app with the new password and **change it again from Settings straight away**: the password you typed above is kept in the dashboard's query history.

Run all three statements. Skipping the third leaves a login that started with the old password able to finish.

## 3. Someone keeps locking the owner out

The lock needs the owner's employee number. Give the owner a new one that is not guessable (digits only; leading zeros count):

```sql
update app_users
set employee_number = 'PUT-NEW-NUMBER-HERE', failed_attempts = 0, locked_until = null
where role = 'owner';
```

The owner then signs in with the new number and the same password. Existing sessions keep working. The Supabase Auth user attached to the account is unaffected.

## What this runbook relies on

- There is exactly one row with `role = 'owner'`. If the first query returns more than one row, stop and identify the right one by `employee_number`; replace `where role = 'owner'` with `where employee_number = '…'` in every statement.
- The statements are run as the dashboard's database role, which bypasses the app's access rules. Do not run anything else there.
- These exact statements are exercised by an automated test (`supabase/tests/10c_owner_recovery.test.sql`). If a statement here is changed, change the test with it.
