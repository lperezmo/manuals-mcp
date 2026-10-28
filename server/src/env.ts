// Server configuration, read once from the environment. Only public values
// (the project URL and its publishable key) are needed to act as a user:
// every database call runs with the caller's own token, so RLS applies.

export interface Env {
  supabaseUrl: string;
  supabasePublishableKey: string;
  /** Public origin of this server, e.g. https://manuals-mcp.vercel.app. Derived from requests when unset. */
  publicUrl?: string;
  /** Optional OpenAI-compatible model API used to read manuals on the server (D6). */
  reader?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function readEnv(source: Record<string, string | undefined> = process.env): Env {
  const supabaseUrl = source.SUPABASE_URL;
  const supabasePublishableKey = source.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set (see .env.example)");
  }
  const readerBase = source.READER_BASE_URL;
  const readerModel = source.READER_MODEL;
  return {
    supabaseUrl: trimSlash(supabaseUrl),
    supabasePublishableKey,
    publicUrl: source.PUBLIC_URL ? trimSlash(source.PUBLIC_URL) : undefined,
    reader:
      readerBase && readerModel
        ? { baseUrl: trimSlash(readerBase), model: readerModel, apiKey: source.READER_API_KEY }
        : undefined,
  };
}

/** Supabase Auth acts as the OAuth 2.1 authorization server. */
export function authIssuer(env: Env): string {
  return `${env.supabaseUrl}/auth/v1`;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= readEnv();
  return cached;
}
