// Two-connection concurrency tests for the RPCs. pgTAP runs each file in one transaction and cannot
// overlap two; here A and B are two real connections. In each test A opens a transaction and runs its
// RPC, B's RPC is shown to block on a lock held by A's backend (overlap), A commits, B finishes.
//
// These tests COMMIT data. They use only BR-03 / user 203 (manager of BR-03), the owner (100) and
// BR-14 / user 301 as the sender, fresh request ids, and assert only on rows they created. Ledger rows
// (stock_movements, activity_log) are insert-only and stay; user 203's login state is restored.
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { begin, type Conn, connect, overlap, rpc, type RpcResult } from "./helpers.ts";

const ITEM = "D-001"; // base unit مل; عبوة = 750 مل
const BOTTLE = "عبوة";

type Ctx = { a: Conn; b: Conn; admin: Conn; setup: Conn };

/** Runs body with connections A, B, an observer and an autocommit set-up connection; always closes them. */
async function withConns(body: (ctx: Ctx) => Promise<void>) {
  const ctx: Ctx = { a: connect(), b: connect(), admin: connect(), setup: connect() };
  try {
    await body(ctx);
  } finally {
    await rollbackQuietly(ctx.a);
    await rollbackQuietly(ctx.b);
    for (const c of [ctx.a, ctx.b, ctx.admin, ctx.setup]) await c.end({ timeout: 5 });
  }
}

async function rollbackQuietly(c: Conn) {
  try {
    await c.unsafe("rollback");
  } catch { /* nothing open */ }
}

/** Commits the open transaction on c (after a failed statement Postgres turns this into a rollback). */
async function commit(c: Conn) {
  await c.unsafe("commit");
}

/** One committed RPC call as `emp`; throws if it fails. */
async function committed(c: Conn, emp: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  await begin(c, emp);
  const r = await rpc(c, name, args);
  if ("error" in r) {
    await c.unsafe("rollback");
    throw new Error(`${name} as ${emp} failed: ${r.error}`);
  }
  await commit(c);
  return r.ok;
}

function okValue(r: RpcResult, what: string): Record<string, unknown> {
  assert("ok" in r, `${what} must succeed, got ${JSON.stringify(r)}`);
  return r.ok as Record<string, unknown>;
}

function assertError(r: RpcResult, code: string, what: string) {
  assert("error" in r, `${what} must fail with ${code}, got ${JSON.stringify(r)}`);
  assertEquals(r.error, code, what);
}

async function q<T>(c: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.unsafe(sql, params as never[])) as unknown as T[];
}

/** 301 (BR-14) sends `quantity` of ITEM in `unit` to BR-03, committed. Returns the transfer id and its line id. */
async function sendToBr03(setup: Conn, quantity: number, unit: string): Promise<{ transfer: string; line: string }> {
  const res = await committed(setup, "301", "send_transfer", {
    p_request_id: crypto.randomUUID(),
    p_to_branch: "BR-03",
    p_lines: [{ item_id: ITEM, unit, quantity, cost_total: 10 }],
  }) as { transfer_id: string };
  const lines = await q<{ id: string }>(setup, `select id::text from transfer_lines where transfer_id = $1`, [res.transfer_id]);
  assertEquals(lines.length, 1);
  return { transfer: res.transfer_id, line: lines[0].id };
}

/** Σ and count of stock_movements of one kind (null = all kinds) for a ref id at a branch (null = any). */
async function movements(c: Conn, refId: string, kind: string | null, branch: string | null) {
  const rows = await q<{ n: number; s: string }>(
    c,
    `select count(*)::int as n, coalesce(sum(base_quantity), 0)::text as s from stock_movements
      where ref_id = $1 and ($2::text is null or kind = $2) and ($3::text is null or branch_id = $3)`,
    [refId, kind, branch],
  );
  return { n: rows[0].n, sum: Number(rows[0].s) };
}

