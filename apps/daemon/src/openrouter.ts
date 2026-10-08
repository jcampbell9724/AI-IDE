import { z } from "zod";
import {
  ModelListResponseSchema,
  type ModelListResponse,
  type OpenRouterModel,
} from "@browser-agent/shared";
import { AppError, throwIfAborted } from "./errors.js";

const rawModelsSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        name: z.string().nullish(),
        description: z.string().nullish(),
        context_length: z.number().nullish(),
        pricing: z
          .object({
            prompt: z.union([z.string(), z.number()]).nullish(),
            completion: z.union([z.string(), z.number()]).nullish(),
          })
          .nullish(),
        supported_parameters: z.array(z.string()).nullish(),
        architecture: z
          .object({
            input_modalities: z.array(z.string()).nullish(),
            output_modalities: z.array(z.string()).nullish(),
            modality: z.string().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough(),
  ),
});

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(),
    reasoning: z.string().nullish(),
    reasoning_content: z.string().nullish(),
    reasoning_details: z.array(z.unknown()).optional(),
  })
  .passthrough();

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        error: z
          .object({
            code: z.union([z.string(), z.number()]).optional(),
            message: z.string().optional(),
            metadata: z.unknown().optional(),
          })
          .passthrough()
          .nullish(),
        message: assistantMessageSchema,
      }),
    )
    .min(1),
  model: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export type OpenRouterToolCall = z.infer<typeof toolCallSchema>;
export type OpenRouterAssistantMessage = z.infer<
  typeof completionSchema
>["choices"][number]["message"];

interface SseParserState {
  buffer: string;
  dataLines: string[];
}

