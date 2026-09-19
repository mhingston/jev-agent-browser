import type { ActionCandidate, BrowserElement, NormalizedSnapshot, Risk } from "./types.js";

const riskyPattern = /\b(delete|remove|purchase|buy|send|confirm|approve|pay|checkout|transfer|password|credential|secret|authorize|grant|revoke|publish)\b/i;
const writePattern = /\b(save|edit|update|change|add|create|post|reply|upload|login|sign in|log in|submit|search|filter)\b/i;

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

function riskFor(element: BrowserElement, kind: "click" | "fill" | "select" | "check" | "uncheck" | "hover" | "focus"): Risk {
  const label = `${element.name} ${element.role} ${element.href ?? ""}`;
  if (riskyPattern.test(label) || (kind === "fill" && /password|credential|secret|token|cvv/i.test(label))) return "destructive";
  if (["fill", "check", "uncheck"].includes(kind) || writePattern.test(label)) return "write";
  return "read";
}

function candidatesForElement(
  element: BrowserElement,
  goal: string,
  inputValues: Record<string, string>,
  index: number,
  allowGeneratedText: boolean,
): ActionCandidate[] {
  if (element.disabled) return [];
  const role = element.role.toLowerCase();
  if (role === "combobox" && element.options?.length) {
    return element.options
      .filter((option) => !option.disabled)
      .map((option, optionIndex) => ({
        id: `c${index + optionIndex}`,
        kind: "select" as const,
        ref: element.ref,
        value: option.value,
        label: `Select option “${option.label}” in ${element.name}`,
        risk: riskFor(element, "select"),
      }));
  }
  if (["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
    const value = inputValues[element.ref];
    if (value == null && /\bfocus\b/i.test(goal)) {
      return [{ id: `c${index}`, kind: "focus", ref: element.ref, label: `Focus ${role} “${element.name}”`, risk: "read" }];
    }
    if (value == null && allowGeneratedText && !/password|credential|secret|token|cvv/i.test(element.name)) {
      return [{
        id: `c${index}`,
        kind: "fill",
        ref: element.ref,
        label: `Fill ${role} “${element.name}” with a value derived from the caller goal`,
        risk: riskFor(element, "fill"),
      }];
    }
    if (value == null) return [];
    return [{
      id: `c${index}`,
      kind: "fill",
      ref: element.ref,
      value,
      label: `Fill ${role} “${element.name}” with the caller-provided value`,
      risk: riskFor(element, "fill"),
    }];
  }
  if (["checkbox", "radio", "switch"].includes(role)) {
    const wantsOff = /\b(uncheck|untick|turn\s+off|disable|deselect)\b/i.test(goal);
    const wantsOn = /\b(check|tick|turn\s+on|enable|select)\b/i.test(goal);
    if (wantsOff && element.checked === true) {
      return [{ id: `c${index}`, kind: "uncheck", ref: element.ref, label: `Uncheck ${role} “${element.name}”`, risk: riskFor(element, "uncheck") }];
    }
    if (wantsOn && element.checked !== true) {
      return [{ id: `c${index}`, kind: "check", ref: element.ref, label: `Check ${role} “${element.name}”`, risk: riskFor(element, "check") }];
    }
    if ((wantsOff && element.checked !== true) || (wantsOn && element.checked === true)) return [];
  }
  if (/\bhover\b/i.test(goal) && ["button", "link", "menuitem", "tab"].includes(role)) {
    return [{ id: `c${index}`, kind: "hover", ref: element.ref, label: `Hover over ${role} “${element.name}”`, risk: riskFor(element, "hover") }];
  }
  if (["button", "checkbox", "link", "menuitem", "option", "radio", "switch", "tab"].includes(role)) {
    return [{
      id: `c${index}`,
      kind: "click",
      ref: element.ref,
      label: `Click ${role} “${element.name}”${element.href ? ` (${element.href})` : ""}`,
      risk: riskFor(element, "click"),
    }];
  }
  return [];
}

export function buildCandidates(
  snapshot: NormalizedSnapshot,
  inputValues: Record<string, string> = {},
  options: { maxCandidates?: number; maxLabelChars?: number; allowGeneratedText?: boolean } = {},
): ActionCandidate[] {
  const maxCandidates = options.maxCandidates ?? 20;
  const maxLabelChars = options.maxLabelChars ?? 160;
  const candidates: ActionCandidate[] = [];
  const rankedElements = snapshot.elements
    .map((element, index) => ({ element, index, score: relevance(snapshot.goal, element) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ element }) => element);
  for (const element of rankedElements) {
    const elementCandidates = candidatesForElement(element, snapshot.goal, inputValues, candidates.length, options.allowGeneratedText ?? false);
    for (const candidate of elementCandidates) {
      candidate.label = candidate.label.slice(0, maxLabelChars);
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length >= maxCandidates) break;
  }

  if (inputValues.__press__) {
    candidates.push({
      id: `c${candidates.length}`,
      kind: "press",
      key: inputValues.__press__,
      label: `Press the caller-authorized key “${inputValues.__press__}”`,
      risk: "write",
    });
  }
  const navigation: ActionCandidate[] = [];
  if (/\b(back|go\s+back|previous\s+page)\b/i.test(snapshot.goal)) navigation.push({ id: "", kind: "back", label: "Go back to the previous page", risk: "read" });
  if (/\b(forward|go\s+forward|next\s+page)\b/i.test(snapshot.goal)) navigation.push({ id: "", kind: "forward", label: "Go forward to the next page", risk: "read" });
  if (/\b(reload|refresh)\b/i.test(snapshot.goal)) navigation.push({ id: "", kind: "reload", label: "Reload the current page", risk: "read" });
  for (const candidate of navigation) {
    candidate.id = `c${candidates.length}`;
    candidates.push(candidate);
  }
  const appendSynthetic = (candidate: Omit<ActionCandidate, "id">): void => {
    candidates.push({ ...candidate, id: `c${candidates.length}` });
  };
  appendSynthetic({ kind: "scroll", direction: "down", pixels: 600, label: "Scroll down to reveal more content", risk: "read" });
  appendSynthetic({ kind: "wait", label: "Wait for the page to finish loading", risk: "read" });
  appendSynthetic({ kind: "stop", label: "Stop because the goal is complete", risk: "read" });
  appendSynthetic({ kind: "review", label: "Ask for review because no safe action is clear", risk: "read" });
  return candidates;
}
