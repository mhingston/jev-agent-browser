import { describe, expect, it, beforeEach } from "vitest";
import { checkAgentBrowser, classifyCommandFailure, commandForDecision, executeDecision } from "../src/agentBrowser.js";
import { buildCandidates } from "../src/candidates.js";
import { normalizeSnapshot } from "../src/normalize.js";
import { clearRouteCache, routeSnapshot } from "../src/router.js";
import { jevPostActionVerifier } from "../src/postAction.js";

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
    async systemOne(request: { state: { candidates: Array<{ id: string }> } }) {
      const ids = request.state.candidates.map((candidate) => candidate.id);
      const otherIds = ids.filter((id) => id !== choice);
      const otherProbability = otherIds.length ? 0.1 / otherIds.length : 0;
      return {
        model: "jev-1.13.0",
        answers: {
          action: {
            choice,
            confidence,
            probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 0.9 : otherProbability])),
          },
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

  it("offers semantic navigation candidates only when requested", () => {
    const snapshot = normalizeSnapshot({ ...rawSnapshot, text: "Page" }, "Go back and refresh the page", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(expect.arrayContaining(["back", "reload"]));
    expect(commandForDecision({ kind: "back", snapshotHash: "x" } as any)).toEqual(["back"]);
    expect(commandForDecision({ kind: "forward", snapshotHash: "x" } as any)).toEqual(["forward"]);
    expect(commandForDecision({ kind: "reload", snapshotHash: "x" } as any)).toEqual(["reload"]);
  });

  it("exposes observed dropdown options as select candidates", () => {
    const snapshot = normalizeSnapshot({
      url: "https://example.test/search",
      title: "Search",
      elements: [{
        ref: "@e4",
        role: "combobox",
        name: "Country",
        options: [
          { value: "gb", label: "United Kingdom" },
          { value: "us", label: "United States" },
        ],
      }],
    }, "Choose United Kingdom", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    expect(candidates.filter((candidate) => candidate.kind === "select").map((candidate) => candidate.value)).toEqual(["gb", "us"]);
  });

  it("maps agent-browser sibling option refs into select candidates", () => {
    const snapshot = normalizeSnapshot({
      origin: "https://example.test/search",
      refs: {
        e1: { name: "Country", role: "combobox" },
        e2: { name: "United Kingdom", role: "option", selected: true },
        e3: { name: "United States", role: "option" },
      },
      snapshot: '- combobox "Country" [expanded=false, ref=e1]: United Kingdom\n  - option "United Kingdom" [selected, ref=e2]\n  - option "United States" [ref=e3]',
    }, "Choose United States", { source: "agent-browser" });
    expect(snapshot.elements.map((element) => element.role)).toEqual(["combobox"]);
    expect(snapshot.elements[0].options?.map((option) => option.label)).toEqual(["United Kingdom", "United States"]);
  });

  it("offers state-aware checkbox actions and optional generated fills", () => {
    const snapshot = normalizeSnapshot({
      url: "https://example.test/preferences",
      title: "Preferences",
      elements: [
        { ref: "@e5", role: "checkbox", name: "Email notifications", checked: false },
        { ref: "@e6", role: "textbox", name: "Search phrase" },
      ],
    }, "Check email notifications and enter the search phrase", { source: "fixture" });
    expect(buildCandidates(snapshot).find((candidate) => candidate.ref === "@e5")?.kind).toBe("check");
    expect(buildCandidates(snapshot, {}, { allowGeneratedText: true }).find((candidate) => candidate.ref === "@e6")?.kind).toBe("fill");
    expect(buildCandidates(snapshot, {}, { allowGeneratedText: true }).find((candidate) => candidate.ref === "@e6")?.value).toBeUndefined();
  });

  it("routes operation and operation-specific target answers", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Open the account settings", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    const target = candidates.find((candidate) => candidate.ref === "@e2")!;
    const operationIds = [...new Set(candidates.map((candidate) => candidate.kind))];
    const operationProbabilities = Object.fromEntries(operationIds.map((operation) => [operation, operation === "click" ? 0.9 : 0.1 / (operationIds.length - 1)]));
    const clickCandidates = candidates.filter((candidate) => candidate.kind === "click");
    const decision = await routeSnapshot(snapshot, {}, {}, {
      async systemOne() {
        return {
          model: "jev-1.13.0",
          answers: {
            operation: { choice: "click", confidence: 0.95, probabilities: operationProbabilities },
            click_target: {
              choice: target.id,
              confidence: 0.95,
              probabilities: Object.fromEntries(clickCandidates.map((candidate) => [candidate.id, candidate.id === target.id ? 0.9 : 0.1 / (clickCandidates.length - 1)])),
            },
            goal_completed: { noul: 0.01 },
          },
        };
      },
    });
    expect(decision.kind).toBe("click");
    expect(decision.ref).toBe("@e2");
  });

  it("can sieve noisy page text before the main route request", async () => {
    const snapshot = normalizeSnapshot({
      ...rawSnapshot,
      text: "Relevant account settings.\n\nUnrelated navigation boilerplate.\n\nCompleted successfully.",
    }, "Open the account settings", { source: "fixture" });
    const candidates = buildCandidates(snapshot);
    const target = candidates.find((candidate) => candidate.ref === "@e2")!;
    const operationIds = [...new Set(candidates.map((candidate) => candidate.kind))];
    const operationProbabilities = Object.fromEntries(operationIds.map((operation) => [operation, operation === "click" ? 0.9 : 0.1 / (operationIds.length - 1)]));
    const clickCandidates = candidates.filter((candidate) => candidate.kind === "click");
    let calls = 0;
    let routedText = "";
    const decision = await routeSnapshot(snapshot, {}, { enableContextSieve: true, maxContextBlocks: 3, contextSieveThreshold: 0.25 }, {
      async systemOne(request) {
        calls += 1;
        if (request.questions.context_b0) {
          return { model: "jev-1.13.0", answers: { context_b0: { noul: 0.9 }, context_b1: { noul: 0.01 }, context_b2: { noul: 0.9 } } };
        }
        routedText = request.state.page.text;
        return {
          model: "jev-1.13.0",
          answers: {
            operation: { choice: "click", confidence: 0.95, probabilities: operationProbabilities },
            click_target: { choice: target.id, confidence: 0.95, probabilities: Object.fromEntries(clickCandidates.map((candidate) => [candidate.id, candidate.id === target.id ? 0.9 : 0.1 / (clickCandidates.length - 1)])) },
            goal_completed: { noul: 0.01 },
          },
        };
      },
    });
    expect(calls).toBe(2);
    expect(routedText).toContain("[context block b1 omitted");
    expect(decision.kind).toBe("click");
  });

  it("rejects malformed probability maps before any action", async () => {
    const snapshot = normalizeSnapshot(rawSnapshot, "Open the account settings", { source: "fixture" });
    const decision = await routeSnapshot(snapshot, {}, {}, {
      async systemOne() {
        return {
          model: "jev-1.13.0",
          answers: {
            action: { choice: "c0", confidence: 0.99, probabilities: { c0: 0.99 } },
            goal_completed: { noul: 0.01 },
          },
        };
      },
    });
    expect(decision.kind).toBe("review");
    expect(decision.reasonCode).toBe("invalid-response");
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

  it("treats a search submit as a reversible write rather than destructive", () => {
    const snapshot = normalizeSnapshot({
      url: "https://example.test/search",
      title: "Search",
      elements: [{ ref: "@e7", role: "button", name: "Submit search" }],
    }, "Submit the search", { source: "fixture" });
    expect(buildCandidates(snapshot).find((candidate) => candidate.ref === "@e7")?.risk).toBe("write");
  });

  it("classifies browser failures for bounded recovery", () => {
    expect(classifyCommandFailure("Element not found: @e4")).toBe("stale");
    expect(classifyCommandFailure("Timed out waiting for networkidle")).toBe("timeout");
    expect(classifyCommandFailure("Unauthorized: login required")).toBe("auth");
    expect(classifyCommandFailure("Unknown command: upload")).toBe("unsupported");
  });

  it("supports an optional Jev post-action verifier without exposing field values", async () => {
    let observedState: any;
    const verifier = jevPostActionVerifier({
      async systemOne(request) {
        observedState = request.state;
        return {
          model: "jev-1.13.0",
          answers: {
            action_succeeded: { noul: 0.95 },
            failure_class: {
              choice: "unknown",
              confidence: 0.95,
              probabilities: { stale: 0.01, timeout: 0.01, auth: 0.01, unsupported: 0.01, network: 0.01, unknown: 0.95 },
            },
          },
        };
      },
    });
    const accepted = await verifier({
      goal: "Submit the search",
      decision: { kind: "fill", ref: "@e1", value: "secret text", snapshotHash: "hash", confidence: 1, goalCompletedProbability: 0, probabilities: {}, model: "jev", fallback: false, reasonCode: "selected", usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, stateSizeChars: 0, cached: false },
      execution: { code: 0, stdout: "ok", stderr: "" },
      before: normalizeSnapshot(rawSnapshot, "Submit the search", { source: "fixture" }),
      after: normalizeSnapshot({ ...rawSnapshot, text: "Submitted" }, "Submit the search", { source: "fixture" }),
    });
    expect(accepted).toBe(true);
    expect(observedState.action).toEqual({ kind: "fill", ref: "@e1" });
    expect(JSON.stringify(observedState)).not.toContain("secret text");
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
    expect(commandForDecision({ ...decision, kind: "select", ref: "@e4", value: "us" })).toEqual(["select", "@e4", "us"]);
    expect(commandForDecision({ ...decision, kind: "check", ref: "@e5" })).toEqual(["check", "@e5"]);
    await expect(executeDecision(decision, { currentSnapshotHash: "new", binary: "agent-browser" })).rejects.toThrow(/stale snapshot/);
  });

  it("reports a missing agent-browser binary with an install hint", async () => {
    await expect(checkAgentBrowser({ binary: "agent-browser-that-is-not-installed", force: true })).rejects.toThrow(/npm i -g agent-browser/);
  });
});
