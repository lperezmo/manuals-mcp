import { env } from "../src/env.js";
import { publicConfigHandler } from "../src/http.js";

// Public Supabase settings for the sign-in and consent page.
export const GET = publicConfigHandler(env());
