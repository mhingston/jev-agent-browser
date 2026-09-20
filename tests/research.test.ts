import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "../src/normalize.js";
import { runResearch } from "../src/researchRunner.js";
import { allowedFollowUpTarget, enrichContactEvidence, keepClassifiedItems } from "../src/research.js";
import type { BrowserDriver, CommandResult } from "../src/agentBrowser.js";
import type { SystemOneLikeClient } from "@mhingston5/jev-cli";

describe("research helpers", () => {
  it("keeps classified items and extracts contact evidence after the keep decision", () => {
    const items = [{ title: "A", text: "person@example.com https://example.com" }, { title: "B", text: "No contact" }];
    const kept = keepClassifiedItems(items, [{ status: "classified", labels: { relevance: "yes" } }, { status: "classified", labels: { relevance: "no" } }], { keep: { dimension: "relevance", choices: ["yes"] } });
    expect(kept).toHaveLength(1);
    expect(enrichContactEvidence(kept[0])).toEqual({ emails: ["person@example.com"], phones: [], urls: ["https://example.com"] });
  });

  it("restricts follow-up URLs to explicit HTTP(S) hosts", () => {
    expect(allowedFollowUpTarget("https://jobs.example.com/a", ["example.com"])).toBe(true);
    expect(allowedFollowUpTarget("https://evil.example.net", ["example.com"])).toBe(false);
    expect(allowedFollowUpTarget("file:///etc/passwd", ["example.com"])).toBe(false);
  });

  it("runs bounded collection and typed classification through the orchestration layer", async () => {
    const initial = normalizeSnapshot({ url: "https://example.test", title: "Results", text: "Results are ready.", elements: [] }, "Collect results", { source: "fixture" });
    const done = normalizeSnapshot({ url: "https://example.test", title: "Results", text: "Results collected.", elements: [] }, "Collect results", { source: "fixture" });
    class ResearchBrowser implements BrowserDriver {
      private snapshots = [initial, initial, done, done];
      async open(_url: string): Promise<CommandResult> { return { code: 0, stdout: "", stderr: "" }; }
      async snapshot(): Promise<unknown> { return this.snapshots.shift() ?? done; }
      async execute(): Promise<CommandResult> { throw new Error("unexpected browser action"); }
      async runTool(): Promise<CommandResult> { return { code: 0, stdout: JSON.stringify({ items: [{ id: "item-1", title: "Relevant role" }] }), stderr: "" }; }
    }
    const client: SystemOneLikeClient = {
      async systemOne(request) {
        const state = request.state as { page?: { text: string }; candidates?: Array<{ id: string; kind: string }> };
        if (state.page && state.candidates) {
          const operation = state.page?.text.includes("collected") ? "stop" : "run-tool";
          const operations = [...new Set(state.candidates.map((candidate) => candidate.kind))];
          const probabilities = Object.fromEntries(operations.map((kind) => [kind, kind === operation ? 0.9 : 0.1 / Math.max(1, operations.length - 1)]));
          const answers: Record<string, unknown> = { operation: { choice: operation, confidence: 0.95, probabilities }, goal_completed: { noul: operation === "stop" ? 0.95 : 0.01 }, stuck: { noul: 0.01 } };
          if (operation === "run-tool") {
            const target = state.candidates.find((candidate) => candidate.kind === "run-tool")!;
            answers["run-tool_target"] = { choice: target.id, confidence: 0.95, probabilities: { [target.id]: 1 } };
          }
          return { model: "fixture", answers };
        }
        return { model: "fixture", answers: { candidate_0_relevance: { choice: "yes" } } };
      },
    };
    const result = await runResearch({
      browser: new ResearchBrowser(),
      client,
      config: {
        queries: [{ url: "https://example.test", goal: "Collect results" }],
        tools: [{ id: "collect", label: "Collect results", collect: true }],
        profile: { dimensions: { relevance: { instructions: "Is this relevant?", choices: { yes: "Relevant", no: "Not relevant" } } }, keep: { dimension: "relevance", choices: ["yes"] } },
      },
    });
    expect(result.collected).toHaveLength(1);
    expect(result.classified[0].labels).toEqual({ relevance: "yes" });
    expect(result.metrics.toolCalls).toBe(1);
  });
});
