import type { AgentEvent } from "./types";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export class SseDecoder {
  private buffer = "";

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let boundary = this.findBoundary();
    while (boundary) {
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const parsed = this.parseBlock(block);
      if (parsed) messages.push(parsed);
      boundary = this.findBoundary();
    }
    return messages;
  }

  finish(): SseMessage[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const parsed = this.parseBlock(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    return parsed ? [parsed] : [];
  }

  private findBoundary(): { index: number; length: number } | undefined {
    const match = /\r?\n\r?\n/.exec(this.buffer);
    return match ? { index: match.index, length: match[0].length } : undefined;
  }

  private parseBlock(block: string): SseMessage | undefined {
    let event = "message";
    let data = "";
    let id: string | undefined;
    let retry: number | undefined;
    let hasField = false;

    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const raw = separator < 0 ? "" : line.slice(separator + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      hasField = true;
      if (field === "event") event = value;
      else if (field === "data") data += (data ? "\n" : "") + value;
      else if (field === "id") id = value;
      else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
    }

    if (!hasField) return undefined;
    const result: SseMessage = { event, data };
    if (id !== undefined) result.id = id;
    if (retry !== undefined) result.retry = retry;
    return result;
  }
}

export async function* readAgentEvents(response: Response, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  if (!response.body) throw new Error("Daemon returned an empty event stream.");
  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const decoder = new SseDecoder();

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      for (const message of decoder.feed(textDecoder.decode(value, { stream: true }))) {
        yield decodeAgentEvent(message);
      }
    }
    const tail = textDecoder.decode();
    const messages = [...decoder.feed(tail), ...decoder.finish()];
    for (const message of messages) yield decodeAgentEvent(message);
  } finally {
    reader.releaseLock();
  }
}

function decodeAgentEvent(message: SseMessage): AgentEvent {
  if (!message.data) return { type: normalizeEventName(message.event) };
  const parsed = JSON.parse(message.data) as Record<string, unknown>;
  const type = typeof parsed.type === "string" ? parsed.type : normalizeEventName(message.event);
  return { ...parsed, type } as AgentEvent;
}

function normalizeEventName(event: string): AgentEvent["type"] {
  return (event === "message" ? "assistant.message" : event) as AgentEvent["type"];
}
