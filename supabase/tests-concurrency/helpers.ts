// Helpers for tests that need two real database connections.
// These tests run against the local Supabase stack; CI is the authoritative run.
import postgres from "npm:postgres@3.4.5";

export type Conn = ReturnType<typeof postgres>;

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Opens one dedicated connection (a pool of exactly one, so `begin` ... `commit`
 * sent through it stay in one transaction). Every connection setting is passed
 * explicitly so the driver has no reason to read PG* environment variables;
 * the only variable read here is DATABASE_URL.
 */
export function connect(): Conn {
  const url = new URL(Deno.env.get("DATABASE_URL") ?? DEFAULT_URL);
  // max_pipeline is a real driver option that its type definitions omit.
  const options = {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
    database: url.pathname.slice(1) || "postgres",
    // Every driver option that would otherwise fall back to a PG* variable:
    ssl: false,
    max: 1,
    idle_timeout: 0,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    max_pipeline: 100,
    backoff: () => 0.5,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: false,
    publications: "alltables",
    target_session_attrs: "read-write",
    onnotice: () => {},
  };
  return postgres(options as unknown as postgres.Options<Record<string, never>>);
}

/** The server process id of a connection. */
export async function backendPid(c: Conn): Promise<number> {
  const rows = await c.unsafe("select pg_backend_pid() as pid");
  return Number((rows[0] as unknown as { pid: number }).pid);
}

/**
 * Polls pg_stat_activity (through `admin`, a third connection) until backend `pid`
 * is waiting for a lock. Fails after `timeoutMs` if it never blocks, so a test can
 * assert that a statement really waited instead of guessing with a sleep.
 */
export async function waitUntilBlocked(admin: Conn, pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await admin.unsafe(
      `select 1 from pg_stat_activity where pid = ${Number(pid)} and wait_event_type = 'Lock'`,
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} was never blocked on a lock within ${timeoutMs} ms`);
}

/** The backend pids that `pid` is waiting for (pg_blocking_pids), seen through `admin`. */
export async function blockersOf(admin: Conn, pid: number): Promise<number[]> {
  const rows = await admin.unsafe(`select unnest(pg_blocking_pids(${Number(pid)})) as b`);
  return rows.map((r) => Number((r as unknown as { b: number }).b));
}

/** Like waitUntilBlocked, and then asserts that `expectedBlocker` is among the backends it waits for. */
export async function waitUntilBlockedBy(admin: Conn, pid: number, expectedBlocker: number, timeoutMs = 5000): Promise<void> {
  await waitUntilBlocked(admin, pid, timeoutMs);
  const blockers = await blockersOf(admin, pid);
  if (!blockers.includes(expectedBlocker)) {
    throw new Error(`backend ${pid} waits for ${JSON.stringify(blockers)}, not for backend ${expectedBlocker}`);
  }
}

/**
 * Opens a transaction on `c` acting as the seeded user `employeeNumber` (test.act_as: role authenticated
 * and that user's seeded session). Everything until commit/rollback on `c` runs as that user.
 */
export async function begin(c: Conn, employeeNumber: string): Promise<void> {
  await c.unsafe("begin");
  await c.unsafe("select test.act_as($1)", [employeeNumber]);
}

/** Opens a transaction on `c` acting as service_role (test.act_as_service), as the login function does. */
export async function beginService(c: Conn): Promise<void> {
  await c.unsafe("begin");
  await c.unsafe("select test.act_as_service()");
}

export type RpcResult = { ok: unknown } | { error: string };

const NAME_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Calls public.<name>(p_key => value, ...) on `c`. Returns the function's result as `ok`, or the
 * Postgres error message as `error` instead of throwing. Parameters are sent untyped, so the server
 * resolves their types from the function signature; the driver then serialises each value for that type
 * (objects and arrays for a jsonb parameter are JSON-encoded once by the driver). A json/jsonb result
 * comes back parsed.
 */
export async function rpc(c: Conn, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  if (!NAME_RE.test(name)) throw new Error(`bad function name ${name}`);
  const keys = Object.keys(args);
  for (const k of keys) if (!NAME_RE.test(k)) throw new Error(`bad argument name ${k}`);
  const list = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  const values = keys.map((k) => args[k] ?? null);
  try {
    const rows = await c.unsafe(`select public.${name}(${list}) as r`, values as never[]);
    let r = (rows[0] as unknown as { r: unknown }).r;
    if (typeof r === "string" && (r.startsWith("{") || r.startsWith("["))) {
      try {
        r = JSON.parse(r);
      } catch { /* a plain text result */ }
    }
    return { ok: r };
  } catch (e) {
    return { error: (e as { message?: string }).message ?? String(e) };
  }
}

/**
 * Runs two transactions so that they really overlap: awaits `a` (A's statements, transaction left open),
 * starts `b` without awaiting it, waits (through `watch.admin`, a third connection) until B's backend is
 * blocked on a lock held by A's backend (fails after 5 s otherwise), then runs `commitA` and awaits `b`.
 */
export async function overlap<T, U>(
  watch: { admin: Conn; a: Conn; b: Conn },
  a: () => Promise<T>,
  b: () => Promise<U>,
  commitA: () => Promise<void>,
): Promise<[T, U]> {
  const pidA = await backendPid(watch.a);
  const pidB = await backendPid(watch.b);
  const ra = await a();
  // keep a rejection from going unhandled while we wait; it is rethrown by the await below
  const pb = b().then((v) => ({ v }), (e: unknown) => ({ e }));
  try {
    await waitUntilBlockedBy(watch.admin, pidB, pidA, 5000);
  } finally {
    await commitA();
  }
  const rb = await pb;
  if ("e" in rb) throw rb.e;
  return [ra, rb.v];
}

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Makes the transaction already open on `c` act as an app session, the way a request through the
 * Supabase API does: `set local role authenticated` plus request.jwt.claims carrying the Auth user
 * id (`sub`) and the app session id (`session_id`). Call it right after `begin`; both settings end
 * with the transaction.
 */
export async function actAsSession(c: Conn, authUserId: string, sessionId: string): Promise<void> {
  if (!UUID_RE.test(authUserId) || !UUID_RE.test(sessionId)) {
    throw new Error("actAsSession needs two uuids");
  }
  const claims = JSON.stringify({ sub: authUserId, role: "authenticated", session_id: sessionId });
  await c.unsafe("set local role authenticated");
  await c.unsafe("select set_config('request.jwt.claims', $1, true)", [claims]);
}
