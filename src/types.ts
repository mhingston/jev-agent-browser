export type ActionKind =
  | "click"
  | "fill"
  | "press"
  | "scroll"
  | "wait"
  | "stop"
  | "review";

export type Risk = "read" | "write" | "destructive";

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
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
}

export interface ActionCandidate {
  id: string;
  kind: ActionKind;
  ref?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  label: string;
  risk: Risk;
}

export interface RouteDecision {
  kind: ActionKind;
  ref?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  candidateId?: string;
  confidence: number;
  goalCompletedProbability: number;
  probabilities: Record<string, number>;
  model: string;
  snapshotHash: string;
  fallback: boolean;
  reasonCode:
    | "goal-complete"
    | "low-confidence"
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
  policy?: Partial<RoutePolicy>;
  source?: "agent-browser" | "fixture";
}

export interface SystemOneLikeClient {
  systemOne(request: {
    model: string;
    // The SDK's EntryType/Questions types are intentionally hidden behind this
    // small adapter so fixture clients can implement the same contract.
    state: any;
    questions: any;
  }): Promise<{
    model: string;
    answers: {
      action: {
        choice: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      };
      goal_completed: { noul: number };
    };
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}
