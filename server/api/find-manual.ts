import { env } from "../src/env.js";
import { findManualHandler } from "../src/http.js";

// Finds manual PDFs on the web for the website's "Find it online".
export const POST = findManualHandler(env());
