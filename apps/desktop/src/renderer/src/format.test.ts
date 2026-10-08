import { describe, expect, it } from "vitest";
import {
  describeAgentError,
  estimateRunCost,
  formatCostUsd,
  formatDuration,
  formatPrice,
  friendlyToolLabel,
  pricePerMillion,
} from "./format";

describe("pricePerMillion", () => {
  it("passes through values already expressed per 1M tokens", () => {
    expect(pricePerMillion("0.15")).toBe(0.15);
    expect(pricePerMillion(0.6)).toBe(0.6);
  });

  it("converts per-token prices to per-1M", () => {
    expect(pricePerMillion("0.00000015")).toBe(0.15);
  });

  it("handles free and unknown", () => {
    expect(pricePerMillion("0")).toBe(0);
    expect(pricePerMillion(null)).toBeNull();
    expect(pricePerMillion(undefined)).toBeNull();
    expect(pricePerMillion("garbage")).toBeNull();
  });
});

describe("formatPrice", () => {
  it("formats currencies and free tiers", () => {
    expect(formatPrice(0.15)).toBe("$0.15");
    expect(formatPrice(0)).toBe("Free");
    expect(formatPrice(0.001)).toBe("<$0.01");
    expect(formatPrice(null)).toBe("—");
  });
});

describe("estimateRunCost", () => {
  it("computes cost from usage and per-1M pricing", () => {
    const estimate = estimateRunCost(
      { prompt_tokens: 1000, completion_tokens: 500 },
      "1",
      "3",
    );
    expect(estimate.inputTokens).toBe(1000);
    expect(estimate.outputTokens).toBe(500);
    expect(estimate.costUsd).toBeCloseTo(0.0025, 6);
  });

  it("returns null cost when there is no usage", () => {
    const estimate = estimateRunCost({}, "1", "3");
    expect(estimate.totalTokens).toBe(0);
    expect(estimate.costUsd).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(1200)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("friendlyToolLabel", () => {
  it("maps known tools to readable labels", () => {
    expect(friendlyToolLabel("fs_replace")).toBe("Edit file");
    expect(friendlyToolLabel("browser_side_effect")).toBe("Browser action");
  });
});

describe("describeAgentError", () => {
  it("marks transient model failures as retryable", () => {
    const failure = describeAgentError("MODEL_CALL_FAILED", "OpenRouter returned HTTP 429");
    expect(failure.retryable).toBe(true);
    expect(failure.detail).not.toContain("HTTP 429");
    expect(failure.technicalDetail).toContain("HTTP 429");
    expect(describeAgentError("MODEL_COMPLETION_ERROR", "stream ended").retryable).toBe(true);
  });

  it("keeps approval and setup failures non-retryable", () => {
    expect(describeAgentError("APPROVAL_DENIED", "nope").retryable).toBe(false);
    expect(describeAgentError("OPENROUTER_KEY_MISSING", "key").retryable).toBe(false);
  });

  it("detects transient wording on unknown codes", () => {
    expect(describeAgentError(undefined, "upstream timed out").retryable).toBe(true);
    expect(describeAgentError(undefined, "workspace mismatch").retryable).toBe(false);
  });

  it("keeps readable local errors visible without technical details", () => {
    const failure = describeAgentError(undefined, "Choose a project folder first.");
    expect(failure.detail).toBe("Choose a project folder first.");
    expect(failure.technicalDetail).toBeUndefined();
  });
});

describe("formatCostUsd", () => {
  it("formats tiny costs without rounding to zero", () => {
    expect(formatCostUsd(0)).toBe("≈$0.0000");
    expect(formatCostUsd(0.00002)).toBe("<$0.0001");
    expect(formatCostUsd(0.0025)).toBe("≈$0.0025");
    expect(formatCostUsd(null)).toBe("—");
  });
});
