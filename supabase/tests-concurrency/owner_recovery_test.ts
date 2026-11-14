// Owner password recovery (docs/runbooks/owner-account-recovery.md, section 2) on real, separate connections.
//
// The SQL under test is NOT copied here: it is read from the runbook file, so the runbook and this test cannot
// drift apart. The block is `begin; do $recovery$ ... $recovery$; commit;`: ONE statement does all the work.
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

/** begin, the one do statement, commit; fails loudly if the block has the wrong shape. */
export function loadRecoveryBlock(md: string, password: string): string[] {
  const stmts = splitSql(rawRecoveryBlock(md, password));
  if (stmts.length !== 3) throw new Error(`runbook block: expected exactly 3 statements (begin, one do block, commit), got ${stmts.length}`);
  if (stmts[0].toLowerCase() !== "begin") throw new Error("runbook block must start with begin;");
  if (stmts[2].toLowerCase() !== "commit") throw new Error("runbook block must end with commit;");
  const d = stmts[1];
  if (!/^do \$recovery\$/.test(d) || !d.endsWith("$recovery$")) throw new Error("runbook block: the middle statement must be one do $recovery$ ... $recovery$ block");
  for (const need of ["'PUT-NEW-' || 'PASSWORD-HERE'", "app.clean_secret('owner'", "credential_version = credential_version + 1", "revoked_at", "app.log_action"]) {
    if (!d.includes(need)) throw new Error(`runbook block: the do body must contain ${need}`);
  }
  const lock = d.indexOf("for update");
  if (lock < 0) throw new Error("runbook block: the do body must lock the owner row with for update");
  for (const change of ["insert into", "update app_users", "update app_sessions"]) {
    const at = d.indexOf(change);
    if (at < 0) throw new Error(`runbook block: the do body must contain ${change}`);
    if (lock > at) throw new Error(`runbook block: for update must come before the first ${change}`);
  }
  return stmts;
}
const blockOf = async () => await Deno.readTextFile(RUNBOOK);
/** The whole block as the person pastes it: one text, comments and all (shape-checked first). */
async function blockText(password = NEW_PW): Promise<string> {
  const md = await blockOf();
  loadRecoveryBlock(md, PLACEHOLDER); // shape check against the template, whatever the password
  return rawRecoveryBlock(md, password);
}
/** begin / the do statement / commit as separate texts. The shape is checked on the template; the password is put in afterwards. */
async function parts(password = NEW_PW): Promise<{ begin: string; doText: string; commit: string }> {
  const t = loadRecoveryBlock(await blockOf(), PLACEHOLDER);
  return { begin: t[0], doText: t[1].replace(`$pw$${PLACEHOLDER}$pw$`, () => `$pw$${password}$pw$`), commit: t[2] };
}
/** Sends `text` as ONE simple-protocol message (several statements in one request). */
const sendWhole = (c: Conn, text: string) => c.unsafe(text).simple().then((x) => x);

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
/**
 * Opens the connections, optionally primes the lock fields to non-default values (3 failed attempts and a lock one
 * hour ahead, so that "cleared" and "unchanged" are both visible), runs `fn`, always rolls back and restores the
 * owner, rethrows the first error.
 */
async function withOwner(fn: (c: Ctx) => Promise<void>, opts: { prime?: boolean } = {}) {
  const setup = connect(), r = connect(), l = connect(), admin = connect(), other = connect();
  const created: string[] = [];
  let owner: Owner | null = null;
  let failure: unknown = null;
  let restoreError: Error | null = null;
  try {
    owner = await readOwner(setup);
    if (opts.prime) await setup.unsafe(`update app_users set failed_attempts = 3, locked_until = clock_timestamp() + interval '1 hour' where id = $1`, [owner.id]);
    await fn({ setup, r, l, admin, other, owner, created });
  } catch (e) {
    failure = e;
  } finally {
    for (const c of [l, other, r]) await rollbackQuietly(c); // l first: it may hold the lock another connection is waiting for
    restoreError = await cleanUp(setup, owner, created);
    for (const c of [setup, r, l, admin, other]) await c.end({ timeout: 5 }).catch(() => {});
  }
  if (failure) throw failure;
  if (restoreError) throw restoreError;
}
const unlock = (setup: Conn, owner: Owner) => setup.unsafe(`update app_users set locked_until = null where id = $1`, [owner.id]);

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
const errMsg = (p: PromiseLike<unknown>) => p.then(() => null as Error | null, (e: unknown) => e as Error);

