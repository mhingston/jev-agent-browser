import { createServer } from "node:http";
import { runAgentBrowser } from "../src/agentBrowser.js";
import { runGoal } from "../src/runner.js";
import type { SystemOneLikeClient } from "@mhingston5/jev-cli";

const html = `<!doctype html>
<html><head><title>Jev E2E Fixture</title></head>
<body>
  <main>
    <h1>Jev E2E Fixture</h1>
    <button id="open">Open details</button>
    <p id="status">Details are closed.</p>
    <label>Country
      <select id="country">
        <option value="gb">United Kingdom</option>
        <option value="us">United States</option>
      </select>
    </label>
    <p id="country-status">Country not selected.</p>
    <label>Search phrase <input id="phrase" aria-label="Search phrase"></label>
    <p id="phrase-status">Phrase empty.</p>
  </main>
  <script>
    document.querySelector('#open').addEventListener('click', () => {
      document.querySelector('#status').textContent = 'Details opened.';
    });
    document.querySelector('#country').addEventListener('change', (event) => {
      document.querySelector('#country-status').textContent = 'Country selected: ' + event.target.selectedOptions[0].textContent;
    });
    document.querySelector('#phrase').addEventListener('input', () => {
      document.querySelector('#phrase-status').textContent = 'Phrase entered.';
    });
  </script>
</body></html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not start E2E fixture server");
const url = `http://127.0.0.1:${address.port}/`;
const session = `jev-e2e-${process.pid}`;

const client: SystemOneLikeClient = {
  async systemOne(request) {
    const state = request.state as {
      goal: string;
      page: { text: string };
      candidates: Array<{ id: string; kind: string; label: string }>;
    };
    const operations = [...new Set(state.candidates.map((candidate) => candidate.kind))];
    const countryGoal = state.goal.toLowerCase().includes("country");
    const phraseGoal = state.goal.toLowerCase().includes("phrase");
    const done = phraseGoal
      ? state.page.text.includes("Phrase entered")
      : countryGoal
      ? state.page.text.includes("Country selected: United States")
      : state.page.text.includes("Details opened");
    const selectedOperation = done ? "stop" : phraseGoal ? "fill" : countryGoal ? "select" : "click";
    const operationProbabilities = Object.fromEntries(operations.map((operation) => [operation, operation === selectedOperation ? 0.9 : 0.1 / Math.max(1, operations.length - 1)]));
    const answers: Record<string, unknown> = {
      operation: { choice: selectedOperation, confidence: 0.95, probabilities: operationProbabilities },
      goal_completed: { noul: done ? 0.95 : 0.01 },
    };
    if (!done) {
      const targetCandidates = state.candidates.filter((candidate) => candidate.kind === selectedOperation);
      const target = targetCandidates.find((candidate) => countryGoal
        ? candidate.label.includes("United States")
        : phraseGoal
        ? candidate.label.includes("Search phrase")
        : candidate.label.includes("Open details"));
      if (!target) throw new Error("E2E fixture did not expose the expected button");
      answers[`${selectedOperation}_target`] = {
        choice: target.id,
        confidence: 0.95,
        probabilities: Object.fromEntries(targetCandidates.map((candidate) => [candidate.id, candidate.id === target.id ? (targetCandidates.length === 1 ? 1 : 0.9) : 0.1 / (targetCandidates.length - 1)])),
      };
    }
    return { model: "fixture-jev", answers, usage: { input_tokens: 1, output_tokens: 1 } };
  },
};

try {
  const opened = await runAgentBrowser(["open", url], { session });
  if (opened.code !== 0) throw new Error(opened.stderr || "agent-browser could not open the fixture");
  const detailsResult = await runGoal({
    goal: "Open the details",
    session,
    client,
    maxSteps: 4,
    verifyCompletion: (snapshot) => snapshot.pageText.includes("Details opened"),
  });
  const countryResult = await runGoal({
    goal: "Choose the United States country",
    session,
    client,
    maxSteps: 4,
    verifyCompletion: (snapshot) => snapshot.pageText.includes("Country selected: United States"),
  });
  const phraseResult = await runGoal({
    goal: "Enter a search phrase",
    session,
    client,
    policy: { allowGeneratedText: true },
    textProvider: async () => "browser agents are fast",
    maxSteps: 4,
    verifyCompletion: (snapshot) => snapshot.pageText.includes("Phrase entered"),
  });
  if (detailsResult.status !== "completed" || detailsResult.steps.length !== 1 || countryResult.status !== "completed" || countryResult.steps.length !== 1 || phraseResult.status !== "completed" || phraseResult.steps.length !== 1) {
    throw new Error(`Unexpected E2E result: ${JSON.stringify({ details: { status: detailsResult.status, steps: detailsResult.steps.length, reason: detailsResult.reason }, country: { status: countryResult.status, steps: countryResult.steps.length, reason: countryResult.reason }, phrase: { status: phraseResult.status, steps: phraseResult.steps.length, reason: phraseResult.reason } })}`);
  }
  console.log(JSON.stringify({ details: { status: detailsResult.status, steps: detailsResult.steps.length, pageChanged: detailsResult.steps[0]?.pageChanged }, country: { status: countryResult.status, steps: countryResult.steps.length, pageChanged: countryResult.steps[0]?.pageChanged }, phrase: { status: phraseResult.status, steps: phraseResult.steps.length, pageChanged: phraseResult.steps[0]?.pageChanged } }, null, 2));
} finally {
  await runAgentBrowser(["close"], { session }).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
