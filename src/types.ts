export type ActionKind =
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "hover"
  | "focus"
  | "press"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "run-tool"
  | "wait"
  | "stop"
  | "review";

export type Risk = "read" | "write" | "destructive";

export type BrowserFailureKind = "stale" | "timeout" | "auth" | "unsupported" | "network" | "unknown";

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  options?: BrowserOption[];
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface BrowserOption {
  label: string;
  value: string;
  disabled?: boolean;
  selected?: boolean;
}

export interface NormalizedSnapshot {
  goal: string;
  url: string;
  title: string;
  pageText: string;
  elements: BrowserElement[];
  snapshotHash: string;
  source: "agent-browser" | "fixture";
}

export interface RoutePolicy {
  model: string;
  confidenceFloor: number;
  goalCompleteThreshold: number;
  riskyConfidence: number;
  allowRisky: boolean;
  maxCandidates: number;
  maxLabelChars: number;
  maxPageTextChars: number;
  cacheTtlMs: number;
  allowGeneratedText: boolean;
  enableContextSieve: boolean;
  contextSieveThreshold: number;
  maxContextBlocks: number;
}

export interface ActionCandidate {
  id: string;
  kind: ActionKind;
  ref?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  toolId?: string;
  label: string;
  risk: Risk;
}

export interface ActionHistoryEntry {
  kind: ActionKind;
  candidateId?: string;
  ref?: string;
  pageChanged: boolean;
  snapshotHash?: string;
}

export interface RouteDecision {
  kind: ActionKind;
  ref?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  toolId?: string;
  candidateId?: string;
  confidence: number;
  goalCompletedProbability: number;
  stuckProbability: number;
  probabilities: Record<string, number>;
  model: string;
  snapshotHash: string;
  fallback: boolean;
  reasonCode:
    | "goal-complete"
    | "low-confidence"
    | "invalid-response"
    | "unsafe-action"
    | "unknown-candidate"
    | "selected";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  latencyMs: number;
  stateSizeChars: number;
  cached: boolean;
}

export interface RouteInput {
  goal: string;
  snapshot: unknown;
  inputValues?: Record<string, string>;
  history?: ActionHistoryEntry[];
  policy?: Partial<RoutePolicy>;
  source?: "agent-browser" | "fixture";
  plan?: string;
  subtask?: string;
  recovery?: RecoveryContext;
}

export interface RecoveryContext {
  reason: string;
  attempt: number;
  avoid?: string[];
  instruction?: string;
}

export interface ChoiceAnswer {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface TextValueContext {
  goal: string;
  field: {
    ref: string;
    role: string;
    name: string;
    currentValue?: string;
  };
  page: { url: string; title: string; text: string };
  recentActions: ActionHistoryEntry[];
}

export type TextValueProvider = (context: TextValueContext) => string | null | Promise<string | null>;

export interface PostActionContext {
  goal: string;
  decision: RouteDecision;
  execution: { code: number; stdout: string; stderr: string };
  before: NormalizedSnapshot;
  after: NormalizedSnapshot;
}

export type PostActionVerifier = (context: PostActionContext) => boolean | Promise<boolean>;

export interface BrowserToolSpec {
  id: string;
  label: string;
  description?: string;
  risk?: Risk;
  source?: string;
  sourcePath?: string;
  config?: Record<string, unknown>;
  collect?: boolean;
}

