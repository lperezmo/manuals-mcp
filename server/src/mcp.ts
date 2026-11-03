import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./env.js";
import * as addItem from "./tools/add-item.js";
import * as askManual from "./tools/ask-manual.js";
import * as carSeatStatus from "./tools/car-seat-status.js";
import * as catchUp from "./tools/catch-up.js";
import * as checkFlagged from "./tools/check-flagged.js";
import type { Surface } from "./tools/context.js";
import * as houseAtlas from "./tools/house-atlas.js";
import * as listItems from "./tools/list-items.js";
import * as logDone from "./tools/log-done.js";
import * as pulse from "./tools/pulse.js";
import * as recordMeasurement from "./tools/record-measurement.js";
import * as requestUpload from "./tools/request-upload.js";
import * as reviseFact from "./tools/revise-fact.js";
import * as saveView from "./tools/save-view.js";
import * as upcoming from "./tools/upcoming.js";
import * as warranty from "./tools/warranty.js";

export const SERVER_INFO = { name: "manuals", version: "0.2.0" };

export const INSTRUCTIONS = `Manuals keeps the user's household manuals and upkeep: appliances, baby gear and other things, each with its manual, an upkeep schedule, facts (error codes, parts, specs, safety) and for car seats the limits per mode. A model (Muse Spark) reads each manual when it's added. The user is often a tired parent; keep answers short and practical.

- Quote the manual page whenever an answer comes from a manual.
- A thing can have several guides; say which guide and page an answer comes from. For safety rules and limits, the owner's manual wins over a quick start or recipe book.
- To set up a new thing: find the official manual PDF on the maker's site, then add_item with pdf_url.
- If add_item says the site won't let apps download it but you can (a code sandbox or browser with network access), call request_manual_upload, PUT the PDF's raw bytes to its upload_url, then add_item with attach_to and upload_id. Never paste a file into the chat.
- Some facts are flagged needs_review. Mention it when you use one, and offer to check it.
- When the user doubts a fact, read its page with ask_manual (item and page), compare, and fix or confirm it with revise_fact. What the user states themselves wins.
- To clear the flagged lines in bulk ("check the ones you weren't sure about"), use check_flagged: it reads each page again and proposes a verdict per line; apply them only after the user says yes.
- When something breaks or needs a repair, check warranty_status first; if it's likely still covered, say so before suggesting a paid repair.
- For car seats, compare the child's latest measurements with the seat's limits and cite the page. Don't predict growth or give health advice; suggest measuring again, and mention a certified child passenger safety technician can check the fit.
- For a thing that isn't new (used for years, never maintained, or out of storage), ask what has been done to it and call catch_up once its manual is read.
- For questions across the house ("what's in the nursery", "what uses water", "what can I do in five minutes", "what's due before winter"), use house_atlas with a lens, and a view in the user's words when the lenses don't cover it.
- For "anything I should know about the house?", use pulse: the few things worth doing now. upcoming has the full list.
- For calendar reminders, use your own calendar tools.`;

interface ToolModule {
  register(server: McpServer, env: Env, surface?: Surface): void;
}

export const TOOL_MODULES: ToolModule[] = [
  addItem,
  requestUpload,
  listItems,
  askManual,
  upcoming,
  pulse,
  reviseFact,
  checkFlagged,
  logDone,
  recordMeasurement,
  carSeatStatus,
  catchUp,
  warranty,
  houseAtlas,
  saveView,
];

/** Registers the tools; the website's chat (surface "chat") leaves out the MCP-only upload slot. */
export function registerTools(server: McpServer, env: Env, surface: Surface = "mcp"): void {
  for (const mod of TOOL_MODULES) mod.register(server, env, surface);
}