/** Everything a recovery may change, in one comparable value. */
type Full = { hash: string; version: number; failed: number; locked: string | null; sessions: string; audits: number };
async function fullSnapshot(setup: Conn): Promise<Full> {
  return (await setup.unsafe(
    `select s.secret_hash as hash, u.credential_version as version, u.failed_attempts as failed, u.locked_until::text as locked,
            (select coalesce(string_agg(a.session_id::text || ':' || coalesce(a.revoked_at::text, '-'), ',' order by a.session_id), '')
               from app_sessions a where a.user_id = u.id) as sessions,
            (select count(*)::int from activity_log where action = 'OWNER_PASSWORD_RECOVERY') as audits
       from app_users u join app_user_secrets s on s.user_id = u.id where u.role = 'owner'`))[0] as unknown as Full;
}
const passwordMatches = async (setup: Conn, pw: string) =>
  ((await setup.unsafe(`select (extensions.crypt($1, s.secret_hash) = s.secret_hash) as ok from app_user_secrets s join app_users u on u.id = s.user_id where u.role = 'owner'`, [pw]))[0] as unknown as { ok: boolean }).ok;
const CHECK_QUERY = `select employee_number, credential_version, locked_until,
       (select count(*) from app_sessions s where s.user_id = u.id and s.revoked_at is null) as live_sessions
from app_users u where role = 'owner'`;

/** The normal success, compared with a snapshot taken before; lock fields cleared. `times` = how many recoveries ran. */
async function assertRecovered(ctx: Ctx, before: Full, pw: string, times = 1) {
  const { setup, l, owner } = ctx;
  const after = await fullSnapshot(setup);
  const rows = await setup.unsafe(CHECK_QUERY);
  assertEquals(rows.length, 1, "the check query returns exactly one row");
  const row = rows[0] as unknown as { credential_version: number; live_sessions: string | number; locked_until: unknown };
  assertEquals(Number(row.live_sessions), 0, "live_sessions = 0");
  assertEquals(row.credential_version, owner.credential_version + times, "credential_version up by the number of runs");
  assertEquals([after.failed, after.locked], [0, null], "failed_attempts and locked_until are cleared");
  assertEquals(after.audits, before.audits + times, "one OWNER_PASSWORD_RECOVERY row per run");
  assertEquals(await passwordMatches(setup, pw), true, "the stored hash is the new password");
  assertEquals((await verifyAs(l, pw)).ok, true, "the new password verifies");
  assertEquals((await verifyAs(l, SEEDED)).ok, false, "the old password does not");
}
/** Nothing changed: the full snapshot is identical, and the old password still verifies. */
async function assertUnchanged(ctx: Ctx, before: Full, why: string, forbiddenPassword?: string) {
  const { setup, l, owner } = ctx;
  assertEquals(await fullSnapshot(setup), before, `${why}: hash, version, lock fields, every session and the audit count are exactly as before`);
  if (forbiddenPassword !== undefined) assertEquals(await passwordMatches(setup, forbiddenPassword), false, `${why}: the stored hash is not a hash of the refused password`);
  await unlock(setup, owner); // the lock was primed: lift it so that the old password can be tried
  assertEquals((await verifyAs(l, SEEDED)).ok, true, `${why}: the old password still verifies`);
  // a successful login clears the counters: put the primed values back so that the next comparison is meaningful
  await setup.unsafe(`update app_users set failed_attempts = $2, locked_until = $3::text::timestamptz where id = $1`, [owner.id, before.failed, before.locked]);
}

