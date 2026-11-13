// End-to-end tests of the login Edge Function against the local Supabase stack (CI is the authoritative run):
// real HTTP to the function (/functions/v1/login), PostgREST (/rest/v1) and GoTrue (/auth/v1), real tokens.
//
// Needs: `supabase start`, `supabase functions serve --env-file supabase/functions/.env.ci`, and in this
// process SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, AUTH_DERIVE_SECRET, APP_ORIGIN.
// Run: deno test --allow-net=127.0.0.1 --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,AUTH_DERIVE_SECRET,APP_ORIGIN,DATABASE_URL
//
// WARNING: this test COMMITS users, sessions, transfers and Auth users in the local stack. Run it last, and run
// `supabase db reset` before running the pgTAP suite again locally afterwards (CI runs pgTAP first).
// Extra env: DATABASE_URL (only for test 15, which changes an employee number directly in the database, as the
// owner-recovery runbook does; defaults to the local stack's 127.0.0.1:54322).
//
// Seeded users (100, 201, 202, 203, 301, 215) are only used for plain logins; everything that resets,
// locks or deactivates uses a user created here. Test 12 (no leakage) must stay last.
import { assert, assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1.0.13";
import { deriveAuthPassword } from "./derive.ts";
import { connect } from "../../tests-concurrency/helpers.ts";

const need = (n: string) => {
  const v = Deno.env.get(n);
  if (!v) throw new Error(`${n} must be set`);
  return v;
};
const BASE = need("SUPABASE_URL").replace(/\/$/, "");
const ANON = need("SUPABASE_ANON_KEY");
const SERVICE = need("SUPABASE_SERVICE_ROLE_KEY");
const DERIVE = need("AUTH_DERIVE_SECRET");
const ORIGIN = need("APP_ORIGIN");
const OWNER_PASSWORD = "correct horse battery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Everything any response said, for the no-leakage test.
const allBodies: string[] = [];
const loginBodies: string[] = [];
const submitted = new Set<string>(); // every secret sent to the login function

type Resp = { status: number; text: string; json: any; headers: Headers };

async function http(url: string, init: RequestInit & { log?: string[] } = {}): Promise<Resp> {
  const r = await fetch(url, init);
  const text = await r.text();
  allBodies.push(text);
  init.log?.push(text);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
}

function loginRaw(body: string, method = "POST"): Promise<Resp> {
  return http(`${BASE}/functions/v1/login`, {
    method,
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: method === "GET" || method === "OPTIONS" ? undefined : body,
    log: loginBodies,
  });
}
function login(employee_number: string, secret: string): Promise<Resp> {
  submitted.add(secret);
  return loginRaw(JSON.stringify({ employee_number, secret }));
}
function rest(path: string, token: string): Promise<Resp> {
  return http(`${BASE}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
}
function rpc(name: string, token: string, args: Record<string, unknown> = {}): Promise<Resp> {
  return http(`${BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}
const rid = () => crypto.randomUUID();
const adminHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

function claims(jwt: string): any {
  const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
}

type Tokens = { access: string; refresh: string };
async function loginOk(num: string, secret: string): Promise<Tokens & { body: any }> {
  const r = await login(num, secret);
  assertEquals(r.status, 200, `login ${num} -> ${r.text.slice(0, 200)}`);
  assert(r.json.access_token && r.json.refresh_token, "tokens present");
  return { access: r.json.access_token, refresh: r.json.refresh_token, body: r.json };
}

const sendBody = () => ({
  p_request_id: rid(),
  p_to_branch: "BR-02",
  p_lines: [{ item_id: "D-001", unit: "عبوة", quantity: 1 }],
});

/** The token is accepted: it reads rows and an RPC works. */
async function assertAlive(label: string, token: string) {
  const items = await rest("items?select=id", token);
  assertEquals(items.status, 200, `${label}: items status`);
  assert(Array.isArray(items.json) && items.json.length >= 1, `${label}: items readable`);
  const t = await rpc("send_transfer", token, sendBody());
  assertEquals(t.status, 200, `${label}: send_transfer -> ${t.text.slice(0, 200)}`);
  assert(t.json?.transfer_id, `${label}: transfer_id returned`);
}
/** The token is refused by the database: RLS shows nothing and an RPC says NOT_AUTHENTICATED. */
async function assertDead(label: string, token: string) {
  const items = await rest("items?select=id", token);
  assertEquals(items.status, 200, `${label}: items status`);
  assertEquals(items.json, [], `${label}: RLS shows nothing`);
  const t = await rpc("send_transfer", token, sendBody());
  assertEquals(t.json?.message, "NOT_AUTHENTICATED", `${label}: RPC refused (${t.text.slice(0, 200)})`);
}

function refresh(refreshToken: string): Promise<Resp> {
  return http(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

async function ownerToken(): Promise<string> {
  return (await loginOk("100", OWNER_PASSWORD)).access;
}

const RUN = String(Date.now()).slice(-7);
let counter = 0;
/** Creates a manager of BR-01 through the real admin RPC, as the owner. */
async function makeUser(owner: string, pin: string, role = "manager", branch = "BR-01", fixedNum?: string) {
  const num = fixedNum ?? `8${RUN}${String(++counter).padStart(2, "0")}`;
  const r = await rpc("admin_create_user", owner, {
    p_request_id: rid(),
    p_employee_number: num,
    p_name: `اختبار ${num}`,
    p_role: role,
    p_branch_id: branch,
    p_secret: pin,
  });
  assertEquals(r.status, 200, `admin_create_user -> ${r.text.slice(0, 200)}`);
  assertMatch(r.json.user_id, UUID);
  submitted.add(pin);
  return { num, id: r.json.user_id as string, pin };
}

async function authUsersWithEmail(email: string): Promise<any[]> {
  const r = await http(`${BASE}/auth/v1/admin/users?page=1&per_page=1000`, { headers: adminHeaders });
  assertEquals(r.status, 200, "admin users list");
  return (r.json.users as any[]).filter((u) => u.email === email);
}
async function appUser(num: string): Promise<any> {
  const r = await http(`${BASE}/rest/v1/app_users?employee_number=eq.${num}&select=id,auth_user_id,role,branch_id,name`, {
    headers: adminHeaders,
  });
  assertEquals(r.status, 200, `app_users read -> ${r.text.slice(0, 200)}`);
  return r.json[0];
}

// 1 ---------------------------------------------------------------------------------------------------
Deno.test("1. good PIN gives a real token that the database accepts", async () => {
  const r = await login("201", "1111");
  assertEquals(r.status, 200);
  const { access_token, refresh_token, expires_at, user } = r.json;
  assert(refresh_token && typeof expires_at === "number");
  const c = claims(access_token);
  assertMatch(c.sub, UUID);
  assertMatch(c.session_id, UUID);
  const row = await appUser("201");
  assertEquals(user, { id: row.id, name: row.name, role: "manager", branch_id: "BR-01" });
  assertEquals(c.sub, row.auth_user_id);
  await assertAlive("201", access_token);
});

// 2 ---------------------------------------------------------------------------------------------------
Deno.test("2. owner login gives a real token that can call admin RPCs", async () => {
  const r = await login("100", OWNER_PASSWORD);
  assertEquals(r.status, 200);
  assertEquals(r.json.user.role, "owner");
  assertEquals(r.json.user.branch_id, null);
  const u = await makeUser(r.json.access_token, "1234");
  assertMatch(u.id, UUID);
});

// 3 ---------------------------------------------------------------------------------------------------
Deno.test("3. first login provisions exactly one Auth user; a second login works", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "2468");
  assertEquals((await appUser(u.num)).auth_user_id, null);
  assertEquals((await login(u.num, u.pin)).status, 200);
  assertEquals((await login(u.num, u.pin)).status, 200);
  assertEquals((await authUsersWithEmail(`${u.num}@gosta.invalid`)).length, 1);
  assertNotEquals((await appUser(u.num)).auth_user_id, null);
});

// 4 ---------------------------------------------------------------------------------------------------
Deno.test("4. interrupted provisioning: an unattached Auth user with a foreign password is taken over", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "1357");
  const email = `${u.num}@gosta.invalid`;
  const foreign = crypto.randomUUID() + crypto.randomUUID();
  const c = await http(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ email, password: foreign, email_confirm: true }),
  });
  assert(c.status === 200 || c.status === 201, `admin createUser -> ${c.text.slice(0, 200)}`);
  const t = await loginOk(u.num, u.pin);
  assertEquals((await authUsersWithEmail(email)).length, 1);
  assertEquals((await appUser(u.num)).auth_user_id, c.json.id);
  await assertAlive("interrupted", t.access);
  // the foreign password no longer works at GoTrue: the Auth user was taken over
  const old = await http(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: foreign }),
  });
  assertEquals(old.status, 400, "the foreign password is dead");
});

