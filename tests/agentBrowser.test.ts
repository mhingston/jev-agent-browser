import { describe, expect, it } from "vitest";
import { commandForDecision, runAgentBrowser } from "../src/agentBrowser.js";

describe("agent-browser adapter", () => {
  it("rejects browser args that could override wrapper-owned routing", async () => {
    await expect(runAgentBrowser(["--version"], { browserArgs: ["--session", "other"] })).rejects.toThrow(/cannot override/);
  });

  it("supports stdin for eval-style browser commands", async () => {
    const result = await runAgentBrowser(
      ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => process.stdout.write(chunk));"],
      { binary: process.execPath, stdin: "fixture-input" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("fixture-input");
  });

  it("does not turn allowlisted tools into shell commands", () => {
    expect(commandForDecision({ kind: "run-tool", snapshotHash: "hash" } as never)).toBeNull();
  });
});
