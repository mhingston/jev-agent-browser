import { choice, noul } from "@typesafe-ai/sdk";
import { createDecisionClient } from "./decision.js";
import type { BrowserToolSpec, SystemOneLikeClient } from "./types.js";

export type ToolSpec = BrowserToolSpec;

export interface ToolRouteOptions {
  model?: string;
  confidenceFloor?: number;
  fitThreshold?: number;
  riskyConfidence?: number;
  allowRisky?: boolean;
}

export interface ToolRouteResult {
  tool?: ToolSpec;
  confidence: number;
  fitProbability: number;
  probabilities: Record<string, number>;
  model: string;
  fallback: boolean;
  reasonCode: "selected" | "low-confidence" | "unsafe-tool" | "no-tool" | "invalid-response";
}

const DEFAULTS: Required<ToolRouteOptions> = {
  model: process.env.JEV_MODEL?.trim() || process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev",
  confidenceFloor: 0.6,
  fitThreshold: 0.5,
  riskyConfidence: 0.9,
  allowRisky: false,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function choiceAnswer(value: unknown): { choice: string; confidence: number; probabilities: Record<string, number> } | null {
  const item = record(value);
  const probabilities = record(item?.probabilities);
  if (!item || typeof item.choice !== "string" || typeof item.confidence !== "number" || !probabilities) return null;
  return { choice: item.choice, confidence: item.confidence, probabilities: probabilities as Record<string, number> };
}

function validChoice(answer: ReturnType<typeof choiceAnswer>, ids: string[]) {
  if (!answer || !ids.includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return false;
  const keys = Object.keys(answer.probabilities).sort();
  const expected = [...ids].sort();
  if (keys.length !== expected.length || keys.join("\u0000") !== expected.join("\u0000")) return false;
  const values = Object.values(answer.probabilities);
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return false;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) return false;
  return answer.probabilities[answer.choice] >= Math.max(...values) - 1e-6;
}

function noulScore(value: unknown): number | null {
  const score = record(value)?.noul;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function fallback(model: string, reasonCode: ToolRouteResult["reasonCode"], fitProbability = 0, probabilities: Record<string, number> = {}): ToolRouteResult {
  return { confidence: 0, fitProbability, probabilities, model, fallback: true, reasonCode };
}

/** Route an intent across a closed, code-owned tool catalog. */
export async function routeTool(
  goal: string,
  state: unknown,
  tools: ToolSpec[],
  client: SystemOneLikeClient = createDecisionClient(),
  options: ToolRouteOptions = {},
): Promise<ToolRouteResult> {
  const policy = { ...DEFAULTS, ...options };
  if (!tools.length) return fallback(policy.model, "no-tool");
  const noneId = "__none__";
  const ids = [...tools.map((tool) => tool.id), noneId];
  if (new Set(ids).size !== ids.length) throw new Error("tool ids must be unique and must not be __none__");
  let response: Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>;
  try {
    response = await client.systemOne({
      model: policy.model,
      state: { goal, state, tools: tools.map(({ id, label, description, risk }) => ({ id, label, description, risk })) },
      questions: {
        tool: choice("Which single listed tool best advances the goal? Choose __none__ when no listed tool fits.", Object.fromEntries(tools.map((tool) => [tool.id, tool.label]).concat([[noneId, "No listed tool fits"]]))),
        tool_fit: noul("Does any listed tool safely fit the goal and current state?", { true: "A listed tool clearly fits.", false: "No listed tool fits or the intent is ambiguous." }),
      },
    });
  } catch {
    return fallback(policy.model, "invalid-response");
  }
  const answer = choiceAnswer(response.answers.tool);
  const fit = noulScore(response.answers.tool_fit);
  if (!answer || !validChoice(answer, ids) || fit == null) return fallback(response.model, "invalid-response", fit ?? 0);
  const selected = tools.find((tool) => tool.id === answer.choice);
  if (!selected || answer.choice === noneId || fit < policy.fitThreshold) {
    return { ...fallback(response.model, "no-tool", fit, answer.probabilities), confidence: answer.confidence };
  }
  if (selected.risk === "destructive" && (!policy.allowRisky || answer.confidence < policy.riskyConfidence)) {
    return { ...fallback(response.model, "unsafe-tool", fit, answer.probabilities), confidence: answer.confidence };
  }
  if (answer.confidence < policy.confidenceFloor) {
    return { ...fallback(response.model, "low-confidence", fit, answer.probabilities), confidence: answer.confidence };
  }
  return { tool: selected, confidence: answer.confidence, fitProbability: fit, probabilities: answer.probabilities, model: response.model, fallback: false, reasonCode: "selected" };
}
