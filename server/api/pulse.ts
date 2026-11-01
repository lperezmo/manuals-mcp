import { env } from "../src/env.js";
import { pulseHandler } from "../src/http.js";

// Household Pulse on the home page: what's worth doing now (Jev, no Muse).
export const POST = pulseHandler(env());
