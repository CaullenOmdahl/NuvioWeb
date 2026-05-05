import assert from "node:assert/strict";
import test from "node:test";

test("email sign-in reports a clear error when Supabase auth config is missing", async () => {
  globalThis.__NUVIO_ENV__ = {
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: ""
  };

  const { AuthManager } = await import("../js/core/auth/authManager.js");

  await assert.rejects(
    () => AuthManager.signInWithEmail("person@example.com", "password"),
    (error) => {
      assert.equal(error.code, "AUTH_CONFIG_MISSING");
      assert.match(error.message, /Nuvio auth is not configured/);
      return true;
    }
  );
});
