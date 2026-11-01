import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { createUploadSlot, sweepStaleUploads } from "../finder/upload-slot.js";
import {
  findItem,
  guarded,
  itemLabel,
  itemPageUrl,
  reply,
  type Surface,
  session,
} from "./context.js";

export const DESCRIPTION = [
  "Opens a slot to upload a manual PDF for a thing, for when add_item can't download the link itself (the maker's site blocks our server) but you can.",
  "1) Download the PDF in your own browser or code sandbox.",
  "2) Send the raw bytes to upload_url with an HTTP PUT and the header content-type: application/pdf (no auth header needed; one file, up to 40 MB; the URL works for 2 hours). Never paste the file or its base64 into the chat or a tool call.",
  "3) Call add_item with attach_to (this thing's id) and upload_id.",
  "If you have no sandbox with network access, or it can't reach the upload host, tell the person to open the thing's page (page_url) and tap Upload a PDF.",
].join(" ");

export function register(server: McpServer, env: Env, surface: Surface = "mcp") {
  // The website's chat can't download files, so the slot is for MCP clients only.
  if (surface === "chat") return;
  server.registerTool(
    "request_manual_upload",
    {
      title: "Upload a manual PDF yourself",
      description: DESCRIPTION,
      inputSchema: z.object({
        item: z.string().min(1).describe("Id or name of the thing the manual is for."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ item: ref }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        const item = await findItem(db, ref);
        await sweepStaleUploads(db, householdId);
        const slot = await createUploadSlot(db, householdId);
        const pageUrl = itemPageUrl(env, ctx, item.id);
        const host = new URL(slot.upload_url).host;
        return reply(
          `Upload slot ready for ${itemLabel(item)}. Download the PDF in your sandbox or browser, PUT its raw bytes to upload_url with content-type: application/pdf (up to 40 MB, within 2 hours), then call add_item with attach_to "${item.id}" and upload_id "${slot.upload_id}". Don't paste the file into the chat. If your sandbox can't reach ${host} (the person may need to allow it in their AI app's code settings) or you can't download files, ask the person to open ${pageUrl} and tap Upload a PDF.`,
          {
            item: { id: item.id, nickname: item.nickname },
            ...slot,
            example: `curl -X PUT -H "content-type: application/pdf" --data-binary @manual.pdf "${slot.upload_url}"`,
            next_call: {
              tool: "add_item",
              arguments: { attach_to: item.id, upload_id: slot.upload_id },
            },
            page_url: pageUrl,
          },
        );
      }),
  );
}
