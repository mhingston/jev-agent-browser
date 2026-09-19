import { AgentBrowserSession, classifyCommandFailure, type BrowserDriver, type CommandResult } from "./agentBrowser.js";
import { normalizeSnapshot } from "./normalize.js";
import { defaultPolicy, routeSnapshot } from "./router.js";
import type {
  ActionHistoryEntry,
  BrowserFailureKind,
  BrowserToolSpec,
  NormalizedSnapshot,
  PostActionVerifier,
  RecoveryContext,
  RouteDecision,
  RoutePolicy,
  SystemOneLikeClient,
  TextValueProvider,
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

export interface RunTraceEntry {
  step: number;
  observation?: NormalizedSnapshot;
  decision?: RouteDecision;
  action?: { executed: boolean; reason?: string; result?: CommandResult | null; signature?: string; recoveryAttempt?: number; input?: unknown; error?: string; durationMs?: number };
  error?: string;
  durationMs?: number;
}

export interface RunHandoff {
  status: RunResult["status"];
  reason: RunResult["reason"] | "completed";
  goal: string;
  plan: string | null;
  subtask: string;
  currentUrl: string | null;
  observation: { url: string; title: string; text: string } | null;
  recentActions: ActionHistoryEntry[];
  inputRequired: { ref?: string; key?: string; name?: string; role?: string; operation?: string } | null;
  escalation: "none" | "parent" | "input";
  parentDecisionRequired: boolean;
  resumable: boolean;
}

export interface RunResult {
  status: "completed" | "review" | "blocked";
  reason: "goal-complete" | "review" | "execution-failed" | "postcondition-failed" | "stuck" | "max-steps" | "recovery-exhausted" | "input-required" | "loop-detected";
  finalSnapshot: NormalizedSnapshot;
  lastDecision?: RouteDecision;
  failureClass?: BrowserFailureKind;
  steps: RunStep[];
  trace?: RunTraceEntry[];
  handoff: RunHandoff;
}

export interface RunEvent {
  type: "start" | "step" | "recovery" | "handoff";
  step?: number;
  goal?: string;
  plan?: string | null;
  subtask?: string;
  entry?: RunTraceEntry;
  recovery?: RecoveryContext;
  handoff?: RunHandoff;
}

export interface RunOptions {
  goal: string;
  session?: string;
  binary?: string;
  browser?: BrowserDriver;
  inputValues?: Record<string, string>;
  policy?: Partial<RoutePolicy>;
  client?: SystemOneLikeClient;
  tools?: BrowserToolSpec[];
  plan?: string;
  subtask?: string;
  initialHistory?: ActionHistoryEntry[];
  historyLimit?: number;
  maxSteps?: number;
  stuckThreshold?: number;
  repeatLimit?: number;
  maxRecoveryAttempts?: number;
  trace?: boolean;
  onEvent?: (event: RunEvent) => void;
  verifyCompletion?: (snapshot: NormalizedSnapshot) => boolean | Promise<boolean>;
  postActionVerifier?: PostActionVerifier;
  textProvider?: TextValueProvider;
}

function emit(onEvent: RunOptions["onEvent"], event: RunEvent): void {
  try { onEvent?.(event); } catch { /* Observability must not change browser safety. */ }
}

function normalizeObserved(raw: unknown, goal: string, policy: RoutePolicy): NormalizedSnapshot {
  if (raw && typeof raw === "object" && "snapshotHash" in raw && "elements" in raw && "pageText" in raw) {
    const snapshot = raw as NormalizedSnapshot;
    return { ...snapshot, goal };
  }
  return normalizeSnapshot(raw, goal, { maxPageTextChars: policy.maxPageTextChars, source: "agent-browser" });
}

function signature(decision: RouteDecision): string {
  return [decision.kind, decision.ref ?? decision.toolId ?? "", decision.value ?? decision.key ?? ""].join("|");
}

function compactObservation(snapshot: NormalizedSnapshot | undefined): RunHandoff["observation"] {
  return snapshot
    ? { url: snapshot.url, title: snapshot.title, text: snapshot.pageText.slice(0, 6_000) }
    : null;
}

function createHandoff(
  options: RunOptions,
  status: RunResult["status"],
  reason: RunResult["reason"],
  snapshot: NormalizedSnapshot,
  history: ActionHistoryEntry[],
  inputRequired: RunHandoff["inputRequired"] = null,
): RunHandoff {
  const completed = status === "completed";
  return {
    status,
    reason: completed ? "completed" : reason,
    goal: options.goal,
    plan: options.plan ?? null,
    subtask: options.subtask ?? options.goal,
    currentUrl: snapshot.url || null,
    observation: compactObservation(snapshot),
    recentActions: history.slice(-(options.historyLimit ?? 6)),
    inputRequired,
    escalation: inputRequired ? "input" : completed ? "none" : "parent",
    parentDecisionRequired: !completed,
    resumable: !completed,
  };
}

function finish(
  options: RunOptions,
  status: RunResult["status"],
  reason: RunResult["reason"],
  snapshot: NormalizedSnapshot,
  steps: RunStep[],
  history: ActionHistoryEntry[],
  trace: RunTraceEntry[],
  lastDecision?: RouteDecision,
  failureClass?: BrowserFailureKind,
  inputRequired: RunHandoff["inputRequired"] = null,
): RunResult {
  const handoff = createHandoff(options, status, reason, snapshot, history, inputRequired);
  emit(options.onEvent, { type: "handoff", handoff });
  return {
    status,
    reason,
    finalSnapshot: snapshot,
    steps,
    handoff,
    ...(options.trace === false ? {} : { trace }),
    ...(lastDecision ? { lastDecision } : {}),
    ...(failureClass ? { failureClass } : {}),
  };
}

export async function runGoal(options: RunOptions): Promise<RunResult> {
  const policy = { ...defaultPolicy(), ...(options.policy ?? {}) };
  const maxSteps = options.maxSteps ?? 30;
  const stuckThreshold = options.stuckThreshold ?? 3;
  const historyLimit = options.historyLimit ?? 6;
  const repeatLimit = options.repeatLimit ?? 2;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("maxSteps must be a positive integer");
  if (!Number.isInteger(stuckThreshold) || stuckThreshold < 1) throw new Error("stuckThreshold must be a positive integer");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) throw new Error("historyLimit must be a positive integer");
  if (!Number.isInteger(repeatLimit) || repeatLimit < 1) throw new Error("repeatLimit must be a positive integer");
  if (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 0) throw new Error("maxRecoveryAttempts must be a non-negative integer");

  const browser = options.browser ?? new AgentBrowserSession({ session: options.session, binary: options.binary });
  let snapshot: NormalizedSnapshot;
  try {
    snapshot = normalizeObserved(await browser.snapshot(), options.goal, policy);
  } catch (error) {
    throw new Error(`browser snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const history = (options.initialHistory ?? []).slice(-historyLimit);
  const steps: RunStep[] = [];
  const trace: RunTraceEntry[] = [];
  let unchangedNonWait = 0;
  let previousSignature: string | undefined;
  let sameActionCount = 0;
  let recovery: RecoveryContext | undefined;
  let recoveryAttempts = 0;
  emit(options.onEvent, { type: "start", goal: options.goal, plan: options.plan ?? null, subtask: options.subtask ?? options.goal });

  for (let index = 0; index < maxSteps; index += 1) {
    const started = Date.now();
    const decision = await routeSnapshot(snapshot, options.inputValues ?? {}, policy, options.client, history, {
      plan: options.plan,
      subtask: options.subtask,
      recovery,
      tools: options.tools,
    });
    const entry: RunTraceEntry = { step: index, observation: snapshot, decision };
    trace.push(entry);

    if (decision.stuckProbability >= 0.8) {
      if (recoveryAttempts < maxRecoveryAttempts) {
        recoveryAttempts += 1;
        recovery = { reason: "jev-reports-stuck", attempt: recoveryAttempts, instruction: "Change strategy locally; do not repeat the last failed approach." };
        entry.action = { executed: false, reason: "local-recovery", recoveryAttempt: recoveryAttempts };
        history.push({ kind: "review", pageChanged: false, snapshotHash: snapshot.snapshotHash });
        while (history.length > historyLimit) history.shift();
        emit(options.onEvent, { type: "recovery", step: index, recovery });
        emit(options.onEvent, { type: "step", step: index, entry });
        continue;
      }
      return finish(options, "blocked", "recovery-exhausted", snapshot, steps, history, trace, decision);
    }
    if (decision.kind === "stop") {
      const verified = options.verifyCompletion ? await options.verifyCompletion(snapshot) : true;
      entry.action = { executed: false, reason: verified ? "goal-complete" : "completion-unverified" };
      emit(options.onEvent, { type: "step", step: index, entry });
      return verified
        ? finish(options, "completed", "goal-complete", snapshot, steps, history, trace, decision)
        : finish(options, "review", "review", snapshot, steps, history, trace, decision);
    }
    if (decision.fallback || decision.kind === "review") {
      entry.action = { executed: false, reason: "review" };
      emit(options.onEvent, { type: "step", step: index, entry });
      return finish(options, "review", "review", snapshot, steps, history, trace, decision);
    }

    const actionSignature = signature(decision);
    sameActionCount = actionSignature === previousSignature ? sameActionCount + 1 : 1;
    previousSignature = actionSignature;
    if (sameActionCount >= repeatLimit) {
      if (recoveryAttempts < maxRecoveryAttempts) {
        recoveryAttempts += 1;
        recovery = { reason: "repeated-action", attempt: recoveryAttempts, avoid: [actionSignature], instruction: "Use a different action or target; the repeated action is not making progress." };
        entry.action = { executed: false, reason: "local-recovery", signature: actionSignature, recoveryAttempt: recoveryAttempts };
        emit(options.onEvent, { type: "recovery", step: index, recovery });
        emit(options.onEvent, { type: "step", step: index, entry });
        continue;
      }
      return finish(options, "blocked", "loop-detected", snapshot, steps, history, trace, decision);
    }

    const preAction = normalizeObserved(await browser.snapshot(), options.goal, policy);
    if (preAction.snapshotHash !== snapshot.snapshotHash) {
      entry.action = { executed: false, reason: "stale-snapshot" };
      emit(options.onEvent, { type: "step", step: index, entry });
      return finish(options, "review", "review", preAction, steps, history, trace, decision);
    }

    let executableDecision = decision;
    if (decision.kind === "fill" && decision.value == null) {
      const field = snapshot.elements.find((element) => element.ref === decision.ref);
      if (!field || !options.textProvider || /password|credential|secret|token|cvv/i.test(field.name)) {
        entry.action = { executed: false, reason: "input-required", input: { ref: decision.ref, name: field?.name, role: field?.role, operation: decision.kind } };
        emit(options.onEvent, { type: "step", step: index, entry });
        return finish(options, "review", "input-required", snapshot, steps, history, trace, decision, undefined, { ref: decision.ref, name: field?.name, role: field?.role, operation: decision.kind });
      }
      let generated: string | null;
      try {
        generated = await options.textProvider({
          goal: options.goal,
          field: { ref: field.ref, role: field.role, name: field.name, currentValue: field.value },
          page: { url: snapshot.url, title: snapshot.title, text: snapshot.pageText },
          recentActions: history.slice(-6),
        });
      } catch { generated = null; }
      if (typeof generated !== "string" || !generated.trim() || generated.length > 2000) {
        entry.action = { executed: false, reason: "input-required" };
        emit(options.onEvent, { type: "step", step: index, entry });
        return finish(options, "review", "input-required", snapshot, steps, history, trace, decision, undefined, { ref: field.ref, name: field.name, role: field.role, operation: decision.kind });
      }
      executableDecision = { ...decision, value: generated };
    }

    let execution: CommandResult | null = null;
    try {
      const tool = decision.toolId ? options.tools?.find((candidate) => candidate.id === decision.toolId) : undefined;
      if (decision.kind === "run-tool") {
        if (!tool || !browser.runTool) throw new Error("allowlisted browser tool is unavailable");
        execution = await browser.runTool(tool);
      } else {
        execution = await browser.execute(executableDecision, snapshot.snapshotHash);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureClass = classifyCommandFailure(message);
      entry.action = { executed: false, reason: "browser-action-failed", error: message, signature: actionSignature };
      if (recoveryAttempts < maxRecoveryAttempts) {
        recoveryAttempts += 1;
        recovery = { reason: "browser-action-failed", attempt: recoveryAttempts, avoid: [actionSignature], instruction: "Recover locally from the browser error and choose another safe action." };
        emit(options.onEvent, { type: "recovery", step: index, recovery });
        emit(options.onEvent, { type: "step", step: index, entry });
        continue;
      }
      emit(options.onEvent, { type: "step", step: index, entry });
      return finish(options, "review", "recovery-exhausted", snapshot, steps, history, trace, decision, failureClass);
    }
    if (!execution || execution.code !== 0) {
      const failureClass = execution ? classifyCommandFailure(execution) : "unknown" as const;
      entry.action = { executed: false, reason: "browser-action-failed", result: execution, signature: actionSignature };
      if (recoveryAttempts < maxRecoveryAttempts) {
        recoveryAttempts += 1;
        recovery = { reason: "browser-action-failed", attempt: recoveryAttempts, avoid: [actionSignature], instruction: "Recover locally from the browser error and choose another safe action." };
        emit(options.onEvent, { type: "recovery", step: index, recovery });
        emit(options.onEvent, { type: "step", step: index, entry });
        continue;
      }
      emit(options.onEvent, { type: "step", step: index, entry });
      return finish(options, "review", "execution-failed", snapshot, steps, history, trace, decision, failureClass);
    }

    const nextSnapshot = normalizeObserved(await browser.snapshot(), options.goal, policy);
    const pageChanged = nextSnapshot.snapshotHash !== snapshot.snapshotHash;
    const step: RunStep = {
      index: index + 1,
      decision: executableDecision,
      execution,
      beforeSnapshotHash: snapshot.snapshotHash,
      afterSnapshotHash: nextSnapshot.snapshotHash,
      pageChanged,
    };
    steps.push(step);
    entry.action = { executed: true, result: execution, signature: actionSignature, durationMs: Date.now() - started };
    if (options.postActionVerifier) {
      let accepted = false;
      try { accepted = await options.postActionVerifier({ goal: options.goal, decision: executableDecision, execution, before: snapshot, after: nextSnapshot }); }
      catch { accepted = false; }
      if (!accepted) {
        emit(options.onEvent, { type: "step", step: index, entry });
        return finish(options, "review", "postcondition-failed", nextSnapshot, steps, history, trace, executableDecision);
      }
    }
    history.push({ kind: executableDecision.kind, candidateId: executableDecision.candidateId, ref: executableDecision.ref, pageChanged, snapshotHash: nextSnapshot.snapshotHash });
    while (history.length > historyLimit) history.shift();
    if (pageChanged || decision.kind === "wait") {
      unchangedNonWait = 0;
      recovery = undefined;
      recoveryAttempts = 0;
    } else unchangedNonWait += 1;
    emit(options.onEvent, { type: "step", step: index, entry });
    if (unchangedNonWait >= stuckThreshold) return finish(options, "blocked", "stuck", nextSnapshot, steps, history, trace, decision);
    snapshot = nextSnapshot;
  }

  return finish(options, "blocked", "max-steps", snapshot, steps, history, trace, steps.at(-1)?.decision);
}
