# Jev Agent Browser

Jev Agent Browser is a small TypeScript sidecar that helps [`agent-browser`](https://github.com/vercel-labs/agent-browser) choose the next safe browser action.

It gives Jev a compact accessibility snapshot and a user goal. Jev returns a typed decision; ordinary code validates the decision and `agent-browser` performs the action. This keeps browser control deterministic while reducing the context sent to a larger reasoning model.

It combines Vercel’s browser automation CLI with [TypeSafe AI’s Jev](https://typesafe.ai/), a typed-decision pattern built around fast Choice and Noul judgments.

## The shortest path

Use this project when you already have an `agent-browser` session and want a bounded, confidence-gated action loop:

1. Install the browser CLI and this project.
2. Export `TYPESAFE_API_KEY` through your environment or secret manager.
3. Run `route` to inspect a proposed action, or `run` to execute the bounded loop.

```bash
npm install -g agent-browser
agent-browser install
npm install
npm run build
npm run doctor

agent-browser --session demo open https://example.com
node dist/cli.js run \
  --goal "Open the example link" \
  --session demo \
  --expect-text "Example Domain"
```

For a Linux Secret Service entry, load the key without putting it in shell history or source files:

```bash
export TYPESAFE_API_KEY="$(secret-tool lookup service typesafe username "$USER")"
```

The command prints no key. Use your organization’s equivalent secret manager elsewhere.

## Highlights

- Compact accessibility normalization with full visible text for postconditions
- One batched TypeSafe request per browser state
- Dynamic operation + target routing: click, fill, select, check, uncheck, hover, focus, press, scroll, back, forward, reload, wait, stop, or review
- Goal-completion detection with a separate Noul judgment
- Strict probability-map validation, confidence thresholds, and explicit destructive-action gates
- Snapshot fingerprints that prevent stale `@eN` refs from being executed
- Bounded route–execute–reobserve loops with recent-action history and stuck detection
- Optional caller-supplied text provider for non-sensitive generated field values
- Optional Jev post-action verifier and structured browser-failure classification
- Optional Jev context sieve that keeps relevant page blocks and leaves recall stubs
- Closed-catalog Jev tool routing for selecting among registered skills/tools
- Offline confidence calibration helpers (Brier score, reliability bins, ECE)
- Short-lived route caching and usage/latency reporting
- No API key or generated form values are exposed to the browser

## Requirements

- Node.js 20 or newer
- `agent-browser` 0.31.x or newer on `PATH`
- A TypeSafe API key exported as `TYPESAFE_API_KEY`

## Install

```bash
npm install
npm run build
npm run doctor
```

The TypeSafe SDK reads the already-exported `TYPESAFE_API_KEY`. Jev is pinned to `jev-1.13.0` by default; set `TYPESAFE_DEFAULT_MODEL` to override it.

The package metadata is prepared for an npm release, but this repository remains `private` until a non-conflicting package name or npm scope is selected. Until then, use the checked-out CLI commands above.

`doctor` verifies that the `agent-browser` binary is executable and that its bundled core skill can be loaded. If it fails, install the browser tool with `npm i -g agent-browser && agent-browser install`.

## Quick start

Open a page with `agent-browser`, then ask Jev for a validated next action:

```bash
agent-browser --session demo open https://example.com

node dist/cli.js route \
  --goal "Open the example link" \
  --session demo
```

`route` is dry-run: it prints a JSON decision without executing it. Use `run` when the decision should be applied:

```bash
node dist/cli.js run \
  --goal "Open the example link" \
  --session demo
```

The runner re-snapshots after every action and refuses low-confidence, unsafe, malformed, or stale decisions. It stops after repeated unchanged non-wait actions or an exhausted step budget. `@eN` refs remain page-state specific.

For a deterministic completion check, add an expected visible string:

```bash
node dist/cli.js run \
  --goal "Open the example link" \
  --session demo \
  --expect-text "Example Domain"
```

The sidecar repeats the same prerequisite check automatically and caches the result briefly, so normal routing does not pay the check on every action.

### Command guide

| Command | Purpose | Calls the live Jev API? |
| --- | --- | --- |
| `npm run doctor` | Verify `agent-browser` and its bundled core skill | No |
| `node dist/cli.js route ...` | Dry-run one validated decision | Yes |
| `node dist/cli.js run ...` | Execute the bounded route–act–reobserve loop | Yes |
| `node dist/cli.js research --config <path>` | Run bounded multi-query collection, follow-ups, and typed classification | Yes |
| `npm run smoke` | Check the TypeSafe API and live router contract | Yes |
| `npm run e2e` | Deterministic browser fixture with a fake Jev client | No |
| `npm run e2e:live` | Real browser fixture with the live Jev API | Yes |

`route` is useful when another program owns execution. `run` is the recommended starting point when this package should own execution and completion checks.

For delegated execution, add `--plan` and `--subtask`. For existing Chrome sessions, use `--cdp`, `--auto-connect`, or `--pin-tab`. The CLI defaults to the TypeSafe SDK; compatible HTTP decision endpoints can be selected with `--transport fetch --endpoint <url>`.

### Library API

The same loop can be embedded in a Node agent. Injecting the browser and decision client keeps tests deterministic and supports CDP/auto-connect sessions:

```ts
import { AgentBrowserSession, createDecisionClient, runGoal } from "jev-agent-browser";

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

```ts
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

The browser fixture E2E check is available with `npm run e2e`.
With `TYPESAFE_API_KEY` exported, `npm run e2e:live` runs the same one-action fixture through the real Jev API.

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
