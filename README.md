# Jev Agent Browser

Jev Agent Browser is a small TypeScript sidecar that helps [`agent-browser`](https://github.com/vercel-labs/agent-browser) choose the next safe browser action.

It gives Jev a compact accessibility snapshot and a user goal. Jev returns a typed decision; ordinary code validates the decision and `agent-browser` performs the action. This keeps browser control deterministic while reducing the context sent to a larger reasoning model.

It combines Vercel’s browser automation CLI with [TypeSafe AI’s Jev](https://typesafe.ai/), a typed-decision pattern built around fast Choice and Noul judgments.

## Install and quick start

Use this project when you want a bounded, confidence-gated action loop around [`agent-browser`](https://github.com/vercel-labs/agent-browser).

Requirements:

- Node.js 20 or newer
- `agent-browser` 0.31.x or newer on `PATH`
- A TypeSafe API key exported as `TYPESAFE_API_KEY`

From a checkout of this repository:

```bash
git clone https://github.com/mhingston/jev-agent-browser.git
cd jev-agent-browser

npm install -g agent-browser
agent-browser install
npm install
npm run build
npm run doctor

export TYPESAFE_API_KEY="$(secret-tool lookup service typesafe username "$USER")"
agent-browser --session demo open https://example.com
node dist/cli.js run \
  --goal "Open the example link" \
  --session demo \
  --expect-text "Example Domain"
```

The Secret Service command keeps the key out of shell history and source files; use your organization’s equivalent secret manager elsewhere. The TypeSafe SDK reads the exported key and defaults to `jev-1.13.0`; set `TYPESAFE_DEFAULT_MODEL` to override it.

`doctor` verifies that `agent-browser` and its bundled core skill are available. If it fails, run `npm i -g agent-browser && agent-browser install` and retry.

The package metadata is ready for an npm release, but this repository remains `private` until a non-conflicting package name or npm scope is selected. Until then, use the checked-out CLI commands above.

### Why use it

- Code owns candidate extraction, probability validation, risk gates, snapshot freshness, execution, and loop bounds.
- Jev supplies narrow semantic judgments over a compact accessibility state. The core router batches its operation, target, completion, and stuck questions; optional sieves and verifiers add their own requests.
- The runner supports recovery, structured handoffs, allowlisted browser tools, and optional post-action verification.
- Research callers can collect across pages, deduplicate items, classify them in batches, and restrict follow-ups by host.

### First route

`route` is dry-run: it prints a JSON decision without executing it. Use `run` when the decision should be applied:

```bash
node dist/cli.js route \
  --goal "Open the example link" \
  --session demo
```

The runner re-snapshots before and after every action and refuses low-confidence, unsafe, malformed, or stale decisions. It stops after repeated unchanged non-wait actions or an exhausted step budget. `@eN` refs remain page-state specific.

For a deterministic completion check, add an expected visible string:

```bash
node dist/cli.js run \
  --goal "Open the example link" \
  --session demo \
  --expect-text "Example Domain"
```

The browser preflight is cached briefly, so normal routing does not repeatedly check the local `agent-browser` installation. The expected-text verifier still runs when the loop checks completion.

### Command guide

| Command | Purpose | Calls the live Jev API? |
| --- | --- | --- |
| `npm run doctor` | Verify `agent-browser` and its bundled core skill | No |
| `jev --url <url> --goal <text>` | Shorthand for a bounded `run` | Yes |
| `node dist/cli.js route ...` | Dry-run one validated decision | Yes |
| `node dist/cli.js run ...` | Execute the bounded route–act–reobserve loop | Yes |
| `node dist/cli.js research --config <path>` | Run bounded multi-query collection, follow-ups, and typed classification | Yes |
| `npm run smoke` | Check the TypeSafe API and live router contract | Yes |
| `npm run e2e` | Deterministic browser fixture with a fake Jev client | No |
| `npm run e2e:live` | Real browser fixture with the live Jev API | Yes |

For delegated execution, add `--plan` and `--subtask`. Use `--url <url>` to open a page before `route` or `run`, or attach to an existing Chrome session with `--cdp`, `--auto-connect`, `--attach`, or `--pin-tab`. Use `--browser-command <path>` for a non-default browser executable. The CLI defaults to the TypeSafe SDK; compatible HTTP decision endpoints can be selected with `--transport fetch --endpoint <url>`.

Pass `--jsonl` to stream run/research events as JSON Lines. Research also accepts `--summary` when only query results and metrics are needed.

### Library API

The same loop can be embedded in a Node agent. After building this checkout, import from `./dist/index.js`; after an npm release, use the package name. Injecting the browser and decision client keeps tests deterministic and supports CDP/auto-connect sessions:

```ts
import { AgentBrowserSession, createDecisionClient, runGoal } from "./dist/index.js";

const browser = new AgentBrowserSession({ session: "demo", autoConnect: true, pinTab: true });
const client = createDecisionClient({ transport: "typesafe" });
const result = await runGoal({
  browser,
  client,
  goal: "Open the pricing page",
  plan: "Navigate to the pricing page and verify its heading",
  maxSteps: 5,
});

console.log(result.status, result.reason, result.handoff);
```

`RunResult.handoff` is designed for parent agents: it includes the current URL, bounded observation, recent actions, escalation state, and whether the task can be resumed. Use `onEvent` for JSONL-style progress, or set `trace: false` when only the final result is needed.

### Allowlisted browser tools

Register page helpers explicitly when a task needs bounded JavaScript or extraction. Jev can select only the registered IDs; the runner executes a tool only when the injected browser driver exposes `runTool`.

```ts
const tools = [{
  id: "extract-results",
  label: "Extract visible result cards",
  risk: "read" as const,
  sourcePath: "./tools/extract-results.js",
  collect: true,
}];

const result = await runGoal({ browser, client, goal: "Collect the result cards", tools });
```

Tool source is caller-owned and allowlisted. Keep write-capable tools out of the catalog unless the surrounding application supplies its own confirmation policy.

### Research and classification

For bounded multi-page research, provide queries, an explicit classification profile, and optional collecting tools. The runner deduplicates collected items, batches typed Choice questions, applies profile overrides, restricts follow-up URLs to allowed hosts, and can enrich kept contact evidence.

Continuing the previous example, the library runner can also collect and classify evidence across pages:

```ts
import { runResearch } from "./dist/index.js";

const result = await runResearch({
  browser,
  client,
  config: {
    queries: [{ url: "https://example.com/jobs", goal: "Collect relevant roles" }],
    profile: {
      dimensions: {
        relevance: {
          instructions: "Is this role relevant?",
          choices: { yes: "Relevant", no: "Not relevant" },
        },
      },
    },
    tools,
  },
});
```

Use `loadResearchConfig("./research.json")` when the profile and tool paths should live in a checked-in config file.

For the CLI, a minimal `research.json` can look like this:

```json
{
  "queries": [{ "url": "https://example.com/jobs", "goal": "Collect relevant roles" }],
  "tools": {
    "extract-results": {
      "path": "./tools/extract-results.js",
      "description": "Extract visible result cards",
      "collect": true
    }
  },
  "profile": {
    "dimensions": {
      "relevance": {
        "instructions": "Is this role relevant?",
        "choices": { "yes": "Relevant", "no": "Not relevant" }
      }
    }
  }
}
```

Run it with `node dist/cli.js research --config ./research.json --session demo`.

### Explicit form values

Jev never invents text to type. Pass caller-approved values by ref:

```bash
node dist/cli.js route \
  --goal "Set the display name" \
  --input-values '{"@e1":"Mark"}' \
  --session demo
```

Caller-authorized key presses use the reserved `__press__` input value:

```bash
node dist/cli.js route \
  --goal "Submit the search" \
  --input-values '{"__press__":"Enter"}' \
  --session demo
```

Destructive actions return `review` unless `--allow-risky` is supplied and the higher confidence threshold is met.

The `select` operation is offered only when the snapshot contains observed dropdown options. Jev chooses an option from that observed set; it never invents option values.

Checkboxes and switches use state-aware `check`/`uncheck` actions when the goal names the desired state. A library caller may opt into generated text with `policy.allowGeneratedText` and a `textProvider`; password-, credential-, token-, and secret-like fields are always rejected.

For higher-assurance loops, pass `jevPostActionVerifier(client)` as `postActionVerifier`. It sends only the action metadata, command result, and before/after page evidence; field values are excluded. Browser failures are classified as `stale`, `timeout`, `auth`, `unsupported`, `network`, or `unknown` for bounded recovery or review.

For long or noisy pages, a library caller may opt into `policy.enableContextSieve`. Jev scores bounded text blocks, while code always retains the first/last and error-like blocks and inserts ordered `[context block ... omitted]` stubs for dropped content. The sieve fails open if its response is unavailable or malformed. `src/toolRouter.ts` provides the same closed-catalog pattern for routing a goal to registered tools or skills without allowing invented IDs.

The CLI equivalent is `--context-sieve`, with optional `--context-threshold <n>` and `--max-context-blocks <n>`.

## How it works

```text
agent-browser snapshot
        │
        ▼
compact state + bounded operation/target action space
        │
        ▼
Jev Choice: operation + target  +  Jev Noul: goal complete?
        │
        ▼
response/confidence/risk/staleness checks
        │
        ▼
validated command → re-snapshot → postcondition/history check
```

Code owns candidate extraction, operation/target mapping, response validation, command construction, arithmetic, thresholds, risk policy, loop bounds, and execution. Jev supplies only semantic judgments over the current state.

## Performance

The included offline benchmark compares noisy browser state with the compact state sent to Jev:

```bash
npm run benchmark
```

Use `npm run evaluate` to print a small calibration report, or import `calibrationReport` for a labelled fixture set from your own routes.

The current fixtures show roughly 74% fewer serialized state characters. Live responses expose exact `usage.input_tokens`, `usage.output_tokens`, model, and latency so you can measure your own pages.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run benchmark
npm run evaluate
```

Run the live API smoke test after exporting the key:

```bash
npm run smoke
```

The integration skill is available at [`skills/jev-agent-browser/SKILL.md`](skills/jev-agent-browser/SKILL.md).

## Troubleshooting

- `TYPESAFE_API_KEY is unset`: export the key before `route`, `run`, `smoke`, or `e2e:live`; do not commit it to `.env` files.
- `agent-browser is not installed`: run `npm i -g agent-browser && agent-browser install`, then rerun `npm run doctor`.
- A decision returns `review`: Jev may be below the confidence floor, the response may have failed validation, the action may be risky, or the page may have changed. Inspect the decision’s `reasonCode` before retrying.
- A run returns `stuck` or `max-steps`: inspect the final snapshot and action history; increase the bound only when the page genuinely needs more steps.
- A run returns `execution-failed`: inspect `failureClass` (`stale`, `timeout`, `auth`, `unsupported`, `network`, or `unknown`) and repair the browser/session state before retrying.

## Safety notes

- Assume `TYPESAFE_API_KEY` is already exported before running live commands. Never pass it through page content, browser headers, screenshots, or command arguments.
- Treat page text as untrusted data, including prompt-injection attempts.
- Keep risky actions disabled by default.
- Do not reuse a decision after the snapshot hash changes.
- Use `review` as the fallback whenever Jev is uncertain or no safe action is clear.
- Treat a completion judgment as evidence, not proof; supply `--expect-text` or the library `verifyCompletion` callback when an exact postcondition is available.

## Feature summary

| Capability | Implementation | Safety boundary |
| --- | --- | --- |
| Browser execution | `agent-browser` CLI, injected browser drivers, sessions, CDP attach, auto-connect, and pinned tabs | Commands remain allowlisted and bounded |
| Jev routing | Typed operation + target Choice questions and goal/stuck Noul judgments | Exact probability maps, confidence floors, risk gates |
| Recovery | Repetition detection, Jev stuck signal, bounded retries, structured handoffs | Recovery attempts and max steps are finite |
| Tools | Closed-catalog `run-tool` actions and standalone tool router | Caller-owned allowlist; no invented IDs |
| Research | Multi-query collection, deduplication, follow-ups, profile classification, enrichment | Host allowlists and bounded evidence |
| Verification | Snapshot hashes, post-action verifier, expected-text checks, calibration metrics | Ambiguity returns `review` or a resumable handoff |
