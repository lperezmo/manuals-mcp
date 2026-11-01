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

/** Builds a tiny PDF, one line of text per page, with real xref offsets. */
export function tinyPdf(pages: string[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
