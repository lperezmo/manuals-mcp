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
    /** Most manual text sent per read; the pages most about upkeep win. */
    maxChars: number;
    /** Most manuals one household can have read per day, to keep costs flat. */
    dailyLimit: number;
  };
  /** Model for the website's chat; defaults to the reader's model. */
  chatModel?: string;
  /** Most chat turns one household can have per day, to keep costs flat. */
  chatDailyLimit: number;
  /** Web search for finding manuals from the website (Tavily). */
  search?: { provider: "tavily"; apiKey: string; dailyLimit: number };
  /** Where issue reports are pushed (an ntfy.sh topic); reports are saved either way. */
  notify?: { url: string; topic: string };
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
        ? {
            baseUrl: trimSlash(readerBase),
            model: readerModel,
            apiKey: source.READER_API_KEY,
            maxChars: positive(source.READER_MAX_CHARS, 40_000),
            dailyLimit: positive(source.READER_DAILY_LIMIT, 10),
          }
        : undefined,
    chatModel: source.CHAT_MODEL || undefined,
    chatDailyLimit: positive(source.CHAT_DAILY_LIMIT, 100),
    search: source.SEARCH_API_KEY
      ? {
          provider: "tavily",
          apiKey: source.SEARCH_API_KEY,
          dailyLimit: positive(source.SEARCH_DAILY_LIMIT, 20),
        }
      : undefined,
    notify: source.NTFY_TOPIC
      ? { url: trimSlash(source.NTFY_URL || "https://ntfy.sh"), topic: source.NTFY_TOPIC }
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
