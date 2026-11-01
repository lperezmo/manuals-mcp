import { env } from "../src/env.js";
import { receiptHandler } from "../src/http.js";

// Reads a receipt or warranty card photo into purchase date, store, price and warranty.
export const POST = receiptHandler(env());
