import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A syntax error in a page's script leaves the page stuck on "One moment…",
// and nothing on the server notices. Parse every page script before it ships.
const PUBLIC = join(import.meta.dir, "..", "public");
const transpiler = new Bun.Transpiler({ loader: "js" });

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? pages(join(dir, e.name))
      : e.name.endsWith(".html")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("page scripts parse", () => {
  for (const file of pages(PUBLIC)) {
    test(file.slice(PUBLIC.length + 1), () => {
      const html = readFileSync(file, "utf8");
      for (const [, code] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
        expect(() => transpiler.transformSync(code ?? "")).not.toThrow();
      }
    });
  }
  for (const file of readdirSync(PUBLIC).filter((f) => f.endsWith(".js"))) {
    test(file, () => {
      expect(() =>
        transpiler.transformSync(readFileSync(join(PUBLIC, file), "utf8")),
      ).not.toThrow();
    });
  }
});
