// Two-connection concurrency tests for the RPCs. pgTAP runs each file in one transaction and cannot
// overlap two; here A and B are two real connections. In each test A opens a transaction and runs its
// RPC, B's RPC is shown to block on a lock held by A's backend (overlap), A commits, B finishes.
//
// These tests COMMIT data. They use only BR-03 / user 203 (manager of BR-03), the owner (100) and
// BR-14 / user 301 as the sender, fresh request ids, and assert only on rows they created. Ledger rows
// (stock_movements, activity_log) are insert-only and stay; user 203's login state is restored.
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  begin,
  beginService,
  type Conn,
  connect,
  overlap,
  rpc,
  type RpcResult,
} from "./helpers.ts";

const ITEM = "D-001"; // base unit مل; عبوة = 750 مل
const ML = "مل";
const BOTTLE = "عبوة";

type Ctx = { a: Conn; b: Conn; admin: Conn; setup: Conn };

/** Runs body with connections A, B, an observer and an autocommit set-up connection; always closes them. */
async function withConns(body: (ctx: Ctx) => Promise<void>) {
  const ctx: Ctx = {
    a: connect(),
    b: connect(),
    admin: connect(),
    setup: connect(),
  };
  try {
    await body(ctx);
  } finally {
    await rollbackQuietly(ctx.a);
    await rollbackQuietly(ctx.b);
    for (const c of [ctx.a, ctx.b, ctx.admin, ctx.setup]) {
      await c.end({ timeout: 5 });
    }
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
async function committed(
  c: Conn,
  emp: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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
  assert(
    "error" in r,
    `${what} must fail with ${code}, got ${JSON.stringify(r)}`,
  );
  assertEquals(r.error, code, what);
}

async function q<T>(
  c: Conn,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await c.unsafe(sql, params as never[])) as unknown as T[];
}

/** 301 (BR-14) sends `quantity` of ITEM in `unit` to BR-03, committed. Returns the transfer id and its line id. */
async function sendToBr03(
  setup: Conn,
  quantity: number,
  unit: string,
): Promise<{ transfer: string; line: string }> {
  const res = await committed(setup, "301", "send_transfer", {
    p_request_id: crypto.randomUUID(),
    p_to_branch: "BR-03",
    p_lines: [{ item_id: ITEM, unit, quantity, cost_total: 10 }],
  }) as { transfer_id: string };
  const lines = await q<{ id: string }>(
    setup,
    `select id::text from transfer_lines where transfer_id = $1`,
    [res.transfer_id],
  );
  assertEquals(lines.length, 1);
  return { transfer: res.transfer_id, line: lines[0].id };
}

/** Σ and count of stock_movements of one kind (null = all kinds) for a ref id at a branch (null = any). */
async function movements(
  c: Conn,
  refId: string,
  kind: string | null,
  branch: string | null,
) {
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
        return await rpc(a, "receive_transfer", {
          p_request_id: crypto.randomUUID(),
          p_transfer_id: t.transfer,
          p_lines: lines,
        });
      },
      async () => {
        await begin(b, "203");
        return await rpc(b, "receive_transfer", {
          p_request_id: crypto.randomUUID(),
          p_transfer_id: t.transfer,
          p_lines: lines,
        });
      },
      () => commit(a),
    );
    await commit(b);
    assertEquals(okValue(ra, "A's receipt").received, 1);
    assertError(rb, "LINE_NOT_PENDING", "B's receipt");
    const tin = await movements(setup, t.line, "transfer_in", "BR-03");
    assertEquals(tin.n, 1, "exactly one transfer_in for the line");
    assertEquals(tin.sum, 1500);
    const st = await q<{ status: string }>(
      setup,
      `select status from transfer_lines where id = $1`,
      [t.line],
    );
    assertEquals(st[0].status, "received");
  });
});

// G2 --------------------------------------------------------------------------------------------------

/** 203's receipt of the single line, short by half: 1 of the 2 bottles sent, reason not_loaded. */
function receiveHalf(c: Conn, t: { transfer: string; line: string }) {
  return rpc(c, "receive_transfer", {
    p_request_id: crypto.randomUUID(),
    p_transfer_id: t.transfer,
    p_lines: [{
      line_id: t.line,
      quantity: 1,
      unit: BOTTLE,
      diff_reason: "not_loaded",
    }],
  });
}

