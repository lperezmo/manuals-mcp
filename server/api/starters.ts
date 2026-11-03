import { env } from "../src/env.js";
import { startersHandler } from "../src/http.js";

// The questions a new chat from Home offers: Jev picks what matters, Muse words them.
export const POST = startersHandler(env());
