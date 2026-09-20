import { describe, expect, it } from "vitest";
import { CloudflareDecisionClient, FetchDecisionClient, createDecisionClient } from "../src/decision.js";

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

  it("uses Vercel's TypeSafe-compatible endpoint and model", async () => {
    let url = "";
    let request: RequestInit | undefined;
    const client = createDecisionClient({
      provider: "vercel",
      apiKey: "vercel-secret",
      model: "typesafe-ai/jev",
      fetchImpl: async (input, init) => {
        url = String(input);
        request = init;
        return new Response(JSON.stringify({
          model: "jev-1.13.0",
          answers: { ok: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200 });
      },
    });

    const result = await client.systemOne({ model: "ignored", state: { goal: "test" }, questions: { ok: { type: "noul", instructions: "ok?" } } });
    expect(url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(JSON.parse(String(request?.body)).model).toBe("typesafe-ai/jev");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer vercel-secret");
    expect(result.answers.ok).toMatchObject({ noul: 0.9 });
  });

  it("wraps Cloudflare requests in the Workers AI model envelope", async () => {
    let request: RequestInit | undefined;
    const client = new CloudflareDecisionClient({
      apiKey: "cf-secret",
      endpoint: "https://api.cloudflare.test/accounts/test/ai/run",
      model: "typesafe/jev",
      fetchImpl: async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({
          result: {
            model: "jev-1.13.0",
            answers: { ok: { type: "noul", noul: 0.8 } },
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        }), { status: 200 });
      },
    });

    const result = await client.systemOne({ model: "ignored", state: { goal: "test" }, questions: { ok: { type: "noul" } } });
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({
      model: "typesafe/jev",
      input: {
        state: { goal: "test" },
        questions: { ok: { type: "noul" } },
      },
    });
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer cf-secret");
    expect(result.model).toBe("jev-1.13.0");
  });
});
