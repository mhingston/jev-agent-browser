import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "../src/normalize.js";
import { runGoal } from "../src/runner.js";
import type { BrowserDriver, CommandResult } from "../src/agentBrowser.js";
import type { SystemOneLikeClient } from "../src/types.js";

const initial = normalizeSnapshot({
  url: "https://example.test",
  title: "Fixture",
  text: "Details are closed.",
  elements: [{ ref: "@e1", role: "button", name: "Open details" }],
}, "Open details", { source: "fixture" });
const changed = normalizeSnapshot({
  url: "https://example.test",
  title: "Fixture",
  text: "Details opened.",
  elements: [{ ref: "@e1", role: "button", name: "Open details" }],
}, "Open details", { source: "fixture" });

function routeClient(): SystemOneLikeClient {
  return {
    async systemOne(request) {
      const state = request.state as { page: { text: string }; candidates: Array<{ id: string; kind: string; label: string }> };
      const done = state.page.text.includes("opened");
      const operations = [...new Set(state.candidates.map((candidate) => candidate.kind))];
      const operation = done ? "stop" : "click";
      const operationProbabilities = Object.fromEntries(operations.map((kind) => [kind, kind === operation ? 0.9 : operations.length > 1 ? 0.1 / (operations.length - 1) : 0]));
      const answers: Record<string, unknown> = {
        operation: { choice: operation, confidence: 0.95, probabilities: operationProbabilities },
        goal_completed: { noul: done ? 0.95 : 0.01 },
        stuck: { noul: 0.01 },
      };
      if (!done) {
        const target = state.candidates.find((candidate) => candidate.kind === "click")!;
        const targets = state.candidates.filter((candidate) => candidate.kind === "click");
        answers.click_target = { choice: target.id, confidence: 0.95, probabilities: Object.fromEntries(targets.map((candidate) => [candidate.id, candidate.id === target.id ? (targets.length === 1 ? 1 : 0.9) : 0.1 / (targets.length - 1)])) };
      }
      return { model: "fixture", answers };
    },
  };
}

class FixtureBrowser implements BrowserDriver {
  private snapshots = [initial, initial, changed, changed];
  readonly executions: string[] = [];
  readonly tools: string[] = [];

  async snapshot() { return this.snapshots.shift() ?? changed; }
  async execute(decision: { kind: string }, _hash: string): Promise<CommandResult> {
    this.executions.push(decision.kind);
    return { code: 0, stdout: "ok", stderr: "" };
  }
  async runTool(tool: { id: string }): Promise<CommandResult> {
    this.tools.push(tool.id);
    return { code: 0, stdout: JSON.stringify({ items: [{ id: "item-1" }] }), stderr: "" };
  }
}

