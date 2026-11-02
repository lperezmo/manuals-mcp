import { env } from "../src/env.js";
import { pageCheckHandler } from "../src/http.js";

// Jev's quick look at one photographed manual page: sharp, and in English?
export const POST = pageCheckHandler(env());