function drainSsePayloads(state: SseParserState, flush = false): string[] {
  const payloads: string[] = [];
  const consumeLine = (line: string): void => {
    if (!line) {
      if (state.dataLines.length) {
        payloads.push(state.dataLines.join("\n"));
        state.dataLines = [];
      }
      return;
    }
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    state.dataLines.push(value);
  };

  for (;;) {
    let lineEnd = -1;
    let separatorLength = 0;
    for (let index = 0; index < state.buffer.length; index += 1) {
      const character = state.buffer[index];
      if (character === "\n") {
        lineEnd = index;
        separatorLength = 1;
        break;
      }
      if (character === "\r") {
        if (index + 1 === state.buffer.length && !flush) return payloads;
        lineEnd = index;
        separatorLength = state.buffer[index + 1] === "\n" ? 2 : 1;
        break;
      }
    }

    if (lineEnd < 0) break;
    const line = state.buffer.slice(0, lineEnd);
    state.buffer = state.buffer.slice(lineEnd + separatorLength);
    consumeLine(line);
  }

  if (flush && state.buffer) {
    consumeLine(state.buffer);
    state.buffer = "";
  }
  if (flush && state.dataLines.length) {
    payloads.push(state.dataLines.join("\n"));
    state.dataLines = [];
  }
  return payloads;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface OpenRouterToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface OpenRouterClientOptions {
  readonly apiKey?: string;
  readonly provider?: "openrouter" | "openai" | "anthropic";
  readonly baseUrl: string;
  readonly referer?: string;
  readonly title: string;
  readonly fetchImpl?: typeof fetch;
  readonly modelCacheTtlMs?: number;
  readonly connectTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
}

export class OpenRouterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly modelCacheTtlMs: number;
  private readonly connectTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private apiKey: string | undefined;
  private provider: "openrouter" | "openai" | "anthropic";
  private baseUrl: string;
  private modelCache: { expiresAt: number; response: ModelListResponse } | undefined;
  private imageInputModels = new Set<string>();

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.modelCacheTtlMs = options.modelCacheTtlMs ?? 5 * 60_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 90_000;
    this.apiKey = this.normalizeApiKey(options.apiKey);
    this.provider = options.provider ?? "openrouter";
    this.baseUrl = options.baseUrl;
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = this.normalizeApiKey(apiKey);
    this.modelCache = undefined;
    this.imageInputModels.clear();
  }

  configureProvider(provider: "openrouter" | "openai" | "anthropic", apiKey: string | undefined): void {
    this.provider = provider;
    this.baseUrl = provider === "openai" ? "https://api.openai.com/v1"
      : provider === "anthropic" ? "https://api.anthropic.com/v1" : this.options.baseUrl;
    this.setApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }

  async listModels(refresh = false, signal?: AbortSignal): Promise<ModelListResponse> {
    if (!refresh && this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return { ...this.modelCache.response, cached: true };
    }
    if (this.provider !== "openrouter") return this.listDirectModels(signal);
    const modelsUrl = new URL(`${this.baseUrl}/models`);
    modelsUrl.searchParams.set("supported_parameters", "tools");
    const response = await this.fetchImpl(modelsUrl, {
      headers: this.headers(false),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await this.apiError(response, "MODEL_LIST_FAILED");
    const raw = rawModelsSchema.parse(await response.json());
    this.imageInputModels = new Set(raw.data.filter((model) => {
      const input = model.architecture?.input_modalities
        ?? model.architecture?.modality?.split("->")[0]?.split("+") ?? [];
      return input.includes("image");
    }).map((model) => model.id));
    const models: OpenRouterModel[] = raw.data.map((model) => {
      const supportedParameters = model.supported_parameters ?? [];
      const modalities = [
        ...(model.architecture?.input_modalities ?? []),
        ...(model.architecture?.output_modalities ?? []),
        ...(model.architecture?.modality ? [model.architecture.modality] : []),
      ];
      return {
        id: model.id,
        name: model.name ?? null,
        description: model.description ?? null,
        contextLength: model.context_length ?? null,
        pricing: {
          prompt: model.pricing?.prompt == null ? null : String(model.pricing.prompt),
          completion:
            model.pricing?.completion == null ? null : String(model.pricing.completion),
        },
        supportedParameters,
        supportsTools: supportedParameters.includes("tools"),
        modalities: [...new Set(modalities)],
      };
    });
    const normalized = ModelListResponseSchema.parse({
      models,
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
    this.modelCache = { expiresAt: Date.now() + this.modelCacheTtlMs, response: normalized };
    return normalized;
  }

  private async listDirectModels(signal?: AbortSignal): Promise<ModelListResponse> {
    if (!this.apiKey) throw new AppError("PROVIDER_KEY_MISSING", "Save a provider API key before loading models", 503);
    const models: OpenRouterModel[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`${this.baseUrl}/models`);
      if (this.provider === "anthropic") {
        url.searchParams.set("limit", "100");
        if (after) url.searchParams.set("after_id", after);
      }
      const response = await this.fetchCompletion(url.toString(), { headers: this.headers(false), redirect: "error" }, signal);
      if (!response.ok) throw await this.apiError(response, "MODEL_LIST_FAILED");
      const raw = z.object({
        data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
        has_more: z.boolean().optional(), last_id: z.string().optional(),
      }).parse(await response.json());
      for (const model of raw.data) {
        const supported = this.provider === "anthropic" ? model.id.startsWith("claude-")
          : /^(gpt-4o(?:-|$)|gpt-4\.1(?:-|$)|gpt-5(?:[.-]|$)|o[34](?:-|$))/.test(model.id)
            && !/(audio|realtime|transcribe|tts|image|search|deep-research|pro|codex)/.test(model.id);
        if (!supported) continue;
        models.push({ id: model.id, name: model.display_name ?? model.id, description: null,
          contextLength: null, pricing: { prompt: null, completion: null },
          supportedParameters: ["tools"], supportsTools: true, modalities: ["text", "image"] });
      }
      if (this.provider !== "anthropic" || !raw.has_more || !raw.last_id || after === raw.last_id) break;
      after = raw.last_id;
    }
    this.imageInputModels = new Set(models.map((model) => model.id));
    const result = ModelListResponseSchema.parse({ models, fetchedAt: new Date().toISOString(), cached: false });
    this.modelCache = { expiresAt: Date.now() + this.modelCacheTtlMs, response: result };
    return result;
  }

  async supportsImageInput(model: string, signal?: AbortSignal): Promise<boolean> {
    await this.listModels(false, signal);
    return this.imageInputModels.has(model);
  }

  async complete(input: {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: OpenRouterToolDefinition[];
    signal?: AbortSignal;
  }): Promise<{
    message: OpenRouterAssistantMessage;
    finishReason: string | null;
    model?: string;
    usage?: Record<string, unknown>;
  }> {
    const parsed = await this.completeOnce(input, false);
    return parsed;
  }

  async completeStream(input: {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: OpenRouterToolDefinition[];
    signal?: AbortSignal;
    onChunk: (chunk: {
      content?: string;
      reasoning?: string;
      usage?: Record<string, unknown>;
    }) => void;
  }): Promise<{
    message: OpenRouterAssistantMessage;
    finishReason: string | null;
    model?: string;
    usage?: Record<string, unknown>;
  }> {
    if (!this.apiKey) {
      throw new AppError(
        "OPENROUTER_KEY_MISSING",
        "Configure your OpenRouter API key in the app before starting an agent run",
        503,
      );
    }
    if (this.provider === "anthropic") {
      throw new AppError(
        "PROVIDER_NOT_IMPLEMENTED",
        "Direct Anthropic chat is not implemented in this prototype. Use OpenRouter for an Anthropic model, or select OpenAI.",
        503,
      );
    }
    const response = await this.fetchCompletion(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: this.headers(true),
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        ...(input.tools.length ? { tools: input.tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
        stream: true,
        ...(this.provider === "openai" ? { stream_options: { include_usage: true } } : {}),
      }),
    }, input.signal);
    if (!response.ok) throw await this.apiError(response, "MODEL_CALL_FAILED");

    let content = "";
    let reasoning = "";
    let reasoningContent = "";
    const reasoningDetails: unknown[] = [];
    let finishReason: string | null = null;
    let model: string | undefined;
    let usage: Record<string, unknown> | undefined;
    const toolCallsByIndex = new Map<
      number,
      { id?: string; type?: string; name?: string; arguments?: string }
    >();
    const emitSafely = (chunk: Parameters<typeof input.onChunk>[0]): void => {
      throwIfAborted(input.signal);
      try {
        input.onChunk(chunk);
      } catch {
        // A consumer callback must never break the stream driver.
      }
    };

    for await (const parsed of this.readSseEvents(response, input.signal)) {
      if (parsed.error && typeof parsed.error === "object") {
        const streamError = parsed.error as { code?: unknown; message?: unknown };
        const detail = typeof streamError.message === "string"
          ? streamError.message
          : "OpenRouter returned an in-band streaming error";
        throw new AppError("MODEL_COMPLETION_ERROR", detail.slice(0, 20_000), 502, {
          code: streamError.code,
        });
      }
      if (typeof parsed.model === "string") model = parsed.model;
      if (isRecord(parsed.usage)) {
        usage = parsed.usage;
        emitSafely({ usage: parsed.usage });
      }
      const choice = (parsed.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      if (choice.error && typeof choice.error === "object") {
        const streamError = choice.error as { code?: unknown; message?: unknown };
        const detail = typeof streamError.message === "string"
          ? streamError.message
          : "OpenRouter returned an in-band streaming error";
        throw new AppError("MODEL_COMPLETION_ERROR", detail.slice(0, 20_000), 502, {
          code: streamError.code,
        });
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        emitSafely({ content: delta.content });
      }
      const reasoningFragment = typeof delta.reasoning === "string" && delta.reasoning
        ? delta.reasoning
        : undefined;
      const reasoningContentFragment = typeof delta.reasoning_content === "string"
        && delta.reasoning_content
        ? delta.reasoning_content
        : undefined;
      if (reasoningFragment) reasoning += reasoningFragment;
      if (reasoningContentFragment) reasoningContent += reasoningContentFragment;
      const streamedReasoning = reasoningFragment ?? reasoningContentFragment;
      if (streamedReasoning) emitSafely({ reasoning: streamedReasoning });
      if (Array.isArray(delta.reasoning_details)) {
        reasoningDetails.push(...delta.reasoning_details);
      }
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        for (const call of calls as Array<Record<string, unknown>>) {
          const index = typeof call.index === "number" ? call.index : 0;
          const target = toolCallsByIndex.get(index) ?? {};
          if (typeof call.id === "string") {
            target.id = `${target.id ?? ""}${call.id}`;
          }
          if (typeof call.type === "string") target.type = call.type;
          const fn = (call.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === "string") {
            target.name = `${target.name ?? ""}${fn.name}`;
          }
          if (typeof fn.arguments === "string") {
            target.arguments = `${target.arguments ?? ""}${fn.arguments}`;
          }
          toolCallsByIndex.set(index, target);
        }
      }
    }

    throwIfAborted(input.signal);
    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: { name: call.name ?? "", arguments: call.arguments ?? "{}" },
      }));
    if (finishReason === "error") {
      throw new AppError(
        "MODEL_COMPLETION_ERROR",
        "Provider returned an in-band streaming error",
        502,
      );
    }
    return {
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      },
      finishReason,
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private async *readSseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const body = response.body;
    if (!body) {
      throw new AppError("MODEL_RESPONSE_INVALID", "Streaming response had no body", 502);
    }
    const reader = body.getReader();
    const onAbort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    const state: SseParserState = { buffer: "", dataLines: [] };
    const parsePayload = (payload: string): Record<string, unknown> | undefined => {
      if (!payload || payload.trim() === "[DONE]") return undefined;
      try {
        const parsed = JSON.parse(payload) as unknown;
        return parsed && typeof parsed === "object"
          ? parsed as Record<string, unknown>
          : undefined;
      } catch {
        // Some providers emit non-JSON data events; skip them.
        return undefined;
      }
    };
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await this.readStreamChunk(reader);
        throwIfAborted(signal);
        if (done) break;
        state.buffer += decoder.decode(value, { stream: true });
        for (const payload of drainSsePayloads(state)) {
          throwIfAborted(signal);
          const parsed = parsePayload(payload);
          if (parsed) yield parsed;
        }
      }
      state.buffer += decoder.decode();
      for (const payload of drainSsePayloads(state, true)) {
        throwIfAborted(signal);
        const parsed = parsePayload(payload);
        if (parsed) yield parsed;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async fetchCompletion(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutError = new AppError(
      "MODEL_CONNECT_TIMEOUT",
      "The model provider did not start a response in time. Try the request again.",
      504,
    );
    let timedOut = false;
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
    }, this.connectTimeoutMs);
    timeout.unref?.();

    try {
      throwIfAborted(requestSignal);
      return await this.fetchImpl(url, { ...init, signal: requestSignal });
    } catch (error) {
      if (timedOut) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    const timeoutError = new AppError(
      "MODEL_STREAM_TIMEOUT",
      "The model provider stopped sending data. Try the request again.",
      504,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);
        void reader.cancel(timeoutError).catch(() => undefined);
      }, this.streamIdleTimeoutMs);
      timeout.unref?.();
    });
    try {
      return await Promise.race([reader.read(), stalled]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async completeOnce(input: {
    model: string;
    messages: Array<Record<string, unknown>>;
    tools: OpenRouterToolDefinition[];
    signal?: AbortSignal;
  }, _stream: boolean): Promise<{
    message: OpenRouterAssistantMessage;
    finishReason: string | null;
    model?: string;
    usage?: Record<string, unknown>;
  }> {
    if (!this.apiKey) {
      throw new AppError(
        "OPENROUTER_KEY_MISSING",
        "Configure your OpenRouter API key in the app before starting an agent run",
        503,
      );
    }
    const response = await this.fetchCompletion(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        tools: input.tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: false,
      }),
    }, input.signal);
    if (!response.ok) throw await this.apiError(response, "MODEL_CALL_FAILED");
    const parsed = completionSchema.parse(await response.json());
    throwIfAborted(input.signal);
    const first = parsed.choices[0];
    if (!first) throw new AppError("MODEL_RESPONSE_INVALID", "Model response had no choices", 502);
    if (first.finish_reason === "error" || first.error) {
      const detail = first.error?.message?.slice(0, 20_000) ?? "OpenRouter returned an in-band completion error";
      throw new AppError("MODEL_COMPLETION_ERROR", detail, 502, {
        code: first.error?.code,
      });
    }
    return {
      message: first.message,
      finishReason: first.finish_reason ?? null,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
    };
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.apiKey
        ? { Authorization: `Bearer ${this.apiKey}` }
        : {}),
      ...(this.provider === "openrouter" ? {
        ...(this.options.referer ? { "HTTP-Referer": this.options.referer } : {}),
        "X-OpenRouter-Title": this.options.title,
      } : {}),
    };
  }

  private async apiError(response: Response, code: string): Promise<AppError> {
    const body = (await response.text()).slice(0, 20_000);
    return new AppError(
      code,
      `OpenRouter returned HTTP ${response.status}${body ? `: ${body}` : ""}`,
      502,
    );
  }

  private normalizeApiKey(apiKey: string | undefined): string | undefined {
    const trimmed = apiKey?.trim();
    return trimmed ? trimmed : undefined;
  }
}