// 5 ---------------------------------------------------------------------------------------------------
Deno.test("5. two simultaneous first logins both succeed with one Auth user", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "8642");
  const [a, b] = await Promise.all([login(u.num, u.pin), login(u.num, u.pin)]);
  assertEquals([a.status, b.status], [200, 200], `${a.text.slice(0, 120)} | ${b.text.slice(0, 120)}`);
  assertEquals((await authUsersWithEmail(`${u.num}@gosta.invalid`)).length, 1);
  assertNotEquals((await appUser(u.num)).auth_user_id, null);
  await assertAlive("sim-a", a.json.access_token);
  await assertAlive("sim-b", b.json.access_token);
});

// 6 ---------------------------------------------------------------------------------------------------
Deno.test("6. wrong PIN and unknown number are indistinguishable", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "5151");
  const wrong = await login(u.num, "0000");
  const unknown = await login("98765432101", "0000");
  assertEquals(wrong.status, 401);
  assertEquals(wrong.text, '{"error":"INVALID_CREDENTIALS"}');
  assertEquals(unknown.status, wrong.status);
  assertEquals(unknown.text, wrong.text);
});

// 7 ---------------------------------------------------------------------------------------------------
Deno.test("7. five wrong PINs lock the account, even for the right PIN", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "7373");
  for (let i = 1; i <= 4; i++) assertEquals((await login(u.num, "0000")).status, 401, `attempt ${i}`);
  const fifth = await login(u.num, "0000");
  assertEquals(fifth.status, 423);
  assertEquals(fifth.json.error, "LOCKED");
  assertEquals(Object.keys(fifth.json).sort(), ["error", "locked_until"]);
  assert(new Date(fifth.json.locked_until).getTime() > Date.now(), "locked_until is in the future");
  const right = await login(u.num, u.pin);
  assertEquals(right.status, 423);
  assertEquals(right.json.error, "LOCKED");
});