function deny(c: Conn, line: string) {
  return rpc(c, "owner_resolve_transfer_line", {
    p_request_id: crypto.randomUUID(),
    p_line_id: line,
    p_action: "deny",
  });
}

async function lineState(c: Conn, line: string) {
  const rows = await q<{ status: string; rbase: string | null }>(
    c,
    `select status, received_base_quantity::text as rbase from transfer_lines where id = $1`,
    [line],
  );
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
    assertEquals(
      source.sum,
      -Number(st.rbase),
      "source net for the line = -received_base_quantity",
    );
    assertEquals(
      (await movements(setup, t.line, "transfer_in", "BR-03")).sum,
      750,
    );
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
    const source = await movements(setup, t.line, null, "BR-14");
    assertEquals(
      source.n,
      2,
      "source rows for the line: transfer_out + the deny's transfer_adjust",
    );
    assertEquals(source.sum, 0, "source net for the line = 0");
    assertEquals(
      (await movements(setup, t.line, "transfer_in", null)).n,
      0,
      "no transfer_in",
    );
  });
});

// G3 --------------------------------------------------------------------------------------------------

function purchaseArgs(requestId: string) {
  return {
    p_request_id: requestId,
    p_supplier_id: "S-01",
    p_lines: [{ item_id: ITEM, unit: ML, quantity: 100 }],
  };
}

/** 203 buys 100 مل of ITEM at BR-03 (committed). Returns the purchase line id. */
async function purchase100(setup: Conn): Promise<string> {
  const res = await committed(
    setup,
    "203",
    "create_purchase",
    purchaseArgs(crypto.randomUUID()),
  ) as { purchase_id: string };
  const lines = await q<{ id: string }>(
    setup,
    `select id::text from purchase_lines where purchase_id = $1`,
    [res.purchase_id],
  );
  assertEquals(lines.length, 1);
  return lines[0].id;
}

function editTo(c: Conn, line: string, quantity: number) {
  return rpc(c, "edit_purchase_line", {
    p_request_id: crypto.randomUUID(),
    p_line_id: line,
    p_quantity: quantity,
    p_unit: ML,
    p_cost_total: null,
  });
}

function voidLine(c: Conn, line: string) {
  return rpc(c, "void_purchase_line", {
    p_request_id: crypto.randomUUID(),
    p_line_id: line,
  });
}

async function purchaseLine(c: Conn, line: string) {
  const rows = await q<{ base: string; voided: boolean }>(
    c,
    `select base_quantity::text as base, voided_at is not null as voided from purchase_lines where id = $1`,
    [line],
  );
  return { base: Number(rows[0].base), voided: rows[0].voided };
}

Deno.test("two purchase edits: both ok; line = 60; Σ movements = 60; history old values 100 then 80", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const line = await purchase100(setup);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "100");
        return await editTo(a, line, 80);
      },
      async () => {
        await begin(b, "100");
        return await editTo(b, line, 60);
      },
      () => commit(a),
    );
    await commit(b);
    okValue(ra, "A's edit");
    okValue(rb, "B's edit");
    assertEquals(
      (await purchaseLine(setup, line)).base,
      60,
      "line base_quantity",
    );
    assertEquals(
      (await movements(setup, line, null, null)).sum,
      60,
      "Σ stock_movements for the line",
    );
    const hist = await q<{ q: string; action: string }>(
      setup,
      `select (old_values ->> 'quantity') as q, action from purchase_line_history
        where purchase_line_id = $1 order by changed_at, id`,
      [line],
    );
    assertEquals(hist.map((h) => [h.action, Number(h.q)]), [["edit", 100], [
      "edit",
      80,
    ]]);
  });
});

Deno.test("edit vs void: B's void ok; line voided; Σ movements = 0", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const line = await purchase100(setup);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "100");
        return await editTo(a, line, 80);
      },
      async () => {
        await begin(b, "100");
        return await voidLine(b, line);
      },
      () => commit(a),
    );
    await commit(b);
    okValue(ra, "A's edit");
    okValue(rb, "B's void");
    assertEquals((await purchaseLine(setup, line)).voided, true, "line voided");
    const m = await movements(setup, line, null, null);
    assertEquals(
      m.n,
      3,
      "rows for the line: purchase_in, the edit's purchase_adjust, the void's purchase_adjust",
    );
    assertEquals(m.sum, 0, "Σ stock_movements for the line");
  });
});

