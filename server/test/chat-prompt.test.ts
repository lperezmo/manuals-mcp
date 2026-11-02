import { expect, test } from "bun:test";
import { runChat } from "../src/chat.js";
import { readEnv } from "../src/env.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});
const auth = { token: "t", clientId: "c", scopes: [], extra: { sub: "u" } } as never;

test("the site chat is told it has no calendar, so it doesn't offer one", async () => {
  let system = "";
  const muse = (async (_u: string, init: RequestInit) => {
    system = JSON.parse(String(init.body)).messages[0].content;
    return Response.json({ choices: [{ message: { content: "They stay in Coming up." } }] });
  }) as unknown as typeof fetch;
  await runChat(env, auth, [{ role: "user", content: "put it on my calendar" }], muse);
  expect(system).toContain("no calendar, email, reminder or messaging tools");
  expect(system).toContain("Never offer to add dates to a calendar");
});
