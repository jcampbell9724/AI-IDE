import { describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import { OpenRouterClient, type OpenRouterClientOptions } from "./openrouter.js";

function client(
  fetchImpl: typeof fetch,
  overrides: Partial<OpenRouterClientOptions> = {},
): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "test-key",
    baseUrl: "https://openrouter.test/api/v1",
    title: "test",
    fetchImpl,
    ...overrides,
  });
}

function byteChunkedSseResponse(source: string): Response {
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function multilineSseEvent(value: Record<string, unknown>, splitBefore: string): string {
  const payload = JSON.stringify(value);
  const splitAt = payload.indexOf(splitBefore);
  if (splitAt < 0) throw new Error(`Could not split payload before ${splitBefore}`);
  return `data: ${payload.slice(0, splitAt)}\r\ndata: ${payload.slice(splitAt)}\r\n\r\n`;
}

describe("OpenRouterClient", () => {
  it("rejects unsupported direct Anthropic chat before making a provider request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const direct = client(fetchImpl, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    await expect(direct.completeStream({
      model: "claude-test", messages: [], tools: [], onChunk: vi.fn(),
    })).rejects.toMatchObject({ code: "PROVIDER_NOT_IMPLEMENTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes a direct OpenAI streaming request to its configured endpoint and credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(byteChunkedSseResponse(
      sseEvent({ model: "gpt-4.1", choices: [{ delta: { content: "Connected" }, finish_reason: "stop" }] }) + "data: [DONE]\r\n\r\n",
    ));
    const direct = client(fetchImpl, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-direct-openai-key",
    });
    const onChunk = vi.fn();
    const result = await direct.completeStream({
      model: "gpt-4.1", messages: [{ role: "user", content: "Hello" }], tools: [], onChunk,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-direct-openai-key");
    expect(headers.has("X-OpenRouter-Title")).toBe(false);
    expect(headers.has("HTTP-Referer")).toBe(false);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "gpt-4.1", stream: true, messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.message.content).toBe("Connected");
    expect(onChunk).toHaveBeenCalledWith({ content: "Connected" });
  });
  it("distinguishes image input from image output capabilities", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "vision", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "generator", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    ] })));
    const models = client(fetchImpl);
    expect(await models.supportsImageInput("vision")).toBe(true);
    expect(await models.supportsImageInput("generator")).toBe(false);
    expect(await models.supportsImageInput("unknown")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["buffered", "waiting"] as const)("cancels a %s stream after the first chunk", async (mode) => {
    const controller = new AbortController();
    const cancelBody = vi.fn();
    const first = sseEvent({ choices: [{ delta: { content: "First" } }] });
    const second = sseEvent({ choices: [{ delta: { content: "Must not arrive" }, finish_reason: "stop" }] });
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(first + (mode === "buffered" ? second : ""))); },
      cancel: cancelBody,
    }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const onChunk = vi.fn(() => {
      if (mode === "buffered") controller.abort();
      else setTimeout(() => controller.abort(), 0);
    });
    await expect(client(fetchImpl).completeStream({
      model: "provider/model", messages: [], tools: [], signal: controller.signal, onChunk,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ content: "First" });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it("accepts a credential configured after startup", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Configured" },
      }],
    }), { status: 200 }));
    const dynamic = new OpenRouterClient({
      baseUrl: "https://openrouter.test/api/v1",
      title: "test",
      fetchImpl,
    });

    await expect(dynamic.complete({ model: "provider/model", messages: [], tools: [] }))
      .rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING" });

    dynamic.setApiKey("new-key");
    await dynamic.complete({ model: "provider/model", messages: [], tools: [] });

    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization"))
      .toBe("Bearer new-key");
  });

  it("discovers only tool-capable models and normalizes their metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: "provider/model",
        name: "Model",
        context_length: 128_000,
        pricing: { prompt: 0.1, completion: "0.2" },
        supported_parameters: ["tools", "structured_outputs"],
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      }],
    }), { status: 200 }));

    const result = await client(fetchImpl).listModels();

    const requestedUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("supported_parameters")).toBe("tools");
    expect(result.models[0]).toMatchObject({
      id: "provider/model",
      contextLength: 128_000,
      supportsTools: true,
      pricing: { prompt: "0.1", completion: "0.2" },
      modalities: ["text"],
    });
  });

  it("sends a serialized, non-streaming tool call request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      model: "provider/model",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "Done" },
      }],
    }), { status: 200 }));

    await client(fetchImpl).complete({
      model: "provider/model",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    });

    const request = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "provider/model",
      stream: false,
      parallel_tool_calls: false,
      tool_choice: "auto",
    });
  });

  it("streams byte-split content and preserves reasoning and fragmented tool calls", async () => {
    const reasoningDetail = {
      id: "reasoning-1",
      type: "reasoning.text",
      format: "openai-responses-v1",
      text: "A preserved reasoning detail",
    };
    const source = [
      ": heartbeat\r\n\r\n",
      sseEvent({
        model: "provider/initial-model",
        choices: [{ delta: { content: "Hel" }, finish_reason: null }],
      }),
      sseEvent({
        choices: [{
          delta: { content: "lo 🌍", reasoning_content: "Plan " },
          finish_reason: null,
        }],
      }),
      multilineSseEvent({
        choices: [{
          delta: {
            reasoning_details: [reasoningDetail],
            tool_calls: [{
              index: 0,
              id: "call_",
              type: "function",
              function: { name: "fs_", arguments: "{\"pa" },
            }],
          },
          finish_reason: null,
        }],
      }, "\"choices\""),
      sseEvent({
        choices: [{
          delta: {
            reasoning: "carefully.",
            tool_calls: [{
              index: 0,
              id: "123",
              function: { name: "read", arguments: "th\":\"a.txt\"}" },
            }],
          },
          finish_reason: null,
        }],
      }),
      sseEvent({
        model: "provider/final-model",
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]\r\n\r\n",
    ].join("");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(byteChunkedSseResponse(source));
    const onChunk = vi.fn();

    const result = await client(fetchImpl).completeStream({
      model: "provider/requested-model",
      messages: [{ role: "user", content: "Read a file" }],
      tools: [],
      onChunk,
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "provider/requested-model",
      stream: true,
    });
    expect(onChunk.mock.calls.map(([chunk]) => chunk)).toEqual([
      { content: "Hel" },
      { content: "lo 🌍" },
      { reasoning: "Plan " },
      { reasoning: "carefully." },
      { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    ]);
    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "Hello 🌍",
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: { name: "fs_read", arguments: "{\"path\":\"a.txt\"}" },
        }],
        reasoning: "carefully.",
        reasoning_content: "Plan ",
        reasoning_details: [reasoningDetail],
      },
      finishReason: "tool_calls",
      model: "provider/final-model",
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
  });

  it("surfaces in-band provider errors from nominal HTTP responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: "error",
        error: { code: 502, message: "Provider failed" },
        message: { role: "assistant", content: null },
      }],
    }), { status: 200 }));

    await expect(client(fetchImpl).complete({
      model: "provider/model",
      messages: [],
      tools: [],
    })).rejects.toMatchObject<AppError>({
      code: "MODEL_COMPLETION_ERROR",
      status: 502,
      message: "Provider failed",
    });
  });

  it("times out when the provider never starts a response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    ));

    const completion = client(fetchImpl, { connectTimeoutMs: 10 }).completeStream({
      model: "provider/model",
      messages: [],
      tools: [],
      onChunk: vi.fn(),
    });

    await expect(completion).rejects.toMatchObject<AppError>({
      code: "MODEL_CONNECT_TIMEOUT",
      status: 504,
    });
  });

  it("times out when an accepted stream stops sending data", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    const completion = client(fetchImpl, { streamIdleTimeoutMs: 10 }).completeStream({
      model: "provider/model",
      messages: [],
      tools: [],
      onChunk: vi.fn(),
    });

    await expect(completion).rejects.toMatchObject<AppError>({
      code: "MODEL_STREAM_TIMEOUT",
      status: 504,
    });
  });
});
