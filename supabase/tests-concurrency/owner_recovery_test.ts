// Owner password recovery (docs/runbooks/owner-account-recovery.md, section 2) on real, separate connections.
//
// The SQL under test is NOT copied here: it is read from the runbook file, so the runbook and this test cannot
// drift apart. The block is `begin; lock; set_config(password); guard; secret; version; sessions; log; commit;`.
//
// Connections: R runs the runbook block, L plays a login (verify / register), `admin` only watches pg_stat_activity
// and pg_blocking_pids, `other` is a third session for lock probes, `setup` is autocommit postgres and does the
// committed set-up and clean-up. L's calls run in a transaction with `set local role service_role`, which is the
// role the login Edge Function uses through PostgREST (login_verify / login_register_session are security definer,
// so the role does not change what they do, but it proves the grants).
// The tests COMMIT real changes to the owner's rows and restore them in `finally` (activity_log is insert-only, so
// LOGIN_* and OWNER_PASSWORD_RECOVERY rows stay). Afterwards the owner must log in with the seeded password.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { backendPid, type Conn, connect, waitUntilBlockedBy } from "./helpers.ts";

const RUNBOOK = new URL("../../docs/runbooks/owner-account-recovery.md", import.meta.url);
const SEEDED = "correct horse battery";
const NEW_PW = "recovered owner pass 987";
const PLACEHOLDER = "PUT-NEW-PASSWORD-HERE";

/** Splits SQL into statements at top-level semicolons; respects '...' strings, $tag$...$tag$ bodies, drops -- comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("splitSql: unterminated string literal");
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new Error(`splitSql: unterminated dollar quote ${m[0]}`);
        cur += sql.slice(i, end + m[0].length);
        i = end + m[0].length;
        continue;
      }
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) throw new Error("splitSql: the block does not end with a semicolon");
  return out;
}

/**
 * The statements of the fenced sql block under "## 2. Password lost". The placeholder is replaced ONLY inside the
 * $pw$...$pw$ literal of the set_config statement. Fails loudly if the block has the wrong shape.
 */
export function loadRecoveryBlock(md: string, password: string): string[] {
  return splitAndCheck(rawRecoveryBlock(md, password));
}

/** The runbook's sql block exactly as printed (comments included), placeholder replaced only inside the $pw$ literal. */
export function rawRecoveryBlock(md: string, password: string): string {
  const h = md.indexOf("\n## 2. Password lost");
  if (h < 0) throw new Error("runbook: heading '## 2. Password lost' not found");
  const rest = md.slice(h + 1);
  const next = rest.indexOf("\n## ", 5);
  const section = next < 0 ? rest : rest.slice(0, next);
  const m = section.match(/```sql\n([\s\S]*?)\n```/);
  if (!m) throw new Error("runbook: no fenced sql block under '## 2. Password lost'");
  const raw = m[1];
  const occurrences = raw.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) throw new Error(`runbook: the placeholder must occur exactly once in the block, found ${occurrences}`);
  const literal = `$pw$${PLACEHOLDER}$pw$`;
  if (!raw.includes(literal)) throw new Error("runbook: the placeholder must sit inside the $pw$...$pw$ literal");
  return raw.replace(literal, () => `$pw$${password}$pw$`);
}

