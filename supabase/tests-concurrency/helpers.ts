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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
