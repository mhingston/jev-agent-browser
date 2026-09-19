import { createServer } from "node:http";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { runAgentBrowser } from "../src/agentBrowser.js";
import { runGoal } from "../src/runner.js";
import type { SystemOneLikeClient } from "../src/types.js";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error("TYPESAFE_API_KEY is unset; export it before running the live E2E test.");
  process.exit(2);
}

const html = `<!doctype html>
<html><head><title>Jev Live E2E</title></head>
<body>
  <main>
    <h1>Jev Live E2E</h1>
    <button id="open">Open details</button>
    <p id="status">Details are closed.</p>
  </main>
  <script>
    document.querySelector('#open').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'Details opened.';
    });
  </script>
</body></html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not start live E2E fixture server");
const url = `http://127.0.0.1:${address.port}/`;
const session = `jev-live-e2e-${process.pid}`;
const client = new TypeSafeClient({ defaultModel: process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0" }) as unknown as SystemOneLikeClient;

try {
  const opened = await runAgentBrowser(["open", url], { session });
  if (opened.code !== 0) throw new Error(opened.stderr || "agent-browser could not open the live fixture");
  const result = await runGoal({
    goal: "Open the details by clicking the button",
    session,
    client,
    maxSteps: 3,
    verifyCompletion: (snapshot) => snapshot.pageText.includes("Details opened"),
  });
  if (result.status !== "completed" || result.steps.length !== 1) {
    throw new Error(`Live E2E did not complete in one action: ${JSON.stringify({ status: result.status, reason: result.reason, steps: result.steps.length })}`);
  }
  console.log(JSON.stringify({ status: result.status, steps: result.steps.length, pageChanged: result.steps[0]?.pageChanged }, null, 2));
} finally {
  await runAgentBrowser(["close"], { session }).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
