import { describe, expect, it } from "vitest";
import { SseDecoder } from "./sse";

describe("SseDecoder", () => {
  it("parses events split across arbitrary chunks", () => {
    const decoder = new SseDecoder();
    expect(decoder.feed("event: assistant.delta\ndata: {\"type\":\"assistant.")).toEqual([]);
    expect(decoder.feed("delta\",\"delta\":\"Hi\"}\n\n")).toEqual([
      {
        event: "assistant.delta",
        data: "{\"type\":\"assistant.delta\",\"delta\":\"Hi\"}",
      },
    ]);
  });

  it("joins multiline data and accepts CRLF boundaries", () => {
    const decoder = new SseDecoder();
    expect(decoder.feed("id: 7\r\nevent: note\r\ndata: first\r\ndata: second\r\n\r\n")).toEqual([
      { event: "note", data: "first\nsecond", id: "7" },
    ]);
  });

  it("ignores comments and flushes a final unterminated event", () => {
    const decoder = new SseDecoder();
    decoder.feed(": keepalive\ndata: done");
    expect(decoder.finish()).toEqual([{ event: "message", data: "done" }]);
  });
});