Deno.test("void vs edit: B's edit gets LINE_VOIDED; Σ movements = 0", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const line = await purchase100(setup);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "100");
        return await voidLine(a, line);
      },
      async () => {
        await begin(b, "100");
        return await editTo(b, line, 80);
      },
      () => commit(a),
    );
    await commit(b);
    okValue(ra, "A's void");
    assertError(rb, "LINE_VOIDED", "B's edit");
    const st = await purchaseLine(setup, line);
    assertEquals(st.voided, true);
    assertEquals(st.base, 100, "a voided line keeps its quantity");
    const m = await movements(setup, line, null, null);
    assertEquals(
      m.n,
      2,
      "rows for the line: purchase_in + the void's purchase_adjust",
    );
    assertEquals(m.sum, 0, "Σ stock_movements for the line");
  });
});

Deno.test("same request id twice: both return the same purchase_id; one purchase row", async () => {
  await withConns(async ({ a, b, admin, setup }) => {
    const r = crypto.randomUUID();
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "203");
        return await rpc(a, "create_purchase", purchaseArgs(r));
      },
      async () => {
        await begin(b, "203");
        return await rpc(b, "create_purchase", purchaseArgs(r));
      },
      () => commit(a),
    );
    await commit(b);
    const pa = okValue(ra, "A's purchase").purchase_id;
    const pb = okValue(rb, "B's purchase").purchase_id;
    assert(typeof pa === "string" && pa.length > 0);
    assertEquals(pb, pa, "the same purchase_id");
    const rows = await q<{ id: string }>(
      setup,
      `select id::text from purchases where request_id = $1`,
      [r],
    );
    assertEquals(rows.map((x) => x.id), [pa], "one purchase row");
    const ins = await q<{ n: number }>(
      setup,
      `select count(*)::int as n from stock_movements m join purchase_lines l on l.id = m.ref_id
        where l.purchase_id = $1 and m.kind = 'purchase_in'`,
      [pa],
    );
    assertEquals(ins[0].n, 1, "one purchase_in");
  });
});

// Count follow-ups (Task 15) ---------------------------------------------------------------------------

/** Fresh month per committed scenario/run; only this scenario's draft/window is cleaned up. */
async function withCountWindow(
  body: (ctx: Ctx, month: string) => Promise<void>,
  restoreTare = false,
) {
  await withConns(async (ctx) => {
    const { a, b, setup } = ctx;
    const months = await q<{ month: string }>(
      setup,
      `select (coalesce(max(period_month), date '2026-10-01') + interval '1 month')::date::text as month
         from (select period_month from count_windows where branch_id = 'BR-03'
               union all select period_month from counts where branch_id = 'BR-03') periods`,
    );
    const month = months[0].month;
    await committed(setup, "100", "open_count_window", {
      p_request_id: crypto.randomUUID(),
      p_branch_id: "BR-03",
      p_period_month: month,
    });
    let failure: unknown = null;
    try {
      await body(ctx, month);
    } catch (e) {
      failure = e;
    } finally {
      await rollbackQuietly(a);
      await rollbackQuietly(b);
      await rollbackQuietly(setup);
      try {
        if (restoreTare) {
          await committed(setup, "100", "set_container_tare", {
            p_request_id: crypto.randomUUID(),
            p_container_id: "D-004-1L",
            p_variant: "glass_pump",
            p_tare_grams: 620,
          });
        }
        const drafts = await q<{ id: string }>(
          setup,
          `select id::text from counts where branch_id = 'BR-03' and period_month = $1::date
             and status in ('draft','returned')`,
          [month],
        );
        for (const draft of drafts) {
          await committed(setup, "100", "discard_count", {
            p_request_id: crypto.randomUUID(),
            p_count_id: draft.id,
          });
        }
        await committed(setup, "100", "close_count_window", {
          p_request_id: crypto.randomUUID(),
          p_branch_id: "BR-03",
          p_period_month: month,
        });
        const remaining = await q<{ closed: boolean; unfinished: number }>(
          setup,
          `select w.status = 'closed' as closed,
                  (select count(*)::int from counts c where c.branch_id = w.branch_id
                    and c.period_month = w.period_month and (c.status in ('draft','returned') or c.frozen_since is not null)) as unfinished
             from count_windows w where w.branch_id = 'BR-03' and w.period_month = $1::date`,
          [month],
        );
        assertEquals([...remaining], [{ closed: true, unfinished: 0 }]);
      } catch (e) {
        console.error("cleaning up count scenario failed:", e);
        if (failure === null) failure = e;
      }
    }
    if (failure !== null) throw failure;
  });
}