function splitAndCheck(sql: string): string[] {
  const stmts = splitSql(sql);
  if (stmts[0]?.toLowerCase() !== "begin") throw new Error("runbook block must start with begin;");
  if (stmts[stmts.length - 1]?.toLowerCase() !== "commit") throw new Error("runbook block must end with commit;");
  if (stmts[1] !== "select id from app_users where role = 'owner' for update") {
    throw new Error("runbook block: the first statement after begin must be the select ... for update on app_users");
  }
  if (!stmts[2]?.startsWith("select set_config('recovery.new_password'")) throw new Error("runbook block: statement 2 must be the set_config of recovery.new_password");
  if (!/^do \$guard\$/.test(stmts[3] ?? "")) throw new Error("runbook block: statement 3 must be the do $guard$ block");
  // statements 5, 6 and 7 (version bump, revocation, audit row) must refuse to act outside the block's transaction
  for (const i of [5, 6, 7]) {
    if (!(stmts[i] ?? "").includes("current_setting('recovery.new_password')")) {
      throw new Error(`runbook block: statement ${i} must contain current_setting('recovery.new_password') so that it does nothing outside the block`);
    }
  }
  if (stmts.length !== 9) throw new Error(`runbook block: expected begin + 7 statements + commit, got ${stmts.length} statements`);
  return stmts;
}
async function block(password = NEW_PW): Promise<string[]> {
  return loadRecoveryBlock(await Deno.readTextFile(RUNBOOK), password);
}
/** The whole block as the person pastes it: one text, comments and all. */
async function blockText(password = NEW_PW): Promise<string> {
  const text = rawRecoveryBlock(await Deno.readTextFile(RUNBOOK), password);
  splitAndCheck(text); // fails loudly on a wrong shape
  return text;
}
/** Sends `text` as ONE simple-protocol message (several statements in one request). */
const sendWhole = (c: Conn, text: string) => c.unsafe(text).simple().then((x) => x);
// statement indexes: 0 begin, 1 lock, 2 set_config, 3 guard, 4 secret, 5 version bump, 6 sessions revoked, 7 log, 8 commit

type Owner = {
  id: string; auth_user_id: string; secret_hash: string; credential_version: number;
  failed_attempts: number; locked_until: string | null; live: string[];
};
async function readOwner(setup: Conn): Promise<Owner> {
  const rows = await setup.unsafe(
    `select u.id, u.auth_user_id, s.secret_hash, u.credential_version, u.failed_attempts, u.locked_until::text as locked_until
       from app_users u join app_user_secrets s on s.user_id = u.id where u.role = 'owner'`);
  assertEquals(rows.length, 1, "exactly one owner");
  const o = rows[0] as unknown as Owner;
  const live = await setup.unsafe(`select session_id::text as id from app_sessions where user_id = $1 and revoked_at is null`, [o.id]);
  o.live = live.map((r) => (r as unknown as { id: string }).id);
  assert(o.live.length >= 1, "the owner needs a live seeded session");
  return o;
}
async function rollbackQuietly(c: Conn) {
  try {
    await c.unsafe("rollback");
  } catch { /* nothing open */ }
}
async function cleanUp(setup: Conn, o: Owner | null, created: string[]): Promise<Error | null> {
  if (!o) return null;
  try {
    await setup.unsafe(`update app_user_secrets set secret_hash = $2 where user_id = $1`, [o.id, o.secret_hash]);
    await setup.unsafe(
      `update app_users set credential_version = $2, failed_attempts = $3, locked_until = $4 where id = $1`,
      [o.id, o.credential_version, o.failed_attempts, o.locked_until]);
    for (const id of created) await setup.unsafe(`delete from app_sessions where session_id = $1`, [id]);
    for (const id of o.live) await setup.unsafe(`update app_sessions set revoked_at = null where session_id = $1`, [id]);
    const back = await setup.unsafe(
      `select (extensions.crypt($2, secret_hash) = secret_hash) as ok from app_user_secrets where user_id = $1`, [o.id, SEEDED]);
    assertEquals((back[0] as unknown as { ok: boolean }).ok, true, "the seeded owner password works again");
    return null;
  } catch (e) {
    console.error("clean-up of the owner's rows failed:", e);
    return e as Error;
  }
}

type Ctx = { setup: Conn; r: Conn; l: Conn; admin: Conn; other: Conn; owner: Owner; created: string[] };
/** Opens the connections, runs `fn`, always rolls back and restores the owner, rethrows the first error. */
async function withOwner(fn: (c: Ctx) => Promise<void>) {
  const setup = connect(), r = connect(), l = connect(), admin = connect(), other = connect();
  const created: string[] = [];
  let owner: Owner | null = null;
  let failure: unknown = null;
  let restoreError: Error | null = null;
  try {
    owner = await readOwner(setup);
    await fn({ setup, r, l, admin, other, owner, created });
  } catch (e) {
    failure = e;
  } finally {
    for (const c of [r, l, other]) await rollbackQuietly(c);
    restoreError = await cleanUp(setup, owner, created);
    for (const c of [setup, r, l, admin, other]) await c.end({ timeout: 5 }).catch(() => {});
  }
  if (failure) throw failure;
  if (restoreError) throw restoreError;
}

