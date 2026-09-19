import { describe, expect, it } from "vitest";
import { applyProfileOverrides, buildBatchClassificationRequest, parseBatchClassificationResponse, validateProfile } from "../src/classification.js";

const profile = {
  goal: "Find relevant roles",
  dimensions: {
    relevance: { instructions: "Is this relevant?", choices: { yes: "Relevant", no: "Not relevant" } },
    seniority: { instructions: "What level?", choices: { senior: "Senior", other: "Other" } },
  },
};

describe("research classification profiles", () => {
  it("builds bounded typed questions and redacts contact evidence", () => {
    const request = buildBatchClassificationRequest({ profile, candidates: [{ title: "Role", text: "Email me at person@example.com" }] });
    expect(Object.keys(request.questions)).toEqual(["candidate_0_relevance", "candidate_0_seniority"]);
    expect(JSON.stringify(request.state)).not.toContain("person@example.com");
  });

  it("parses labels and applies explicit profile overrides", () => {
    const response = { answers: {
      candidate_0_relevance: { choice: "yes" },
      candidate_0_seniority: { choice: "other" },
    } };
    const parsed = parseBatchClassificationResponse(response, profile, 1);
    expect(parsed[0].labels).toEqual({ relevance: "yes", seniority: "other" });
    const overridden = applyProfileOverrides([{ title: "Role" }], parsed, { ...profile, overrides: [{ when: { field: "title", matches: "role" }, set: { labels: { seniority: "senior" } } }] });
    expect(overridden[0].labels?.seniority).toBe("senior");
    expect(() => validateProfile({ dimensions: {} })).not.toThrow();
  });
});
