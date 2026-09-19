import { describe, expect, it } from "vitest";
import { routeTool } from "../src/toolRouter.js";

const tools = [
  { id: "search", label: "Search the web", risk: "read" as const },
  { id: "publish", label: "Publish a post", risk: "destructive" as const },
];

describe("closed-catalog Jev tool router", () => {
  it("selects only an offered tool with a matching fit judgment", async () => {
    const result = await routeTool("Find recent documentation", { page: "docs" }, tools, {
      async systemOne() {
        return {
          model: "jev-1.13.0",
          answers: {
            tool: { choice: "search", confidence: 0.94, probabilities: { search: 0.9, publish: 0.05, __none__: 0.05 } },
            tool_fit: { noul: 0.93 },
          },
        };
      },
    });
    expect(result.reasonCode).toBe("selected");
    expect(result.tool?.id).toBe("search");
  });

  it("gates destructive tools and rejects invented ids", async () => {
    const gated = await routeTool("Publish this post", {}, tools, {
      async systemOne() {
        return {
          model: "jev-1.13.0",
          answers: {
            tool: { choice: "publish", confidence: 0.95, probabilities: { search: 0.02, publish: 0.95, __none__: 0.03 } },
            tool_fit: { noul: 0.95 },
          },
        };
      },
    });
    expect(gated.reasonCode).toBe("unsafe-tool");

    const invalid = await routeTool("Do it", {}, tools, {
      async systemOne() {
        return {
          model: "jev-1.13.0",
          answers: {
            tool: { choice: "invented", confidence: 0.99, probabilities: { invented: 1 } },
            tool_fit: { noul: 0.99 },
          },
        };
      },
    });
    expect(invalid.reasonCode).toBe("invalid-response");
  });
});
