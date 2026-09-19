import { describe, expect, it } from "vitest";
import { FetchDecisionClient } from "../src/decision.js";

describe("decision transport seam", () => {
  it("supports a fetch-compatible endpoint without exposing the key in state", async () => {
    let request: RequestInit | undefined;
    const client = new FetchDecisionClient({
      apiKey: "test-secret",
      endpoint: "https://decisions.example.test/custom",
      fetchImpl: async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({ model: "fixture", answers: { ok: { noul: 0.9 } }, usage: { input_tokens: 1 } }), { status: 200 });
      },
    });
    const result = await client.systemOne({ model: "jev", state: { goal: "test" }, questions: { ok: {} } });
    expect(result.model).toBe("fixture");
    expect(result.answers.ok).toEqual({ noul: 0.9 });
    expect(String(request?.headers && new Headers(request.headers).get("authorization"))).toContain("test-secret");
    expect(String(request?.body)).toContain("test");
    expect(String(request?.body)).not.toContain("test-secret");
  });

  it("reports non-success responses", async () => {
    const client = new FetchDecisionClient({
      apiKey: "test-secret",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
    });
    await expect(client.systemOne({ model: "jev", state: {}, questions: {} })).rejects.toThrow(/Decision API 400/);
  });
});
