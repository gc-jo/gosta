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