/** Save all four fixture lines in the caller's open 203 transaction. */
async function saveCount(
  c: Conn,
  count: string,
  syrup = false,
): Promise<number> {
  let revision = 0;
  for (const item of [ITEM, "D-002", "D-004", "D-005"]) {
    const entries = item === ITEM
      ? [{ unit: ML, quantity: 1000 }]
      : item === "D-004" && syrup
      ? {
        packs: [],
        containers: [{
          container_id: "D-004-1L",
          closed: 2,
          closed_confirm: 2,
          open: 2,
          open_confirm: 2,
          weights: [
            { grams: 1000, variant: "glass_pump" },
            { grams: 700, variant: "plastic_pump" },
          ],
        }],
      }
      : null;
    const result = okValue(
      await rpc(c, "save_count_line", {
        p_count_id: count,
        p_item_id: item,
        p_expected_revision: 0,
        p_state: entries === null ? "none" : "counted",
        p_entries: entries,
      }),
      `save ${item}`,
    );
    revision = result.count_revision as number;
  }
  assertEquals(revision, 4, "four saved fixture lines");
  return revision;
}

/** Stored baseline and calc of this test's syrup line, with the cutoff/author checked independently. */
async function syrupBaseline(setup: Conn, count: string) {
  const rows = await q<{
    quantity: string;
    line_quantity: string;
    tare: string;
    status: string;
    cutoff: boolean;
    owner: boolean;
  }>(
    setup,
    `select b.base_quantity::text as quantity, l.base_quantity::text as line_quantity,
            l.calc #>> '{containers,0,tares,glass_pump}' as tare, c.status,
            b.effective_at = l.effective_at and l.effective_at = c.submitted_at as cutoff,
            b.created_by = (select id from app_users where employee_number = '100') as owner
       from stock_baselines b join counts c on c.id = b.ref_id
       join count_lines l on l.count_id = c.id and l.item_id = b.item_id
       where b.ref_id = $1 and b.source = 'count' and b.branch_id = 'BR-03' and b.item_id = 'D-004'`,
    [count],
  );
  assertEquals(rows.length, 1, "exactly one syrup baseline for this count");
  return {
    quantity: Number(rows[0].quantity),
    line_quantity: Number(rows[0].line_quantity),
    tare: Number(rows[0].tare),
    status: rows[0].status,
    cutoff: rows[0].cutoff,
    owner: rows[0].owner,
  };
}

Deno.test("start of count vs purchase: purchase waits, then BRANCH_FROZEN and no purchase row", async () => {
  await withCountWindow(async ({ a, b, admin, setup }, month) => {
    const request = crypto.randomUUID();
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "203");
        return await rpc(a, "start_count", {
          p_request_id: crypto.randomUUID(),
        });
      },
      async () => {
        await begin(b, "203");
        return await rpc(b, "create_purchase", purchaseArgs(request));
      },
      () => commit(a),
    );
    await commit(b);
    const count = okValue(ra, "A's start").count_id;
    assertError(rb, "BRANCH_FROZEN", "B's purchase");
    const rows = await q<{ frozen: boolean; month: string; lines: number }>(
      setup,
      `select frozen_since is not null as frozen, period_month::text as month,
              (select count(*)::int from count_lines where count_id = c.id and state = 'uncounted' and revision = 0) as lines
         from counts c where c.id = $1 and c.branch_id = 'BR-03'`,
      [count],
    );
    assertEquals([...rows], [{ frozen: true, month, lines: 4 }]);
    assertEquals(
      [
        ...await q(setup, `select id from purchases where request_id = $1`, [
          request,
        ]),
      ],
      [],
      "the refused request wrote no purchase",
    );
    assertEquals(
      [
        ...await q(
          setup,
          `select request_id from rpc_requests where request_id = $1`,
          [request],
        ),
      ],
      [],
      "the refused request stored no replay result",
    );
  });
});

