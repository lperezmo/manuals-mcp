import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { authIssuer, type Env } from "./env.js";

// Access tokens come from Supabase Auth: either an OAuth token issued to an
// AI app (Claude, ChatGPT, Muse...) or the Android app's own session token.
// Both are JWTs signed with the project's asymmetric keys, so we check them
// against the published JWKS and pass them straight through to Supabase,
// where row-level security does the rest.

export interface UserAuth {
  userId: string;
  email?: string;
}

export function userFrom(auth: AuthInfo | undefined): UserAuth {
  const extra = auth?.extra as Partial<UserAuth> | undefined;
  if (!auth || !extra?.userId) {
    throw new Error("Not signed in");
  }
  return { userId: extra.userId, email: extra.email };
}

export interface VerifierOptions {
  issuer: string;
  jwks: JWTVerifyGetKey;
  audience?: string;
}

export function createVerifier({ issuer, jwks, audience = "authenticated" }: VerifierOptions) {
  return async function verify(token: string | undefined): Promise<AuthInfo | undefined> {
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      if (typeof payload.sub !== "string" || payload.role !== "authenticated") return undefined;
      const scope = typeof payload.scope === "string" ? payload.scope : "";
      return {
        token,
        clientId: typeof payload.client_id === "string" ? payload.client_id : "manuals-app",
        scopes: scope.split(" ").filter(Boolean),
        expiresAt: payload.exp,
        extra: {
          userId: payload.sub,
          email: typeof payload.email === "string" ? payload.email : undefined,
        },
      };
    } catch {
      return undefined;
    }
  };
}

let remote: ReturnType<typeof createVerifier> | undefined;

export function supabaseVerifier(env: Env) {
  if (!remote) {
    const issuer = authIssuer(env);
    remote = createVerifier({
      issuer,
      jwks: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
    });
  }
  return remote;
}

export function bearer(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}
