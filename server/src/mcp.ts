import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./env.js";
import * as addItem from "./tools/add-item.js";
import * as askManual from "./tools/ask-manual.js";
import * as carSeatStatus from "./tools/car-seat-status.js";
import * as listItems from "./tools/list-items.js";
import * as logDone from "./tools/log-done.js";
import * as recordMeasurement from "./tools/record-measurement.js";
import * as reviseFact from "./tools/revise-fact.js";
import * as upcoming from "./tools/upcoming.js";

export const SERVER_INFO = { name: "manuals", version: "0.2.0" };

export const INSTRUCTIONS = `Manuals keeps the user's household manuals and upkeep: appliances, baby gear and other things, each with its manual, an upkeep schedule, facts (error codes, parts, specs, safety) and for car seats the limits per mode. A model (Muse Spark) reads each manual when it's added. The user is often a tired parent; keep answers short and practical.

- Quote the manual page whenever an answer comes from a manual.
- To set up a new thing: find the official manual PDF on the maker's site, then add_item with pdf_url.
- Some facts are flagged needs_review. Mention it when you use one, and offer to check it.
- When the user doubts a fact, read its page with ask_manual (item and page), compare, and fix or confirm it with revise_fact. What the user states themselves wins.
- For car seats, compare the child's latest measurements with the seat's limits and cite the page. Don't predict growth or give health advice; suggest measuring again, and mention a certified child passenger safety technician can check the fit.
- For calendar reminders, use your own calendar tools.`;

export const TOOL_MODULES = [
  addItem,
  listItems,
  askManual,
  upcoming,
  reviseFact,
  logDone,
  recordMeasurement,
  carSeatStatus,
];

export function registerTools(server: McpServer, env: Env): void {
  for (const mod of TOOL_MODULES) mod.register(server, env);
}
