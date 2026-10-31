import { env } from "../src/env.js";
import { upkeepGroupsHandler } from "../src/http.js";

// Sorts a thing's upkeep tasks into the tiles on its page (Jev).
export const POST = upkeepGroupsHandler(env());