describe("agent-browser run orchestration", () => {
  it("supports injected browser drivers and structured handoffs", async () => {
    const browser = new FixtureBrowser();
    const events: string[] = [];
    const result = await runGoal({
      goal: "Open details",
      browser,
      client: routeClient(),
      maxSteps: 3,
      onEvent: (event) => events.push(event.type),
      verifyCompletion: (snapshot) => snapshot.pageText.includes("Details opened"),
    });
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
    expect(result.handoff.parentDecisionRequired).toBe(false);
    expect(result.handoff.currentUrl).toBe("https://example.test");
    expect(browser.executions).toEqual(["click"]);
    expect(events).toContain("handoff");
  });

  it("returns a resumable handoff after a repeated action", async () => {
    const browser = new FixtureBrowser();
    const result = await runGoal({
      goal: "Open details",
      browser,
      client: {
        async systemOne(request) {
          const state = request.state as { candidates: Array<{ id: string; kind: string }> };
          const ids = state.candidates.map((candidate) => candidate.kind);
          const probabilities = Object.fromEntries(ids.map((kind, index) => [kind, index === 0 ? 0.9 : ids.length > 1 ? 0.1 / (ids.length - 1) : 0]));
          const target = state.candidates.find((candidate) => candidate.kind === "click")!;
          const targets = state.candidates.filter((candidate) => candidate.kind === "click");
          return { model: "fixture", answers: { operation: { choice: "click", confidence: 0.95, probabilities }, click_target: { choice: target.id, confidence: 0.95, probabilities: Object.fromEntries(targets.map((candidate) => [candidate.id, 1])) }, goal_completed: { noul: 0.01 }, stuck: { noul: 0.01 } } };
        },
      },
      repeatLimit: 1,
      maxRecoveryAttempts: 0,
      maxSteps: 1,
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("loop-detected");
    expect(result.handoff.resumable).toBe(true);
  });

  it("executes only an explicitly registered browser tool", async () => {
    const browser = new FixtureBrowser();
    const tool = { id: "extract", label: "Extract cards", risk: "read" as const };
    const result = await runGoal({
      goal: "Extract the cards",
      browser,
      tools: [tool],
      client: {
        async systemOne(request) {
          const state = request.state as { page: { text: string }; candidates: Array<{ id: string; kind: string; tool_id?: string }> };
          const done = state.page.text.includes("opened");
          const operations = [...new Set(state.candidates.map((candidate) => candidate.kind))];
          const operation = done ? "stop" : "run-tool";
          const probabilities = Object.fromEntries(operations.map((kind) => [kind, kind === operation ? 0.9 : 0.1 / (operations.length - 1)]));
          const answers: Record<string, unknown> = { operation: { choice: operation, confidence: 0.95, probabilities }, goal_completed: { noul: done ? 0.95 : 0.01 }, stuck: { noul: 0.01 } };
          if (!done) {
            const target = state.candidates.find((candidate) => candidate.kind === "run-tool")!;
            const targets = state.candidates.filter((candidate) => candidate.kind === "run-tool");
            answers["run-tool_target"] = { choice: target.id, confidence: 0.95, probabilities: Object.fromEntries(targets.map((candidate) => [candidate.id, 1])) };
          }
          return { model: "fixture", answers };
        },
      },
      maxSteps: 3,
    });
    expect(result.status).toBe("completed");
    expect(browser.tools).toEqual(["extract"]);
  });

  it("bounds Jev-reported stuck recovery", async () => {
    const browser = new FixtureBrowser();
    const result = await runGoal({
      goal: "Trigger stuck recovery",
      browser,
      client: {
        async systemOne(request) {
          const state = request.state as { candidates: Array<{ id: string; kind: string }> };
          const operations = [...new Set(state.candidates.map((candidate) => candidate.kind))];
          const probabilities = Object.fromEntries(operations.map((kind) => [kind, kind === "click" ? 0.9 : 0.1 / Math.max(1, operations.length - 1)]));
          const target = state.candidates.find((candidate) => candidate.kind === "click")!;
          return { model: "fixture", answers: { operation: { choice: "click", confidence: 0.95, probabilities }, click_target: { choice: target.id, confidence: 0.95, probabilities: { [target.id]: 1 } }, goal_completed: { noul: 0.01 }, stuck: { noul: 0.95 } } };
        },
      },
      maxRecoveryAttempts: 1,
      maxSteps: 3,
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("recovery-exhausted");
    expect(result.handoff.escalation).toBe("parent");
  });

  it("classifies a terminal browser failure for parent recovery", async () => {
    class FailingBrowser extends FixtureBrowser {
      async execute(): Promise<CommandResult> { return { code: 1, stdout: "", stderr: "timed out" }; }
    }
    const result = await runGoal({
      goal: "Open details",
      browser: new FailingBrowser(),
      client: routeClient(),
      maxRecoveryAttempts: 0,
      maxSteps: 1,
    });
    expect(result.status).toBe("review");
    expect(result.reason).toBe("execution-failed");
    expect(result.failureClass).toBe("timeout");
  });
});
