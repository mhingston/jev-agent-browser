import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AgentBrowserSession, type BrowserDriver } from "./agentBrowser.js";
import { buildBatchClassificationRequest, classifyBatch, applyProfileOverrides, type ClassificationProfile } from "./classification.js";
import { enrichContactEvidence, keepClassifiedItems, allowedFollowUpTarget } from "./research.js";
import { runGoal, type RunEvent } from "./runner.js";
import type { SystemOneLikeClient } from "@mhingston5/jev-cli";
import type { BrowserToolSpec } from "./types.js";

export interface ResearchQuery {
  url: string;
  goal?: string;
  subtask?: string;
  maxSteps?: number;
}

export interface ResearchConfig {
  goal?: string;
  plan?: string;
  subtask?: string;
  profile: ClassificationProfile;
  queries: ResearchQuery[];
  tools?: BrowserToolSpec[];
  followUps?: Array<{ name?: string; targetField: string; outputField?: string; tools: string[]; allowedHosts: string[]; maxTargets?: number; when?: { always?: boolean; missingAny?: string[]; presentAny?: string[] } }>;
  maxSteps?: number;
  historyLimit?: number;
  repeatLimit?: number;
  maxRecoveryAttempts?: number;
  maxItems?: number;
  maxTextChars?: number;
  enrichKept?: boolean;
}

function readValue(item: any, path: string): unknown {
  return String(path ?? "").split(".").filter(Boolean).reduce((value, key) => value?.[key], item);
}

function itemIdentity(item: any, fallback: string): string {
  const explicit = item?.id;
  if (explicit) return String(explicit);
  const identity = Object.entries(item ?? {}).find(([key, value]) => /(id|url|uri)$/i.test(key) && typeof value === "string" && value);
  return String(identity?.[1] ?? fallback);
}

