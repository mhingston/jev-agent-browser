import { noul } from "@typesafe-ai/sdk";
import { createDecisionClient } from "../src/decision.js";
import { normalizeSnapshot } from "../src/normalize.js";
import { routeSnapshot } from "../src/router.js";

const client = createDecisionClient();
const response = await client.systemOne({
  model: "jev-1.13.0",
  state: {
    goal: "Open the settings page",
    page: { title: "Settings", text: "The settings page is visible." },
  },
  questions: {
    goal_completed: noul("Does the current `page` show that `goal` is complete?"),
  },
});

const routeSnapshotInput = normalizeSnapshot({
  url: "https://example.test/settings",
  title: "Settings",
  text: "A settings page with an available button.",
  elements: [{ ref: "@e1", role: "button", name: "Settings" }],
}, "Click the Settings button", { source: "fixture" });
const routed = await routeSnapshot(
  routeSnapshotInput,
  {},
  { cacheTtlMs: 0 },
  client,
);
if (routed.kind !== "click" || routed.ref !== "@e1" || routed.fallback) {
  throw new Error(`Live route smoke did not select the expected safe click: ${JSON.stringify({ kind: routed.kind, ref: routed.ref, fallback: routed.fallback, reasonCode: routed.reasonCode })}`);
}

console.log(JSON.stringify({
  model: response.model,
  goal_completed: response.answers.goal_completed,
  routed: { kind: routed.kind, ref: routed.ref, confidence: routed.confidence, goalCompletedProbability: routed.goalCompletedProbability },
  usage: response.usage,
}, null, 2));
