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

// Logs where each call went and how it answered (never headers or keys), plus Jev's scores.
const traced = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const res = await fetch(input, init);
  if (/typesafe|cr\.|search\./.test(url.hostname)) {
    const peek = await res.clone().text();
    const note = url.hostname.includes("typesafe")
      ? ` answers=${JSON.stringify(JSON.parse(peek).answers ?? peek.slice(0, 200))}`
      : res.ok
        ? ""
        : ` body=${peek.slice(0, 200).replace(/\s+/g, " ")}`;
    console.log(`   [${url.hostname}${url.pathname}] HTTP ${res.status}${note}`);
  }
  return res;
}) as typeof fetch;
const item = { brand: "Toshiba", nickname: "Air Conditioner", model: "RAC-PD0811CRU" };
console.log(
  "search:",
  env.search?.provider ?? "none",
  "| crawl:",
  env.crawl ? "on" : "off",
  "| jev:",
  env.router ? "on" : "off",
);

if (env.crawl) {
  // Access only, no Crawl4AI token: /health needs no token, so this isolates Cloudflare.
  const health = await fetch(`${env.crawl.baseUrl}/health`, {
    headers: {
      "CF-Access-Client-Id": env.crawl.accessId ?? "",
      "CF-Access-Client-Secret": env.crawl.accessSecret ?? "",
    },
  });
  console.log(
    `cr /health with Access headers only: HTTP ${health.status}, server=${health.headers.get("server")}, cf-ray=${health.headers.has("cf-ray")}`,
  );
  // Through the tunnel: Access lets the service token in, then Crawl4AI checks its own token.
  const links = await pdfLinksFromPages(
    env.crawl,
    [{ url: "https://www.galanz.com/us/support", title: "Galanz support", score: 1 }],
    traced,
  );
  console.log(`Crawl4AI tunnel check: ${links.length} PDF links on galanz.com/us/support`);
}

const query = "Toshiba RAC-PD0811CRU manual";
const results = await searchWeb(env, query, traced);
console.log(`\n${results.length} results for "${query}"`);

const pages = pagesWorthOpening(results, item);
console.log(`\nPages worth opening: ${pages.map((p) => p.url).join(", ") || "none"}`);
if (env.crawl && pages.length) {
  const started = Date.now();
  const links = await pdfLinksFromPages(env.crawl, pages, traced);
  console.log(`Crawl4AI found ${links.length} PDF links in ${Date.now() - started} ms`);
  for (const l of links.slice(0, 5)) console.log(" -", l.title, "|", l.url);
}

const started = Date.now();
const found = await findManual(env, item, traced);
console.log(`\nfindManual in ${Date.now() - started} ms:`);
for (const c of found.candidates) {
  console.log(
    ` - ${c.best ? "[BEST] " : ""}${c.title} | ${c.host} | ${c.page_count ?? "?"} pages${c.models ? ` | covers ${c.models.length} models` : ""}`,
  );
}
