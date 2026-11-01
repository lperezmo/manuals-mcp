import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createVerifier } from "../src/auth.js";
import { readEnv } from "../src/env.js";

export const testEnv = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  PUBLIC_URL: "https://manuals.example.com",
});

export const ISSUER = "https://example-ref.supabase.co/auth/v1";

/** A verifier backed by a throwaway key, and a way to mint tokens for it. */
export async function testAuth() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" };
  const verify = createVerifier({ issuer: ISSUER, jwks: createLocalJWKSet({ keys: [jwk] }) });
  const mint = (claims: Record<string, unknown> = {}, issuer = ISSUER) =>
    new SignJWT({ role: "authenticated", email: "parent@example.com", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setSubject(String(claims.sub ?? "00000000-0000-0000-0000-0000000000aa"))
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  return { verify, mint };
}
