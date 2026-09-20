import type { RoutePolicy } from "./types.js";

export const DEFAULT_POLICY: RoutePolicy = {
  model: process.env.JEV_MODEL?.trim() || process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev",
  confidenceFloor: 0.6,
  goalCompleteThreshold: 0.8,
  riskyConfidence: 0.9,
  allowRisky: false,
  maxCandidates: 20,
  maxLabelChars: 160,
  maxPageTextChars: 2000,
  cacheTtlMs: 5000,
  allowGeneratedText: false,
  enableContextSieve: false,
  contextSieveThreshold: 0.25,
  maxContextBlocks: 12,
};

export function resolvePolicy(input?: Partial<RoutePolicy>): RoutePolicy {
  const result = { ...DEFAULT_POLICY, ...(input ?? {}) };
  if (!(result.confidenceFloor >= 0 && result.confidenceFloor <= 1)) {
    throw new Error("confidenceFloor must be between 0 and 1");
  }
  if (!(result.goalCompleteThreshold >= 0 && result.goalCompleteThreshold <= 1)) {
    throw new Error("goalCompleteThreshold must be between 0 and 1");
  }
  if (!(result.riskyConfidence >= 0 && result.riskyConfidence <= 1)) {
    throw new Error("riskyConfidence must be between 0 and 1");
  }
  if (!Number.isInteger(result.maxCandidates) || result.maxCandidates < 1) {
    throw new Error("maxCandidates must be a positive integer");
  }
  if (!Number.isInteger(result.maxContextBlocks) || result.maxContextBlocks < 1) {
    throw new Error("maxContextBlocks must be a positive integer");
  }
  if (!(result.contextSieveThreshold >= 0 && result.contextSieveThreshold <= 1)) {
    throw new Error("contextSieveThreshold must be between 0 and 1");
  }
  return result;
}
