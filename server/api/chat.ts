import { env } from "../src/env.js";
import { chatHandler } from "../src/http.js";

// The website's chat with Muse.
export const POST = chatHandler(env());
