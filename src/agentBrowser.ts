import { spawn } from "node:child_process";
import type { RouteDecision } from "./types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function agentBrowserArgs(session: string | undefined, args: string[]): string[] {
  return session ? ["--session", session, ...args] : args;
}

export function runAgentBrowser(
  args: string[],
  options: { session?: string; binary?: string } = {},
): Promise<CommandResult> {
  const binary = options.binary ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
  const finalArgs = agentBrowserArgs(options.session, args);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, finalArgs, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function captureSnapshot(session?: string): Promise<unknown> {
  const result = await runAgentBrowser(["snapshot", "-i", "--json"], { session });
  if (result.code !== 0) throw new Error(`agent-browser snapshot failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("agent-browser snapshot did not return JSON");
  }
}

export function commandForDecision(decision: RouteDecision): string[] | null {
  switch (decision.kind) {
    case "click":
      return decision.ref ? ["click", decision.ref] : null;
    case "fill":
      return decision.ref && decision.value != null ? ["fill", decision.ref, decision.value] : null;
    case "press":
      return decision.key ? ["press", decision.key] : null;
    case "scroll":
      return ["scroll", decision.direction ?? "down", String(decision.pixels ?? 600)];
    case "wait":
      return ["wait", "--load", "networkidle"];
    case "stop":
    case "review":
      return null;
  }
}

export async function executeDecision(
  decision: RouteDecision,
  options: { session?: string; currentSnapshotHash: string; binary?: string },
): Promise<CommandResult | null> {
  if (decision.snapshotHash !== options.currentSnapshotHash) {
    throw new Error("Refusing to execute a decision from a stale snapshot");
  }
  const command = commandForDecision(decision);
  if (!command) return null;
  return runAgentBrowser(command, options);
}
