// handleLogin with fake clients: every exit, what it created, and what it may reveal. No network.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.13";
import { handleLogin } from "./handler.ts";

const ORIGIN = "http://app.example";
const SECRET = "d".repeat(40);
// deno-lint-ignore no-explicit-any
type Any = any;

function setup(o: Any) {
  const calls: string[] = [];
  const service: Any = {
    rpc: (n: string) => (calls.push(n), Promise.resolve(o.rpc[n])),
    auth: {
      admin: {
        createUser: () => (calls.push("create"), Promise.resolve(o.create ?? { error: null })),
        updateUserById: () => (calls.push("update"), Promise.resolve(o.update ?? { error: null })),
        signOut: () => (calls.push("signout"), Promise.resolve({})),
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve(o.profile ?? { data: { id: "u1", name: "n", role: "manager", branch_id: "BR-01" }, error: null }),
        }),
      }),
    }),
  };
  let n = 0;
  const makeAnon = () =>
    ({
      auth: {
        signInWithPassword: () => (calls.push("signin"), Promise.resolve(o.signin[Math.min(n++, o.signin.length - 1)])),
      },
    }) as Any;
  const deps = { config: { appOrigin: ORIGIN, deriveSecret: "derive" in o ? o.derive : SECRET }, service, makeAnon };
  return { calls, deps };
}
const jwt = `h.${btoa(JSON.stringify({ session_id: "s1" })).replace(/=+$/, "")}.s`;
const session = { data: { session: { access_token: jwt, refresh_token: "r", expires_at: 1 } }, error: null };
const bad = { data: { session: null }, error: { status: 400, code: "invalid_credentials", message: "x" } };
const verify = (auth: string | null) => ({
  data: { ok: true, user_id: "u1", auth_user_id: auth, employee_number: "201", credential_version: 3 },
  error: null,
});
const post = (body: unknown = { employee_number: "201", secret: "s3cret-value" }) =>
  new Request("http://x/login", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

async function run(o: Any, req: Request = post()) {
  const m = setup(o);
  const res = await handleLogin(req, m.deps);
  const text = await res.text();
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), ORIGIN, "CORS origin on every response");
  assert(!text.includes("s3cret-value") && !text.includes(SECRET), "no secret in the body");
  return { status: res.status, text, json: text ? JSON.parse(text) : null, calls: m.calls };
}
const ok = { login_register_session: { error: null } };

Deno.test("existing Auth user: 200 with the session and the app user", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), ...ok }, signin: [session] });
  assertEquals(r.status, 200);
  assertEquals(r.calls, ["login_verify", "signin", "login_register_session"]);
  assertEquals(r.json.user, { id: "u1", name: "n", role: "manager", branch_id: "BR-01" });
  assertEquals(r.json.access_token, jwt);
});
Deno.test("first login: create, attach, set password, sign in, register", async () => {
  const r = await run({ rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null }, ...ok }, signin: [session] });
  assertEquals(r.status, 200);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user", "update", "signin", "login_register_session"]);
});
Deno.test("an already-registered Auth user is not a failure", async () => {
  const r = await run({
    create: { error: { status: 422, code: "email_exists", message: "exists" } },
    rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null }, ...ok },
    signin: [session],
  });
  assertEquals(r.status, 200);
});
Deno.test("a createUser error is survivable when the attach finds the Auth user (lost insert race)", async () => {
  const r = await run({
    create: { error: { status: 500, code: "unexpected_failure", message: "Database error creating new user" } },
    rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null }, ...ok },
    signin: [session],
  });
  assertEquals(r.status, 200);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user", "update", "signin", "login_register_session"]);
});
Deno.test("a createUser error with nothing to attach is a 500 with no detail (attach retried once)", async () => {
  const r = await run({
    create: { error: { status: 500, code: "x", message: "boom" } },
    rpc: { login_verify: verify(null), login_attach_auth_user: { data: null, error: null } },
    signin: [],
  });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user", "login_attach_auth_user"]);
});
Deno.test("attach returning null is a 500", async () => {
  const r = await run({ rpc: { login_verify: verify(null), login_attach_auth_user: { data: null, error: null } }, signin: [] });
  assertEquals(r.status, 500);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user"]);
});
Deno.test("failed sign-in for an existing user repairs the password once and retries", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), ...ok }, signin: [bad, session] });
  assertEquals(r.status, 200);
  assertEquals(r.calls, ["login_verify", "signin", "update", "signin", "login_register_session"]);
});
Deno.test("a second sign-in failure is a 500", async () => {
  const r = await run({ rpc: { login_verify: verify("a") }, signin: [bad, bad] });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify", "signin", "update", "signin"]);
});
Deno.test("USER_INVALID at registration signs the Auth session out and answers 401", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), login_register_session: { error: { message: "USER_INVALID" } } }, signin: [session] });
  assertEquals([r.status, r.text], [401, '{"error":"INVALID_CREDENTIALS"}']);
  assertEquals(r.calls.at(-1), "signout");
});
Deno.test("another registration failure signs out and answers 500", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), login_register_session: { error: { message: "oops" } } }, signin: [session] });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls.at(-1), "signout");
});
Deno.test("a token without session_id is never returned", async () => {
  const noSid = { data: { session: { access_token: "a.e30.c", refresh_token: "r", expires_at: 1 } }, error: null };
  const r = await run({ rpc: { login_verify: verify("a") }, signin: [noSid] });
  assertEquals(r.status, 500);
  assert(!r.calls.includes("login_register_session"));
});
Deno.test("locked and invalid answers", async () => {
  const locked = await run({ rpc: { login_verify: { data: { ok: false, reason: "locked", locked_until: "2030-01-01T00:00:00Z" }, error: null } }, signin: [] });
  assertEquals([locked.status, locked.json], [423, { error: "LOCKED", locked_until: "2030-01-01T00:00:00Z" }]);
  const inv = await run({ rpc: { login_verify: { data: { ok: false, reason: "invalid", locked_until: null }, error: null } }, signin: [] });
  assertEquals([inv.status, inv.text], [401, '{"error":"INVALID_CREDENTIALS"}']);
  assertEquals(inv.calls, ["login_verify"]);
});
Deno.test("the email uses the number the database returned, not the input", async () => {
  let email = "";
  const m = setup({ rpc: { login_verify: { data: { ...verify("a").data, employee_number: "0204" }, error: null }, ...ok }, signin: [session] });
  m.deps.makeAnon = () => ({ auth: { signInWithPassword: (a: Any) => ((email = a.email), Promise.resolve(session)) } }) as Any;
  await handleLogin(post({ employee_number: "  ٠٢٠٤ ", secret: "x" }), m.deps);
  assertEquals(email, "0204@gosta.invalid");
});
Deno.test("bad requests, methods and a short derive secret", async () => {
  const o = { rpc: {}, signin: [] };
  for (const b of ["{}", "nope", '{"employee_number":1,"secret":"x"}', JSON.stringify({ employee_number: "1", secret: "a".repeat(2000) })]) {
    const r = await run(o, post(b));
    assertEquals([r.status, r.text], [400, '{"error":"BAD_REQUEST"}']);
  }
  assertEquals((await run(o, new Request("http://x", { method: "GET" }))).status, 405);
  const opt = await run(o, new Request("http://x", { method: "OPTIONS" }));
  assertEquals(opt.status, 204);
  for (const d of [undefined, "short"]) {
    const r = await run({ ...o, derive: d });
    assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
    assertEquals(r.calls, []);
  }
  assertNotEquals(SECRET.length, 0);
});