// 8 ---------------------------------------------------------------------------------------------------
Deno.test("8. reset, re-login: old PIN, old tokens and old refresh tokens are dead", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "4444");
  const reset = (pin: string) => {
    submitted.add(pin);
    return rpc("admin_set_secret", owner, { p_request_id: rid(), p_user_id: u.id, p_secret: pin });
  };

  const A = await loginOk(u.num, "4444");
  await assertAlive("A before reset", A.access);

  assertEquals((await reset("5555")).status, 200);

  assertEquals((await login(u.num, "4444")).status, 401, "old PIN is refused");
  const B = await loginOk(u.num, "5555");
  const sidA = claims(A.access).session_id, sidB = claims(B.access).session_id;
  assertNotEquals(sidA, sidB, "a new login is a new session");

  await assertDead("A after new login", A.access);

  const dead: Array<[string, string]> = [["A", A.access]];
  const rA = await refresh(A.refresh);
  let A2: string | null = null;
  if (rA.status === 200 && rA.json?.access_token) {
    A2 = rA.json.access_token as string;
    console.log("CASE 8 refresh branch: GoTrue ISSUED a new access token for refresh token A; the app refuses it");
    assertEquals(claims(A2).session_id, sidA, "the refreshed token belongs to A's session");
    await assertDead("A2", A2);
    dead.push(["A2", A2]);
  } else {
    console.log(`CASE 8 refresh branch: GoTrue REFUSED refresh token A with status ${rA.status}`);
    assert(rA.status >= 400 && rA.status < 500, `refusal status ${rA.status}`);
  }

  await assertAlive("B", B.access);
  const rB = await refresh(B.refresh);
  assertEquals(rB.status, 200, "refresh token B refreshes");
  assertEquals(claims(rB.json.access_token).session_id, sidB);
  await assertAlive("B2", rB.json.access_token);

  // second reset and a third login revive nothing
  assertEquals((await reset("6666")).status, 200);
  const C = await loginOk(u.num, "6666");
  assertNotEquals(claims(C.access).session_id, sidB);
  dead.push(["B", B.access], ["B2", rB.json.access_token]);
  for (const [label, tok] of dead) await assertDead(`${label} after second reset`, tok);
  for (const [label, rt] of [["A refresh", A.refresh], ["B2 refresh", rB.json.refresh_token]]) {
    const r = await refresh(rt);
    if (r.status === 200) await assertDead(`${label} again`, r.json.access_token);
  }
  assertEquals((await login(u.num, "5555")).status, 401, "previous PIN stays dead");
  await assertAlive("C", C.access);
});

