import { choice } from "@typesafe-ai/sdk";
import type { SystemOneLikeClient } from "./types.js";

export const DEFAULT_MAX_ITEMS = 20;
export const DEFAULT_MAX_TEXT_CHARS = 2_000;

export interface ClassificationDimension {
  instructions: string;
  choices: Record<string, string>;
}

export interface ClassificationProfile {
  goal?: string;
  context?: unknown;
  dimensions: Record<string, ClassificationDimension>;
  evidenceFields?: string[];
  overrides?: Array<{ when?: { field?: string; matches?: string }; set?: { labels?: Record<string, string> }; reason?: string }>;
  keep?: { dimension?: string; choices?: string[] };
}

export interface ClassificationResult {
  index: number;
  status: "classified" | "classification-error";
  labels?: Record<string, string>;
  errors?: string[];
}

function readPath(value: unknown, path: string | undefined): unknown {
  return String(path ?? "").split(".").filter(Boolean).reduce((current: any, key) => current?.[key], value);
}

export function validateProfile(profile: ClassificationProfile): ClassificationProfile {
  if (!profile?.dimensions || typeof profile.dimensions !== "object" || Array.isArray(profile.dimensions)) throw new Error("profile.dimensions must be an object");
  const dimensions: Record<string, ClassificationDimension> = {};
  for (const [name, dimension] of Object.entries(profile.dimensions)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid profile dimension: ${name}`);
    if (!dimension || typeof dimension.instructions !== "string" || !dimension.instructions.trim()) throw new Error(`profile dimension ${name} needs instructions`);
    if (!dimension.choices || typeof dimension.choices !== "object" || Array.isArray(dimension.choices) || Object.keys(dimension.choices).length < 2 || Object.keys(dimension.choices).length > 8) throw new Error(`profile dimension ${name} needs 2-8 choices`);
    dimensions[name] = { instructions: dimension.instructions, choices: Object.fromEntries(Object.entries(dimension.choices).map(([key, value]) => [String(key), String(value)])) };
  }
  return { ...profile, dimensions };
}

function redact(value: unknown, maxChars = 1_000): unknown {
  if (typeof value === "string") return value
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?:\+\d[\d\s().-]{7,}\d|\b\d{2,4}[\s().-]\d{3}[\s().-]\d{3,4}\b)/g, "[redacted-phone]")
    .replace(/(?:https?|mailto):\/\/[^\s<>'"]+/gi, "[redacted-url]")
    .slice(0, maxChars);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, maxChars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, redact(item, maxChars)]));
  return value;
}

function sanitizeCandidate(candidate: any, index: number, maxTextChars: number, evidenceFields: string[] = []): Record<string, unknown> {
  return {
    id: String(candidate?.id ?? index),
    author: redact(String(candidate?.author ?? "").slice(0, 160)),
    title: redact(String(candidate?.title ?? "").slice(0, 240)),
    company: redact(String(candidate?.company ?? candidate?.company_or_client ?? "").slice(0, 160)),
    location: redact(String(candidate?.location ?? candidate?.geo ?? candidate?.remote_scope ?? "").slice(0, 160)),
    stack: redact(String(candidate?.stack ?? "").slice(0, 300)),
    signals: redact({ positive: Array.isArray(candidate?.positive) ? candidate.positive.slice(0, 12) : [], negative: Array.isArray(candidate?.negative) ? candidate.negative.slice(0, 12) : [] }),
    evidence: Object.fromEntries(evidenceFields.map((field) => [field, redact(candidate?.[field], Math.max(200, Math.floor(maxTextChars / 2)))])),
    text: redact(String(candidate?.text ?? candidate?.summary ?? candidate?.title ?? "").slice(0, maxTextChars)),
  };
}

export function questionKey(index: number, dimension: string): string {
  return `candidate_${index}_${dimension}`;
}

export function buildBatchClassificationRequest(options: {
  goal?: string;
  candidates: unknown[];
  profile: ClassificationProfile;
  model?: string;
  maxItems?: number;
  maxTextChars?: number;
}): { model: string; state: unknown; questions: Record<string, unknown> } {
  const profile = validateProfile(options.profile);
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  if (!Array.isArray(options.candidates) || options.candidates.length === 0) throw new Error("candidates must be a non-empty array");
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error("maxItems must be a positive integer");
  if (!Number.isInteger(maxTextChars) || maxTextChars < 1) throw new Error("maxTextChars must be a positive integer");
  const bounded = options.candidates.slice(0, maxItems);
  const questions: Record<string, unknown> = {};
  for (let index = 0; index < bounded.length; index += 1) {
    for (const [dimension, config] of Object.entries(profile.dimensions)) {
      questions[questionKey(index, dimension)] = choice(config.instructions, config.choices);
    }
  }
  return {
    model: options.model ?? "jev-1.13.0",
    state: {
      goal: options.goal ?? profile.goal ?? "Classify these evidence items.",
      ...(profile.context ? { context: profile.context } : {}),
      profile,
      candidates: bounded.map((candidate, index) => sanitizeCandidate(candidate, index, maxTextChars, profile.evidenceFields)),
    },
    questions,
  };
}

function pickChoice(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return typeof record.choice === "string" ? record.choice : typeof record.value === "string" ? record.value : undefined;
}

export function parseBatchClassificationResponse(response: { answers?: Record<string, unknown> } | Record<string, unknown>, profile: ClassificationProfile, candidateCount: number): ClassificationResult[] {
  const normalized = validateProfile(profile);
  const answers = ("answers" in response && response.answers && typeof response.answers === "object" ? response.answers : response) as Record<string, unknown>;
  return Array.from({ length: candidateCount }, (_, index) => {
    const labels: Record<string, string> = {};
    const errors: string[] = [];
    for (const [dimension, config] of Object.entries(normalized.dimensions)) {
      const value = pickChoice(answers[questionKey(index, dimension)]);
      if (!value || !Object.hasOwn(config.choices, value)) errors.push(`${dimension}:${value ?? "missing"}`);
      else labels[dimension] = value;
    }
    return errors.length ? { index, status: "classification-error", errors } : { index, status: "classified", labels };
  });
}

export async function classifyBatch(options: {
  client: SystemOneLikeClient;
  request: { model: string; state: unknown; questions: Record<string, unknown> };
  profile: ClassificationProfile;
}): Promise<ClassificationResult[]> {
  const candidateCount = (options.request.state as { candidates?: unknown[] }).candidates?.length ?? 0;
  const response = await options.client.systemOne(options.request);
  return parseBatchClassificationResponse(response, options.profile, candidateCount);
}

export function applyProfileOverrides(candidates: unknown[], classifications: ClassificationResult[], profile: ClassificationProfile): ClassificationResult[] {
  const overrides = Array.isArray(profile.overrides) ? profile.overrides : [];
  return classifications.map((classification, index) => {
    if (classification.status !== "classified") return classification;
    const matched = overrides.filter((override) => {
      const value = readPath(candidates[index], override.when?.field);
      if (override.when?.matches === undefined) return Boolean(value);
      try { return new RegExp(String(override.when.matches), "i").test(String(value ?? "")); } catch { return false; }
    });
    if (!matched.length) return classification;
    return {
      ...classification,
      labels: matched.reduce<Record<string, string>>((labels, override) => ({ ...labels, ...(override.set?.labels ?? {}) }), { ...(classification.labels ?? {}) }),
    };
  });
}
