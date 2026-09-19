import { createHash } from "node:crypto";
import type { BrowserElement, NormalizedSnapshot } from "./types.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

const STRUCTURAL_ROLES = new Set([
  "alert",
  "article",
  "banner",
  "document",
  "group",
  "heading",
  "img",
  "main",
  "navigation",
  "paragraph",
  "region",
  "row",
  "section",
  "separator",
]);

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function clamp(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function looksLikeRef(value: unknown): value is string {
  return typeof value === "string" && /^@e\d+$/.test(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function collectNodeObjects(value: unknown, result: Record<string, unknown>[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodeObjects(item, result);
    return;
  }
  const record = value as Record<string, unknown>;
  // agent-browser 0.31.x returns interactive nodes in a `refs` map whose
  // keys are `e1`, `e2`, ... and whose values contain role/name metadata.
  if (record.refs && typeof record.refs === "object" && !Array.isArray(record.refs)) {
    for (const [key, node] of Object.entries(record.refs as Record<string, unknown>)) {
      if (node && typeof node === "object") {
        result.push({ ...(node as Record<string, unknown>), ref: key.startsWith("@") ? key : `@${key}` });
      }
    }
  }
  if (looksLikeRef(record.ref) || looksLikeRef(record.id)) result.push(record);
  for (const child of Object.values(record)) collectNodeObjects(child, result);
}

function parseTextSnapshot(raw: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const linePattern = /(@e\d+)\s+\[([^\]]+)\](?:\s+"([^"]*)")?/g;
  for (const match of raw.matchAll(linePattern)) {
    nodes.push({ ref: match[1], role: match[2], name: match[3] ?? "" });
  }
  return nodes;
}

function toElement(record: Record<string, unknown>): BrowserElement | null {
  const ref = looksLikeRef(record.ref) ? record.ref : looksLikeRef(record.id) ? record.id : "";
  if (!ref) return null;
  const role = firstString(record, ["role", "type", "tag"]).toLowerCase();
  const name = firstString(record, ["name", "accessibleName", "ariaLabel", "label", "text", "value"]);
  const interactive = Boolean(record.interactive) || INTERACTIVE_ROLES.has(role);
  if (!interactive || STRUCTURAL_ROLES.has(role)) return null;

  const element: BrowserElement = { ref, role: role || "unknown", name: clamp(name || ref, 160) };
  const value = firstString(record, ["value", "inputValue"]);
  const href = firstString(record, ["href", "url"]);
  if (value) element.value = clamp(value, 160);
  if (href) element.href = clamp(href, 500);
  if (typeof record.disabled === "boolean") element.disabled = record.disabled;
  if (typeof record.checked === "boolean") element.checked = record.checked;
  if (typeof record.selected === "boolean") element.selected = record.selected;
  return element;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot: Omit<NormalizedSnapshot, "snapshotHash">): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex").slice(0, 16);
}

export function normalizeSnapshot(
  raw: unknown,
  goal: string,
  options: { maxPageTextChars?: number; source?: "agent-browser" | "fixture" } = {},
): NormalizedSnapshot {
  const maxPageTextChars = options.maxPageTextChars ?? 2000;
  const outer = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const root = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
    ? (outer.data as Record<string, unknown>)
    : outer;
  const textRoot = typeof raw === "string" ? raw : "";
  const records: Record<string, unknown>[] = [];
  collectNodeObjects(raw, records);
  if (textRoot) records.push(...parseTextSnapshot(textRoot));

  const seen = new Set<string>();
  const elements: BrowserElement[] = [];
  for (const record of records) {
    const element = toElement(record);
    if (!element || seen.has(element.ref)) continue;
    seen.add(element.ref);
    elements.push(element);
  }

  const base = {
    goal: goal.trim(),
    url: firstString(root, ["url", "origin", "pageUrl", "href"]),
    title: firstString(root, ["title", "pageTitle"]),
    pageText: clamp(firstString(root, ["text", "content", "bodyText", "snapshot"]), maxPageTextChars),
    elements,
    source: options.source ?? "agent-browser",
  } satisfies Omit<NormalizedSnapshot, "snapshotHash">;

  return { ...base, snapshotHash: hashSnapshot(base) };
}
