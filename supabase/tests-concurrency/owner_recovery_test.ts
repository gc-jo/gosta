// Owner password recovery (docs/runbooks/owner-account-recovery.md, section 2) on real, separate connections.
//
// The SQL under test is NOT copied here: it is read from the runbook file, so the runbook and this test cannot
// drift apart. The block is `begin; select ... for update; <secret>; <version>; <sessions>; commit;`.
//
// Connections: R runs the runbook block, L plays a login that was verified earlier and now registers its session,
// `admin` only watches pg_stat_activity, `setup` is autocommit postgres and does the committed set-up and clean-up.
// L's calls run inside a transaction with `set local role service_role`, which is the role the login Edge Function
// uses through PostgREST (login_verify / login_register_session are security definer, so the role does not change
// what they do, but it proves the grants).
// The tests COMMIT real changes to the owner's rows and restore them in `finally` (activity_log is insert-only, so
// the LOGIN_OK rows stay). Afterwards the owner must log in with the seeded password.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { backendPid, type Conn, connect, waitUntilBlocked } from "./helpers.ts";

const RUNBOOK = new URL("../../docs/runbooks/owner-account-recovery.md", import.meta.url);
const SEEDED = "correct horse battery";
const NEW_PW = "recovered owner pass 987";

/** The statements of the fenced sql block under "## 2. Password lost", placeholder replaced; fails loudly if the shape is wrong. */
export function loadRecoveryBlock(md: string, password: string): string[] {
  const h = md.indexOf("\n## 2. Password lost");
  if (h < 0) throw new Error("runbook: heading '## 2. Password lost' not found");
  const rest = md.slice(h + 1);
  const next = rest.indexOf("\n## ", 5);
  const section = next < 0 ? rest : rest.slice(0, next);
  const m = section.match(/```sql\n([\s\S]*?)\n```/);
  if (!m) throw new Error("runbook: no fenced sql block under '## 2. Password lost'");
  if (!m[1].includes("PUT-NEW-PASSWORD-HERE")) throw new Error("runbook: placeholder PUT-NEW-PASSWORD-HERE not found");
  const sql = m[1].replaceAll("PUT-NEW-PASSWORD-HERE", password);
  const stmts = sql
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  if (stmts[0]?.toLowerCase() !== "begin") throw new Error("runbook block must start with begin;");
  if (stmts[stmts.length - 1]?.toLowerCase() !== "commit") throw new Error("runbook block must end with commit;");
  if (!/^select id from app_users where role = 'owner' for update$/i.test(stmts[1] ?? "")) {
    throw new Error("runbook block: the first statement after begin must be the select ... for update on app_users");
  }
  if (stmts.length !== 6) throw new Error(`runbook block: expected begin + 4 statements + commit, got ${stmts.length} statements`);
  return stmts;
}
async function block(): Promise<string[]> {
  return loadRecoveryBlock(await Deno.readTextFile(RUNBOOK), NEW_PW);
}

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
async function verify(l: Conn): Promise<number> {
  const rows = await asService(l, () => l.unsafe(`select public.login_verify('100', $1) as r`, [SEEDED]));
  const r = (rows[0] as unknown as { r: { ok: boolean; credential_version: number } }).r;
  assertEquals(r.ok, true, "the owner's login verifies with the seeded password");
  return r.credential_version;
}
const register = (c: Conn, ownerId: string, sid: string, v: number) =>
  c.unsafe(`select public.login_register_session($1, $2, $3)`, [ownerId, sid, v]);