/** Runs `fn` as service_role inside one committed transaction on `c`. */
async function asService<T>(c: Conn, fn: () => Promise<T>): Promise<T> {
  await c.unsafe("begin");
  try {
    await c.unsafe("set local role service_role");
    const r = await fn();
    await c.unsafe("commit");
    return r;
  } catch (e) {
    await rollbackQuietly(c);
    throw e;
  }
}
type Verify = { ok: boolean; reason?: string; credential_version?: number };
async function verifyAs(l: Conn, password: string): Promise<Verify> {
  const rows = await asService(l, () => l.unsafe(`select public.login_verify('100', $1) as r`, [password]));
  return (rows[0] as unknown as { r: Verify }).r;
}
async function verifyOk(l: Conn, password = SEEDED): Promise<number> {
  const r = await verifyAs(l, password);
  assertEquals(r.ok, true, "the owner's login verifies");
  return r.credential_version!;
}
const register = (c: Conn, ownerId: string, sid: string, v: number) =>
  c.unsafe(`select public.login_register_session($1, $2, $3)`, [ownerId, sid, v]);
const errMsg = (p: Promise<unknown>) => p.then(() => null as Error | null, (e: unknown) => e as Error);

type State = { is_new: boolean; is_old: boolean; credential_version: number; unrevoked: number; sid_rows: number; failed_attempts: number };
async function state(setup: Conn, o: Owner, sid: string, newPw = NEW_PW): Promise<State> {
  return (await setup.unsafe(
    `select (extensions.crypt($2, s.secret_hash) = s.secret_hash) as is_new,
            (extensions.crypt($3, s.secret_hash) = s.secret_hash) as is_old,
            u.credential_version, u.failed_attempts,
            (select count(*)::int from app_sessions a where a.user_id = u.id and a.revoked_at is null) as unrevoked,
            (select count(*)::int from app_sessions a where a.session_id = $4) as sid_rows
       from app_users u join app_user_secrets s on s.user_id = u.id where u.id = $1`,
    [o.id, newPw, SEEDED, sid]))[0] as unknown as State;
}

// ---- registration arriving while the block runs --------------------------------------------------------------------
// A login verified before the recovery tries to register while the block is running: R has executed statements 0..stopAfter
// (the last one run is the boundary), L's registration is started now and must WAIT for R (blocker identity asserted);
// R then finishes and commits.
async function registrationDuringBlock(stopAfter: number) {
  await withOwner(async ({ setup, r, l, admin, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const stmts = await block();
    const v = await verifyOk(l);
    assertEquals(v, owner.credential_version, "verified with the current version");
    const pidL = await backendPid(l), pidR = await backendPid(r);
    for (let i = 0; i <= stopAfter; i++) await r.unsafe(stmts[i]); // R holds the row lock from statement 1 on

    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = errMsg(register(l, owner.id, sid, v));
    await waitUntilBlockedBy(admin, pidL, pidR); // L waits, and for R specifically
    for (let i = stopAfter + 1; i < stmts.length; i++) await r.unsafe(stmts[i]); // rest of the block, ending with commit
    const err = await outcome;
    await rollbackQuietly(l);

    const st = await state(setup, owner, sid);
    console.log("observed:", JSON.stringify({ stopAfter, err: err?.message ?? null, ...st, originalVersion: owner.credential_version }));
    assert(err !== null, "the registration that was waiting must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    assertEquals(st.sid_rows, 0, "no app_sessions row for the refused registration");
    assertEquals(st.unrevoked, 0, "the owner has no unrevoked session at all");
    assertEquals(st.is_new, true, "the stored hash matches the new password");
    assertEquals(st.is_old, false, "and not the old one");
    assertEquals(st.credential_version, owner.credential_version + 1, "credential_version rose by exactly 1");
  });
}
const BOUNDARIES: Array<[number, string]> = [
  [1, "right after the lock"], [2, "after the password is put into the setting"], [3, "after the guard"],
  [4, "after the new secret is stored"], [5, "between the version bump and the revocation"],
  [6, "after the revocation"], [7, "after the recovery is logged (everything but commit)"],
];
for (const [stopAfter, label] of BOUNDARIES) {
  Deno.test(`recovery block: a login verified before it cannot register ${label} (waits for R, then refused)`, async () => {
    await registrationDuringBlock(stopAfter);
  });
}

Deno.test("recovery block: a login verified with the old password just before the recovery cannot register after it", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const stmts = await block();
    const v = await verifyOk(l); // finished (committed) before the block takes its lock
    for (const s of stmts) await r.unsafe(s);
    const err = await errMsg(asService(l, () => register(l, owner.id, sid, v)));
    assert(err !== null, "the late registration must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    const st = await state(setup, owner, sid);
    assertEquals([st.sid_rows, st.unrevoked, st.credential_version], [0, 0, owner.credential_version + 1]);
  });
});

