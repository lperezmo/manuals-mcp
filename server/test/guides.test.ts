import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db.js";
import {
  alsoInLine,
  disagreementNote,
  findDisagreement,
  findSameTask,
  guessGuideKind,
  guideName,
  labelKey,
  primaryManual,
  sameTask,
  titleWords,
  valuesAgree,
  withAlsoIn,
} from "../src/finder/guides.js";
import { saveKnowledge } from "../src/finder/knowledge.js";
import { autoApplies, type Check, describeLine } from "../src/recheck.js";
import { guideLabels } from "../src/tools/ask-manual.js";

describe("guessGuideKind", () => {
  test("reads the kind from the title first", () => {
    expect(guessGuideKind("Ninja AF101 Quick Start Guide.pdf", "")).toBe("quick_start");
    expect(guessGuideKind("AF101_QSG_EN.pdf", "")).toBe("quick_start");
    expect(guessGuideKind("AF101_IB_EN.pdf", "")).toBe("owner");
    expect(guessGuideKind("Inspiration Guide", "")).toBe("recipes");
    expect(guessGuideKind("Owner's Manual", "Quick start")).toBe("owner");
    expect(guessGuideKind("Use & Care Guide", "")).toBe("owner");
  });

  test("falls back to the cover, where the first kind named wins", () => {
    expect(
      guessGuideKind("Air fryer manual", "QUICK START GUIDE\nRead the Owner's Guide before use."),
    ).toBe("quick_start");
    expect(
      guessGuideKind("Air fryer manual", "OWNER'S GUIDE\nAir fryer\nQuick recipes inside"),
    ).toBe("owner");
    expect(guessGuideKind(null, "75 recipes for your air fryer")).toBe("recipes");
    expect(guessGuideKind("x.pdf", "Getting started with your blender")).toBe("quick_start");
  });

  test("says nothing when the words don't", () => {
    expect(guessGuideKind("Air fryer manual", "Model AF101. 120V 1550W.")).toBeNull();
    expect(guessGuideKind(undefined, undefined)).toBeNull();
  });
});

describe("primaryManual and guideName", () => {
  const owner = { id: "b", kind: "owner", title: "x", created_at: "2026-11-02" };
  const quick = { id: "a", kind: "quick_start", title: "y", created_at: "2026-11-01" };
  test("the owner's manual wins, else the first added", () => {
    expect(primaryManual([quick, owner])?.id).toBe("b");
    expect(primaryManual([{ ...owner, kind: null }, quick])?.id).toBe("a");
    expect(primaryManual([])).toBeNull();
  });
  test("names a guide by its kind, else its title", () => {
    expect(guideName(quick)).toBe("Quick start");
    expect(guideName({ id: "c", kind: null, title: "AF101_recipes_v2.pdf" })).toBe(
      "AF101 recipes v2",
    );
    expect(guideName({ id: "c", kind: "other", title: "" })).toBe("another guide");
  });
});

describe("the same task in two guides", () => {
  test("titles are compared by their meaningful words", () => {
    expect([...titleWords("Clean the filters after every use!")]).toEqual(["clean", "filter"]);
  });
  test("alike titles match, with the same interval unit when both have one", () => {
    expect(
      sameTask(
        { title: "Clean the filter", interval_unit: "months" },
        { title: "Clean filters", interval_unit: "months" },
      ),
    ).toBe(true);
    expect(
      sameTask(
        { title: "Clean the crisper plate", interval_unit: "cycles" },
        { title: "Wash the crisper plate", interval_unit: "cycles" },
      ),
    ).toBe(true);
    expect(
      sameTask(
        { title: "Clean the filter", interval_unit: "months" },
        { title: "Clean the filter", interval_unit: "cycles" },
      ),
    ).toBe(false);
    // "As needed" says nothing about how often.
    expect(
      sameTask(
        { title: "Descale the kettle", interval_unit: "as_needed" },
        { title: "Descale kettle", interval_unit: "months" },
      ),
    ).toBe(true);
    expect(sameTask({ title: "Clean the basket" }, { title: "Replace the basket" })).toBe(false);
  });
  test("finds the most alike existing task", () => {
    const existing = [
      { id: "1", title: "Clean the basket and crisper plate" },
      { id: "2", title: "Clean the basket" },
    ];
    expect(findSameTask({ title: "Clean basket" }, existing)?.id).toBe("2");
    expect(findSameTask({ title: "Check the power cord" }, existing)).toBeNull();
  });
  test("adds the citation once, and only when it fits", () => {
    const line = alsoInLine("Quick start", 4);
    expect(line).toBe("Also in the Quick start, p. 4.");
    expect(withAlsoIn("Soak it in warm water.", line)).toBe(
      "Soak it in warm water.\nAlso in the Quick start, p. 4.",
    );
    expect(withAlsoIn(null, line)).toBe(line);
    expect(withAlsoIn(`Soak it.\n${line}`, line)).toBeNull();
    expect(withAlsoIn("x".repeat(990), line, 1000)).toBeNull();
    expect(alsoInLine("Recipe book", null)).toBe("Also in the Recipe book.");
  });
});

