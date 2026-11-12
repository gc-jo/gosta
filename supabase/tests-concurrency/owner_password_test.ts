// admin_set_secret validates the caller's session before it waits for the target row lock. When the
// owner changes their own password from session S2, S2 revokes the owner's other session S1 under that
// lock; a request from S1 that was already waiting must then be refused (migration 0012), not go on to
// change the password.
//
// Connections: A acts as S2, B acts as S1, `admin` only watches pg_stat_activity, `setup` is postgres
// with autocommit and does the committed set-up and clean-up. The test commits real changes to the
// owner's rows and restores them in `finally`; activity_log is insert-only, so its rows stay.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { actAsSession, backendPid, type Conn, connect, waitUntilBlocked } from "./helpers.ts";

const P2 = "second password P2 !!";
const P3 = "third password P3 ??";

type Owner = { id: string; auth_user_id: string; secret_hash: string; credential_version: number; s1: string };

async function readOwner(setup: Conn): Promise<Owner> {
  const rows = await setup.unsafe(
    `select u.id, u.auth_user_id, s.secret_hash, u.credential_version,
            (select a.session_id from app_sessions a where a.user_id = u.id and a.revoked_at is null
             order by a.created_at, a.session_id limit 1) as s1
       from app_users u join app_user_secrets s on s.user_id = u.id
      where u.employee_number = '100'`,
  );
  assertEquals(rows.length, 1, "the seeded owner 100 must exist");
  const o = rows[0] as unknown as Owner;
  assert(o.auth_user_id && o.s1, "the owner needs an Auth user and a live seeded session");
  return o;
}

/** Puts the owner's rows back as they were (committed, as postgres). */
async function restore(setup: Conn, o: Owner, s2: string, reqs: string[]) {
  await setup.unsafe(
    `update app_user_secrets set secret_hash = $2 where user_id = $1`, [o.id, o.secret_hash]);
  await setup.unsafe(
    `update app_users set credential_version = $2, failed_attempts = 0, locked_until = null where id = $1`,
    [o.id, o.credential_version]);
  await setup.unsafe(`delete from app_sessions where session_id = $1`, [s2]);
  await setup.unsafe(`update app_sessions set revoked_at = null where session_id = $1`, [o.s1]);
  await setup.unsafe(`delete from rpc_requests where request_id in ($1, $2)`, [reqs[0], reqs[1]]);
}

async function rollbackQuietly(c: Conn) {
  try {
    await c.unsafe("rollback");
  } catch { /* nothing open */ }
}