Deno.test("recovery block: a session registered before the block starts is revoked by it", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const stmts = await block();
    const v = await verifyOk(l);
    await asService(l, () => register(l, owner.id, sid, v)); // committed
    assertEquals((await state(setup, owner, sid)).sid_rows, 1, "the session exists before the recovery");
    for (const s of stmts) await r.unsafe(s);
    const row = (await setup.unsafe(`select revoked_at is not null as revoked from app_sessions where session_id = $1`, [sid]))[0] as unknown as { revoked: boolean };
    assertEquals(row.revoked, true, "that session is revoked by the block");
    assertEquals((await state(setup, owner, sid)).unrevoked, 0, "no live owner session remains");
  });
});

// ---- login_verify racing the block ---------------------------------------------------------------------------------
Deno.test("recovery block: a login_verify with the OLD password that arrives during the block waits for R and is refused", async () => {
  await withOwner(async ({ setup, r, l, admin, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const stmts = await block();
    const pidL = await backendPid(l), pidR = await backendPid(r);
    for (let i = 0; i < stmts.length - 1; i++) await r.unsafe(stmts[i]); // everything but commit
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = l.unsafe(`select public.login_verify('100', $1) as r`, [SEEDED]).then((rows) => rows); // .then starts the lazy query
    await waitUntilBlockedBy(admin, pidL, pidR);
    await r.unsafe(stmts[stmts.length - 1]); // commit
    const res = ((await outcome)[0] as unknown as { r: Verify & { locked_until: unknown } }).r;
    await l.unsafe("commit");
    assertEquals(res.ok, false);
    assertEquals(res.reason, "invalid", "the old password is wrong once the block has committed");
    const st = await state(setup, owner, sid);
    assertEquals(st.failed_attempts, 1, "the refused attempt counted once (the block had cleared the counter)");
    assertEquals(st.unrevoked, 0, "no session exists");
    // the new password works, with the new version, and a registration with it succeeds
    const rv = await verifyAs(l, NEW_PW);
    assertEquals(rv.ok, true);
    assertEquals(rv.credential_version, owner.credential_version + 1);
    await asService(l, () => register(l, owner.id, sid, rv.credential_version!));
    assertEquals((await state(setup, owner, sid)).sid_rows, 1, "the session of the new login is registered");
  });
});

// ---- guard and special characters -------------------------------------------------------------------------------------
Deno.test("recovery block: with the placeholder left in, the guard stops the block, changes nothing and releases the lock at the error", async () => {
  await withOwner(async ({ setup, r, other, owner }) => {
    const stmts = await block(PLACEHOLDER); // the loader leaves the literal as it is in the runbook
    for (let i = 0; i <= 2; i++) await r.unsafe(stmts[i]);
    const err = await errMsg(r.unsafe(stmts[3]));
    assert(err !== null, "the guard must raise");
    assertStringIncludes(err.message, "STOP:");
    assertStringIncludes(err.message, "placeholder");
    // the transaction is aborted but not yet rolled back: its row lock is already gone
    await other.unsafe("begin");
    const got = await other.unsafe(`select id from app_users where role = 'owner' for update nowait`);
    assertEquals(got.length, 1, "another connection can lock the owner row before any rollback");
    await other.unsafe("rollback");
    const later = await errMsg(r.unsafe("select 1"));
    assert(later !== null, "the aborted transaction refuses further statements");
    await r.unsafe("rollback");
    const st = await state(setup, owner, crypto.randomUUID());
    assertEquals([st.is_old, st.credential_version, st.unrevoked], [true, owner.credential_version, owner.live.length]);
  });
});

Deno.test("recovery block: a password with quote, double quote, backslash, semicolon and a dollar goes through unaltered", async () => {
  const P = `it's "q"; back\\slash $x$ $$ ok 123`;
  await withOwner(async ({ setup, r, l, owner }) => {
    const stmts = await block(P);
    assertEquals(stmts.length, 9, "semicolons inside the password do not split the block");
    for (const s of stmts) await r.unsafe(s);
    const v = await verifyAs(l, P);
    assertEquals(v.ok, true, "login_verify with exactly that string succeeds");
    assertEquals(v.credential_version, owner.credential_version + 1);
    const st = await state(setup, owner, crypto.randomUUID(), P);
    assertEquals(st.is_new, true);
    const wrong = await verifyAs(l, P.replace("ok", "ko"));
    assertEquals(wrong.ok, false, "one changed character is refused");
  });
});

// ---- the old order ----------------------------------------------------------------------------------------------------
// DEMONSTRATION of the defect the lock closes; it does not guard the runbook (tests above do that).
Deno.test("DEMONSTRATION, old order in a transaction, no row lock: a verified login keeps its session -- this is why the runbook locks first", async () => {
  await withOwner(async ({ setup, r, l, admin, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l);
    // the OLD statements (git show 321776b:docs/runbooks/owner-account-recovery.md), merely wrapped in a transaction
    // WITHOUT the leading select ... for update
    await r.unsafe("begin");
    await r.unsafe(`update app_user_secrets set secret_hash = extensions.crypt('${NEW_PW}', extensions.gen_salt('bf', 10))
                    where user_id = (select id from app_users where role = 'owner')`);
    await r.unsafe(`update app_sessions set revoked_at = clock_timestamp()
                    where user_id = (select id from app_users where role = 'owner') and revoked_at is null`);
    // not committed yet: L registers now; nothing holds the owner's app_users row, so L must not wait.
    // lock_timeout makes a wait fail fast (SQLSTATE 55P03) instead of hanging: no sleep, no race.
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    await l.unsafe("set local lock_timeout = '500ms'");
    const err = await errMsg(register(l, owner.id, sid, v));
    assertEquals(err, null, "the registration completed without waiting for R (a wait would raise lock_timeout)");
    await l.unsafe("commit");
    await r.unsafe(`update app_users set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null where role = 'owner'`);
    await r.unsafe("commit");

    const row = (await setup.unsafe(
      `select revoked_at is null as unrevoked, expires_at > clock_timestamp() as valid from app_sessions where session_id = $1`, [sid]))[0] as unknown as { unrevoked: boolean; valid: boolean };
    console.log("observed (old order):", JSON.stringify(row));
    assertEquals(row.unrevoked, true, "the session registered with the pre-recovery version survived the recovery");
    assertEquals(row.valid, true, "and has not expired");
    const claims = JSON.stringify({ sub: owner.auth_user_id, role: "authenticated", session_id: sid });
    await setup.unsafe("begin");
    await setup.unsafe("set local role authenticated");
    await setup.unsafe("select set_config('request.jwt.claims', $1, true)", [claims]);
    const ok = (await setup.unsafe("select app.session_ok() as ok"))[0] as unknown as { ok: boolean };
    await setup.unsafe("rollback");
    assertEquals(ok.ok, true, "and the database accepts it: a login with the OLD password is still signed in after the recovery");
  });
});

// ---- login_verify with the NEW password racing the block ---------------------------------------------------------------
Deno.test("recovery block: a login_verify with the NEW password that arrives during the block waits for R, then succeeds with the new version", async () => {
  await withOwner(async ({ r, l, admin, owner }) => {
    const stmts = await block();
    const pidL = await backendPid(l), pidR = await backendPid(r);
    for (let i = 0; i < stmts.length - 1; i++) await r.unsafe(stmts[i]); // everything but commit
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = l.unsafe(`select public.login_verify('100', $1) as r`, [NEW_PW]).then((rows) => rows); // .then starts the lazy query
    await waitUntilBlockedBy(admin, pidL, pidR);
    await r.unsafe(stmts[stmts.length - 1]); // commit
    const res = ((await outcome)[0] as unknown as { r: Verify }).r;
    await l.unsafe("commit");
    assertEquals(res.ok, true, "the new password verifies once the block has committed");
    assertEquals(res.credential_version, owner.credential_version + 1);
  });
});

// ---- the block as the runbook prescribes: ONE request ---------------------------------------------------------------------
const CHECK_QUERY = `select employee_number, credential_version, locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u where role = 'owner'`;
const auditCount = async (c: Conn) =>
  Number(((await c.unsafe(`select count(*)::int as n from activity_log where action = 'OWNER_PASSWORD_RECOVERY'`))[0] as unknown as { n: number }).n);

Deno.test("single request: the driver really sends one simple-protocol message (several statements in one message work with .simple(); the extended protocol refuses them)", async () => {
  const c = connect();
  try {
    const res = await c.unsafe("select 1 as a; select 2 as b").simple();
    assertEquals(res.length, 2, "two result sets came back from ONE request: the simple query protocol");
    // the extended protocol (parse/bind/execute, used when parameters are sent) refuses several statements in one message
    const err = await errMsg(c.unsafe("select 1 as a; select $1::int as b", [2]).then((x) => x));
    assert(err !== null, "the same kind of text sent with parameters (extended protocol) is refused");
    assertStringIncludes(err.message, "multiple commands");
  } finally {
    await c.end({ timeout: 5 }).catch(() => {});
  }
});

Deno.test("single request: the whole block with a valid password succeeds in one request", async () => {
  await withOwner(async ({ setup, r, l, owner }) => {
    const audits = await auditCount(setup);
    await sendWhole(r, await blockText());
    const row = (await setup.unsafe(CHECK_QUERY))[0] as unknown as { credential_version: number; live_sessions: string | number };
    assertEquals((await setup.unsafe(CHECK_QUERY)).length, 1, "the check query returns exactly one row");
    assertEquals(Number(row.live_sessions), 0);
    assertEquals(row.credential_version, owner.credential_version + 1);
    assertEquals((await verifyAs(l, NEW_PW)).ok, true, "the new password verifies");
    assertEquals((await verifyAs(l, SEEDED)).ok, false, "the old one does not");
    assertEquals(await auditCount(setup), audits + 1, "exactly one OWNER_PASSWORD_RECOVERY row was added");
  });
});

/** Nothing changed and the owner row is not locked by the failed connection `r` (checked from `other`, before any rollback on r). */
async function assertFailedRequestLeftNothing({ setup, r, other, owner }: Ctx, audits: number, expected: string) {
  const st = await state(setup, owner, crypto.randomUUID());
  assertEquals([st.is_old, st.credential_version, st.unrevoked, await auditCount(setup)], [true, owner.credential_version, owner.live.length, audits], `${expected}: nothing changed`);
  await other.unsafe("begin");
  const got = await other.unsafe(`select id from app_users where role = 'owner' for update nowait`);
  assertEquals(got.length, 1, "the owner row is not left locked: another connection locks it with NOWAIT, no rollback sent on r yet");
  await other.unsafe("rollback");
  await r.unsafe("rollback"); // only now
  assertEquals(((await r.unsafe("select 1 as ok"))[0] as unknown as { ok: number }).ok, 1, "the failed connection is usable after rollback");
}

Deno.test("single request: the placeholder left in stops the block with STOP:, changes nothing and leaves no lock", async () => {
  await withOwner(async (ctx) => {
    const audits = await auditCount(ctx.setup);
    const err = await errMsg(sendWhole(ctx.r, await blockText(PLACEHOLDER)));
    assert(err !== null, "the request must fail");
    assertStringIncludes(err.message, "STOP:");
    assertStringIncludes(err.message, "placeholder");
    await assertFailedRequestLeftNothing(ctx, audits, "placeholder");
  });
});

Deno.test("single request: a 10-character password is refused with SECRET_WEAK, changes nothing and leaves no lock", async () => {
  await withOwner(async (ctx) => {
    const audits = await auditCount(ctx.setup);
    const err = await errMsg(sendWhole(ctx.r, await blockText("tenchars12")));
    assert(err !== null, "the request must fail");
    assertStringIncludes(err.message, "SECRET_WEAK");
    await assertFailedRequestLeftNothing(ctx, audits, "weak password");
  });
});

Deno.test("single request: a login verified with the old password before the request cannot register after it", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l); // committed
    await sendWhole(r, await blockText()); // runs to completion and commits by itself
    const err = await errMsg(asService(l, () => register(l, owner.id, sid, v)));
    assert(err !== null, "the late registration must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    const st = await state(setup, owner, sid);
    assertEquals([st.sid_rows, st.unrevoked, st.credential_version], [0, 0, owner.credential_version + 1]);
  });
});

