// Login Edge Function entry point: wires the real clients to handleLogin (handler.ts). Nothing imports this file.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { handleLogin, type LoginConfig } from "./handler.ts";

{
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const config: LoginConfig = {
    appOrigin: Deno.env.get("APP_ORIGIN") ?? "",
    deriveSecret: Deno.env.get("AUTH_DERIVE_SECRET"),
  };
  const service = createClient(url, serviceKey, opts);
  Deno.serve((req) => handleLogin(req, { config, service, makeAnon: () => createClient(url, anonKey, opts) }));
}