Deno.test("purchase vs start of count: start waits, then movement predates the freeze", async () => {
  await withCountWindow(async ({ a, b, admin, setup }, month) => {
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await begin(a, "203");
        return await rpc(
          a,
          "create_purchase",
          purchaseArgs(crypto.randomUUID()),
        );
      },
      async () => {
        await begin(b, "203");
        return await rpc(b, "start_count", {
          p_request_id: crypto.randomUUID(),
        });
      },
      () => commit(a),
    );
    await commit(b);
    const purchase = okValue(ra, "A's purchase").purchase_id;
    const count = okValue(rb, "B's start").count_id;
    const rows = await q<{ before_freeze: boolean; quantity: string }>(
      setup,
      `select m.occurred_at = p.created_at and m.occurred_at < c.frozen_since as before_freeze,
              m.base_quantity::text as quantity
         from purchases p join purchase_lines l on l.purchase_id = p.id
         join stock_movements m on m.ref_id = l.id and m.ref_table = 'purchase_lines' and m.kind = 'purchase_in'
         join counts c on c.id = $2 and c.branch_id = p.branch_id
         where p.id = $1 and p.branch_id = 'BR-03' and c.period_month = $3::date`,
      [purchase, count, month],
    );
    assertEquals([...rows], [{ before_freeze: true, quantity: "100" }]);
  });
});

Deno.test("purchase transaction began before submission: movement follows all cutoffs and survives approval", async () => {
  await withCountWindow(async ({ a, b, setup }) => {
    const started = await committed(setup, "203", "start_count", {
      p_request_id: crypto.randomUUID(),
    }) as { count_id: string };
    await begin(a, "203");
    // Deliberately pin the transaction clock before B saves/submits; no overlap helper here.
    const pinned = (await q<{ t: string }>(a, `select now()::text as t`))[0].t;
    await begin(b, "203");
    const revision = await saveCount(b, started.count_id);
    okValue(
      await rpc(b, "submit_count", {
        p_request_id: crypto.randomUUID(),
        p_count_id: started.count_id,
        p_expected_revision: revision,
      }),
      "B's submit",
    );
    await commit(b);
    const purchase = okValue(
      await rpc(a, "create_purchase", purchaseArgs(crypto.randomUUID())),
      "A's purchase after submission",
    ).purchase_id;
    await commit(a);
    const ordering = await q<{ n: number; ordered: boolean }>(
      setup,
      `select count(*)::int as n,
              bool_and($3::text::timestamptz < c.submitted_at and c.frozen_since is null
                       and m.occurred_at = p.created_at and m.occurred_at > l.effective_at) as ordered
         from counts c join count_lines l on l.count_id = c.id
         join purchases p on p.id = $2 and p.branch_id = c.branch_id
         join purchase_lines pl on pl.purchase_id = p.id
         join stock_movements m on m.ref_id = pl.id and m.ref_table = 'purchase_lines' and m.kind = 'purchase_in'
         where c.id = $1 and c.branch_id = 'BR-03'`,
      [started.count_id, purchase, pinned],
    );
    assertEquals([...ordering], [{ n: 4, ordered: true }]);
    await committed(setup, "100", "review_count", {
      p_request_id: crypto.randomUUID(),
      p_count_id: started.count_id,
      p_action: "approve",
    });
    const balance = await q<{ quantity: string; baseline: string; n: number }>(
      setup,
      `select test.balance('BR-03', 'D-001')::text as quantity, b.base_quantity::text as baseline,
              (select count(*)::int from stock_baselines where ref_id = $1 and source = 'count') as n
         from stock_baselines b where b.ref_id = $1 and b.source = 'count'
           and b.branch_id = 'BR-03' and b.item_id = 'D-001'`,
      [started.count_id],
    );
    // Counted 1000 x 1 ml + purchased 100 x 1 ml = 1100 ml, regardless of previous runs.
    assertEquals([...balance], [{ quantity: "1100", baseline: "1000", n: 4 }]);
  });
});

