#!/usr/bin/env node
import { captureSnapshot, checkAgentBrowser, executeDecision } from "./agentBrowser.js";
import { normalizeSnapshot } from "./normalize.js";
import { routeSnapshot } from "./router.js";

function usage(): never {
  console.error(`Usage:
  jev-agent-browser doctor
  jev-agent-browser route --goal <text> [--session <id>] [--input-values <json>] [--allow-risky]
  jev-agent-browser run --goal <text> [--session <id>] [--input-values <json>] [--allow-risky]

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
  const raw = await captureSnapshot(session);
  const snapshot = normalizeSnapshot(raw, goal);
  const decision = await routeSnapshot(snapshot, inputValues, { allowRisky });

  if (command === "run" && !decision.fallback && decision.kind !== "stop") {
    const result = await executeDecision(decision, { session, currentSnapshotHash: snapshot.snapshotHash });
    console.log(JSON.stringify({ decision, execution: result }, null, 2));
    return;
  }
  console.log(JSON.stringify({ decision }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jev-agent-browser: ${message}`);
  process.exitCode = 1;
});