Deno.test("single request: a session registered before the request is revoked by it", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l);
    await asService(l, () => register(l, owner.id, sid, v)); // committed
    await sendWhole(r, await blockText());
    const row = (await setup.unsafe(`select revoked_at is not null as revoked from app_sessions where session_id = $1`, [sid]))[0] as unknown as { revoked: boolean };
    assertEquals(row.revoked, true);
    assertEquals((await state(setup, owner, sid)).unrevoked, 0);
  });
});

// ---- the statements run OUTSIDE the block's single transaction ----------------------------------------------------------
// Since the runbook hardening, statements 5-7 carry current_setting('recovery.new_password') <> '' and so do nothing
// unless statement 2 set the password in the same transaction.
type Full = { hash: string; version: number; failed: number; locked: string | null; sessions: string; audits: number };
async function fullSnapshot(setup: Conn): Promise<Full> {
  const o = (await setup.unsafe(
    `select s.secret_hash as hash, u.credential_version as version, u.failed_attempts as failed, u.locked_until::text as locked,
            (select coalesce(string_agg(a.session_id::text || ':' || coalesce(a.revoked_at::text, '-'), ',' order by a.session_id), '')
               from app_sessions a where a.user_id = u.id) as sessions,
            (select count(*)::int from activity_log where action = 'OWNER_PASSWORD_RECOVERY') as audits
       from app_users u join app_user_secrets s on s.user_id = u.id where u.role = 'owner'`))[0] as unknown as Full;
  return o;
}
const LABELS = ["begin", "lock", "set_config", "guard", "secret", "version bump", "revoke sessions", "audit row", "commit"];
/** Runs one statement and describes what happened: "ok rows=N" or "ERROR <message>". */
async function runOne(c: Conn, sql: string): Promise<{ text: string; error: boolean; rows: number }> {
  try {
    const res = await c.unsafe(sql);
    return { text: `ok rows=${res.count ?? res.length}`, error: false, rows: Number(res.count ?? res.length) };
  } catch (e) {
    return { text: `ERROR ${(e as Error).message}`, error: true, rows: 0 };
  }
}

