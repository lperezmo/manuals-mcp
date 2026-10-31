import { env } from "../src/env.js";
import { attachHandler } from "../src/http.js";

// "Use this" on a found manual: downloads and stores the PDF; /api/ingest reads it.
export const POST = attachHandler(env());