Deno.test("owner password: a session revoked while it waited for the row lock cannot change it", async () => {
  const setup = connect();
  const a = connect();
  const b = connect();
  const admin = connect();
  const s2 = crypto.randomUUID();
  const reqA = crypto.randomUUID();
  const reqB = crypto.randomUUID();
  let owner: Owner | null = null;
  try {
    owner = await readOwner(setup);
    const s1 = owner.s1;
    await setup.unsafe(
      `insert into app_sessions (session_id, user_id, expires_at)
       values ($1, $2, clock_timestamp() + interval '7 days')`, [s2, owner.id]);
    const pidB = await backendPid(b);

    // A (session S2): changes the owner's own password, not committed yet.
    await a.unsafe("begin");
    await actAsSession(a, owner.auth_user_id, s2);
    await a.unsafe(`select public.admin_set_secret($1, $2, $3)`, [reqA, owner.id, P2]);

    // B (session S1): the same call; it must wait for A's row lock.
    await b.unsafe("begin");
    await actAsSession(b, owner.auth_user_id, s1);
    const bOutcome = b
      .unsafe(`select public.admin_set_secret($1, $2, $3)`, [reqB, owner.id, P3])
      .then(() => null as Error | null, (e: unknown) => e as Error);
    await waitUntilBlocked(admin, pidB); // B really waits on a lock

    await a.unsafe("commit");
    const bError = await bOutcome;
    if (bError === null) {
      await b.unsafe("commit"); // without the recheck B goes through; commit it to see what it did
    } else {
      await b.unsafe("rollback");
    }

    const state = (await setup.unsafe(
      `select (extensions.crypt($2, s.secret_hash) = s.secret_hash) as is_p2,
              (extensions.crypt($3, s.secret_hash) = s.secret_hash) as is_p3,
              u.credential_version,
              (select a1.revoked_at is not null from app_sessions a1 where a1.session_id = $4) as s1_revoked,
              (select a2.revoked_at is not null from app_sessions a2 where a2.session_id = $5) as s2_revoked,
              (select coalesce(string_agg(r.request_id::text, ','), '') from rpc_requests r
                where r.request_id in ($6, $7)) as stored_requests
         from app_users u join app_user_secrets s on s.user_id = u.id where u.id = $1`,
      [owner.id, P2, P3, s1, s2, reqA, reqB],
    ))[0] as unknown as {
      is_p2: boolean; is_p3: boolean; credential_version: number;
      s1_revoked: boolean; s2_revoked: boolean; stored_requests: string;
    };
    console.log("observed:", JSON.stringify({ bError: bError?.message ?? null, ...state, originalVersion: owner.credential_version }));

    assert(bError !== null, "B (revoked while it waited) must be refused, but its call succeeded");
    assertStringIncludes(bError.message, "NOT_AUTHENTICATED");
    assertEquals(state.is_p2, true, "the stored hash must match A's password P2");
    assertEquals(state.is_p3, false, "the stored hash must not match B's password P3");
    assertEquals(state.credential_version, owner.credential_version + 1, "credential_version rises by exactly 1");
    assertEquals(state.s1_revoked, true, "S1 is revoked");
    assertEquals(state.s2_revoked, false, "S2 is not revoked");
    assertEquals(state.stored_requests, reqA, "only A's request is stored");
  } finally {
    await rollbackQuietly(a);
    await rollbackQuietly(b);
    if (owner) {
      await restore(setup, owner, s2, [reqA, reqB]);
      const back = await setup.unsafe(`select secret_hash from app_user_secrets where user_id = $1`, [owner.id]);
      assertEquals((back[0] as unknown as { secret_hash: string }).secret_hash, owner.secret_hash, "the owner's hash is restored");
    }
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
    await setup.end({ timeout: 5 });
  }
});

Deno.test("control: one session changing the owner's password twice in a row works", async () => {
  const setup = connect();
  const a = connect();
  const s2 = crypto.randomUUID();
  const reqs = [crypto.randomUUID(), crypto.randomUUID()];
  let owner: Owner | null = null;
  try {
    owner = await readOwner(setup);
    await setup.unsafe(
      `insert into app_sessions (session_id, user_id, expires_at)
       values ($1, $2, clock_timestamp() + interval '7 days')`, [s2, owner.id]);
    for (const [i, pw] of [P2, P3].entries()) {
      await a.unsafe("begin");
      await actAsSession(a, owner.auth_user_id, s2);
      await a.unsafe(`select public.admin_set_secret($1, $2, $3)`, [reqs[i], owner.id, pw]);
      await a.unsafe("commit");
    }
    const state = (await setup.unsafe(
      `select (extensions.crypt($2, s.secret_hash) = s.secret_hash) as is_p3, u.credential_version,
              (select a2.revoked_at is not null from app_sessions a2 where a2.session_id = $3) as s2_revoked,
              (select a1.revoked_at is not null from app_sessions a1 where a1.session_id = $4) as s1_revoked
         from app_users u join app_user_secrets s on s.user_id = u.id where u.id = $1`,
      [owner.id, P3, s2, owner.s1],
    ))[0] as unknown as { is_p3: boolean; credential_version: number; s2_revoked: boolean; s1_revoked: boolean };
    assertEquals(state.is_p3, true, "the second change is the stored password");
    assertEquals(state.credential_version, owner.credential_version + 2, "two real changes, two versions");
    assertEquals(state.s2_revoked, false, "the calling session survives its own change");
    assertEquals(state.s1_revoked, true, "the other owner session was revoked by the first change");
  } finally {
    await rollbackQuietly(a);
    if (owner) {
      await restore(setup, owner, s2, reqs);
      const back = await setup.unsafe(`select secret_hash from app_user_secrets where user_id = $1`, [owner.id]);
      assertEquals((back[0] as unknown as { secret_hash: string }).secret_hash, owner.secret_hash, "the owner's hash is restored");
    }
    await a.end({ timeout: 5 });
    await setup.end({ timeout: 5 });
  }
});