Deno.test("statements run separately on fresh connections change nothing (every statement after the first either fails or affects no rows)", async () => {
  await withOwner(async ({ setup, l, owner }) => {
    const stmts = await block();
    const before = await fullSnapshot(setup);
    const outcomes: string[] = [];
    for (const [i, sql] of stmts.entries()) {
      const c = connect(); // a fresh connection per statement: no shared transaction, no shared settings
      try {
        const o = await runOne(c, sql);
        outcomes.push(`${i} ${LABELS[i]}: ${o.text}`);
        if (i >= 3 && i <= 7) assert(o.error || o.rows === 0, `statement ${i} must fail or affect no rows, got ${o.text}`);
      } finally {
        await c.end({ timeout: 5 }).catch(() => {});
      }
    }
    console.log("SEPARATE FRESH CONNECTIONS, per statement:\n  " + outcomes.join("\n  "));
    assertEquals(await fullSnapshot(setup), before, "hash, version, lock fields, every session and the audit log are exactly as before");
    assertEquals((await verifyAs(l, SEEDED)).ok, true, "the old password still verifies");
    assertEquals(before.version, owner.credential_version);
  });
});

Deno.test("statements run one by one on ONE connection in autocommit mode (no begin/commit) change nothing", async () => {
  await withOwner(async ({ setup, r, l }) => {
    const stmts = await block();
    const before = await fullSnapshot(setup);
    const outcomes: string[] = [];
    for (let i = 1; i <= 7; i++) { // begin and commit left out: every statement commits by itself
      const o = await runOne(r, stmts[i]);
      outcomes.push(`${i} ${LABELS[i]}: ${o.text}`);
      if (i >= 4 && i <= 7) assert(o.error || o.rows === 0, `statement ${i} must fail or affect no rows, got ${o.text}`);
    }
    console.log("SEPARATE, ONE CONNECTION, AUTOCOMMIT, per statement:\n  " + outcomes.join("\n  "));
    assertEquals(await fullSnapshot(setup), before, "everything is exactly as before");
    assertEquals((await verifyAs(l, SEEDED)).ok, true, "the old password still verifies");
  });
});

