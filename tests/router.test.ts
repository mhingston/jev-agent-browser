import { describe, expect, it, beforeEach } from "vitest";
import { checkAgentBrowser, commandForDecision, executeDecision } from "../src/agentBrowser.js";
import { buildCandidates } from "../src/candidates.js";
import { normalizeSnapshot } from "../src/normalize.js";
import { clearRouteCache, routeSnapshot } from "../src/router.js";

const rawSnapshot = {
  url: "https://example.test/settings",
  title: "Settings",
  text: "Account settings",
  elements: [
    { ref: "@e1", role: "textbox", name: "Display name" },
    { ref: "@e2", role: "button", name: "Save changes" },
    { ref: "@e3", role: "button", name: "Delete account" },
  ],
};

function fakeClient(choice: string, confidence = 0.95, goalCompleted = 0.01) {
  return {
    async systemOne() {
      return {
        model: "jev-1.13.0",
        answers: {
          action: { choice, confidence, probabilities: { [choice]: confidence } },
          goal_completed: { noul: goalCompleted },
        },
        usage: { input_tokens: 120, output_tokens: 18 },
      };
    },
  };
}

describe("agent-browser Jev router", () => {
  beforeEach(() => clearRouteCache());

  it("normalizes interactive refs and keeps structural nodes out", () => {
    const snapshot = normalizeSnapshot({ ...rawSnapshot, heading: { ref: "@e9", role: "heading", name: "No" } }, "Change the name", { source: "fixture" });
    expect(snapshot.elements.map((element) => element.ref)).toEqual(["@e1", "@e2", "@e3"]);
    expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("accepts the agent-browser JSON envelope and refs map", () => {
    const snapshot = normalizeSnapshot({
      success: true,
      data: {
        origin: "https://example.test",
        refs: {
          e1: { name: "Search", role: "combobox" },
          e2: { name: "Submit", role: "button" },
          e3: { name: "Content", role: "generic" },
        },
        snapshot: '- combobox "Search" [ref=e1]\\n- button "Submit" [ref=e2]',
      },
    }, "Search and submit", { source: "agent-browser" });
    expect(snapshot.url).toBe("https://example.test");
    expect(snapshot.elements.map((element) => element.ref)).toEqual(["@e1", "@e2"]);
  });

  it("creates only caller-authorized fill candidates", () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Change the name", { source: "fixture" });
    expect(buildCandidates(snapshot).find((candidate) => candidate.ref === "@e1")).toBeUndefined();
    const candidates = buildCandidates(snapshot, { "@e1": "Mark" });
    expect(candidates.find((candidate) => candidate.ref === "@e1")?.kind).toBe("fill");
    expect(buildCandidates(snapshot, { __press__: "Enter" }).find((candidate) => candidate.kind === "press")?.key).toBe("Enter");
  });

  it("routes a safe click and reports usage", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Open the account settings", { source: "fixture" });
    const saveCandidate = buildCandidates(snapshot).find((candidate) => candidate.ref === "@e2");
    const decision = await routeSnapshot(snapshot, {}, {}, fakeClient(saveCandidate!.id));
    expect(decision.kind).toBe("click");
    expect(decision.ref).toBe("@e2");
    expect(decision.usage.input_tokens).toBe(120);
    expect(decision.fallback).toBe(false);
  });

  it("gates destructive actions by default", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Delete the account", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    const deleteCandidate = candidates.find((candidate) => candidate.ref === "@e3");
    expect(deleteCandidate?.risk).toBe("destructive");
    const decision = await routeSnapshot(snapshot, {}, {}, fakeClient(deleteCandidate!.id));
    expect(decision.kind).toBe("review");
    expect(decision.reasonCode).toBe("unsafe-action");
  });

  it("stops when the goal-completion signal is high", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "The account settings are open", { source: "fixture" });
    const decision = await routeSnapshot(snapshot, {}, {}, fakeClient("c0", 0.95, 0.9));
    expect(decision.kind).toBe("stop");
    expect(decision.reasonCode).toBe("goal-complete");
  });

  it("falls back on low confidence", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Do something ambiguous", { source: "fixture" });
    const decision = await routeSnapshot(snapshot, {}, {}, fakeClient("c0", 0.4));
    expect(decision.kind).toBe("review");
    expect(decision.reasonCode).toBe("low-confidence");
  });

  it("does not trust a stop choice without completion evidence", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Do something ambiguous", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    const stopCandidate = candidates.find((candidate) => candidate.kind === "stop");
    const decision = await routeSnapshot(snapshot, {}, {}, fakeClient(stopCandidate!.id, 0.99, 0.2));
    expect(decision.kind).toBe("review");
    expect(decision.reasonCode).toBe("low-confidence");
  });

  it("does not execute a stale decision", async () => {
    const decision = { kind: "click", ref: "@e1", snapshotHash: "old", confidence: 1, goalCompletedProbability: 0, probabilities: {}, model: "jev-1.13.0", fallback: false, reasonCode: "selected", usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, stateSizeChars: 0, cached: false } as const;
    expect(commandForDecision(decision)).toEqual(["click", "@e1"]);
    await expect(executeDecision(decision, { currentSnapshotHash: "new", binary: "agent-browser" })).rejects.toThrow(/stale snapshot/);
  });

  it("reports a missing agent-browser binary with an install hint", async () => {
    await expect(checkAgentBrowser({ binary: "agent-browser-that-is-not-installed", force: true })).rejects.toThrow(/npm i -g agent-browser/);
  });
});