// ---- the driver ------------------------------------------------------------------------------------------------------
Deno.test("the driver really sends one simple-protocol message (several statements in one message work with .simple(); the extended protocol refuses them)", async () => {
  const c = connect();
  try {
    const res = await c.unsafe("select 1 as a; select 2 as b").simple();
    assertEquals(res.length, 2, "two result sets came back from ONE request: the simple query protocol");
    const err = await errMsg(c.unsafe("select 1 as a; select $1::int as b", [2]));
    assert(err !== null, "the same kind of text sent with parameters (extended protocol) is refused");
    assertStringIncludes(err.message, "multiple commands");
  } finally {
    await c.end({ timeout: 5 }).catch(() => {});
  }
});

// ---- races with a login -------------------------------------------------------------------------------------------------
Deno.test("2a. a login verified with the old password before the recovery cannot register after it (USER_INVALID, no session)", async () => {
  await withOwner(async (ctx) => {
    const { setup, r, l, owner, created } = ctx;
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l); // committed, version v
    await sendWhole(r, await blockText()); // the whole block, runs to completion and commits
    const err = await errMsg(asService(l, () => register(l, owner.id, sid, v)));
    assert(err !== null, "the late registration must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    const n = (await setup.unsafe(`select count(*)::int as n from app_sessions where session_id = $1`, [sid]))[0] as unknown as { n: number };
    assertEquals(n.n, 0, "no session row");
    assertEquals(Number(((await setup.unsafe(CHECK_QUERY))[0] as unknown as { live_sessions: number }).live_sessions), 0);
  });
});