describe("the same fact, said differently", () => {
  test("labels match however they are written", () => {
    expect(labelKey("Maximum Temperature")).toBe(labelKey("max temperature"));
    expect(labelKey("The Max. load")).toBe("max load");
  });
  test("numbers decide when both values have them", () => {
    expect(valuesAgree("400°F", "400°F (205°C)")).toBe(true);
    expect(valuesAgree("400 F", "350 F")).toBe(false);
    expect(valuesAgree("1,5 L", "1.5 litres")).toBe(true);
  });
  test("words only: they agree unless they share nothing", () => {
    expect(valuesAgree("Drain pump blocked", "The drain pump is blocked; clean it")).toBe(true);
    expect(valuesAgree("Lid not closed", "Temperature sensor fault")).toBe(false);
    // One with numbers and one without can't be told apart.
    expect(valuesAgree("12 lb", "A full drum")).toBe(true);
  });
  test("finds the other guide's fact and writes the note", () => {
    const existing = [
      { label: "Max temperature", value: "400°F", source_page: 12, manual_id: "m1" },
      { label: "Capacity", value: "4 qt", source_page: 3, manual_id: "m1" },
    ];
    const other = findDisagreement({ label: "Maximum temperature", value: "390°F" }, existing);
    expect(other?.value).toBe("400°F");
    expect(findDisagreement({ label: "Capacity", value: "4 qt" }, existing)).toBeNull();
    expect(findDisagreement({ label: "Weight", value: "10 lb" }, existing)).toBeNull();
    expect(disagreementNote("Owner's manual", existing[0] as never)).toBe(
      `The Owner's manual says "400°F" on p. 12. Check which one fits yours.`,
    );
    expect(
      disagreementNote("Owner's manual", { label: "x", value: "y".repeat(900) }).length,
    ).toBeLessThanOrEqual(600);
  });
});

describe("guides in answers and the second read", () => {
  test("only things with several guides get a guide on each line", () => {
    const g = guideLabels([
      { id: "a", item_id: "fryer", kind: "quick_start", created_at: "2" },
      { id: "b", item_id: "fryer", kind: "owner", created_at: "1" },
      { id: "c", item_id: "washer", kind: null, created_at: "1" },
    ]);
    expect(g.label("a")).toEqual({ guide: "Quick start" });
    expect(g.label("c")).toEqual({});
    expect(g.label(null)).toEqual({});
    expect(g.primary.get("fryer")).toBe("b");
  });

  test("a disagreement is shown with its note and never saved without a yes", () => {
    const what = describeLine({
      id: "f",
      type: "fact",
      item_id: "i",
      item: "Air fryer",
      page: 6,
      note: 'The Owner\'s manual says "400°F" on p. 12.',
      line: { label: "Max temperature", value: "390°F" },
    });
    expect(what).toContain("390°F");
    expect(what).toContain("Owner's manual");
    const check: Check = {
      id: "f",
      type: "fact",
      item: "Air fryer",
      page: 6,
      what,
      verdict: "confirm",
      reason: "p. 6",
    };
    expect(autoApplies(check)).toBe(true);
    expect(autoApplies({ ...check, disagrees: true })).toBe(false);
  });
});

/**
 * A stand-in for the Supabase client: each select answers from `tables`,
 * and every write is recorded.
 */
function fakeDb(tables: Record<string, Record<string, unknown>[]>, failNote = false) {
  const writes: { table: string; op: string; rows?: unknown; change?: unknown; id?: unknown }[] =
    [];
  const from = (table: string) => {
    let op = "select";
    let payload: unknown;
    let id: unknown;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const m of ["select", "neq", "is", "in", "order", "limit", "not"]) builder[m] = chain;
    builder.eq = (col: string, value: unknown) => {
      if (col === "id") id = value;
      return builder;
    };
    builder.insert = (rows: unknown) => {
      op = "insert";
      payload = rows;
      return builder;
    };
    builder.update = (change: unknown) => {
      op = "update";
      payload = change;
      return builder;
    };
    builder.delete = () => {
      op = "delete";
      return builder;
    };
    builder.upsert = (rows: unknown) => {
      op = "upsert";
      payload = rows;
      return builder;
    };
    // biome-ignore lint/suspicious/noThenProperty: it stands in for the query builder, which is awaited.
    builder.then = (resolve: (v: unknown) => void) => {
      if (op === "select") return resolve({ data: tables[table] ?? [], error: null });
      const rows = Array.isArray(payload) ? payload : [];
      if (op === "insert" && failNote && rows.some((r) => r && "note" in r))
        return resolve({ data: null, error: { message: "column note does not exist" } });
      writes.push({
        table,
        op,
        ...(op === "update" ? { change: payload, id } : { rows: payload }),
      });
      return resolve({ data: null, error: null });
    };
    return builder;
  };
  return { db: { from } as unknown as Db, writes };
}

