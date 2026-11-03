import { describe, expect, test } from "bun:test";

// The Muse chat box (plain JS, served as /chatbox.js).
type Key = Partial<
  Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing", boolean>
> & {
  key: string;
};
const box = (await import(String(new URL("../public/chatbox.js", import.meta.url)))) as {
  MAX_BOX_PX: number;
  boxHeight: (scrollHeight: number, min?: number, max?: number) => number;
  growBox: (el: { style: Record<string, string>; scrollHeight: number }) => void;
  enterSends: (e: Key, finePointer: boolean) => boolean;
};
const { MAX_BOX_PX, boxHeight, growBox, enterSends } = box;

describe("the chat box grows with what's typed", () => {
  test("one line at least, about six at most, then it scrolls", () => {
    expect(boxHeight(20)).toBe(48);
    expect(boxHeight(96)).toBe(96);
    expect(boxHeight(900)).toBe(MAX_BOX_PX);
  });

  test("growBox sets the height and only scrolls when full", () => {
    const short = { style: {} as Record<string, string>, scrollHeight: 70 };
    growBox(short);
    expect(short.style).toEqual({ height: "70px", overflowY: "hidden" });
    const long = { style: {} as Record<string, string>, scrollHeight: 400 };
    growBox(long);
    expect(long.style).toEqual({ height: `${MAX_BOX_PX}px`, overflowY: "auto" });
  });
});

describe("what Enter does", () => {
  test("with a keyboard, Enter sends and Shift+Enter is a new line", () => {
    expect(enterSends({ key: "Enter" }, true)).toBe(true);
    expect(enterSends({ key: "Enter", shiftKey: true }, true)).toBe(false);
    expect(enterSends({ key: "a" }, true)).toBe(false);
  });

  test("on a phone, Enter is a new line and Send sends", () => {
    expect(enterSends({ key: "Enter" }, false)).toBe(false);
  });

  test("never while a word is still being composed", () => {
    expect(enterSends({ key: "Enter", isComposing: true }, true)).toBe(false);
  });
});