Deno.test("statements sent one by one on one connection WITH begin and commit as separate requests are a real transaction and succeed", async () => {
  await withOwner(async ({ setup, r, l, owner }) => {
    const stmts = await block();
    const before = await fullSnapshot(setup);
    for (const sql of stmts) await r.unsafe(sql); // begin; ...; commit; each its own request, same session
    const after = await fullSnapshot(setup);
    const row = (await setup.unsafe(CHECK_QUERY))[0] as unknown as { credential_version: number; live_sessions: string | number };
    assertEquals(row.credential_version, owner.credential_version + 1, "version +1");
    assertEquals(Number(row.live_sessions), 0, "every owner session revoked");
    assertEquals(after.audits, before.audits + 1, "exactly one OWNER_PASSWORD_RECOVERY row");
    assertEquals((await verifyAs(l, NEW_PW)).ok, true, "the new password works");
    assertEquals((await verifyAs(l, SEEDED)).ok, false, "the old one does not");
  });
});

// ---- the loader ---------------------------------------------------------------------------------------------------------
Deno.test("runbook block loader: splits respecting dollar quotes and fails loudly on a wrong shape", () => {
  const good = "## 1. x\n\n## 2. Password lost\n\n```sql\nbegin;\n-- c\nselect id from app_users where role = 'owner' for update;\nselect set_config('recovery.new_password', $pw$PUT-NEW-PASSWORD-HERE$pw$, true);\ndo $guard$\nbegin\n  if 1 = 2 then raise exception 'STOP: x'; end if;\nend\n$guard$;\nupdate a set b = 1;\nupdate c set d = 2 where current_setting('recovery.new_password') <> '';\nupdate e set f = 3 where current_setting('recovery.new_password') <> '';\nselect 1 where current_setting('recovery.new_password') <> '';\ncommit;\n```\n\n## 3. next\n";
  const s = loadRecoveryBlock(good, "a;b'c$d");
  assertEquals(s.length, 9);
  assertStringIncludes(s[2], "$pw$a;b'c$d$pw$");
  assertStringIncludes(s[3], "raise exception 'STOP: x'; end if;"); // the semicolons of the do block stay inside one statement
  const must = (md: string, text: string) => {
    let msg = "";
    try { loadRecoveryBlock(md, "pw"); } catch (e) { msg = (e as Error).message; }
    assertStringIncludes(msg, text);
  };
  must("nothing", "heading");
  must(good.replace("```sql", "```text"), "no fenced sql block");
  must(good.replace("begin;\n-- c", "-- c"), "begin");
  must(good.replace("commit;\n", ""), "commit");
  must(good.replace("select id from app_users where role = 'owner' for update;", "select 1;"), "for update");
  must(good.replace("PUT-NEW-PASSWORD-HERE", "something"), "exactly once");
  must(good.replace("$pw$PUT-NEW-PASSWORD-HERE$pw$", "'PUT-NEW-PASSWORD-HERE'"), "$pw$");
  must(good.replace("select set_config('recovery.new_password'", "select set_config('x'"), "set_config");
  must(good.replace("do $guard$", "do $g$").replace("$guard$;", "$g$;"), "guard");
  must(good.replace("commit;", "select 2;\ncommit;"), "expected begin");
  must(good.replace("update c set d = 2 where current_setting('recovery.new_password') <> '';", "update c set d = 2;"), "statement 5");
  must(good.replace("update e set f = 3 where current_setting('recovery.new_password') <> '';", "update e set f = 3;"), "statement 6");
  must(good.replace("select 1 where current_setting('recovery.new_password') <> '';", "select 1;"), "statement 7");
});
Deno.test("splitSql: quotes, doubled quotes, comments and dollar bodies", () => {
  assertEquals(splitSql("select 'a;b'; select 'it''s;'; -- x;\nselect $q$;$q$;"), ["select 'a;b'", "select 'it''s;'", "select $q$;$q$"]);
  let threw = false;
  try { splitSql("select 1"); } catch { threw = true; }
  assert(threw, "a trailing statement without a semicolon is an error");
});
