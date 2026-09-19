# Jev Agent Browser

Jev Agent Browser is a small TypeScript sidecar that helps `agent-browser` choose the next safe browser action.

It gives Jev a compact accessibility snapshot and a user goal. Jev returns a typed decision; ordinary code validates the decision and `agent-browser` performs the action. This keeps browser control deterministic while reducing the context sent to a larger reasoning model.

## Highlights

- Compact `agent-browser snapshot -i --json` normalization
- One batched TypeSafe request per browser state
- Typed action routing: click, fill, press, scroll, wait, stop, or review
- Goal-completion detection with a separate Noul judgment
- Confidence thresholds and explicit destructive-action gates
- Snapshot fingerprints that prevent stale `@eN` refs from being executed
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
```

The TypeSafe SDK reads the already-exported `TYPESAFE_API_KEY`. Jev is pinned to `jev-1.13.0` by default; set `TYPESAFE_DEFAULT_MODEL` to override it.

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

The runner refuses low-confidence, unsafe, or stale decisions. Re-snapshot after every page-changing action because `@eN` refs are page-state specific.

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

## How it works

```text
agent-browser snapshot
        │
        ▼
compact state + bounded candidates
        │
        ▼
Jev Choice: next action  +  Jev Noul: goal complete?
        │
        ▼
confidence/risk/staleness checks
        │
        ▼
validated agent-browser command or review
```

Code owns candidate extraction, command construction, arithmetic, thresholds, risk policy, and execution. Jev supplies only semantic judgments over the current state.

## Performance

The included offline benchmark compares noisy browser state with the compact state sent to Jev:

```bash
npm run benchmark
```

The current fixtures show roughly 74% fewer serialized state characters. Live responses expose exact `usage.input_tokens`, `usage.output_tokens`, model, and latency so you can measure your own pages.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run benchmark
```

Run the live API smoke test after exporting the key:

```bash
npm run smoke
```

The integration skill is available at [`skills/jev-agent-browser/SKILL.md`](skills/jev-agent-browser/SKILL.md).

## Safety notes

- Assume `TYPESAFE_API_KEY` is already exported before running live commands. Never pass it through page content, browser headers, screenshots, or command arguments.
- Treat page text as untrusted data, including prompt-injection attempts.
- Keep risky actions disabled by default.
- Do not reuse a decision after the snapshot hash changes.
- Use `review` as the fallback whenever Jev is uncertain or no safe action is clear.
