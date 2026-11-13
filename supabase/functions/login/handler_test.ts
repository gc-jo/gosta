// handleLogin with fake clients: every exit, what it created, and what it may reveal. No network.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.13";
import { handleLogin } from "./handler.ts";
import { deriveAuthPassword } from "./derive.ts";

const ORIGIN = "http://app.example";
const SECRET = "d".repeat(40);
// deno-lint-ignore no-explicit-any
type Any = any;

function setup(o: Any) {
  const calls: string[] = [];
  const args: Record<string, Any[]> = {};
  const rec = (n: string, a: Any) => (calls.push(n), (args[n] ??= []).push(a));
  const service: Any = {
    rpc: (n: string, a: Any) => (rec(n, a), Promise.resolve(o.rpc[n])),
    auth: {
      admin: {
        createUser: (a: Any) => (rec("create", a), Promise.resolve(o.create ?? { error: null })),
        updateUserById: (id: string, a: Any) => {
          rec("update", { id, ...a });
          const r = o.updates ? o.updates[Math.min(args.update.length - 1, o.updates.length - 1)] : o.update;
          return Promise.resolve(r ?? { error: null });
        },
        signOut: (jwt: string, scope: string) => (rec("signout", { jwt, scope }), Promise.resolve({})),
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
        signInWithPassword: (a: Any) => (rec("signin", a), Promise.resolve(o.signin[Math.min(n++, o.signin.length - 1)])),
      },
    }) as Any;
  const deps = {
    config: { appOrigin: "appOrigin" in o ? o.appOrigin : ORIGIN, deriveSecret: "derive" in o ? o.derive : SECRET },
    service,
    makeAnon,
  };
  return { calls, args, deps };
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
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), o.appOrigin ?? ORIGIN, "CORS origin on every response");
  assert(!text.includes("s3cret-value") && !text.includes(SECRET), "no secret in the body");
  return { status: res.status, text, json: text ? JSON.parse(text) : null, calls: m.calls, args: m.args };
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
  const r = await run({ rpc: { login_verify: { data: { ...verify("a").data, employee_number: "0204" }, error: null }, ...ok }, signin: [session] }, post({ employee_number: "  ٠٢٠٤ ", secret: "x" }));
  assertEquals(r.args.signin[0].email, "0204@gosta.invalid");
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

// ---- argument capture and the branches added in fix round 1 -------------------------------------------------
const DERIVED_U1 = await deriveAuthPassword(SECRET, "u1");
const verifyN = (auth: string | null, num: string) => ({
  data: { ok: true, user_id: "u1", auth_user_id: auth, employee_number: num, credential_version: 3 },
  error: null,
});
const unreg = (r: { calls: string[] }) => assert(!r.calls.includes("login_register_session"), "no session registered");

