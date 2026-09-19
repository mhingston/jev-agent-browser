import { describe, expect, it } from "vitest";
import { sieveContext, splitContext } from "../src/context.js";

describe("optional Jev context sieve", () => {
  it("keeps ordered recall stubs while dropping irrelevant blocks", async () => {
    const blocks = splitContext("Goal evidence is here.\n\nUnrelated navigation boilerplate.\n\nCompleted successfully.", 12, 40);
    let requestState: any;
    const result = await sieveContext("Find the goal evidence", "Goal evidence is here.\n\nUnrelated navigation boilerplate.\n\nCompleted successfully.", {
      async systemOne(request) {
        requestState = request.state;
        return {
          model: "jev-1.13.0",
          answers: {
            context_b0: { noul: 0.9 },
            context_b1: { noul: 0.01 },
            context_b2: { noul: 0.9 },
          },
        };
      },
    }, { threshold: 0.25, maxBlockChars: 40 });
    expect(result.keptIds).toEqual(["b0", "b2"]);
    expect(result.droppedIds).toEqual(["b1"]);
    expect(result.text).toContain("[context block b1 omitted; recall=b1]");
    expect(result.recall.b1).toContain("Unrelated");
    expect(requestState.blocks.map((block: any) => block.id)).toEqual(["b0", "b1", "b2"]);
  });

  it("fails open when Jev is unavailable or returns malformed scores", async () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const result = await sieveContext("Read it", text, {
      async systemOne() {
        throw new Error("offline");
      },
    }, { maxBlockChars: 20 });
    expect(result.text).toBe(text);
    expect(result.droppedIds).toEqual([]);

    const malformed = await sieveContext("Read it", text, {
      async systemOne() {
        return { model: "jev", answers: { context_b0: { noul: 0.9 }, context_b1: { nope: 1 }, context_b2: { noul: 0.01 } } };
      },
    }, { maxBlockChars: 20 });
    expect(malformed.text).toBe(text);
  });

  it("validates sieve bounds before splitting", () => {
    expect(() => splitContext("text", 0)).toThrow(/maxBlocks/);
    expect(() => splitContext("text", 2, 0)).toThrow(/maxBlockChars/);
  });
});
