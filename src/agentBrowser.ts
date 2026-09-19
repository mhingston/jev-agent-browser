import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { BrowserFailureKind, BrowserToolSpec, RouteDecision } from "./types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentBrowserOptions {
  session?: string;
  binary?: string;
  timeoutMs?: number;
  cdp?: string | number;
  autoConnect?: boolean;
  pinTab?: boolean;
  browserArgs?: string[];
  stdin?: string;
}

export interface BrowserDriver {
  snapshot(): Promise<unknown>;
  execute(decision: RouteDecision, currentSnapshotHash: string): Promise<CommandResult | null>;
  run?(args: string[]): Promise<CommandResult>;
  open?(url: string): Promise<CommandResult>;
  close?(): Promise<CommandResult>;
  eval?(source: string): Promise<unknown>;
  runTool?(tool: BrowserToolSpec): Promise<CommandResult>;
}

export function classifyCommandFailure(result: Pick<CommandResult, "stdout" | "stderr"> | string): BrowserFailureKind {
  const text = typeof result === "string" ? result : `${result.stdout}\n${result.stderr}`;
  if (/stale|ref not found|element not found|target changed|covered/i.test(text)) return "stale";
  if (/timeout|timed out|networkidle/i.test(text)) return "timeout";
  if (/unauthori[sz]ed|forbidden|login|sign[ -]?in|credential|cookie/i.test(text)) return "auth";
  if (/unknown command|unsupported|not supported|cannot select|upload/i.test(text)) return "unsupported";
  if (/network|connection|econn|dns/i.test(text)) return "network";
  return "unknown";
}

export interface AgentBrowserPreflight {
  binary: string;
  version: string;
  coreSkill: "available";
}

let preflightCache: { binary: string; expiresAt: number; result: AgentBrowserPreflight } | undefined;
const PREFLIGHT_CACHE_MS = 30_000;

export function agentBrowserArgs(session: string | undefined, args: string[]): string[] {
  return session ? ["--session", session, ...args] : args;
}

