import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { SystemOneLikeClient } from "./types.js";

export type DecisionTransport = "typesafe" | "fetch";

export interface DecisionClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  transport?: DecisionTransport;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function endpointRoot(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname.replace(/\/v1\/systemone\/?$/, "")}`.replace(/\/$/, "");
}

function responsePayload(payload: any): { model: string; answers: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number } } {
  const body = payload?.data ?? payload;
  const value = body?.answers ? body : body?.result?.answers ? body.result : body?.output?.answers ? body.output : body;
  if (!value || typeof value !== "object" || !value.answers || typeof value.answers !== "object") {
    throw new Error("Decision API response did not contain answers");
  }
  return {
    model: typeof value.model === "string" ? value.model : "jev-1.13.0",
    answers: value.answers,
    usage: value.usage,
  };
}

export class FetchDecisionClient implements SystemOneLikeClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DecisionClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(request: Parameters<SystemOneLikeClient["systemOne"]>[0]): Promise<Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>> {
    if (!this.apiKey) throw new Error("Decision API key is required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { ...this.headers, authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`Decision API ${response.status}: ${body?.error?.message ?? "request failed"}`);
      return responsePayload(body);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Decision API timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDecisionClient(options: DecisionClientOptions = {}): SystemOneLikeClient {
  const transport = options.transport ?? "typesafe";
  if (transport === "fetch") return new FetchDecisionClient(options);
  const endpoint = options.endpoint ?? process.env.TYPESAFE_BASE_URL;
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: endpoint ? endpointRoot(endpoint) : undefined,
    defaultModel: options.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-1.13.0",
    timeout: options.timeoutMs,
    defaultHeaders: options.headers,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  return client as unknown as SystemOneLikeClient;
}

export { DEFAULT_ENDPOINT };