// 9 ---------------------------------------------------------------------------------------------------
Deno.test("9. deactivation kills live tokens and logins", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "9090");
  const t = await loginOk(u.num, u.pin);
  await assertAlive("before", t.access);
  const r = await rpc("admin_set_user_active", owner, { p_request_id: rid(), p_user_id: u.id, p_active: false });
  assertEquals(r.status, 200, r.text);
  await assertDead("after deactivation", t.access);
  const l = await login(u.num, u.pin);
  assertEquals(l.status, 401);
  assertEquals(l.text, '{"error":"INVALID_CREDENTIALS"}');
});

// 10 --------------------------------------------------------------------------------------------------
Deno.test("10. logout revokes the token; a fresh login works", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "1212");
  const t = await loginOk(u.num, u.pin);
  await assertAlive("before logout", t.access);
  const out = await rpc("logout", t.access);
  assert(out.status >= 200 && out.status < 300, `logout -> ${out.status} ${out.text}`);
  await assertDead("after logout", t.access);
  const t2 = await loginOk(u.num, u.pin);
  await assertAlive("fresh login", t2.access);
});

// 11 --------------------------------------------------------------------------------------------------
Deno.test("11. bad requests, methods and CORS", async () => {
  const bad = '{"error":"BAD_REQUEST"}';
  const empty = await loginRaw("{}");
  assertEquals([empty.status, empty.text], [400, bad]);
  const notJson = await loginRaw("this is not json");
  assertEquals([notJson.status, notJson.text], [400, bad]);
  const nonString = await loginRaw('{"employee_number":201,"secret":"1111"}');
  assertEquals([nonString.status, nonString.text], [400, bad]);
  const big = await loginRaw(JSON.stringify({ employee_number: "201", secret: "a".repeat(2048) }));
  assertEquals([big.status, big.text], [400, bad]);
  const get = await loginRaw("", "GET");
  assertEquals(get.status, 405);
  assertEquals(get.text, bad);
  const opt = await loginRaw("", "OPTIONS");
  assert(opt.status >= 200 && opt.status < 300, `OPTIONS -> ${opt.status}`);
  // The local gateway may answer a preflight itself; the function's own header is asserted on POST below.
  console.log(`OPTIONS Access-Control-Allow-Origin: ${opt.headers.get("access-control-allow-origin")}`);
  assert(opt.headers.get("access-control-allow-origin"), "CORS origin header on OPTIONS");
  assert((opt.headers.get("access-control-allow-headers") ?? "").includes("authorization"));
  // The local gateway (Kong) adds its own CORS header ("*") to function responses, so only the presence of
  // the header is asserted here; the function's own value (APP_ORIGIN on every exit) is covered in handler_test.ts.
  const post = await login("201", "1111");
  const post401 = await login("98765432101", "x");
  for (const r of [post, post401]) {
    const o = r.headers.get("access-control-allow-origin");
    console.log(`POST ${r.status} Access-Control-Allow-Origin: ${o}`);
    assert(o === ORIGIN || o === "*", `CORS origin on a POST response: ${o}`);
  }
});

