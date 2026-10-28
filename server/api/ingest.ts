import { env } from "../src/env.js";
import { ingestHandler } from "../src/http.js";

// The app calls this after uploading a PDF to storage.
export const POST = ingestHandler(env());