Deno.test("2b. a registration that arrives while the recovery holds the lock waits for R, then is refused", async () => {
  await withOwner(async ({ setup, r, l, admin, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l);
    const { begin, doText, commit } = await parts();
    const pidL = await backendPid(l), pidR = await backendPid(r);
    await r.unsafe(begin);
    await r.unsafe(doText); // the recovery has done everything and holds the lock; no commit yet
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = errMsg(register(l, owner.id, sid, v));
    await waitUntilBlockedBy(admin, pidL, pidR); // L waits, and for R specifically
    await r.unsafe(commit);
    const err = await outcome;
    await rollbackQuietly(l);
    assert(err !== null, "the registration that was waiting must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    const n = (await setup.unsafe(`select count(*)::int as n from app_sessions where session_id = $1`, [sid]))[0] as unknown as { n: number };
    assertEquals(n.n, 0, "no row for that session id");
    assertEquals(Number(((await setup.unsafe(CHECK_QUERY))[0] as unknown as { live_sessions: number }).live_sessions), 0, "no unrevoked owner session");
  });
});

Deno.test("2c. a registration that holds the row lock FIRST makes the recovery wait for L, and the session it registered is then revoked", async () => {
  await withOwner(async ({ setup, r, l, admin, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l);
    const pidL = await backendPid(l), pidR = await backendPid(r);
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    await register(l, owner.id, sid, v).then((x) => x); // succeeds, NOT committed: L holds the owner row lock and an uncommitted session row
    const { begin, doText, commit } = await parts();
    await r.unsafe(begin);
    const recovery = errMsg(r.unsafe(doText).then((x) => x));
    await waitUntilBlockedBy(admin, pidR, pidL); // the recovery waits, for L specifically
    await l.unsafe("commit");
    assertEquals(await recovery, null, "the recovery completes once L has committed");
    await r.unsafe(commit);
    const row = (await setup.unsafe(`select revoked_at is not null as revoked from app_sessions where session_id = $1`, [sid]))[0] as unknown as { revoked: boolean };
    assertEquals(row.revoked, true, "the session L registered is revoked: the block's revocation saw it");
    assertEquals(Number(((await setup.unsafe(CHECK_QUERY))[0] as unknown as { live_sessions: number }).live_sessions), 0);
  });
});

Deno.test("2d. login_verify with the OLD password during the recovery waits for R and is refused (failed_attempts 1)", async () => {
  await withOwner(async ({ setup, r, l, admin, owner }) => {
    const { begin, doText, commit } = await parts();
    const pidL = await backendPid(l), pidR = await backendPid(r);
    await r.unsafe(begin);
    await r.unsafe(doText);
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = l.unsafe(`select public.login_verify('100', $1) as r`, [SEEDED]).then((rows) => rows); // .then starts the lazy query
    await waitUntilBlockedBy(admin, pidL, pidR);
    await r.unsafe(commit);
    const res = ((await outcome)[0] as unknown as { r: Verify }).r;
    await l.unsafe("commit");
    assertEquals([res.ok, res.reason], [false, "invalid"], "the old password is wrong once the recovery has committed");
    const st = await fullSnapshot(setup);
    assertEquals(st.failed, 1, "the refused attempt counted once (the block had cleared the counter)");
    assertEquals(st.version, owner.credential_version + 1);
  });
});

Deno.test("2d. login_verify with the NEW password during the recovery waits for R, then succeeds with the new version", async () => {
  await withOwner(async ({ r, l, admin, owner }) => {
    const { begin, doText, commit } = await parts();
    const pidL = await backendPid(l), pidR = await backendPid(r);
    await r.unsafe(begin);
    await r.unsafe(doText);
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = l.unsafe(`select public.login_verify('100', $1) as r`, [NEW_PW]).then((rows) => rows);
    await waitUntilBlockedBy(admin, pidL, pidR);
    await r.unsafe(commit);
    const res = ((await outcome)[0] as unknown as { r: Verify }).r;
    await l.unsafe("commit");
    assertEquals(res.ok, true);
    assertEquals(res.credential_version, owner.credential_version + 1);
  });
});

Deno.test("2e. the lock comes before any change: while the recovery waits for L's row lock it holds no RowExclusiveLock on app_user_secrets, app_sessions or app_users", async () => {
  await withOwner(async (ctx) => {
    const { setup, r, l, admin } = ctx;
    const before = await fullSnapshot(setup);
    const pidL = await backendPid(l), pidR = await backendPid(r);
    await l.unsafe("begin");
    await l.unsafe("select id from app_users where role = 'owner' for update"); // L holds the owner row
    const recovery = errMsg(sendWhole(r, await blockText())); // the whole block, one request
    await waitUntilBlockedBy(admin, pidR, pidL);
    const locks = await admin.unsafe(
      `select l.locktype, l.mode, l.granted, c.relname
         from pg_locks l left join pg_class c on c.oid = l.relation where l.pid = ${Number(pidR)}`) as unknown as
      Array<{ locktype: string; mode: string; granted: boolean; relname: string | null }>;
    console.log("R's locks while waiting:", JSON.stringify(locks.map((x) => [x.locktype, x.mode, x.granted, x.relname])));
    const writes = locks.filter((x) => x.mode === "RowExclusiveLock" && ["app_user_secrets", "app_sessions", "app_users"].includes(x.relname ?? ""));
    assertEquals(writes, [], "R has not started any insert or update: no RowExclusiveLock on the three tables");
    assert(locks.some((x) => !x.granted && (x.locktype === "tuple" || x.locktype === "transactionid")), "R is waiting for a tuple/transaction lock (the owner row held by L)");
    assertEquals((await fullSnapshot(setup)).hash, before.hash, "nothing has been stored yet");
    await l.unsafe("rollback");
    assertEquals(await recovery, null, "once L lets go the recovery completes");
    await assertRecovered(ctx, before, NEW_PW);
  });
});

// ---- all-or-nothing, in every client mode --------------------------------------------------------------------------------
Deno.test("f1. one multi-statement request: success; lock fields cleared, one audit row, check query one row", async () => {
  await withOwner(async (ctx) => {
    const before = await fullSnapshot(ctx.setup);
    assertEquals([before.failed, before.locked !== null], [3, true], "the lock fields are primed");
    await sendWhole(ctx.r, await blockText());
    await assertRecovered(ctx, before, NEW_PW);
  }, { prime: true });
});

/** The whole block as one request fails with `expected`, leaves an aborted transaction without a lock, and changed nothing. */
async function singleRequestRefused(pw: string, expected: string) {
  await withOwner(async (ctx) => {
    const { setup, r, other } = ctx;
    const before = await fullSnapshot(setup);
    const err = await errMsg(sendWhole(r, await blockText(pw)));
    assert(err !== null, "the request must fail");
    assertStringIncludes(err.message, expected);
    const later = await errMsg(r.unsafe("select 1").then((x) => x));
    assert(later !== null, "the connection is in an aborted transaction (it refuses further statements) before any rollback");
    assertStringIncludes(later.message, "aborted");
    await other.unsafe("begin");
    const got = await other.unsafe(`select id from app_users where role = 'owner' for update nowait`);
    assertEquals(got.length, 1, "the owner row is not locked: a second connection gets it with NOWAIT while r is still aborted");
    await other.unsafe("rollback");
    await r.unsafe("rollback");
    assertEquals(((await r.unsafe("select 1 as ok"))[0] as unknown as { ok: number }).ok, 1, "r is usable after the rollback");
    await assertUnchanged(ctx, before, expected, pw);
  }, { prime: true });
}
Deno.test("f2. one request, placeholder left in: STOP:, nothing changed, no lock left", async () => {
  await singleRequestRefused(PLACEHOLDER, "STOP: the placeholder was not replaced");
});
Deno.test("f3. one request, 10-character password: SECRET_WEAK, nothing changed", async () => {
  await singleRequestRefused("tenchars12", "SECRET_WEAK");
});
Deno.test("f4. one request, 73-byte password: SECRET_TOO_LONG, nothing changed", async () => {
  await singleRequestRefused("a".repeat(73), "SECRET_TOO_LONG");
});
Deno.test("f5. one request, password with a tab: SECRET_INVALID, nothing changed", async () => {
  await singleRequestRefused("brand new\towner pass 123", "SECRET_INVALID");
});

Deno.test("f6. begin, the do statement and commit as three separate requests on one session: success", async () => {
  await withOwner(async (ctx) => {
    const before = await fullSnapshot(ctx.setup);
    const { begin, doText, commit } = await parts();
    for (const sql of [begin, doText, commit]) await ctx.r.unsafe(sql);
    await assertRecovered(ctx, before, NEW_PW);
  }, { prime: true });
});

Deno.test("f7. one session, autocommit, only the do statement (begin and commit skipped): success, atomically, exactly once", async () => {
  await withOwner(async (ctx) => {
    const before = await fullSnapshot(ctx.setup);
    await ctx.r.unsafe((await parts()).doText);
    await assertRecovered(ctx, before, NEW_PW);
  }, { prime: true });
});

Deno.test("f8. each statement on its own fresh connection (begin, do, commit): the do succeeds atomically on its own; begin and commit are harmless", async () => {
  await withOwner(async (ctx) => {
    const before = await fullSnapshot(ctx.setup);
    for (const sql of Object.values(await parts())) {
      const c = connect();
      try {
        await c.unsafe(sql);
      } finally {
        await c.end({ timeout: 5 }).catch(() => {});
      }
    }
    await assertRecovered(ctx, before, NEW_PW);
  }, { prime: true });
});

Deno.test("f9. continue-on-error / savepoint per statement: a refused block is undone completely, a valid one succeeds", async () => {
  await withOwner(async (ctx) => {
    const { setup, r } = ctx;
    const before = await fullSnapshot(setup);
    for (const [pw, expected] of [[PLACEHOLDER, "STOP:"], ["tenchars12", "SECRET_WEAK"]] as const) {
      const { doText } = await parts(pw);
      await r.unsafe("begin");
      await r.unsafe("savepoint s1");
      const err = await errMsg(r.unsafe(doText).then((x) => x));
      assert(err !== null);
      assertStringIncludes(err.message, expected);
      await r.unsafe("rollback to savepoint s1");
      await r.unsafe("commit"); // the client carries on and commits anyway
      await assertUnchanged(ctx, before, `savepoint mode, ${expected}`, pw);
    }
    // the same wrapping with a valid password: full success
    const { doText } = await parts();
    await r.unsafe("begin");
    await r.unsafe("savepoint s1");
    await r.unsafe(doText);
    await r.unsafe("release savepoint s1");
    await r.unsafe("commit");
    await assertRecovered(ctx, before, NEW_PW);
  }, { prime: true });
});
Deno.test("f10. the block run twice with two passwords: the second works, the first does not, version +2, two audit rows", async () => {
  await withOwner(async (ctx) => {
    const { setup, r, l } = ctx;
    const before = await fullSnapshot(setup);
    const FIRST = "first recovery pass 111", SECOND = "second recovery pass 222";
    await sendWhole(r, await blockText(FIRST));
    await sendWhole(r, await blockText(SECOND));
    await assertRecovered(ctx, before, SECOND, 2);
    assertEquals((await verifyAs(l, FIRST)).ok, false, "the first password no longer works");
  }, { prime: true });
});

Deno.test("f11. a session registered before the recovery is revoked by it", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
    const sid = crypto.randomUUID();
    created.push(sid);
    const v = await verifyOk(l);
    await asService(l, () => register(l, owner.id, sid, v)); // committed
    await sendWhole(r, await blockText());
    const row = (await setup.unsafe(`select revoked_at is not null as revoked from app_sessions where session_id = $1`, [sid]))[0] as unknown as { revoked: boolean };
    assertEquals(row.revoked, true);
    assertEquals(Number(((await setup.unsafe(CHECK_QUERY))[0] as unknown as { live_sessions: number }).live_sessions), 0);
  });
});

