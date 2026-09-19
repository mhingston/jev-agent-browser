import type { ActionCandidate, BrowserElement, NormalizedSnapshot, Risk } from "./types.js";

const riskyPattern = /\b(delete|remove|purchase|buy|send|submit|confirm|approve|pay|checkout|transfer|password|credential|secret|authorize|grant|revoke|publish)\b/i;
const writePattern = /\b(save|edit|update|change|add|create|post|reply|upload|login|sign in|log in)\b/i;

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

function relevance(goal: string, element: BrowserElement): number {
  const goalWords = words(goal);
  const labelWords = words(`${element.name} ${element.role} ${element.href ?? ""}`);
  let score = 0;
  for (const word of goalWords) if (labelWords.has(word)) score += 3;
  if (goalWords.has(element.role.toLowerCase())) score += 1;
  return score;
}

function riskFor(element: BrowserElement, kind: "click" | "fill"): Risk {
  const label = `${element.name} ${element.role} ${element.href ?? ""}`;
  if (riskyPattern.test(label) || (kind === "fill" && /password|credential|secret|token|cvv/i.test(label))) return "destructive";
  if (kind === "fill" || writePattern.test(label)) return "write";
  return "read";
}

function candidateForElement(element: BrowserElement, inputValues: Record<string, string>, index: number): ActionCandidate | null {
  if (element.disabled) return null;
  const role = element.role.toLowerCase();
  if (["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
    const value = inputValues[element.ref];
    if (value == null) return null;
    return {
      id: `c${index}`,
      kind: "fill",
      ref: element.ref,
      value,
      label: `Fill ${role} “${element.name}” with the caller-provided value`,
      risk: riskFor(element, "fill"),
    };
  }
  if (["button", "checkbox", "link", "menuitem", "option", "radio", "switch", "tab"].includes(role)) {
    return {
      id: `c${index}`,
      kind: "click",
      ref: element.ref,
      label: `Click ${role} “${element.name}”${element.href ? ` (${element.href})` : ""}`,
      risk: riskFor(element, "click"),
    };
  }
  return null;
}

export function buildCandidates(
  snapshot: NormalizedSnapshot,
  inputValues: Record<string, string> = {},
  options: { maxCandidates?: number; maxLabelChars?: number } = {},
): ActionCandidate[] {
  const maxCandidates = options.maxCandidates ?? 20;
  const maxLabelChars = options.maxLabelChars ?? 160;
  const candidates: ActionCandidate[] = [];
  const rankedElements = snapshot.elements
    .map((element, index) => ({ element, index, score: relevance(snapshot.goal, element) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ element }) => element);
  for (const element of rankedElements) {
    const candidate = candidateForElement(element, inputValues, candidates.length);
    if (!candidate) continue;
    candidate.label = candidate.label.slice(0, maxLabelChars);
    candidates.push(candidate);
    if (candidates.length >= maxCandidates) break;
  }

  const base = candidates.length;
  if (inputValues.__press__) {
    candidates.push({
      id: `c${candidates.length}`,
      kind: "press",
      key: inputValues.__press__,
      label: `Press the caller-authorized key “${inputValues.__press__}”`,
      risk: "write",
    });
  }
  const offset = inputValues.__press__ ? 1 : 0;
  candidates.push({ id: `c${base + offset}`, kind: "scroll", direction: "down", pixels: 600, label: "Scroll down to reveal more content", risk: "read" });
  candidates.push({ id: `c${base + offset + 1}`, kind: "wait", label: "Wait for the page to finish loading", risk: "read" });
  candidates.push({ id: `c${base + offset + 2}`, kind: "stop", label: "Stop because the goal is complete", risk: "read" });
  candidates.push({ id: `c${base + offset + 3}`, kind: "review", label: "Ask for review because no safe action is clear", risk: "read" });
  return candidates;
}
