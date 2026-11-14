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

Choose a new password of at least 12 characters and at most 72 bytes (an Arabic letter counts as 2 bytes). It is compared exactly as typed: Arabic and Latin digits are different characters. It must not contain control characters (tab, line break and the like), and it must not contain the character sequences `$pw` or `$recovery` (they would end the quoting early; the block then stops with a syntax error and changes nothing). Type it on the keyboard rather than pasting from a formatted document, and do not press Tab inside it: an editor may turn a tab into spaces, which would be a different password.

Type the new password **once**, between the two `$pw$` markers, replacing `PUT-NEW-PASSWORD-HERE`. Nothing between the markers needs escaping: quotes and backslashes are taken literally. Change nothing else.

First run the check query shown after the block and note the owner's `credential_version`.

Then run the block. All the work is done by **one statement** (the `do` block), so it either happens completely or not at all, however the editor sends it: as one request, statement by statement, or continuing after an error. Inside it, the first thing that happens is a lock on the owner's row. A login with the old password cannot get past it: whichever of the two reaches the row first makes the other wait, and either way the old password's login ends up refused or, if it had already finished, ended when the sessions are revoked.

```sql
begin;

do $recovery$
declare
  v_new   text := $pw$PUT-NEW-PASSWORD-HERE$pw$;
  v_count integer;
  v_owner uuid;
begin
  -- there must be exactly one owner
  select count(*) into v_count from app_users where role = 'owner';
  if v_count <> 1 then
    raise exception 'STOP: expected exactly one owner row, found %. Nothing was changed.', v_count;
  end if;

  -- lock the owner's row first; everything below happens under this lock
  select id into v_owner from app_users where role = 'owner' for update;

  -- the placeholder must have been replaced
  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then
    raise exception 'STOP: the placeholder was not replaced with a new password. Nothing was changed.';
  end if;

  -- store the new password (refused, and everything undone, if it breaks the rules above)
  insert into app_user_secrets (user_id, secret_hash)
  values (v_owner, extensions.crypt(app.clean_secret('owner', v_new), extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set secret_hash = excluded.secret_hash;

  -- invalidate logins in flight and clear any lock
  update app_users
  set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null
  where id = v_owner;

  -- end every existing owner session
  update app_sessions
  set revoked_at = clock_timestamp()
  where user_id = v_owner and revoked_at is null;

  -- record that this was done
  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY', 'app_users', v_owner::text, '{"via": "runbook"}'::jsonb);
end
$recovery$;

commit;
```

**Do not trust what the editor displays.** It may show `COMMIT`, a notice, an error, or nothing. Whatever it showed, run this check query again:

```sql
select employee_number,
       credential_version,
       locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u
where role = 'owner';
```

- `credential_version` is exactly one higher than the value you noted, and `live_sessions` is 0: the password was changed. (Two higher means the block ran twice; that is harmless, and the password is the one from the last run.)
- `credential_version` is unchanged: nothing was changed, whatever the editor displayed. If an error was shown (`STOP: …`, `SECRET_WEAK`, `SECRET_TOO_LONG`, `SECRET_INVALID`, or a syntax error), correct the cause and run the block again. If the editor left a transaction open, run `rollback;` first.

The final proof is the next step: sign in to the app with the new password, and confirm the old one is refused. Then **change the password again from Settings straight away**: the password you typed is kept in the dashboard's query history and may be written to the database's statement and error logs, whether the block succeeded or not.

What this does not touch: the owner's sign-ins at Supabase Auth itself are not ended. They are useless on their own, because every read and every action in the app checks the app's own session list, which the block has just emptied. This holds as long as nothing is added to the project that trusts a Supabase Auth session without that check.

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
- **Not verified on a hosted project, and not verified for the dashboard's SQL editor anywhere.** The automated tests send the block from a test program to the local stack; no SQL editor is involved, locally or hosted. Section 2 is written so that it does not depend on how an editor sends it (one statement does all the work), and the tests cover one request, separate requests, autocommit and continue-after-error. Still to be checked by hand on the test project before launch (it is on the cutover checklist): that the dashboard's database role may run the block (it calls `app.clean_secret` and `app.log_action`), what the editor displays on success and on each kind of error, and that the check query and a real sign-in confirm the result.
- These exact statements are exercised by automated tests on the local stack: `supabase/tests/10c_owner_recovery.test.sql`, and for section 2 a two-connection test (`supabase/tests-concurrency/owner_recovery_test.ts`) that reads the SQL block straight from this file and proves a login verified before the recovery cannot keep a session after it. If a statement here is changed, run both.
