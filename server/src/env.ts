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
  /** Most label photos one household can have read per day. */
  snapDailyLimit: number;
  /** Most catch-up plans (back history for things that aren't new) one household can have a day. */
  planDailyLimit: number;
  /** Most model calls (reads, chats, photos, plans) across every household per day: the budget's ceiling. */
  globalDailyLimit: number;
  /**
   * Web search for finding manuals from the website: a self-hosted SearXNG
   * first when set (behind Cloudflare Access), then Tavily as the fallback.
   */
  search?: {
    /** What the model log names, e.g. "searxng+tavily". */
    provider: string;
    dailyLimit: number;
    searxng?: { baseUrl: string; accessId?: string; accessSecret?: string };
    tavily?: { apiKey: string };
  };
  /**
   * Self-hosted Crawl4AI, for opening a maker's product page when the search
   * found too few PDFs. Shares SearXNG's Cloudflare Access service token.
   */
  crawl?: { baseUrl: string; token: string; accessId?: string; accessSecret?: string };
  /** Where issue reports are pushed (an ntfy.sh topic); reports are saved either way. */
  notify?: { url: string; topic: string };
  /** Jev (TypeSafe AI) sorts each chat message so Muse only gets the tools it needs. */
  router?: { baseUrl: string; model: string; apiKey: string };
  /**
   * Meta's image model, for marking up a chat photo ("circle the cup filter").
   * Text stays on READER_* (Baseten); images use the Meta key. `cap` is the
   * most image calls ever, counted in model_runs, kept under the free credits.
   */
  image?: {
    baseUrl: string;
    model: string;
    apiKey: string;
    cap: number;
    /** Meta's segmentation model, tried first: it outlines the part on the untouched photo. */
    segmentModel: string;
  };
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
  // READER_PROVIDER=meta (local only) reads Muse from Meta's own API with the
  // META_READER_* keys; anything else, Vercel included, uses READER_* (Baseten).
  const meta = source.READER_PROVIDER === "meta";
  const readerBase = meta ? source.META_READER_BASE_URL : source.READER_BASE_URL;
  const readerModel = meta ? source.META_READER_MODEL : source.READER_MODEL;
  const readerKey = meta ? source.META_READER_API_KEY : source.READER_API_KEY;
  return {
    supabaseUrl: trimSlash(supabaseUrl),
    supabasePublishableKey,
    publicUrl: source.PUBLIC_URL ? trimSlash(source.PUBLIC_URL) : undefined,
    reader:
      readerBase && readerModel
        ? {
            baseUrl: trimSlash(readerBase),
            model: readerModel,
            apiKey: readerKey,
            maxChars: positive(source.READER_MAX_CHARS, 40_000),
            dailyLimit: positive(source.READER_DAILY_LIMIT, 10),
          }
        : undefined,
    chatModel: source.CHAT_MODEL || undefined,
    chatDailyLimit: positive(source.CHAT_DAILY_LIMIT, 100),
    snapDailyLimit: positive(source.SNAP_DAILY_LIMIT, 20),
    planDailyLimit: positive(source.PLAN_DAILY_LIMIT, 20),
    globalDailyLimit: positive(source.GLOBAL_DAILY_LIMIT, 400),
    search:
      source.SEARXNG_URL || source.SEARCH_API_KEY
        ? {
            provider: [source.SEARXNG_URL && "searxng", source.SEARCH_API_KEY && "tavily"]
              .filter(Boolean)
              .join("+"),
            dailyLimit: positive(source.SEARCH_DAILY_LIMIT, 80),
            ...(source.SEARXNG_URL
              ? {
                  searxng: {
                    baseUrl: trimSlash(source.SEARXNG_URL),
                    accessId: source.SEARXNG_ACCESS_ID || undefined,
                    accessSecret: source.SEARXNG_ACCESS_SECRET || undefined,
                  },
                }
              : {}),
            ...(source.SEARCH_API_KEY ? { tavily: { apiKey: source.SEARCH_API_KEY } } : {}),
          }
        : undefined,
    crawl:
      source.CRAWL4AI_URL && source.CRAWL4AI_API_TOKEN
        ? {
            baseUrl: trimSlash(source.CRAWL4AI_URL),
            token: source.CRAWL4AI_API_TOKEN,
            accessId: source.SEARXNG_ACCESS_ID || undefined,
            accessSecret: source.SEARXNG_ACCESS_SECRET || undefined,
          }
        : undefined,
    notify: source.NTFY_TOPIC
      ? { url: trimSlash(source.NTFY_URL || "https://ntfy.sh"), topic: source.NTFY_TOPIC }
      : undefined,
    router: source.JEV_API_KEY
      ? {
          baseUrl: trimSlash(source.JEV_BASE_URL || "https://api.typesafe.ai"),
          model: source.JEV_MODEL || "jev-latest",
          apiKey: source.JEV_API_KEY,
        }
      : undefined,
    image: source.META_READER_API_KEY
      ? {
          baseUrl: trimSlash(
            source.META_IMAGE_BASE_URL || source.META_READER_BASE_URL || "https://api.meta.ai/v1",
          ),
          model: source.META_IMAGE_MODEL || "muse-image-1.0",
          apiKey: source.META_READER_API_KEY,
          cap: positive(source.IMAGE_CAP, 140),
          segmentModel: source.META_SEGMENT_MODEL || "sam-3.1",
        }
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
