import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { SystemOneLikeClient } from "./types.js";

export const DECISION_PROVIDERS = ["typesafe", "vercel", "cloudflare", "custom"] as const;
export type DecisionProvider = typeof DECISION_PROVIDERS[number];

/** @deprecated Prefer provider. Kept for CLI/library compatibility. */
export type DecisionTransport = "typesafe" | "fetch";

export interface DecisionClientOptions {
  provider?: DecisionProvider;
  /** @deprecated Prefer provider. */
  transport?: DecisionTransport;
  apiKey?: string;
  accountId?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const VERCEL_ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

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
    model: typeof value.model === "string" ? value.model : "jev",
    answers: value.answers,
    usage: value.usage,
  };
}

function errorMessage(body: any): string {
  return body?.error?.message
    ?? body?.errors?.[0]?.message
    ?? body?.message
    ?? "request failed";
}

export function resolveDecisionProvider(options: DecisionClientOptions = {}): DecisionProvider {
  if (options.provider) return options.provider;
  if (options.transport === "fetch") return "custom";
  if (options.transport === "typesafe") return "typesafe";
  const env = process.env.JEV_PROVIDER?.trim().toLowerCase();
  if (env && DECISION_PROVIDERS.includes(env as DecisionProvider)) return env as DecisionProvider;
  return "typesafe";
}

export function defaultModelForProvider(provider: DecisionProvider): string {
  const override = process.env.JEV_MODEL?.trim();
  if (override) return override;
  switch (provider) {
    case "typesafe":
      return process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0";
    case "vercel":
      return "typesafe-ai/jev";
    case "cloudflare":
      return "typesafe/jev";
    case "custom":
      return process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-1.13.0";
  }
}

function defaultApiKey(provider: DecisionProvider): string | undefined {
  switch (provider) {
    case "typesafe":
      return process.env.TYPESAFE_API_KEY;
    case "vercel":
      return process.env.AI_GATEWAY_API_KEY;
    case "cloudflare":
      return process.env.CLOUDFLARE_API_TOKEN;
    case "custom":
      return process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  }
}

function defaultEndpoint(provider: DecisionProvider, accountId?: string): string {
  const override = process.env.JEV_ENDPOINT?.trim();
  if (override) return override;
  switch (provider) {
    case "typesafe":
      return process.env.TYPESAFE_BASE_URL?.trim() || DEFAULT_ENDPOINT;
    case "vercel":
      return VERCEL_ENDPOINT;
    case "cloudflare": {
      const id = accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
      if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID is required for the cloudflare provider unless --endpoint is supplied");
      return `https://api.cloudflare.com/client/v4/accounts/${id}/ai/run`;
    }
    case "custom":
      return DEFAULT_ENDPOINT;
  }
}

class TypeSafeCompatibleDecisionClient implements SystemOneLikeClient {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(provider: "typesafe" | "vercel", options: DecisionClientOptions = {}) {
    const apiKey = options.apiKey ?? defaultApiKey(provider);
    if (!apiKey) {
      throw new Error(provider === "vercel"
        ? "AI_GATEWAY_API_KEY is required for the vercel provider"
        : "TYPESAFE_API_KEY is required for the typesafe provider");
    }
    const endpoint = options.endpoint ?? defaultEndpoint(provider, options.accountId);
    this.model = options.model ?? defaultModelForProvider(provider);
    this.client = new TypeSafeClient({
      apiKey,
      baseURL: endpointRoot(endpoint),
      defaultModel: this.model,
      timeout: options.timeoutMs,
      defaultHeaders: options.headers,
      ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  }

  async systemOne(request: Parameters<SystemOneLikeClient["systemOne"]>[0]): Promise<Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>> {
    return this.client.systemOne({ ...request, model: this.model }) as unknown as Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>;
  }
}

export class FetchDecisionClient implements SystemOneLikeClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DecisionClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.apiKey = options.apiKey ?? defaultApiKey("custom");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(request: Parameters<SystemOneLikeClient["systemOne"]>[0]): Promise<Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          ...this.headers,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...request, ...(this.model ? { model: this.model } : {}) }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`Decision API ${response.status}: ${errorMessage(body)}`);
      return responsePayload(body);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error(`Decision API timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CloudflareDecisionClient implements SystemOneLikeClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DecisionClientOptions = {}) {
    this.endpoint = options.endpoint ?? defaultEndpoint("cloudflare", options.accountId);
    const apiKey = options.apiKey ?? defaultApiKey("cloudflare");
    if (!apiKey) throw new Error("CLOUDFLARE_API_TOKEN is required for the cloudflare provider");
    this.apiKey = apiKey;
    this.model = options.model ?? defaultModelForProvider("cloudflare");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(request: Parameters<SystemOneLikeClient["systemOne"]>[0]): Promise<Awaited<ReturnType<SystemOneLikeClient["systemOne"]>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { ...this.headers, authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          input: {
            state: request.state,
            questions: request.questions,
          },
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`Decision API ${response.status}: ${errorMessage(body)}`);
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
  const provider = resolveDecisionProvider(options);
  if (provider === "cloudflare") return new CloudflareDecisionClient(options);
  if (provider === "custom") return new FetchDecisionClient({
    ...options,
    endpoint: options.endpoint ?? process.env.JEV_ENDPOINT ?? DEFAULT_ENDPOINT,
    model: options.model ?? process.env.JEV_MODEL,
  });
  return new TypeSafeCompatibleDecisionClient(provider, options);
}