// 13 --------------------------------------------------------------------------------------------------
Deno.test("13. a token signed in directly against Auth but never registered is refused", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "3030");
  await loginOk(u.num, u.pin); // provisions the Auth user with the derived password
  // a login verified with the current PIN, then a reset before registration
  const ver = await rpc("login_verify", SERVICE, { p_employee_number: u.num, p_secret: u.pin });
  assertEquals(ver.json.ok, true);
  const rs = await rpc("admin_set_secret", owner, { p_request_id: rid(), p_user_id: u.id, p_secret: "3131" });
  assertEquals(rs.status, 200);
  const reg = await rpc("login_register_session", SERVICE, {
    p_user_id: u.id, p_session_id: rid(), p_credential_version: ver.json.credential_version,
  });
  assertEquals(reg.json?.message, "USER_INVALID", "stale version refused");
  // sign in directly with the derived password: a real token, never registered
  const direct = await http(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${u.num}@gosta.invalid`, password: await deriveAuthPassword(DERIVE, u.id) }),
  });
  assertEquals(direct.status, 200, direct.text.slice(0, 200));
  await assertDead("unregistered", direct.json.access_token);
});

// 14 --------------------------------------------------------------------------------------------------
Deno.test("14. seeded users can still log in", async () => {
  for (const [n, s] of [["100", OWNER_PASSWORD], ["201", "1111"], ["202", "2222"], ["203", "0303"], ["301", "3333"], ["215", "1515"]]) {
    assertEquals((await login(n, s)).status, 200, `seeded ${n}`);
  }
});

// 15 --------------------------------------------------------------------------------------------------
Deno.test("15. a changed employee number (runbook section 3): login works, the Auth email follows, the old number is reusable", async () => {
  const owner = await ownerToken();
  const u = await makeUser(owner, "6464");
  const n1 = u.num;
  const n2 = `7${RUN}${String(++counter).padStart(2, "0")}`;
  assertEquals((await loginOk(n1, u.pin)).access.length > 0, true);
  const before = await authUsersWithEmail(`${n1}@gosta.invalid`);
  assertEquals(before.length, 1);
  const authId = before[0].id;

  const db = connect();
  try {
    await db.unsafe(`update app_users set employee_number = $2 where id = $1`, [u.id, n2]);
  } finally {
    await db.end();
  }

  const t = await loginOk(n2, u.pin);
  await assertAlive("after number change", t.access);
  const after = await authUsersWithEmail(`${n2}@gosta.invalid`);
  assertEquals(after.length, 1, "exactly one Auth user for the new number");
  assertEquals(after[0].id, authId, "it is the same Auth user, its email was updated");
  assertEquals((await authUsersWithEmail(`${n1}@gosta.invalid`)).length, 0, "the old email is gone");
  assertEquals((await login(n2, u.pin)).status, 200, "second login with the new number");
  assertEquals((await login(n1, u.pin)).status, 401, "the old number no longer logs in");

  // the old number is free for someone else
  const u2 = await makeUser(owner, "6565", "manager", "BR-01", n1);
  const t2 = await loginOk(n1, u2.pin);
  await assertAlive("new holder of the old number", t2.access);
  const mine = await authUsersWithEmail(`${n1}@gosta.invalid`);
  assertEquals(mine.length, 1);
  assertNotEquals(mine[0].id, authId, "a different Auth user");
  assertEquals((await appUser(n1)).auth_user_id, mine[0].id);
  assertEquals((await appUser(n2)).auth_user_id, authId);
});

// 12 (kept last) --------------------------------------------------------------------------------------
Deno.test("12. no response ever contains a submitted secret or the derive secret", () => {
  assert(allBodies.length > 50, "the test saw the traffic");
  for (const body of allBodies) assert(!body.includes(DERIVE), "derive secret in a response");
  // PINs are 4 digits and would match inside tokens by chance: check them against the login function's error bodies only
  for (const body of allBodies) {
    for (const s of submitted) if (s.length >= 12) assert(!body.includes(s), "a long secret appeared in a response");
  }
  for (const body of loginBodies) {
    // a lock body carries a timestamp whose digits could contain a PIN by chance
    if (body.includes("access_token") || body.includes("locked_until")) continue;
    for (const s of submitted) assert(s === "" || !body.includes(s), "a secret appeared in a login error body");
  }
  for (const body of loginBodies) assert(!body.includes(SERVICE), "service key in a login response");
});
