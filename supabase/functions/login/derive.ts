// Pure helpers for the login function: no network, no environment.

/** True when the server-side derive secret is present and long enough (32 characters or more). */
export function checkDeriveSecret(secret: string | undefined | null): boolean {
  return typeof secret === "string" && secret.length >= 32;
}

/** True when APP_ORIGIN is a plain http(s) origin (scheme://host[:port], nothing else). */
export function checkAppOrigin(origin: string | undefined | null): boolean {
  if (typeof origin !== "string" || origin === "") return false;
  try {
    const u = new URL(origin);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === origin;
  } catch {
    return false;
  }
}

/**
 * The Supabase Auth password of an app user: lowercase hex HMAC-SHA-256 of the app user id, keyed by the
 * server-only derive secret. The client never sees it; it is never the PIN.
 */
export async function deriveAuthPassword(secret: string, userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(userId)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64Url(s: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The `session_id` claim of a JWT access token. Throws when the token is malformed or the claim is absent. */
export function sessionIdFromJwt(accessToken: string): string {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const payload = JSON.parse(decodeBase64Url(parts[1]));
  const id = payload?.session_id;
  if (typeof id !== "string" || id === "") throw new Error("session_id claim missing");
  return id;
}
