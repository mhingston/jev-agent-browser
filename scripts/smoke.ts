import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { normalizeSnapshot } from "../src/normalize.js";
import { routeSnapshot } from "../src/router.js";
import type { SystemOneLikeClient } from "../src/types.js";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error("TYPESAFE_API_KEY is unset; export it before running the live smoke test.");
  process.exit(2);
}

const client = new TypeSafeClient({ defaultModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0" });
const response = await client.systemOne({
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
  client as unknown as SystemOneLikeClient,
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
