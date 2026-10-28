import { env } from "../src/env.js";
import { toolHandler } from "../src/http.js";

// Website buttons run the same tools as the AI.
export const POST = toolHandler(env());