for (const tareFirst of [true, false]) {
  Deno.test(
    tareFirst
      ? "tare first: approval waits on setup and uses 600, baseline 3390"
      : "approval first: tare update waits, approved baseline stays 3370",
    async () => {
      await withCountWindow(async ({ a, b, admin, setup }) => {
        await committed(setup, "100", "set_container_tare", {
          p_request_id: crypto.randomUUID(),
          p_container_id: "D-004-1L",
          p_variant: "glass_pump",
          p_tare_grams: 620,
        });
        const started = await committed(setup, "203", "start_count", {
          p_request_id: crypto.randomUUID(),
        }) as { count_id: string };
        await begin(setup, "203");
        const revision = await saveCount(setup, started.count_id, true);
        okValue(
          await rpc(setup, "submit_count", {
            p_request_id: crypto.randomUUID(),
            p_count_id: started.count_id,
            p_expected_revision: revision,
          }),
          "submit syrup count",
        );
        await commit(setup);
        const tareArgs = {
          p_request_id: crypto.randomUUID(),
          p_container_id: "D-004-1L",
          p_variant: "glass_pump",
          p_tare_grams: 600,
        };
        const reviewArgs = {
          p_request_id: crypto.randomUUID(),
          p_count_id: started.count_id,
          p_action: "approve",
        };
        // Both orders share the count lock: setup's recompute sees the submitted
        // row until approval commits, then skips it because it is approved.
        const [ra, rb] = await overlap(
          { admin, a, b },
          async () => {
            await begin(a, "100");
            return tareFirst
              ? await rpc(a, "set_container_tare", tareArgs)
              : await rpc(a, "review_count", reviewArgs);
          },
          async () => {
            await begin(b, "100");
            return tareFirst
              ? await rpc(b, "review_count", reviewArgs)
              : await rpc(b, "set_container_tare", tareArgs);
          },
          () => commit(a),
        );
        okValue(ra, "A's first RPC");
        okValue(rb, "B's RPC after waiting for A");
        // Before B commits, A's approval (when first) already has its final baseline.
        if (!tareFirst) {
          const approved = await syrupBaseline(setup, started.count_id);
          assertEquals(approved.quantity, 3370);
          assertEquals(approved.tare, 620);
        }
        await commit(b);
        // New tare: 2 x 1250 + (1000 - 600) + (700 - 210) = 3390 g.
        // Approval first: 2 x 1250 + (1000 - 620) + (700 - 210) = 3370 g, immutable thereafter.
        assertEquals(await syrupBaseline(setup, started.count_id), {
          quantity: tareFirst ? 3390 : 3370,
          line_quantity: tareFirst ? 3390 : 3370,
          tare: tareFirst ? 600 : 620,
          status: "approved",
          cutoff: true,
          owner: true,
        });
        const tares = await q<{ quantity: string }>(
          setup,
          `select tare_grams::text as quantity from container_tares where container_id = 'D-004-1L' and variant = 'glass_pump'`,
        );
        assertEquals(
          [...tares],
          [{ quantity: "600" }],
          "the new tare really committed",
        );
      }, true);
    },
  );
}

// G4 --------------------------------------------------------------------------------------------------

/**
 * Rows a send from BR-03 could have written since `since` (a database clock reading taken before the call).
 * Only these oversized tests send from BR-03, so the counts hold even when other tests run in parallel.
 */
async function br03SendRows(c: Conn, since: string) {
  const rows = await q<{ t: number; l: number; m: number }>(
    c,
    `select (select count(*) from transfers where from_branch = 'BR-03' and created_at >= $1::text::timestamptz)::int as t,
            (select count(*) from transfer_lines l join transfers t on t.id = l.transfer_id
              where t.from_branch = 'BR-03' and t.created_at >= $1::text::timestamptz)::int as l,
            (select count(*) from stock_movements where branch_id = 'BR-03' and kind = 'transfer_out'
              and created_at >= $1::text::timestamptz)::int as m`,
    [since],
  );
  return rows[0];
}

// 1e131070 is sent as a JSON string because a JS number cannot hold it (it would become Infinity).
for (
  const [label, quantity] of [["1e13 (JSON number)", 1e13], [
    "1e131070 (numeric string)",
    "1e131070",
  ]] as const
) {
  Deno.test(`oversized quantity ${label} on a committed connection: QUANTITY_INVALID, nothing written`, async () => {
    await withConns(async ({ a, setup }) => {
      const req = crypto.randomUUID();
      // the clock as text: a Date parameter would drop the microseconds
      const since =
        (await q<{ t: string }>(setup, `select clock_timestamp()::text as t`))[
          0
        ].t;
      await begin(a, "203");
      const r = await rpc(a, "send_transfer", {
        p_request_id: req,
        p_to_branch: "BR-14",
        p_lines: [{ item_id: ITEM, unit: ML, quantity }],
      });
      await commit(a); // the transaction is aborted: commit ends it as a rollback
      assertError(
        r,
        "QUANTITY_INVALID",
        "send_transfer with an oversized quantity",
      );
      assertEquals(
        await br03SendRows(setup, since),
        { t: 0, l: 0, m: 0 },
        "no transfer, transfer line or stock movement written",
      );
      const own = await q<{ t: number; r: number }>(
        setup,
        `select (select count(*) from transfers where request_id = $1)::int as t,
                (select count(*) from rpc_requests where request_id = $1)::int as r`,
        [req],
      );
      assertEquals(
        own[0],
        { t: 0, r: 0 },
        "no transfer row and no stored request for this request id",
      );
    });
  });
}

