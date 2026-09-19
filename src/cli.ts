#!/usr/bin/env node
import { captureSnapshot, checkAgentBrowser } from "./agentBrowser.js";
import { normalizeSnapshot } from "./normalize.js";
import { routeSnapshot } from "./router.js";
import { runGoal } from "./runner.js";

function usage(): never {
  console.error(`Usage:
  jev-agent-browser doctor
  jev-agent-browser route --goal <text> [--session <id>] [--input-values <json>] [--allow-risky] [--context-sieve] [--context-threshold <n>] [--max-context-blocks <n>]
  jev-agent-browser run --goal <text> [--session <id>] [--input-values <json>] [--allow-risky] [--max-steps <n>] [--expect-text <text>] [--context-sieve] [--context-threshold <n>] [--max-context-blocks <n>]

The route command is dry-run. The run command executes only a validated, non-review decision.`);
  process.exit(2);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "doctor") {
    console.log(JSON.stringify(await checkAgentBrowser({ force: true }), null, 2));
    return;
  }
  if (!command || !["route", "run"].includes(command)) usage();
  const goal = argValue(args, "--goal");
  if (!goal) usage();
  const session = argValue(args, "--session");
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
    const result = await runGoal({
      goal,
      session,
      inputValues,
      policy,
      maxSteps,
      verifyCompletion: expectedText
        ? (snapshot) => snapshot.pageText.includes(expectedText) || snapshot.title.includes(expectedText)
        : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const raw = await captureSnapshot({ session });
  const snapshot = normalizeSnapshot(raw, goal);
  const decision = await routeSnapshot(snapshot, inputValues, policy);

  console.log(JSON.stringify({ decision }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jev-agent-browser: ${message}`);
  process.exitCode = 1;
});
