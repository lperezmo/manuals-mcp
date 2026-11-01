import { env } from "../src/env.js";
import { suggestHandler } from "../src/http.js";

// Search as you type: saved facts and tasks that answer what's being typed (Jev, no Muse).
export const POST = suggestHandler(env());
