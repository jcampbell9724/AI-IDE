import { describe, expect, it } from "vitest";
import { filterMessages, filterModels } from "./search";

const models = [
  {
    id: "anthropic/claude-sonnet",
    name: "Claude Sonnet",
    description: "Balanced model for coding",
  },
  {
    id: "openai/gpt-fast",
    name: "GPT Fast",
    description: "Quick general assistant",
  },
  {
    id: "google/gemini-pro",
    name: null,
    description: null,
  },
];

const messages = [
  { id: "1", role: "user" as const, content: "Please fix the navigation menu" },
  { id: "2", role: "assistant" as const, content: "I updated the header styles." },
  { id: "3", role: "user" as const, content: "Now check the footer" },
];

describe("desktop search helpers", () => {
  it("returns every item for a blank query without changing its order", () => {
    expect(filterModels(models, "   ")).toEqual(models);
    expect(filterMessages(messages, "")).toEqual(messages);
  });

  it("finds models by name, ID, provider, description, and multiple terms", () => {
    expect(filterModels(models, "SONNET").map((model) => model.id)).toEqual(["anthropic/claude-sonnet"]);
    expect(filterModels(models, "google").map((model) => model.id)).toEqual(["google/gemini-pro"]);
    expect(filterModels(models, "coding anthropic").map((model) => model.id)).toEqual(["anthropic/claude-sonnet"]);
    expect(filterModels(models, "missing")).toEqual([]);
  });

  it("finds chat messages by content or friendly role label", () => {
    expect(filterMessages(messages, "HEADER").map((message) => message.id)).toEqual(["2"]);
    expect(filterMessages(messages, "you footer").map((message) => message.id)).toEqual(["3"]);
    expect(filterMessages(messages, "agent styles").map((message) => message.id)).toEqual(["2"]);
    expect(filterMessages(messages, "missing")).toEqual([]);
  });
});