// G5: login ------------------------------------------------------------------------------------------
// User 203 (PIN 0303). login_verify / login_register_session run as service_role (as the login function
// does); admin_set_secret runs as the owner. Every test starts from and ends with user 203 restored:
// PIN 0303 hashed as the seed and admin_set_secret hash it (crypt(pin, gen_salt('bf', 10))),
// failed_attempts 0, locked_until null, the original credential_version, the seeded session unrevoked
// and every session the test registered deleted (test.act_as('203') must keep finding one session).

const SEEDED_203_SESSION = "5e5e5e5e-0000-4000-8000-000000000203";
const NEW_PIN = "4321";

type User203 = { id: string; version: number };

async function read203(setup: Conn): Promise<User203> {
  const rows = await q<{ id: string; version: number }>(
    setup,
    `select id::text, credential_version as version from app_users where employee_number = '203'`,
  );
  assertEquals(rows.length, 1, "seeded user 203 must exist");
  return rows[0];
}

async function restore203(setup: Conn, u: User203, sessions: string[]) {
  await setup.unsafe(
    `update app_user_secrets set secret_hash = extensions.crypt('0303', extensions.gen_salt('bf', 10)) where user_id = $1`,
    [u.id],
  );
  await setup.unsafe(
    `update app_users set failed_attempts = 0, locked_until = null, credential_version = $2 where id = $1`,
    [u.id, u.version],
  );
  for (const s of sessions) {
    await setup.unsafe(
      `delete from app_sessions where session_id = $1 and user_id = $2`,
      [s, u.id],
    );
  }
  await setup.unsafe(
    `update app_sessions set revoked_at = null where session_id = $1`,
    [SEEDED_203_SESSION],
  );
}

async function state203(setup: Conn, id: string) {
  const rows = await q<
    { failed: number; locked: string | null; version: number }
  >(
    setup,
    `select failed_attempts as failed, locked_until::text as locked, credential_version as version
       from app_users where id = $1`,
    [id],
  );
  return rows[0];
}

/** Runs a login test with user 203 restored before and after (the restore never masks a test failure). */
async function withUser203(
  body: (ctx: Ctx, u: User203, sessions: string[]) => Promise<void>,
) {
  await withConns(async (ctx) => {
    const u = await read203(ctx.setup);
    const sessions: string[] = [];
    await restore203(ctx.setup, u, sessions);
    let failure: unknown = null;
    try {
      await body(ctx, u, sessions);
    } catch (e) {
      failure = e;
    } finally {
      await rollbackQuietly(ctx.a);
      await rollbackQuietly(ctx.b);
      try {
        await restore203(ctx.setup, u, sessions);
      } catch (e) {
        console.error("restoring user 203 failed:", e);
        if (failure === null) failure = e;
      }
    }
    if (failure !== null) throw failure;
  });
}

function verify(c: Conn, pin: string) {
  return rpc(c, "login_verify", { p_employee_number: "203", p_secret: pin });
}

const INVALID = { ok: false, reason: "invalid", locked_until: null };

Deno.test("L1 two simultaneous wrong PINs: B waits for A; failed_attempts rises by exactly 2", async () => {
  await withUser203(async ({ a, b, admin, setup }, u) => {
    const before = (await state203(setup, u.id)).failed;
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await beginService(a);
        return await verify(a, "9999");
      },
      async () => {
        await beginService(b);
        return await verify(b, "9999");
      },
      () => commit(a),
    );
    await commit(b);
    assertEquals(okValue(ra, "A's login_verify"), INVALID);
    assertEquals(okValue(rb, "B's login_verify"), INVALID);
    const st = await state203(setup, u.id);
    assertEquals(st.failed, before + 2, "failed_attempts + 2");
    assertEquals(st.locked, null);
  });
});