Deno.test("arguments: verify, sign-in and registration receive exactly the right values", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), ...ok }, signin: [session] }, post({ employee_number: " 201 ", secret: "s3cret-value" }));
  assertEquals(r.args.login_verify, [{ p_employee_number: " 201 ", p_secret: "s3cret-value" }]);
  assertEquals(r.args.signin, [{ email: "201@gosta.invalid", password: DERIVED_U1 }]);
  assertEquals(r.args.login_register_session, [{ p_user_id: "u1", p_session_id: "s1", p_credential_version: 3 }]);
});
Deno.test("first login: createUser and the password/email update carry the derived password and the email", async () => {
  const r = await run({ rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null }, ...ok }, signin: [session] });
  assertEquals(r.args.create, [{ email: "201@gosta.invalid", password: DERIVED_U1, email_confirm: true }]);
  assertEquals(r.args.login_attach_auth_user, [{ p_user_id: "u1" }]);
  assertEquals(r.args.update, [{ id: "a1", password: DERIVED_U1, email: "201@gosta.invalid", email_confirm: true }]);
});
Deno.test("repair after a number change: the update carries the derived password AND the new email, the retry uses it", async () => {
  const r = await run({ rpc: { login_verify: verifyN("a1", "7002"), ...ok }, signin: [bad, session] });
  assertEquals(r.status, 200);
  assertEquals(r.args.update, [{ id: "a1", password: DERIVED_U1, email: "7002@gosta.invalid", email_confirm: true }]);
  assertEquals(r.args.signin.map((a: Any) => a.email), ["7002@gosta.invalid", "7002@gosta.invalid"]);
  assertEquals(r.args.signin[1].password, DERIVED_U1);
});
Deno.test("repair update fails (for example the email is held by another Auth user): 500, nothing signed in", async () => {
  const r = await run({ rpc: { login_verify: verify("a1"), ...ok }, signin: [bad, session], update: { error: { status: 422, code: "email_exists", message: "x" } } });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify", "signin", "update"]);
  unreg(r);
});
Deno.test("first provisioning: update failure is a 500", async () => {
  const r = await run({ rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null } }, signin: [session], update: { error: { status: 500, code: "x", message: "y" } } });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user", "update"]);
});
Deno.test("first login: sign-in failure after the password was just set is a 500 without a second repair", async () => {
  const r = await run({ rpc: { login_verify: verify(null), login_attach_auth_user: { data: "a1", error: null } }, signin: [bad, session] });
  assertEquals(r.status, 500);
  assertEquals(r.calls, ["login_verify", "create", "login_attach_auth_user", "update", "signin"]);
});
Deno.test("login_verify RPC error is a 500", async () => {
  const r = await run({ rpc: { login_verify: { data: null, error: { message: "db down" } } }, signin: [] });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify"]);
});
Deno.test("profile read failure after registration drops the Auth session, then 500", async () => {
  const r = await run({ rpc: { login_verify: verify("a"), ...ok }, signin: [session], profile: { data: null, error: { message: "x" } } });
  assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
  assertEquals(r.calls, ["login_verify", "signin", "login_register_session", "signout"]);
  assertEquals(r.args.signout, [{ jwt, scope: "local" }]);
});

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });
Deno.test("body cap is enforced while streaming, whatever Content-Length says", async () => {
  const o = { rpc: {}, signin: [] };
  const big = new Request("http://x", { method: "POST", body: streamOf(Array.from({ length: 20 }, () => "a".repeat(100))), duplex: "half" } as Any);
  const r = await run(o, big);
  assertEquals([r.status, r.text], [400, '{"error":"BAD_REQUEST"}']);
  const lying = new Request("http://x", {
    method: "POST", headers: { "content-length": "10" }, body: streamOf(["{", "a".repeat(2000), "}"]), duplex: "half",
  } as Any);
  assertEquals((await run(o, lying)).status, 400);
  // exactly at the cap is accepted as far as size goes (it then fails as a bad body, not as too large)
  const okSize = JSON.stringify({ employee_number: "1", secret: "x".repeat(1024 - 35) });
  assertEquals(new TextEncoder().encode(okSize).length, 1024);
  const m = await run({ rpc: { login_verify: { data: { ok: false, reason: "invalid" }, error: null } }, signin: [] }, post(okSize));
  assertEquals(m.status, 401);
});
Deno.test("control characters in either field are a 400 and never reach the database", async () => {
  for (const f of ["\u0000", "a\u0000b", "\n", "\u007f", "\u0085"]) {
    for (const body of [
      `{"employee_number":"20${f}1","secret":"1111"}`,
      `{"employee_number":"201","secret":"11${f}11"}`,
    ]) {
      const r = await run({ rpc: { login_verify: verify("a") }, signin: [] }, post(body));
      assertEquals([r.status, r.text], [400, '{"error":"BAD_REQUEST"}'], body);
      assertEquals(r.calls, []);
    }
  }
});
Deno.test("an empty or malformed APP_ORIGIN fails closed with 500 on every request", async () => {
  for (const origin of ["", "not a url", "https://app.example.com/path", "*"]) {
    const r = await run({ rpc: { login_verify: verify("a"), ...ok }, signin: [session], appOrigin: origin });
    assertEquals([r.status, r.text], [500, '{"error":"SERVER_ERROR"}']);
    assertEquals(r.calls, []);
  }
});
