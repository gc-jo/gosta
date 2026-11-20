// The base-unit rule (an item's base unit row exists, is active and has rate 1)
// is checked per transaction at commit. These tests run two transactions that are
// each valid alone and check that together they cannot break the rule.
//
// To make the two commit-time checks overlap deterministically, each transaction
// runs `set constraints all immediate` (which fires the same check the commit
// would) before either one commits. Without the row lock in app.check_item_base_unit
// both checks pass and both transactions commit; with it the second check waits
// for the first transaction to finish and then sees its committed change.
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { backendPid, type Conn, connect, waitUntilBlocked } from "./helpers.ts";

const BASE = "مل";
const OTHER = "لتر";

type Outcome = { code: string | null; message: string } | null;

/** Runs a statement and returns the error (if any) instead of throwing. */
async function run(c: Conn, query: string): Promise<Outcome> {
  try {
    await c.unsafe(query);
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? null, message: err.message ?? String(e) };
  }
}

async function createItem(c: Conn, id: string) {
  await c.unsafe(`
    begin;
    insert into items (id, name_ar, base_unit, item_type) values ('${id}', 'اختبار', '${BASE}', 'syrup');
    insert into item_units (item_id, unit_name, conversion_rate) values
      ('${id}', '${BASE}', 1), ('${id}', '${OTHER}', 1);
    commit;`);
}

async function dropItem(c: Conn, id: string) {
  // Units and item in one transaction: the base-unit check is deferred to commit
  // and skips an item that no longer exists.
  await c.unsafe(`
    begin;
    delete from item_units where item_id = '${id}';
    delete from items where id = '${id}';
    commit;`);
}

type Ctx = { a: Conn; b: Conn; id: string; pidA: number; pidB: number; admin: Conn };

/** Runs body with two transaction connections, an observer and one fresh item; always cleans up. */
async function withItem(id: string, body: (ctx: Ctx) => Promise<void>) {
  const a = connect();
  const b = connect();
  const admin = connect();
  try {
    const pidA = await backendPid(a);
    const pidB = await backendPid(b);
    await createItem(a, id);
    try {
      await body({ a, b, id, pidA, pidB, admin });
    } finally {
      await run(a, "rollback");
      await run(b, "rollback");
      await dropItem(a, id);
    }
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
}

async function baseUnitRow(c: Conn, id: string) {
  const rows = await c.unsafe(
    `select u.conversion_rate::text as rate, u.active
       from items i join item_units u on u.item_id = i.id and u.unit_name = i.base_unit
      where i.id = '${id}'`,
  );
  assertEquals(rows.length, 1, "the item's base unit must have a row in item_units");
  return rows[0] as unknown as { rate: string; active: boolean };
}

function assertRuleHolds(row: { rate: string; active: boolean }) {
  assertEquals(row.rate, "1", "base unit rate must still be 1");
  assertEquals(row.active, true, "base unit must still be active");
}

function assertRefused(o: Outcome, what: string) {
  assert(o !== null, `${what} must be refused`);
  assertEquals(o.code, "23514", `${what}: ${o.message}`);
}

/**
 * A repoints the item's base unit to OTHER. B changes OTHER while A is still open
 * (B started after A's update). A finishes first; B must be the one refused.
 */
async function aFirst({ a, b, id, pidB, admin }: Ctx, bChange: string) {
  await a.unsafe("begin");
  await b.unsafe("begin");
  assertEquals(await run(a, `update items set base_unit = '${OTHER}' where id = '${id}'`), null);
  assertEquals(await run(b, bChange), null);
  // A's check runs now: B's change is not visible to it, so it passes.
  assertEquals(await run(a, "set constraints all immediate"), null);
  // B's check runs while A is still open. With the lock it waits for A.
  const bCheck = run(b, "set constraints all immediate");
  await waitUntilBlocked(admin, pidB); // B really waits for A
  assertEquals(await run(a, "commit"), null, "A commits first");
  const failures = [await bCheck];
  failures.push(await run(b, "commit"));
  const refused = failures.find((f) => f !== null) ?? null;
  assertRefused(refused, "B's change");
  await run(b, "rollback");
  assertRuleHolds(await baseUnitRow(a, id));
}

Deno.test("repoint vs rate change: the rate change is refused", async () => {
  await withItem("D-901", (ctx) =>
    aFirst(ctx, `update item_units set conversion_rate = 1000 where item_id = '${ctx.id}' and unit_name = '${OTHER}'`));
});

Deno.test("rate change vs repoint: the later commit is refused", async () => {
  await withItem("D-902", async ({ a, b, id, pidA, admin }) => {
    await b.unsafe("begin");
    await a.unsafe("begin");
    assertEquals(
      await run(b, `update item_units set conversion_rate = 1000 where item_id = '${id}' and unit_name = '${OTHER}'`),
      null,
    );
    // B's check runs first and passes; with the lock it keeps the item row until B ends.
    assertEquals(await run(b, "set constraints all immediate"), null);
    // A repoints and checks. With the lock the update itself waits for B.
    const aSteps = (async () => {
      const upd = await run(a, `update items set base_unit = '${OTHER}' where id = '${id}'`);
      if (upd) return upd;
      return await run(a, "set constraints all immediate");
    })();
    await waitUntilBlocked(admin, pidA); // A's update really waits for B
    assertEquals(await run(b, "commit"), null, "B commits first");
    const failures = [await aSteps];
    failures.push(await run(a, "commit"));
    const refused = failures.find((f) => f !== null) ?? null;
    assertRefused(refused, "A's repoint");
    await run(a, "rollback");
    assertRuleHolds(await baseUnitRow(b, id));
  });
});

Deno.test("repoint vs deactivate: the deactivation is refused", async () => {
  await withItem("D-903", (ctx) =>
    aFirst(ctx, `update item_units set active = false where item_id = '${ctx.id}' and unit_name = '${OTHER}'`));
});

Deno.test("control: changes to two different items both commit", async () => {
  const a = connect();
  const b = connect();
  try {
    await createItem(a, "D-904");
    await createItem(a, "D-905");
    try {
      await a.unsafe("begin");
      await b.unsafe("begin");
      assertEquals(await run(a, `update items set base_unit = '${OTHER}' where id = 'D-904'`), null);
      assertEquals(
        await run(b, `update item_units set conversion_rate = 1000 where item_id = 'D-905' and unit_name = '${OTHER}'`),
        null,
      );
      assertEquals(await run(a, "set constraints all immediate"), null);
      assertEquals(await run(b, "set constraints all immediate"), null);
      assertEquals(await run(a, "commit"), null);
      assertEquals(await run(b, "commit"), null);
      assertEquals((await baseUnitRow(a, "D-904")).rate, "1");
      assertEquals((await baseUnitRow(a, "D-905")).rate, "1");
    } finally {
      await run(a, "rollback");
      await run(b, "rollback");
      await dropItem(a, "D-904");
      await dropItem(a, "D-905");
    }
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }
});