// ---- special characters ---------------------------------------------------------------------------------------------------
Deno.test("g1. a password with quote, double quote, backslash, semicolon and a dollar goes through unaltered", async () => {
  const P = `it's "q"; back\\slash $x$ ok 123`;
  for (const mode of ["single request", "separate requests"]) {
    await withOwner(async (ctx) => {
      const before = await fullSnapshot(ctx.setup);
      if (mode === "single request") await sendWhole(ctx.r, await blockText(P));
      else for (const sql of Object.values(await parts(P))) await ctx.r.unsafe(sql);
      await assertRecovered(ctx, before, P);
      assertEquals((await verifyAs(ctx.l, P.replace("ok", "ko"))).ok, false, "one changed character is refused");
    }, { prime: true });
  }
});

// A password that contains the closing marker of a dollar quote ends the quoting early: the statement is a syntax
// error and NOTHING is changed (the runbook says so). What the connection looks like afterwards is recorded.
for (const marker of ["$pw$", "$recovery$"]) {
  Deno.test(`g2. a password containing ${marker}: syntax error, nothing changed (single request and separate requests)`, async () => {
    const P = `first${marker}second pass 12345`;
    await withOwner(async (ctx) => {
      const before = await fullSnapshot(ctx.setup);
      const e1 = await errMsg(sendWhole(ctx.r, await blockText(P)));
      assert(e1 !== null, "the single request fails");
      console.log(`${marker} single request ->`, e1.message.slice(0, 80));
      await rollbackQuietly(ctx.r);
      await assertUnchanged(ctx, before, `${marker} single request`, P);
      const { begin, doText, commit } = await parts(P);
      await ctx.r.unsafe(begin);
      const e2 = await errMsg(ctx.r.unsafe(doText).then((x) => x));
      assert(e2 !== null, "the do statement fails");
      console.log(`${marker} separate requests ->`, e2.message.slice(0, 80));
      await ctx.r.unsafe(commit); // acts as a rollback in the aborted transaction
      await assertUnchanged(ctx, before, `${marker} separate requests`, P);
    }, { prime: true });
  });
}

