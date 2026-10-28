import { env } from "../src/env.js";
import { snapHandler } from "../src/http.js";

// Reads a label photo into brand and model.
export const POST = snapHandler(env());
