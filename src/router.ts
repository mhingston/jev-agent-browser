import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { buildCandidates } from "./candidates.js";
import { normalizeSnapshot } from "./normalize.js";
import { DEFAULT_POLICY, resolvePolicy } from "./policy.js";
import type {
  ActionCandidate,
  NormalizedSnapshot,
  RouteDecision,
  RouteInput,
  RoutePolicy,
  SystemOneLikeClient,
} from "./types.js";

const cache = new Map<string, { expiresAt: number; decision: RouteDecision }>();

function requestState(snapshot: NormalizedSnapshot, candidates: ActionCandidate[]): unknown {
  const candidateRefs = new Set(candidates.map((candidate) => candidate.ref).filter((ref): ref is string => Boolean(ref)));
  return {
    goal: snapshot.goal,
    page: {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.pageText,
    },
    elements: snapshot.elements.filter((element) => candidateRefs.has(element.ref)),
    candidates: candidates.map(({ id, kind, ref, label, risk }) => ({ id, kind, ref, label, risk })),
  };
}

function requestQuestions(candidates: ActionCandidate[]) {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) criteria[candidate.id] = candidate.label;
  return {
    action: choice(
      "Which single candidate action best advances `goal` on the current `page`? Choose review when no safe action is clear, and choose stop only when the goal is complete.",
      criteria,
    ),
    goal_completed: noul(
      "Does the current `page` show that `goal` is complete?",
      {
        true: "The page visibly confirms the requested goal is complete.",
        false: "The goal is not visibly complete, or the page does not provide enough evidence.",
      },
    ),
  };
}

function fallbackDecision(
  snapshot: NormalizedSnapshot,
  policy: RoutePolicy,
  reasonCode: RouteDecision["reasonCode"],
  response: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } } = {},
  confidence = 0,
  goalCompletedProbability = 0,
  probabilities: Record<string, number> = {},
  stateSizeChars = 0,
  latencyMs = 0,
  cached = false,
): RouteDecision {
  return {
    kind: reasonCode === "goal-complete" ? "stop" : "review",
    confidence,
    goalCompletedProbability,
    probabilities,
    model: response.model ?? policy.model,
    snapshotHash: snapshot.snapshotHash,
    fallback: true,
    reasonCode,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
    latencyMs,
    stateSizeChars,
    cached,
  };
}

export function clearRouteCache(): void {
  cache.clear();
}

export async function routeSnapshot(
  snapshot: NormalizedSnapshot,
  inputValues: Record<string, string> = {},
  options: Partial<RoutePolicy> = {},
  client: SystemOneLikeClient = new TypeSafeClient() as unknown as SystemOneLikeClient,
): Promise<RouteDecision> {
  const policy = resolvePolicy(options);
  const candidates = buildCandidates(snapshot, inputValues, policy);
  const state = requestState(snapshot, candidates);
  const stateSizeChars = JSON.stringify(state).length;
  const cacheKey = `${snapshot.snapshotHash}:${snapshot.goal}:${JSON.stringify(inputValues)}:${policy.model}:${policy.allowRisky}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { ...hit.decision, cached: true };

  const started = performance.now();
  const response = await client.systemOne({ model: policy.model, state, questions: requestQuestions(candidates) });
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;
  const action = response.answers.action;
  const goalCompletedProbability = response.answers.goal_completed.noul;
  const confidence = action.confidence ?? 0;
  const probabilities = action.probabilities ?? {};

  let decision: RouteDecision;
  if (goalCompletedProbability >= policy.goalCompleteThreshold) {
    decision = fallbackDecision(snapshot, policy, "goal-complete", response, confidence, goalCompletedProbability, probabilities, stateSizeChars, latencyMs);
  } else if (confidence < policy.confidenceFloor) {
    decision = fallbackDecision(snapshot, policy, "low-confidence", response, confidence, goalCompletedProbability, probabilities, stateSizeChars, latencyMs);
  } else {
    const selected = candidates.find((candidate) => candidate.id === action.choice);
    if (!selected) {
      decision = fallbackDecision(snapshot, policy, "unknown-candidate", response, confidence, goalCompletedProbability, probabilities, stateSizeChars, latencyMs);
    } else if (selected.kind === "stop" && goalCompletedProbability < policy.goalCompleteThreshold) {
      decision = fallbackDecision(snapshot, policy, "low-confidence", response, confidence, goalCompletedProbability, probabilities, stateSizeChars, latencyMs);
    } else if (selected.risk === "destructive" && (!policy.allowRisky || confidence < policy.riskyConfidence)) {
      decision = fallbackDecision(snapshot, policy, "unsafe-action", response, confidence, goalCompletedProbability, probabilities, stateSizeChars, latencyMs);
    } else {
      decision = {
        kind: selected.kind,
        ref: selected.ref,
        value: selected.value,
        key: selected.key,
        direction: selected.direction,
        pixels: selected.pixels,
        candidateId: selected.id,
        confidence,
        goalCompletedProbability,
        probabilities,
        model: response.model,
        snapshotHash: snapshot.snapshotHash,
        fallback: false,
        reasonCode: "selected",
        usage: {
          input_tokens: response.usage?.input_tokens ?? 0,
          output_tokens: response.usage?.output_tokens ?? 0,
        },
        latencyMs,
        stateSizeChars,
        cached: false,
      };
    }
  }

  cache.set(cacheKey, { expiresAt: now + policy.cacheTtlMs, decision });
  return decision;
}

export async function routeInput(
  input: RouteInput,
  client?: SystemOneLikeClient,
): Promise<RouteDecision> {
  const policy = resolvePolicy(input.policy);
  const snapshot = normalizeSnapshot(input.snapshot, input.goal, {
    maxPageTextChars: policy.maxPageTextChars,
    source: input.source,
  });
  return routeSnapshot(snapshot, input.inputValues, policy, client);
}

export function defaultPolicy(): RoutePolicy {
  return { ...DEFAULT_POLICY };
}
