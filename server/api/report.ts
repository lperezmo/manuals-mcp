import { env } from "../src/env.js";
import { reportHandler } from "../src/http.js";

// "Report an issue" from the website.
export const POST = reportHandler(env());
