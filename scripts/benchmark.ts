import { buildCandidates } from "../src/candidates.js";
import { normalizeSnapshot } from "../src/normalize.js";
import { resolvePolicy } from "../src/policy.js";

const fixtures = [
  {
    name: "settings-form",
    goal: "Change the display name and save it",
    snapshot: {
      origin: "https://example.test/settings",
      refs: {
        e1: { name: "Display name", role: "textbox" },
        e2: { name: "Save changes", role: "button" },
        e3: { name: "Delete account", role: "button" },
      },
      snapshot: "Account settings",
    },
    inputValues: { "@e1": "Mark" },
  },
  {
    name: "jev-skill-page",
    goal: "Open the Jev skill sources",
    snapshot: {
      origin: "https://github.com/dbreunig/building-with-jev-skill/blob/main/skills/jev/SKILL.md",
      refs: {
        e1: { name: "Raw", role: "link" },
        e2: { name: "https://docs.typesafe.ai/llms.txt", role: "link" },
        e3: { name: "Copy raw file", role: "button" },
      },
      snapshot: "Jev skill",
    },
  },
];

for (const fixture of fixtures) {
  const raw = fixture.snapshot as { refs: Record<string, { name: string; role: string }>; snapshot: string };
  for (let index = 0; index < 80; index += 1) {
    raw.refs[`noise${index}`] = { name: `Unrelated page text ${index}`, role: "generic" };
  }
  raw.snapshot = `${raw.snapshot}\n${Array.from({ length: 80 }, (_, index) => `- paragraph \"Unrelated content ${index} that should be filtered before inference\"`).join("\n")}`;
}

const policy = resolvePolicy();
const rows = fixtures.map((fixture) => {
  const normalized = normalizeSnapshot(fixture.snapshot, fixture.goal, { maxPageTextChars: policy.maxPageTextChars, source: "fixture" });
  const candidates = buildCandidates(normalized, fixture.inputValues ?? {}, policy);
  const baselineChars = JSON.stringify(fixture.snapshot).length + fixture.goal.length;
  const optimizedState = {
    goal: normalized.goal,
    page: { url: normalized.url, title: normalized.title, text: normalized.pageText },
    elements: normalized.elements.filter((element) => candidates.some((candidate) => candidate.ref === element.ref)),
    candidates: candidates.map(({ id, kind, ref, label, risk }) => ({ id, kind, ref, label, risk })),
  };
  const optimizedChars = JSON.stringify(optimizedState).length;
  return {
    fixture: fixture.name,
    baseline_chars: baselineChars,
    optimized_chars: optimizedChars,
    estimated_input_tokens: Math.ceil(optimizedChars / 4),
    reduction_percent: Math.round((1 - optimizedChars / baselineChars) * 100),
    candidates: candidates.length,
  };
});

console.table(rows);
const totalBaseline = rows.reduce((sum, row) => sum + row.baseline_chars, 0);
const totalOptimized = rows.reduce((sum, row) => sum + row.optimized_chars, 0);
console.log(JSON.stringify({
  total_baseline_chars: totalBaseline,
  total_optimized_chars: totalOptimized,
  reduction_percent: Math.round((1 - totalOptimized / totalBaseline) * 100),
  note: "Token estimates use four characters per token; live TypeSafe usage is reported by response.usage.",
}, null, 2));
