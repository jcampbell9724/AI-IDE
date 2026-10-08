import { describe, expect, it } from "vitest";
import type { OpenRouterModel } from "@browser-agent/shared";
import { cataloguePrice, suggestModel, filterModels } from "./model-info";

const model = (id: string, prompt: string | null, overrides: Partial<OpenRouterModel> = {}): OpenRouterModel => ({ id, name: id, description: null, contextLength: 32000, pricing: { prompt, completion: prompt }, supportedParameters: ["tools"], supportsTools: true, modalities: ["text"], ...overrides });
describe("model selection information", () => {
  it("converts per-token prices including free, expensive, and unknown values", () => {
    expect(cataloguePrice("0.000003")).toBe(3);
    expect(cataloguePrice("0.001")).toBe(1000);
    expect(cataloguePrice("0")).toBe(0);
    for (const value of [null, "", "unknown", "-1"]) expect(cataloguePrice(value)).toBeNull();
  });
  it("requires tools, prefers images then known lower prices, without mutating the catalogue", () => {
    const models = [model("text", "0"), model("unknown", null, { modalities: ["image"] }), model("vision", "0.000001", { modalities: ["image"] }), model("no-tools", "0", { supportsTools: false, modalities: ["image"] })];
    expect(suggestModel(models)?.id).toBe("vision");
    expect(models[0]?.id).toBe("text");
    expect(suggestModel([models[3]!])).toBeUndefined();
  });
});

it("combines search, image support and known zero input/output prices", () => {
  const models = [model("free-vision", "0", { modalities: ["image"] }), model("free-text", "0"), model("unknown", null), model("paid-output", "0", { pricing: { prompt: "0", completion: "0.000001" }, modalities: ["image"] })];
  expect(filterModels(models, "", true, true).map(m => m.id)).toEqual(["free-vision"]);
  expect(filterModels(models, " TEXT ", true, false).map(m => m.id)).toEqual(["free-text"]);
  expect(filterModels(models, "missing", false, false)).toEqual([]);
  expect(models).toHaveLength(4);
});