// G1 --------------------------------------------------------------------------------------------------

Deno.test("double receipt: one ok, one LINE_NOT_PENDING, one transfer_in per line", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const t = await sendToBr03(setup, 2, BOTTLE);
    const lines = [{ line_id: t.line, quantity: 2, unit: BOTTLE }];
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "203");
        return await rpc(a, "receive_transfer", { p_request_id: crypto.randomUUID(), p_transfer_id: t.transfer, p_lines: lines });
      },
      async () => {
        await begin(b, "203");
        return await rpc(b, "receive_transfer", { p_request_id: crypto.randomUUID(), p_transfer_id: t.transfer, p_lines: lines });
      },
      () => commit(a),
    );
    await commit(b);
    assertEquals(okValue(ra, "A's receipt").received, 1);
    assertError(rb, "LINE_NOT_PENDING", "B's receipt");
    const tin = await movements(setup, t.line, "transfer_in", "BR-03");
    assertEquals(tin.n, 1, "exactly one transfer_in for the line");
    assertEquals(tin.sum, 1500);
    const st = await q<{ status: string }>(setup, `select status from transfer_lines where id = $1`, [t.line]);
    assertEquals(st[0].status, "received");
  });
});

// G2 --------------------------------------------------------------------------------------------------

/** 203's receipt of the single line, short by half: 1 of the 2 bottles sent, reason not_loaded. */
function receiveHalf(c: Conn, t: { transfer: string; line: string }) {
  return rpc(c, "receive_transfer", {
    p_request_id: crypto.randomUUID(),
    p_transfer_id: t.transfer,
    p_lines: [{ line_id: t.line, quantity: 1, unit: BOTTLE, diff_reason: "not_loaded" }],
  });
}

function deny(c: Conn, line: string) {
  return rpc(c, "owner_resolve_transfer_line", { p_request_id: crypto.randomUUID(), p_line_id: line, p_action: "deny" });
}

async function lineState(c: Conn, line: string) {
  const rows = await q<{ status: string; rbase: string | null }>(
    c, `select status, received_base_quantity::text as rbase from transfer_lines where id = $1`, [line]);
  return rows[0];
}

Deno.test("receipt (short by half) vs owner deny: B gets LINE_NOT_PENDING; source net = -received_base_quantity", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const t = await sendToBr03(setup, 2, BOTTLE);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "203");
        return await receiveHalf(a, t);
      },
      async () => {
        await begin(b, "100");
        return await deny(b, t.line);
      },
      () => commit(a),
    );
    await commit(b);
    assertEquals(okValue(ra, "A's receipt").received, 1);
    assertError(rb, "LINE_NOT_PENDING", "B's deny");
    const st = await lineState(setup, t.line);
    assertEquals(st.status, "received");
    assertEquals(Number(st.rbase), 750);
    const source = await movements(setup, t.line, null, "BR-14");
    assertEquals(source.sum, -Number(st.rbase), "source net for the line = -received_base_quantity");
    assertEquals((await movements(setup, t.line, "transfer_in", "BR-03")).sum, 750);
  });
});

Deno.test("owner deny vs receipt: line denied, B gets LINE_NOT_PENDING; source net = 0", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const t = await sendToBr03(setup, 2, BOTTLE);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "100");
        return await deny(a, t.line);
      },
      async () => {
        await begin(b, "203");
        return await receiveHalf(b, t);
      },
      () => commit(a),
    );
    await commit(b);
    assertEquals(okValue(ra, "A's deny").status, "denied");
    assertError(rb, "LINE_NOT_PENDING", "B's receipt");
    assertEquals((await lineState(setup, t.line)).status, "denied");
    assertEquals((await movements(setup, t.line, null, "BR-14")).sum, 0, "source net for the line = 0");
    assertEquals((await movements(setup, t.line, "transfer_in", null)).n, 0, "no transfer_in");
  });
});
