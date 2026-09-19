#!/usr/bin/env node
import { AgentBrowserSession, checkAgentBrowser } from "./agentBrowser.js";
import { createDecisionClient, type DecisionTransport } from "./decision.js";
import { normalizeSnapshot } from "./normalize.js";
import { loadResearchConfig, runResearch } from "./researchRunner.js";
import { routeSnapshot } from "./router.js";
import { runGoal } from "./runner.js";

function usage(): never {
  console.error(`Usage:
  jev [--url <url>] --goal <text> [run options]   # shorthand for jev run
  jev-agent-browser doctor [--browser-command <path>]
  jev-agent-browser route --goal <text> [--url <url>] [--session <id>] [--browser-command <path>] [--input-values <json>] [--allow-risky] [--context-sieve] [--context-threshold <n>] [--max-context-blocks <n>] [--cdp <port|url>] [--auto-connect|--attach] [--pin-tab] [--browser-arg <arg>] [--transport <typesafe|fetch>] [--endpoint <url>] [--jsonl]
  jev-agent-browser run --goal <text> [--url <url>] [--plan <text>] [--subtask <text>] [--session <id>] [--browser-command <path>] [--input-values <json>] [--allow-risky] [--max-steps <n>] [--max-recovery-attempts <n>] [--history-limit <n>] [--repeat-limit <n>] [--expect-text <text>] [--context-sieve] [--context-threshold <n>] [--max-context-blocks <n>] [--cdp <port|url>] [--auto-connect|--attach] [--pin-tab] [--browser-arg <arg>] [--transport <typesafe|fetch>] [--endpoint <url>] [--jsonl]
  jev-agent-browser research --config <path> [--session <id>] [--browser-command <path>] [--cdp <port|url>] [--auto-connect|--attach] [--pin-tab] [--browser-arg <arg>] [--transport <typesafe|fetch>] [--endpoint <url>] [--jsonl] [--summary]

The route command is dry-run. The run command executes only a validated, non-review decision.`);
  process.exit(2);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function argValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] != null) values.push(args[index + 1]);
  }
  return values;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let [command, ...args] = argv;
  if (command === "--help" || command === "-h") usage();
  if (command?.startsWith("-")) {
    args = argv;
    command = argValue(args, "--mode") === "research" ? "research" : "run";
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await checkAgentBrowser({ force: true, binary: argValue(args, "--browser-command") }), null, 2));
    return;
  }
  if (!command || !["route", "run", "research"].includes(command)) usage();
  const goal = argValue(args, "--goal");
  const configPath = argValue(args, "--config");
  if (command === "research" && !configPath) usage();
  if (command !== "research" && !goal) usage();
  const plan = argValue(args, "--plan");
  const subtask = argValue(args, "--subtask");
  const url = argValue(args, "--url");
  const session = argValue(args, "--session");
  const binary = argValue(args, "--browser-command");
  const cdp = argValue(args, "--cdp");
  const autoConnect = args.includes("--auto-connect") || args.includes("--attach");
  const pinTab = args.includes("--pin-tab");
  const browserArgs = argValues(args, "--browser-arg");
  const transportText = argValue(args, "--transport") as DecisionTransport | undefined;
  if (transportText != null && transportText !== "typesafe" && transportText !== "fetch") throw new Error("--transport must be typesafe or fetch");
  const endpoint = argValue(args, "--endpoint");
  const jsonl = args.includes("--jsonl");
  const summary = args.includes("--summary");
  if (command === "research" && url) throw new Error("--url is only supported by route and run; research URLs belong in the config");
  const browser = new AgentBrowserSession({ session, binary, cdp, autoConnect, pinTab, browserArgs });
  const client = createDecisionClient({ transport: transportText, endpoint });
  if (command === "research") {
    const config = await loadResearchConfig(configPath!);
    const result = await runResearch({ config, browser, client, onEvent: jsonl ? (event) => console.log(JSON.stringify(event)) : undefined });
    if (jsonl) console.log(JSON.stringify({ type: "result", ...(summary ? { summary: { queryResults: result.queryResults, metrics: result.metrics } } : { result }) }));
    else console.log(JSON.stringify(summary ? { queryResults: result.queryResults, metrics: result.metrics } : result, null, 2));
    return;
  }
  if (url) {
    const opened = await browser.open(url);
    if (opened.code !== 0) throw new Error(`agent-browser could not open ${url}: ${opened.stderr.trim() || `exit ${opened.code}`}`);
  }
  const valuesText = argValue(args, "--input-values");
  let inputValues: Record<string, string> = {};
  if (valuesText) {
    try { inputValues = JSON.parse(valuesText) as Record<string, string>; }
    catch { throw new Error("--input-values must be valid JSON"); }
  }
  const allowRisky = args.includes("--allow-risky");
  const contextSieve = args.includes("--context-sieve");
  const contextThresholdText = argValue(args, "--context-threshold");
  const maxContextBlocksText = argValue(args, "--max-context-blocks");
  const contextSieveThreshold = contextThresholdText == null ? undefined : Number(contextThresholdText);
  const maxContextBlocks = maxContextBlocksText == null ? undefined : Number(maxContextBlocksText);
  if (contextThresholdText != null && !Number.isFinite(contextSieveThreshold)) throw new Error("--context-threshold must be a number");
  if (maxContextBlocksText != null && (!Number.isInteger(maxContextBlocks) || maxContextBlocks! < 1)) throw new Error("--max-context-blocks must be a positive integer");
  const policy = { allowRisky, enableContextSieve: contextSieve, ...(contextSieveThreshold == null ? {} : { contextSieveThreshold }), ...(maxContextBlocks == null ? {} : { maxContextBlocks }) };
  if (command === "run") {
    const maxStepsText = argValue(args, "--max-steps");
    const maxSteps = maxStepsText == null ? undefined : Number(maxStepsText);
    if (maxStepsText != null && (maxSteps == null || !Number.isInteger(maxSteps) || maxSteps < 1)) throw new Error("--max-steps must be a positive integer");
    const expectedText = argValue(args, "--expect-text");
    const historyLimitText = argValue(args, "--history-limit");
    const repeatLimitText = argValue(args, "--repeat-limit");
    const maxRecoveryAttemptsText = argValue(args, "--max-recovery-attempts");
    const historyLimit = historyLimitText == null ? undefined : Number(historyLimitText);
    const repeatLimit = repeatLimitText == null ? undefined : Number(repeatLimitText);
    const maxRecoveryAttempts = maxRecoveryAttemptsText == null ? undefined : Number(maxRecoveryAttemptsText);
    if (historyLimitText != null && (!Number.isInteger(historyLimit) || historyLimit! < 1)) throw new Error("--history-limit must be a positive integer");
    if (repeatLimitText != null && (!Number.isInteger(repeatLimit) || repeatLimit! < 1)) throw new Error("--repeat-limit must be a positive integer");
    if (maxRecoveryAttemptsText != null && (!Number.isInteger(maxRecoveryAttempts) || maxRecoveryAttempts! < 0)) throw new Error("--max-recovery-attempts must be a non-negative integer");
    const result = await runGoal({
      goal: goal!,
      plan,
      subtask,
      session,
      browser,
      client,
      inputValues,
      policy,
      maxSteps,
      historyLimit,
      repeatLimit,
      maxRecoveryAttempts,
      onEvent: jsonl ? (event) => console.log(JSON.stringify(event)) : undefined,
      verifyCompletion: expectedText
        ? (snapshot) => snapshot.pageText.includes(expectedText) || snapshot.title.includes(expectedText)
        : undefined,
    });
    console.log(JSON.stringify(jsonl ? { type: "result", result } : result, null, jsonl ? 0 : 2));
    return;
  }
  const raw = await browser.snapshot();
  const snapshot = normalizeSnapshot(raw, goal!);
  const decision = await routeSnapshot(snapshot, inputValues, policy, client);

  console.log(JSON.stringify(jsonl ? { type: "result", decision } : { decision }, null, jsonl ? 0 : 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jev-agent-browser: ${message}`);
  process.exitCode = 1;
});