Deno.test("L2 at 4 failures, two simultaneous wrong PINs: one lock; B sees the locked outcome; no further increment", async () => {
  await withUser203(async ({ a, b, admin, setup }, u) => {
    await setup.unsafe(
      `update app_users set failed_attempts = 4 where id = $1`,
      [u.id],
    );
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await beginService(a);
        return await verify(a, "9999");
      },
      async () => {
        await beginService(b);
        return await verify(b, "9999");
      },
      () => commit(a),
    );
    await commit(b);
    const va = okValue(ra, "A's login_verify");
    const vb = okValue(rb, "B's login_verify");
    assertEquals(
      [va.ok, va.reason],
      [false, "locked"],
      "A's fifth failure locks",
    );
    assert(typeof va.locked_until === "string", "A returns locked_until");
    // B waited for A's row lock, then found the user locked: the locked path changes nothing and returns
    // the lock A set, not a new one
    assertEquals(vb, {
      ok: false,
      reason: "locked",
      locked_until: va.locked_until,
    }, "B's outcome after waiting");
    const st = await state203(setup, u.id);
    assertEquals(
      st.failed,
      0,
      "failed_attempts reset to 0 by the lock, not incremented by B",
    );
    // compared as the jsonb text both results use (a JS Date parameter would drop the microseconds)
    const lock = await q<{ lu: string; future: boolean }>(
      setup,
      `select to_jsonb(locked_until) #>> '{}' as lu, locked_until > clock_timestamp() as future
         from app_users where id = $1`,
      [u.id],
    );
    assertEquals(
      lock[0],
      { lu: va.locked_until, future: true },
      "exactly one lock: A's locked_until, in the future",
    );
  });
});

Deno.test("L3 PIN reset between verify and register: the old credential_version is refused; new PIN works, old fails", async () => {
  await withUser203(async ({ a, b, setup }, u, sessions) => {
    await beginService(a);
    const ok = okValue(await verify(a, "0303"), "login_verify with PIN 0303");
    await commit(a);
    assertEquals(ok.ok, true);
    const oldVersion = ok.credential_version as number;
    assertEquals(oldVersion, u.version);

    await begin(b, "100");
    okValue(
      await rpc(b, "admin_set_secret", {
        p_request_id: crypto.randomUUID(),
        p_user_id: u.id,
        p_secret: NEW_PIN,
      }),
      "owner's admin_set_secret",
    );
    await commit(b);

    const s = crypto.randomUUID();
    sessions.push(s);
    await beginService(a);
    const reg = await rpc(a, "login_register_session", {
      p_user_id: u.id,
      p_session_id: s,
      p_credential_version: oldVersion,
    });
    await commit(a);
    assertError(
      reg,
      "USER_INVALID",
      "login_register_session with the old credential_version",
    );
    const n = await q<{ n: number }>(
      setup,
      `select count(*)::int as n from app_sessions where session_id = $1`,
      [s],
    );
    assertEquals(n[0].n, 0, "no session registered");

    await beginService(a);
    const fresh = okValue(
      await verify(a, NEW_PIN),
      "login_verify with the new PIN",
    );
    const stale = okValue(
      await verify(a, "0303"),
      "login_verify with the old PIN",
    );
    await commit(a);
    assertEquals(fresh.ok, true, "the new PIN logs in");
    assertEquals(fresh.credential_version, oldVersion + 1);
    assertEquals(stale, INVALID, "the old PIN fails");
  });
});

Deno.test("L4 registration holds the row lock first: the owner's reset waits, then revokes the new session", async () => {
  await withUser203(async ({ a, b, admin, setup }, u, sessions) => {
    const s = crypto.randomUUID();
    sessions.push(s);
    const [ra, rb] = await overlap(
      { admin, a, b },
      async () => {
        await beginService(a);
        return await rpc(a, "login_register_session", {
          p_user_id: u.id,
          p_session_id: s,
          p_credential_version: u.version,
        });
      },
      async () => {
        await begin(b, "100");
        return await rpc(b, "admin_set_secret", {
          p_request_id: crypto.randomUUID(),
          p_user_id: u.id,
          p_secret: NEW_PIN,
        });
      },
      () => commit(a),
    );
    await commit(b);
    assert(
      "ok" in ra,
      `A's login_register_session must succeed, got ${JSON.stringify(ra)}`,
    );
    assertEquals(okValue(rb, "B's admin_set_secret").user_id, u.id);
    const row = await q<{ revoked: boolean }>(
      setup,
      `select revoked_at is not null as revoked from app_sessions where session_id = $1 and user_id = $2`,
      [s, u.id],
    );
    assertEquals(row.length, 1, "A's session was registered");
    assertEquals(row[0].revoked, true, "A's session is revoked by the reset");
    assertEquals(
      (await state203(setup, u.id)).version,
      u.version + 1,
      "credential_version + 1",
    );
  });
});