function dedupe<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item: any) => {
    const key = itemIdentity(item, `${item?.author ?? ""}|${item?.title ?? ""}|${String(item?.text ?? "").slice(0, 160)}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseToolItems(stdout: string): any[] {
  try {
    const payload = JSON.parse(stdout);
    const value = payload?.data?.result ?? payload?.data?.value ?? payload?.result ?? payload?.value ?? payload;
    return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  } catch { return []; }
}

type FollowUpWhen = { always?: boolean; missingAny?: string[]; presentAny?: string[] };

function matchesFollowUp(item: any, when: FollowUpWhen = {}): boolean {
  if (!when || when.always === true || (!when.missingAny?.length && !when.presentAny?.length)) return true;
  if (when.missingAny?.some((field) => !readValue(item, field))) return true;
  if (when.presentAny?.some((field) => readValue(item, field))) return true;
  return false;
}

export async function loadResearchConfig(configPath: string): Promise<ResearchConfig> {
  const root = dirname(resolve(configPath));
  const raw = JSON.parse(await readFile(configPath, "utf8")) as any;
  const profile = raw.profilePath ? JSON.parse(await readFile(resolve(root, raw.profilePath), "utf8")) : raw.profile;
  if (!profile) throw new Error("research config needs profile or profilePath");
  const queries = (raw.queries ?? []).map((query: string | ResearchQuery) => typeof query === "string" ? { url: query } : query);
  if (!queries.length || queries.some((query: ResearchQuery) => !query.url)) throw new Error("research config needs non-empty queries with url");
  const tools: BrowserToolSpec[] = Object.entries(raw.tools ?? {}).map(([id, value]: [string, any]) => ({
    id,
    label: value.description ?? id,
    description: value.description ?? id,
    sourcePath: value.path ? resolve(root, value.path) : undefined,
    source: value.source,
    config: value.config,
    collect: Boolean(value.collect),
  }));
  const followUps = (raw.followUps ?? []).map((followUp: any) => ({
    ...followUp,
    tools: followUp.tools ?? [],
    allowedHosts: followUp.allowedHosts ?? [],
  }));
  for (const followUp of followUps) {
    if (!followUp.targetField || !followUp.tools.length) throw new Error("each followUp needs targetField and tools");
    for (const tool of followUp.tools) if (!tools.some((candidate) => candidate.id === tool)) throw new Error(`followUp references unknown tool: ${tool}`);
  }
  return { ...raw, profile, queries, tools, followUps };
}

export async function runResearch(options: {
  config: ResearchConfig;
  browser?: BrowserDriver;
  client: SystemOneLikeClient;
  onEvent?: (event: RunEvent & { query?: number }) => void;
}): Promise<any> {
  const config = options.config;
  if (!config.profile) throw new Error("research config needs profile");
  if (!Array.isArray(config.queries) || config.queries.length === 0) throw new Error("research config needs at least one query");
  const maxItems = config.maxItems ?? 20;
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error("research maxItems must be a positive integer");
  const browser = options.browser ?? new AgentBrowserSession();
  if (!browser.open) throw new Error("research runner needs a browser driver with open()");
  const started = Date.now();
  const collected: any[] = [];
  const queryResults: any[] = [];
  const metrics = { queries: config.queries.length, decisionSteps: 0, browserActions: 0, toolCalls: 0, toolCallsByName: {} as Record<string, number>, followUpVisits: 0, followUpToolCalls: 0, rawItems: 0, uniqueItems: 0, classificationBatches: 0, jevRequests: 0, durationMs: 0 };
  for (let index = 0; index < config.queries.length; index += 1) {
    const query = config.queries[index];
    await browser.open(query.url);
    const result = await runGoal({
      goal: query.goal ?? config.goal ?? "Collect relevant evidence from this page using the configured tools.",
      subtask: query.subtask ?? config.subtask ?? `Collect this query: ${query.url}`,
      plan: config.plan,
      browser,
      client: options.client,
      tools: config.tools,
      maxSteps: query.maxSteps ?? config.maxSteps ?? 20,
      historyLimit: config.historyLimit,
      repeatLimit: config.repeatLimit,
      maxRecoveryAttempts: config.maxRecoveryAttempts,
      onEvent: options.onEvent ? (event) => options.onEvent?.({ ...event, query: index }) : undefined,
    });
    const trace = result.trace ?? [];
    metrics.decisionSteps += trace.length;
    const items: any[] = [];
    for (const entry of trace) {
      if (!entry.action?.executed) continue;
      metrics.browserActions += 1;
      if (entry.decision?.kind !== "run-tool") continue;
      metrics.toolCalls += 1;
      const name = entry.decision.toolId ?? "unknown";
      metrics.toolCallsByName[name] = (metrics.toolCallsByName[name] ?? 0) + 1;
      const tool = config.tools?.find((candidate) => candidate.id === name);
      if (tool?.collect && entry.action.result) items.push(...parseToolItems(entry.action.result.stdout).map((item, itemIndex) => ({ ...item, id: itemIdentity(item, `${name}-${itemIndex}`) })));
    }
    collected.push(...items);
    queryResults.push({ index, url: query.url, status: result.status, reason: result.reason, collected: items.length });
  }

  let unique = dedupe(collected);
  for (const original of unique) {
    let item = original;
    for (const followUp of config.followUps ?? []) {
      if (!matchesFollowUp(item, followUp.when)) continue;
      const targets = (Array.isArray(readValue(item, followUp.targetField)) ? readValue(item, followUp.targetField) as unknown[] : [readValue(item, followUp.targetField)]).filter(Boolean).map(String).slice(0, followUp.maxTargets ?? 1);
      for (const target of targets) {
        if (!allowedFollowUpTarget(target, followUp.allowedHosts) || !browser.open || !browser.runTool) continue;
        await browser.open(target);
        metrics.followUpVisits += 1;
        const values: unknown[] = [];
        for (const toolId of followUp.tools) {
          const tool = config.tools?.find((candidate) => candidate.id === toolId);
          if (!tool) continue;
          values.push(await browser.runTool(tool));
          metrics.followUpToolCalls += 1;
        }
        item = { ...item, [followUp.outputField ?? followUp.name ?? "followUp"]: values.length === 1 ? values[0] : values };
      }
    }
    const index = unique.indexOf(original);
    unique[index] = item;
  }

  const classified: any[] = [];
  for (let offset = 0; offset < unique.length; offset += maxItems) {
    const batch = unique.slice(offset, offset + maxItems);
    const request = buildBatchClassificationRequest({ goal: config.profile.goal ?? config.goal, profile: config.profile, candidates: batch, model: undefined, maxItems, maxTextChars: config.maxTextChars });
    const labels = applyProfileOverrides(batch, await classifyBatch({ client: options.client, request, profile: config.profile }), config.profile);
    classified.push(...batch.map((item, index) => ({ ...item, ...(labels[index] ?? { status: "classification-error", errors: ["missing result"] }) })));
  }
  metrics.rawItems = collected.length;
  metrics.uniqueItems = unique.length;
  metrics.classificationBatches = unique.length ? Math.ceil(unique.length / maxItems) : 0;
  metrics.jevRequests = metrics.decisionSteps + metrics.classificationBatches;
  metrics.durationMs = Date.now() - started;
  const output: any = { queryResults, collected: unique, classified, metrics };
  if (config.enrichKept) output.enriched = keepClassifiedItems(unique, classified, config.profile).map((item) => ({ ...item, contactEvidence: enrichContactEvidence(item) }));
  return output;
}