type State = { is_new: boolean; is_old: boolean; credential_version: number; unrevoked: number; sid_rows: number };
async function state(setup: Conn, o: Owner, sid: string): Promise<State> {
  return (await setup.unsafe(
    `select (extensions.crypt($2, s.secret_hash) = s.secret_hash) as is_new,
            (extensions.crypt($3, s.secret_hash) = s.secret_hash) as is_old,
            u.credential_version,
            (select count(*)::int from app_sessions a where a.user_id = u.id and a.revoked_at is null) as unrevoked,
            (select count(*)::int from app_sessions a where a.session_id = $4) as sid_rows
       from app_users u join app_user_secrets s on s.user_id = u.id where u.id = $1`,
    [o.id, NEW_PW, SEEDED, sid]))[0] as unknown as State;
}

/**
 * A login verified before the recovery tries to register while the block is running: R has executed the block up to
 * and including statement index `stopAfter` (index into the 6-statement list; 5 = everything but commit), L's
 * registration is started now and must wait; R then finishes and commits.
 */
async function registrationDuringBlock(stopAfter: number) {
  const setup = connect(), r = connect(), l = connect(), admin = connect();
  const sid = crypto.randomUUID();
  let owner: Owner | null = null;
  let failure: unknown = null;
  let restoreError: Error | null = null;
  try {
    owner = await readOwner(setup);
    const stmts = await block();
    const v = await verify(l);
    assertEquals(v, owner.credential_version, "verified with the current version");
    const pidL = await backendPid(l);
    for (let i = 0; i <= stopAfter; i++) await r.unsafe(stmts[i]); // R holds the row lock from statement 1 on

    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const outcome = register(l, owner.id, sid, v).then(() => null as Error | null, (e: unknown) => e as Error);
    await waitUntilBlocked(admin, pidL); // L really waits on a lock held by R
    for (let i = stopAfter + 1; i < stmts.length; i++) await r.unsafe(stmts[i]); // rest of the block, ending with commit
    const err = await outcome;
    await rollbackQuietly(l);

    const st = await state(setup, owner, sid);
    console.log("observed:", JSON.stringify({ err: err?.message ?? null, ...st, originalVersion: owner.credential_version }));
    assert(err !== null, "the registration that was waiting must be refused");
    assertStringIncludes(err.message, "USER_INVALID");
    assertEquals(st.sid_rows, 0, "no app_sessions row for the refused registration");
    assertEquals(st.unrevoked, 0, "the owner has no unrevoked session at all");
    assertEquals(st.is_new, true, "the stored hash matches the new password");
    assertEquals(st.is_old, false, "and not the old one");
    assertEquals(st.credential_version, owner.credential_version + 1, "credential_version rose by exactly 1");
  } catch (e) {
    failure = e;
  } finally {
    await rollbackQuietly(r);
    await rollbackQuietly(l);
    restoreError = await cleanUp(setup, owner, [sid]);
    for (const c of [setup, r, l, admin]) await c.end({ timeout: 5 }).catch(() => {});
  }
  if (failure) throw failure;
  if (restoreError) throw restoreError;
}

// Statement indexes: 0 begin, 1 lock, 2 secret, 3 version bump, 4 sessions revoked, 5 commit. A registration started
// after ANY of the first five (4 = "everything but commit") must wait for the lock and then be refused; in
// particular 3 is "after the version bump, before the revocation", the gap the lock closes.
for (const [stopAfter, label] of [[1, "right after the lock"], [2, "after the new secret is stored"], [3, "between the version bump and the revocation"], [4, "after everything but commit"]] as const) {
  Deno.test(`recovery block: a login verified before it cannot register ${label} (waits on the row lock, then refused)`, async () => {
    await registrationDuringBlock(stopAfter);
  });
}

