// Request handling of the login function: employee number + secret -> a real Supabase Auth session that the database accepts.
// The database decides who may log in (login_verify) and which sessions count (login_register_session);
// this function only turns a verified login into an Auth session. See spec section 5.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";
import { checkDeriveSecret, deriveAuthPassword, sessionIdFromJwt } from "./derive.ts";

const MAX_BODY_BYTES = 1024;
const EMAIL_DOMAIN = "gosta.invalid";

export type LoginConfig = { appOrigin: string; deriveSecret: string | undefined };
export type LoginDeps = {
  config: LoginConfig;
  /** service-role client (admin API and the login_* RPCs) */
  service: SupabaseClient;
  /** a fresh anon client per call, so sessions never leak between requests */
  makeAnon: () => SupabaseClient;
};

function respond(cfg: LoginConfig, status: number, body?: unknown): Response {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": cfg.appOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (body === undefined) return new Response(null, { status, headers });
  headers["Content-Type"] = "application/json";
  return new Response(JSON.stringify(body), { status, headers });
}

const bad = (c: LoginConfig) => respond(c, 400, { error: "BAD_REQUEST" });
const invalid = (c: LoginConfig) => respond(c, 401, { error: "INVALID_CREDENTIALS" });
const fail = (c: LoginConfig, tag: string, err?: { status?: number; code?: string; message?: string }) => {
  // a short tag, plus status/code/message of an Auth error (GoTrue messages carry no credentials): never the object
  console.error(`login: ${tag}${err ? ` [${err.status ?? "?"} ${err.code ?? "?"} ${String(err.message ?? "").slice(0, 100)}]` : ""}`);
  return respond(c, 500, { error: "SERVER_ERROR" });
};

/** Reads and validates the body; null when it is not acceptable. */
async function readBody(req: Request): Promise<{ employee_number: string; secret: string } | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { employee_number, secret } = parsed as Record<string, unknown>;
  if (typeof employee_number !== "string" || typeof secret !== "string") return null;
  return { employee_number, secret };
}

const isAlreadyRegistered = (e: { code?: string; status?: number; message?: string }) =>
  e.code === "email_exists" || e.code === "user_already_exists" ||
  /already (been )?registered|already exists/i.test(e.message ?? "");

export async function handleLogin(req: Request, deps: LoginDeps): Promise<Response> {
  const cfg = deps.config;
  const deriveSecret = cfg.deriveSecret;
  if (!checkDeriveSecret(deriveSecret)) return fail(cfg, "derive secret missing or too short");
  if (req.method === "OPTIONS") return respond(cfg, 204);
  if (req.method !== "POST") return respond(cfg, 405, { error: "BAD_REQUEST" });

  try {
    const body = await readBody(req);
    if (!body) return bad(cfg);

    // 1. the database verifies the credential, counts failures and locks
    const ver = await deps.service.rpc("login_verify", {
      p_employee_number: body.employee_number,
      p_secret: body.secret,
    });
    if (ver.error || !ver.data || typeof ver.data !== "object") return fail(cfg, "login_verify failed");
    const v = ver.data as {
      ok: boolean; reason?: string; locked_until?: string | null;
      user_id?: string; auth_user_id?: string | null; employee_number?: string; credential_version?: number;
    };
    if (!v.ok) {
      if (v.reason === "locked") return respond(cfg, 423, { error: "LOCKED", locked_until: v.locked_until ?? null });
      return invalid(cfg);
    }
    const userId = v.user_id!;
    const version = v.credential_version!;
    // the normalised number the database returned, never the raw input
    const email = `${v.employee_number}@${EMAIL_DOMAIN}`;
    const derived = await deriveAuthPassword(deriveSecret!, userId);
    const admin = deps.service.auth.admin;

    // 2. provision the Auth user on first login (resumable, safe against a simultaneous first login)
    let authId = v.auth_user_id ?? null;
    let passwordSet = false;
    if (!authId) {
      const created = await admin.createUser({ email, password: derived, email_confirm: true });
      if (created.error && !isAlreadyRegistered(created.error)) return fail(cfg, "createUser failed", created.error);
      const att = await deps.service.rpc("login_attach_auth_user", { p_user_id: userId });
      if (att.error || !att.data || typeof att.data !== "string") return fail(cfg, "attach failed");
      authId = att.data;
      // 3. an Auth user found by email is trusted only once its password is ours
      const upd = await admin.updateUserById(authId, { password: derived });
      if (upd.error) return fail(cfg, "password set failed", upd.error);
      passwordSet = true;
    }

    // 4. sign in with the derived password; repair the password once if that fails
    const signIn = () => deps.makeAnon().auth.signInWithPassword({ email, password: derived });
    let res = await signIn();
    if (res.error || !res.data.session) {
      if (passwordSet) return fail(cfg, "sign-in failed", res.error ?? undefined);
      const upd = await admin.updateUserById(authId, { password: derived });
      if (upd.error) return fail(cfg, "password repair failed", upd.error);
      res = await signIn();
      if (res.error || !res.data.session) return fail(cfg, "sign-in failed after repair", res.error ?? undefined);
    }
    const session = res.data.session;

    // From here on an Auth session exists. Unless it is registered it is useless (the database refuses it),
    // so on any failure we sign it out best-effort.
    const dropSession = async () => {
      try {
        await admin.signOut(session.access_token, "local");
      } catch { /* best effort */ }
    };

    // 5. register this one session
    let sessionId: string;
    try {
      sessionId = sessionIdFromJwt(session.access_token);
    } catch {
      await dropSession();
      return fail(cfg, "no session_id claim");
    }
    const reg = await deps.service.rpc("login_register_session", {
      p_user_id: userId,
      p_session_id: sessionId,
      p_credential_version: version,
    });
    if (reg.error) {
      await dropSession();
      if (reg.error.message === "USER_INVALID") return invalid(cfg);
      return fail(cfg, "register failed");
    }

    // 6. the session and the user's profile (app user id, not the Auth id)
    const prof = await deps.service.from("app_users").select("id, name, role, branch_id").eq("id", userId).single();
    if (prof.error || !prof.data) return fail(cfg, "profile read failed");
    return respond(cfg, 200, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: { id: prof.data.id, name: prof.data.name, role: prof.data.role, branch_id: prof.data.branch_id },
    });
  } catch {
    return fail(cfg, "unexpected exception");
  }
}