export function runAgentBrowser(
  args: string[],
  options: AgentBrowserOptions = {},
): Promise<CommandResult> {
  const binary = options.binary ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
  if (options.browserArgs?.some((arg) => typeof arg !== "string")) {
    return Promise.reject(new Error("browserArgs must be an array of strings"));
  }
  const wrapperOwnedArgs = new Set(["--session", "--cdp", "--auto-connect", "--pin-tab"]);
  if (options.browserArgs?.some((arg) => wrapperOwnedArgs.has(arg.split("=", 1)[0]))) {
    return Promise.reject(new Error("browserArgs cannot override session or connection options"));
  }
  const connectionArgs = options.cdp != null
    ? ["--cdp", String(options.cdp)]
    : options.autoConnect ? ["--auto-connect"] : [];
  if (options.pinTab) connectionArgs.push("--pin-tab");
  const finalArgs = [
    ...(options.session && options.cdp == null && !options.autoConnect ? ["--session", options.session] : []),
    ...connectionArgs,
    ...(options.browserArgs ?? []),
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, finalArgs, { shell: false, stdio: [options.stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, result?: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { code: 1, stdout, stderr });
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(null, { code: code ?? 1, stdout, stderr }));
    if (options.stdin != null) child.stdin?.end(options.stdin);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`agent-browser timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function binaryFor(options: { binary?: string } = {}): string {
  return options.binary ?? process.env.AGENT_BROWSER_BIN ?? "agent-browser";
}

export async function checkAgentBrowser(
  options: { binary?: string; force?: boolean } = {},
): Promise<AgentBrowserPreflight> {
  const binary = binaryFor(options);
  const now = Date.now();
  if (!options.force && preflightCache?.binary === binary && preflightCache.expiresAt > now) {
    return preflightCache.result;
  }

  let versionResult: CommandResult;
  try {
    versionResult = await runAgentBrowser(["--version"], { binary });
  } catch {
    throw new Error("agent-browser is not installed or executable. Install it with `npm i -g agent-browser && agent-browser install`.");
  }
  if (versionResult.code !== 0) {
    throw new Error(`agent-browser could not run --version: ${versionResult.stderr.trim() || `exit ${versionResult.code}`}`);
  }

  let coreSkillResult: CommandResult;
  try {
    coreSkillResult = await runAgentBrowser(["skills", "get", "core"], { binary });
  } catch {
    throw new Error("agent-browser is present, but its bundled core skill could not be loaded. Reinstall or upgrade agent-browser.");
  }
  if (coreSkillResult.code !== 0) {
    throw new Error(`agent-browser core skill is unavailable: ${coreSkillResult.stderr.trim() || `exit ${coreSkillResult.code}`}`);
  }

  const result: AgentBrowserPreflight = {
    binary,
    version: versionResult.stdout.trim() || versionResult.stderr.trim(),
    coreSkill: "available",
  };
  preflightCache = { binary, expiresAt: now + PREFLIGHT_CACHE_MS, result };
  return result;
}

export function clearAgentBrowserPreflightCache(): void {
  preflightCache = undefined;
}

export function captureSnapshot(session?: string): Promise<unknown>;
export function captureSnapshot(options?: AgentBrowserOptions): Promise<unknown>;
export async function captureSnapshot(optionsOrSession: string | AgentBrowserOptions = {}): Promise<unknown> {
  const options = typeof optionsOrSession === "string" ? { session: optionsOrSession } : optionsOrSession;
  await checkAgentBrowser({ binary: options.binary });
  // Keep the full accessibility text for postconditions; normalizeSnapshot still
  // filters structural nodes before sending candidates to Jev.
  const result = await runAgentBrowser(["snapshot", "--json"], options);
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
    case "select":
      return decision.ref && decision.value != null ? ["select", decision.ref, decision.value] : null;
    case "check":
      return decision.ref ? ["check", decision.ref] : null;
    case "uncheck":
      return decision.ref ? ["uncheck", decision.ref] : null;
    case "hover":
      return decision.ref ? ["hover", decision.ref] : null;
    case "focus":
      return decision.ref ? ["focus", decision.ref] : null;
    case "press":
      return decision.key ? ["press", decision.key] : null;
    case "scroll":
      return ["scroll", decision.direction ?? "down", String(decision.pixels ?? 600)];
    case "back":
      return ["back"];
    case "forward":
      return ["forward"];
    case "reload":
      return ["reload"];
    case "run-tool":
      return null;
    case "wait":
      return ["wait", "--load", "networkidle"];
    case "stop":
    case "review":
      return null;
  }
}

export async function executeDecision(
  decision: RouteDecision,
  options: AgentBrowserOptions & { currentSnapshotHash: string },
): Promise<CommandResult | null> {
  if (decision.snapshotHash !== options.currentSnapshotHash) {
    throw new Error("Refusing to execute a decision from a stale snapshot");
  }
  await checkAgentBrowser({ binary: options.binary });
  const command = commandForDecision(decision);
  if (!command) return null;
  return runAgentBrowser(command, options);
}

/** Injectable browser seam for library callers, tests, CDP attach, and parent agents. */
export class AgentBrowserSession implements BrowserDriver {
  constructor(private readonly options: AgentBrowserOptions = {}) {}

  run(args: string[]): Promise<CommandResult> {
    return runAgentBrowser(args, this.options);
  }

  snapshot(): Promise<unknown> {
    return captureSnapshot(this.options);
  }

  execute(decision: RouteDecision, currentSnapshotHash: string): Promise<CommandResult | null> {
    return executeDecision(decision, { ...this.options, currentSnapshotHash });
  }

  open(url: string): Promise<CommandResult> {
    return this.run(["open", url]);
  }

  close(): Promise<CommandResult> {
    return this.run(["close"]);
  }

  async eval(source: string): Promise<unknown> {
    const result = await runAgentBrowser(["eval", "--json", "--stdin"], { ...this.options, stdin: source });
    if (result.code !== 0) throw new Error(`agent-browser eval failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      return (parsed.data as Record<string, unknown> | undefined)?.result ?? parsed.result ?? parsed;
    } catch {
      throw new Error(`agent-browser returned invalid eval JSON: ${result.stdout.slice(0, 500)}`);
    }
  }

  async runTool(tool: BrowserToolSpec): Promise<CommandResult> {
    const source = tool.sourcePath ? await readFile(tool.sourcePath, "utf8") : tool.source;
    if (!source) throw new Error(`allowlisted tool has no source: ${tool.id}`);
    const config = tool.config && typeof tool.config === "object"
      ? `globalThis.__JEV_TOOL_CONFIG__ = ${JSON.stringify(tool.config)};\n`
      : "";
    return runAgentBrowser(["eval", "--json", "--stdin"], { ...this.options, stdin: `${config}${source}` });
  }
}
