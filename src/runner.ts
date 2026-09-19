import { captureSnapshot, classifyCommandFailure, executeDecision, type CommandResult } from "./agentBrowser.js";
import { normalizeSnapshot } from "./normalize.js";
import { defaultPolicy, routeSnapshot } from "./router.js";
import type {
  ActionHistoryEntry,
  NormalizedSnapshot,
  RouteDecision,
  RoutePolicy,
  SystemOneLikeClient,
  PostActionVerifier,
  TextValueProvider,
  BrowserFailureKind,
} from "./types.js";

export interface RunStep {
  index: number;
  decision: RouteDecision;
  execution: CommandResult;
  beforeSnapshotHash: string;
  afterSnapshotHash: string;
  pageChanged: boolean;
  failureClass?: BrowserFailureKind;
}

export interface RunResult {
  status: "completed" | "review" | "blocked";
  reason: "goal-complete" | "review" | "execution-failed" | "postcondition-failed" | "stuck" | "max-steps";
  finalSnapshot: NormalizedSnapshot;
  lastDecision?: RouteDecision;
  failureClass?: BrowserFailureKind;
  steps: RunStep[];
}

export interface RunOptions {
  goal: string;
  session?: string;
  binary?: string;
  inputValues?: Record<string, string>;
  policy?: Partial<RoutePolicy>;
  client?: SystemOneLikeClient;
  maxSteps?: number;
  stuckThreshold?: number;
  verifyCompletion?: (snapshot: NormalizedSnapshot) => boolean | Promise<boolean>;
  postActionVerifier?: PostActionVerifier;
  textProvider?: TextValueProvider;
}

function result(
  status: RunResult["status"],
  reason: RunResult["reason"],
  finalSnapshot: NormalizedSnapshot,
  steps: RunStep[],
  lastDecision?: RouteDecision,
  failureClass?: BrowserFailureKind,
): RunResult {
  return { status, reason, finalSnapshot, steps, ...(lastDecision ? { lastDecision } : {}), ...(failureClass ? { failureClass } : {}) };
}

export async function runGoal(options: RunOptions): Promise<RunResult> {
  const policy = { ...defaultPolicy(), ...(options.policy ?? {}) };
  const maxSteps = options.maxSteps ?? 30;
  const stuckThreshold = options.stuckThreshold ?? 3;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
  if (!Number.isInteger(stuckThreshold) || stuckThreshold < 1) throw new Error("stuckThreshold must be a positive integer");

  const raw = await captureSnapshot({ session: options.session, binary: options.binary });
  let snapshot = normalizeSnapshot(raw, options.goal, {
    maxPageTextChars: policy.maxPageTextChars,
    source: "agent-browser",
  });
  const history: ActionHistoryEntry[] = [];
  const steps: RunStep[] = [];
  let unchangedNonWait = 0;

  for (let index = 0; index < maxSteps; index += 1) {
    const decision = await routeSnapshot(snapshot, options.inputValues ?? {}, policy, options.client, history);
    if (decision.kind === "stop") {
      const verified = options.verifyCompletion ? await options.verifyCompletion(snapshot) : true;
      return verified
        ? result("completed", "goal-complete", snapshot, steps, decision)
        : result("review", "review", snapshot, steps, decision);
    }
    if (decision.fallback || decision.kind === "review") {
      return result("review", "review", snapshot, steps, decision);
    }

    // Re-probe immediately before the mutation. A route decision is only
    // advisory until the observed page is still the page it was chosen from.
    const preActionRaw = await captureSnapshot({ session: options.session, binary: options.binary });
    const preActionSnapshot = normalizeSnapshot(preActionRaw, options.goal, {
      maxPageTextChars: policy.maxPageTextChars,
      source: "agent-browser",
    });
    if (preActionSnapshot.snapshotHash !== snapshot.snapshotHash) {
      return result("review", "review", preActionSnapshot, steps, decision);
    }

    let executableDecision = decision;
    if (decision.kind === "fill" && decision.value == null) {
      const field = snapshot.elements.find((element) => element.ref === decision.ref);
      if (!field || !options.textProvider || /password|credential|secret|token|cvv/i.test(field.name)) {
        return result("review", "review", snapshot, steps, decision);
      }
      let generated: string | null;
      try {
        generated = await options.textProvider({
          goal: options.goal,
          field: { ref: field.ref, role: field.role, name: field.name, currentValue: field.value },
          page: { url: snapshot.url, title: snapshot.title, text: snapshot.pageText },
          recentActions: history.slice(-6),
        });
      } catch {
        return result("review", "review", snapshot, steps, decision);
      }
      if (typeof generated !== "string" || !generated.trim() || generated.length > 2000) {
        return result("review", "review", snapshot, steps, decision);
      }
      executableDecision = { ...decision, value: generated };
    }

    let execution: CommandResult | null;
    try {
      execution = await executeDecision(executableDecision, {
        session: options.session,
        binary: options.binary,
        currentSnapshotHash: snapshot.snapshotHash,
      });
    } catch (error) {
      const failureClass = classifyCommandFailure(error instanceof Error ? error.message : String(error));
      return result("review", "execution-failed", snapshot, steps, decision, failureClass);
    }
    if (!execution || execution.code !== 0) {
      const failureClass = execution ? classifyCommandFailure(execution) : "unknown" as const;
      return result("review", "execution-failed", snapshot, steps, decision, failureClass);
    }

    const beforeSnapshotHash = snapshot.snapshotHash;
    const nextRaw = await captureSnapshot({ session: options.session, binary: options.binary });
    const nextSnapshot = normalizeSnapshot(nextRaw, options.goal, {
      maxPageTextChars: policy.maxPageTextChars,
      source: "agent-browser",
    });
    const pageChanged = nextSnapshot.snapshotHash !== beforeSnapshotHash;
    const step = { index: index + 1, decision: executableDecision, execution, beforeSnapshotHash, afterSnapshotHash: nextSnapshot.snapshotHash, pageChanged };
    steps.push(step);
    if (options.postActionVerifier) {
      let accepted = false;
      try {
        accepted = await options.postActionVerifier({ goal: options.goal, decision: executableDecision, execution, before: snapshot, after: nextSnapshot });
      } catch {
        accepted = false;
      }
      if (!accepted) return result("review", "postcondition-failed", nextSnapshot, steps, executableDecision);
    }
    history.push({
      kind: executableDecision.kind,
      candidateId: executableDecision.candidateId,
      ref: executableDecision.ref,
      pageChanged,
      snapshotHash: nextSnapshot.snapshotHash,
    });

    if (pageChanged || decision.kind === "wait") unchangedNonWait = 0;
    else unchangedNonWait += 1;
    if (unchangedNonWait >= stuckThreshold) {
      return result("blocked", "stuck", nextSnapshot, steps, decision);
    }
    snapshot = nextSnapshot;
  }

  return result("blocked", "max-steps", snapshot, steps, steps.at(-1)?.decision);
}
