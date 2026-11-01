// Live check of manual search: SearXNG (via Cloudflare Access), Crawl4AI on
// non-PDF pages, then the full findManual with Jev's pick. Run from server/
// with `bun scripts/probe-find.ts`; bun loads .env. Prints results only.
import { readEnv } from "../src/env.js";
import {
  findManual,
  pagesWorthOpening,
  pdfLinksFromPages,
  searchWeb,
} from "../src/finder/search.js";

const env = readEnv(process.env);
const item = { brand: "Toshiba", nickname: "Air Conditioner", model: "RAC-PD0811CRU" };
console.log("search:", env.search?.provider ?? "none", "| crawl:", env.crawl ? "on" : "off");

const query = "Toshiba RAC-PD0811CRU manual";
const results = await searchWeb(env, query);
console.log(`\n${results.length} results for "${query}"`);

const pages = pagesWorthOpening(results, item);
console.log(`\nPages worth opening: ${pages.map((p) => p.url).join(", ") || "none"}`);
if (env.crawl && pages.length) {
  const started = Date.now();
  const links = await pdfLinksFromPages(env.crawl, pages);
  console.log(`Crawl4AI found ${links.length} PDF links in ${Date.now() - started} ms`);
  for (const l of links.slice(0, 5)) console.log(" -", l.title, "|", l.url);
}

const started = Date.now();
const found = await findManual(env, item);
console.log(`\nfindManual in ${Date.now() - started} ms:`);
for (const c of found.candidates) {
  console.log(
    ` - ${c.best ? "[BEST] " : ""}${c.title} | ${c.host} | ${c.page_count ?? "?"} pages${c.models ? ` | covers ${c.models.length} models` : ""}`,
  );
}