Deno.test("recovery block: a session registered before the block starts is revoked by it", async () => {
  const setup = connect(), r = connect(), l = connect();
  const sid = crypto.randomUUID();
  let owner: Owner | null = null;
  let failure: unknown = null;
  let restoreError: Error | null = null;
  try {
    owner = await readOwner(setup);
    const stmts = await block();
    const v = await verify(l);
    await asService(l, () => register(l, owner!.id, sid, v)); // committed
    assertEquals((await state(setup, owner, sid)).sid_rows, 1, "the session exists before the recovery");
    for (const s of stmts) await r.unsafe(s);
    const row = (await setup.unsafe(`select revoked_at is not null as revoked from app_sessions where session_id = $1`, [sid]))[0] as unknown as { revoked: boolean };
    assertEquals(row.revoked, true, "that session is revoked by the block");
    assertEquals((await state(setup, owner, sid)).unrevoked, 0, "no live owner session remains");
  } catch (e) {
    failure = e;
  } finally {
    await rollbackQuietly(r);
    restoreError = await cleanUp(setup, owner, [sid]);
    for (const c of [setup, r, l]) await c.end({ timeout: 5 }).catch(() => {});
  }
  if (failure) throw failure;
  if (restoreError) throw restoreError;
});

Deno.test("old order in a transaction, no row lock: a verified login keeps its session -- this is why the runbook locks first", async () => {
  const setup = connect(), r = connect(), l = connect(), admin = connect();
  const sid = crypto.randomUUID();
  let owner: Owner | null = null;
  let failure: unknown = null;
  let restoreError: Error | null = null;
  try {
    owner = await readOwner(setup);
    const v = await verify(l);
    // the OLD statements (git show 321776b:docs/runbooks/owner-account-recovery.md), merely wrapped in a transaction
    // WITHOUT the leading select ... for update
    await r.unsafe("begin");
    await r.unsafe(`update app_user_secrets set secret_hash = extensions.crypt('${NEW_PW}', extensions.gen_salt('bf', 10))
                    where user_id = (select id from app_users where role = 'owner')`);
    await r.unsafe(`update app_sessions set revoked_at = clock_timestamp()
                    where user_id = (select id from app_users where role = 'owner') and revoked_at is null`);
    // not committed yet: L registers now. Nothing makes it wait, because nothing holds the owner's app_users row.
    await l.unsafe("begin");
    await l.unsafe("set local role service_role");
    const registered = await Promise.race([
      register(l, owner.id, sid, v).then(() => "registered"),
      new Promise<string>((res) => setTimeout(() => res("blocked"), 3000)),
    ]);
    assertEquals(registered, "registered", "without the row lock the registration is NOT blocked");
    await l.unsafe("commit");
    // R now bumps the version and commits, as the old third statement did
    await r.unsafe(`update app_users set credential_version = credential_version + 1, failed_attempts = 0, locked_until = null where role = 'owner'`);
    await r.unsafe("commit");
    await admin.unsafe("select 1");

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
  } catch (e) {
    failure = e;
  } finally {
    await rollbackQuietly(r);
    await rollbackQuietly(l);
    restoreError = await cleanUp(setup, owner, [sid]);
    for (const c of [setup, r, l, admin]) await c.end({ timeout: 5 }).catch(() => {});
  }
  if (failure) throw failure;
  if (restoreError) throw restoreError;
});

Deno.test("runbook block loader fails loudly on a wrong shape", () => {
  const good = "## 1. x\n\n## 2. Password lost\n\n```sql\nbegin;\nselect id from app_users where role = 'owner' for update;\nupdate a set b = 'PUT-NEW-PASSWORD-HERE';\nupdate c set d = 1;\nupdate e set f = 2;\ncommit;\n```\n\n## 3. next\n";
  assertEquals(loadRecoveryBlock(good, "pw").length, 6);
  const must = (md: string, text: string) => {
    let msg = "";
    try { loadRecoveryBlock(md, "pw"); } catch (e) { msg = (e as Error).message; }
    assertStringIncludes(msg, text);
  };
  must("nothing", "heading");
  must(good.replace("```sql", "```text"), "no fenced sql block");
  must(good.replace("begin;\n", ""), "begin");
  must(good.replace("commit;\n", ""), "commit");
  must(good.replace("select id from app_users where role = 'owner' for update;\n", "select 1;\n"), "for update");
});