describe("saveKnowledge with a second guide", () => {
  const tables = {
    manuals: [
      { id: "owner", item_id: "fryer", kind: "owner", title: "Owner's guide", created_at: "1" },
      { id: "quick", item_id: "fryer", kind: "quick_start", title: "QSG", created_at: "2" },
    ],
    tasks: [
      {
        id: "t1",
        title: "Clean the crisper plate",
        details: "Hand wash or dishwasher.",
        interval_unit: "cycles",
        source: "reader",
        source_manual_id: "owner",
      },
      {
        id: "t2",
        title: "Unplug before cleaning",
        details: null,
        interval_unit: "as_needed",
        source: "user",
        source_manual_id: "owner",
      },
    ],
    manual_facts: [
      { label: "Max temperature", value: "400°F", source_page: 12, manual_id: "owner" },
    ],
  };
  const knowledge = {
    tasks: [
      {
        title: "Wash the crisper plate",
        interval_unit: "cycles" as const,
        interval_value: 1,
        source_page: 4,
      },
      { title: "Unplug it before cleaning", interval_unit: "as_needed" as const, source_page: 5 },
      { title: "Shake the basket", interval_unit: "as_needed" as const, source_page: 6 },
    ],
    facts: [
      { kind: "spec" as const, label: "Maximum temperature", value: "390°F", source_page: 6 },
      { kind: "spec" as const, label: "Capacity", value: "4 qt", source_page: 2 },
    ],
    seat_modes: [],
  };

  test("skips repeated tasks, cites the reader's, and flags the disagreement", async () => {
    const { db, writes } = fakeDb(tables);
    const out = await saveKnowledge({
      db,
      householdId: "h",
      itemId: "fryer",
      manualId: "quick",
      knowledge,
    });
    const taskInsert = writes.find((w) => w.table === "tasks" && w.op === "insert");
    expect(((taskInsert?.rows ?? []) as { title: string }[]).map((t) => t.title)).toEqual([
      "Shake the basket",
    ]);
    const citations = writes.filter((w) => w.table === "tasks" && w.op === "update");
    // The user's own task is never edited.
    expect(citations).toEqual([
      {
        table: "tasks",
        op: "update",
        id: "t1",
        change: { details: "Hand wash or dishwasher.\nAlso in the Quick start, p. 4." },
      },
    ]);
    const facts = writes
      .filter((w) => w.table === "manual_facts" && w.op === "insert")
      .flatMap((w) => w.rows as { label: string; status: string; note?: string }[]);
    const temp = facts.find((f) => f.label === "Maximum temperature");
    expect(temp?.status).toBe("needs_review");
    expect(temp?.note).toContain('The Owner\'s manual says "400°F" on p. 12.');
    expect(facts.find((f) => f.label === "Capacity")?.status).toBe("extracted");
    expect(out).toMatchObject({ tasks: 1, facts: 2, needs_review: 1, repeated: 2 });
  });

  test("saves the flagged fact without its note before the column exists", async () => {
    const { db, writes } = fakeDb(tables, true);
    await saveKnowledge({ db, householdId: "h", itemId: "fryer", manualId: "quick", knowledge });
    const facts = writes
      .filter((w) => w.table === "manual_facts" && w.op === "insert")
      .flatMap((w) => w.rows as { label: string; status: string; note?: string }[]);
    expect(facts).toHaveLength(2);
    const temp = facts.find((f) => f.label === "Maximum temperature");
    expect(temp?.status).toBe("needs_review");
    expect(temp && "note" in temp).toBe(false);
  });

  test("a thing's only guide is saved as before", async () => {
    const { db, writes } = fakeDb({ ...tables, manuals: [tables.manuals[0] as never] });
    const out = await saveKnowledge({
      db,
      householdId: "h",
      itemId: "fryer",
      manualId: "owner",
      knowledge,
    });
    const taskInsert = writes.find((w) => w.table === "tasks" && w.op === "insert");
    expect(taskInsert?.rows).toHaveLength(3);
    expect(out).not.toHaveProperty("repeated");
  });
});