// ---- the original defect -----------------------------------------------------------------------------------------------
// DEMONSTRATION of the defect the lock closes (the first runbook order, merely wrapped in a transaction); it does not
// guard the current runbook (the tests above do that).
Deno.test("h. DEMONSTRATION, old order in a transaction, no row lock: a verified login keeps its session -- this is why the runbook locks first", async () => {
  await withOwner(async ({ setup, r, l, owner, created }) => {
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

// ---- the loader ---------------------------------------------------------------------------------------------------------
const GOOD = "## 1. x\n\n## 2. Password lost\n\n```sql\nbegin;\n\ndo $recovery$\ndeclare\n  v_new text := $pw$PUT-NEW-PASSWORD-HERE$pw$;\nbegin\n  select id into v_owner from app_users where role = 'owner' for update;\n  if v_new = 'PUT-NEW-' || 'PASSWORD-HERE' then raise exception 'STOP: x'; end if;\n  insert into app_user_secrets values (v_owner, app.clean_secret('owner', v_new));\n  update app_users set credential_version = credential_version + 1 where id = v_owner;\n  update app_sessions set revoked_at = now() where user_id = v_owner;\n  perform app.log_action(v_owner, 'OWNER_PASSWORD_RECOVERY');\nend\n$recovery$;\n\ncommit;\n```\n\n## 3. next\n";
Deno.test("runbook block loader: accepts the expected shape, puts the password only in the $pw$ literal, fails loudly otherwise", () => {
  const s = loadRecoveryBlock(GOOD, "a;b'c$d");
  assertEquals(s.length, 3);
  assertStringIncludes(rawRecoveryBlock(GOOD, "a;b'c$d"), "$pw$a;b'c$d$pw$");
  const must = (md: string, text: string) => {
    let msg = "";
    try { loadRecoveryBlock(md, "pw"); } catch (e) { msg = (e as Error).message; }
    assertStringIncludes(msg, text);
  };
  must("nothing", "heading");
  must(GOOD.replace("```sql", "```text"), "no fenced sql block");
  must(GOOD.replace("PUT-NEW-PASSWORD-HERE", "something"), "exactly once");
  must(GOOD.replace("$pw$PUT-NEW-PASSWORD-HERE$pw$", "'PUT-NEW-PASSWORD-HERE'"), "$pw$");
  must(GOOD.replace("begin;\n\ndo", "do"), "exactly 3 statements");
  must(GOOD.replace("commit;\n", ""), "exactly 3 statements");
  must(GOOD.replace("begin;\n\ndo", "select 1;\ndo"), "begin");
  must(GOOD.replace("\ncommit;", "\nselect 1;"), "commit");
  must(GOOD.replaceAll("$recovery$", "$r$"), "do $recovery$");
  must(GOOD.replace("'PUT-NEW-' || 'PASSWORD-HERE'", "'x'"), "'PUT-NEW-' || 'PASSWORD-HERE'");
  must(GOOD.replace("app.clean_secret('owner', v_new)", "v_new"), "app.clean_secret('owner'");
  must(GOOD.replace("credential_version = credential_version + 1", "credential_version = 1"), "credential_version");
  must(GOOD.replace("revoked_at = now()", "x = now()"), "revoked_at");
  must(GOOD.replace("app.log_action", "app.nothing"), "app.log_action");
  must(GOOD.replace(" for update;", ";"), "for update");
  // for update after the first insert
  must(GOOD.replace(" for update;", ";").replace("insert into app_user_secrets values (v_owner, app.clean_secret('owner', v_new));", "insert into app_user_secrets values (v_owner, app.clean_secret('owner', v_new));\n  perform 1 from app_users where role = 'owner' for update;"), "must come before the first insert into");
});
Deno.test("splitSql: quotes, doubled quotes, comments and dollar bodies", () => {
  assertEquals(splitSql("select 'a;b'; select 'it''s;'; -- x;\nselect $q$;$q$;"), ["select 'a;b'", "select 'it''s;'", "select $q$;$q$"]);
  assertEquals(splitSql("do $r$ begin v := $pw$a;b$pw$; end $r$;"), ["do $r$ begin v := $pw$a;b$pw$; end $r$"]);
  let threw = false;
  try { splitSql("select 1"); } catch { threw = true; }
  assert(threw, "a trailing statement without a semicolon is an error");
});
