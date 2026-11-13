import { assertEquals, assertMatch, assertNotEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { checkDeriveSecret, deriveAuthPassword, sessionIdFromJwt } from "./derive.ts";

Deno.test("deriveAuthPassword is deterministic, 64 hex chars, depends on both inputs", async () => {
  const a = await deriveAuthPassword("k1", "u1");
  assertEquals(a, await deriveAuthPassword("k1", "u1"));
  assertMatch(a, /^[0-9a-f]{64}$/);
  assertNotEquals(a, await deriveAuthPassword("k2", "u1"));
  assertNotEquals(a, await deriveAuthPassword("k1", "u2"));
});

Deno.test("deriveAuthPassword matches a known HMAC-SHA-256 vector", async () => {
  // RFC 4231 style check computed independently: HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
  assertEquals(
    await deriveAuthPassword("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
});

const jwt = (p: object) => `x.${btoa(JSON.stringify(p)).replace(/=+$/, "")}.y`;

Deno.test("sessionIdFromJwt reads the claim and rejects a token without it", () => {
  assertEquals(sessionIdFromJwt(jwt({ session_id: "abc" })), "abc");
  assertThrows(() => sessionIdFromJwt(jwt({ sub: "u" })));
});

Deno.test("sessionIdFromJwt handles base64url characters and missing padding", () => {
  // "?>?>?>" style bytes produce '+' and '/' in standard base64, '-' and '_' in base64url
  const payload = { session_id: "s-é-ÿ", pad: "???>>>" };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const std = btoa(String.fromCharCode(...bytes));
  const url = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(url.includes("-") || url.includes("_"), true, "test payload must exercise url-safe characters");
  assertEquals(sessionIdFromJwt(`h.${url}.s`), "s-é-ÿ");
  // lengths 1, 2 and 3 mod 4 (padding of 3, 2, 1 characters removed)
  for (const id of ["a", "ab", "abc", "abcd"]) {
    assertEquals(sessionIdFromJwt(jwt({ session_id: id })), id);
  }
});

Deno.test("sessionIdFromJwt throws on strings that are not a JWT", () => {
  assertThrows(() => sessionIdFromJwt("not-a-jwt"));
  assertThrows(() => sessionIdFromJwt(""));
  assertThrows(() => sessionIdFromJwt("a.@@@.c"));
  assertThrows(() => sessionIdFromJwt("a.bm90anNvbg.c")); // payload "notjson"
  assertThrows(() => sessionIdFromJwt(jwt({ session_id: 5 })));
  assertThrows(() => sessionIdFromJwt(jwt({ session_id: "" })));
});

Deno.test("checkDeriveSecret fails closed on a missing or short secret", () => {
  assertEquals(checkDeriveSecret(undefined), false);
  assertEquals(checkDeriveSecret(""), false);
  assertEquals(checkDeriveSecret("x".repeat(31)), false);
  assertEquals(checkDeriveSecret("x".repeat(32)), true);
  assertEquals(checkDeriveSecret("x".repeat(64)), true);
});
