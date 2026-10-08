import type { OpenRouterModel } from "@browser-agent/shared";
import type { ReactElement } from "react";

// OpenRouter's model catalogue reports USD per token.
export function cataloguePrice(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number * 1_000_000 : null;
}

function price(value: string | null): string {
  const amount = cataloguePrice(value);
  return amount === null ? "Unknown" : amount === 0 ? "Free" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 3 }).format(amount);
}

export function suggestModel(models: readonly OpenRouterModel[]): OpenRouterModel | undefined {
  return [...models].filter((model) => model.supportsTools).sort((a, b) =>
    Number(b.modalities.includes("image")) - Number(a.modalities.includes("image"))
    || (cataloguePrice(a.pricing.prompt) ?? Infinity) - (cataloguePrice(b.pricing.prompt) ?? Infinity)
    || (b.contextLength ?? 0) - (a.contextLength ?? 0)
    || a.id.localeCompare(b.id),
  )[0];
}

export function ModelFacts({ model }: { model: OpenRouterModel }): ReactElement {
  return <span className="model-facts">
    <span>{model.modalities.includes("image") ? "Images + text" : "Text input"} · {model.contextLength ? `${model.contextLength.toLocaleString()} token context` : "Context unknown"}</span>
    <span>{price(model.pricing.prompt)} input / {price(model.pricing.completion)} output per 1M tokens</span>
  </span>;
}

export function ModelSuggestion({ models, onSelect, busy }: { models: readonly OpenRouterModel[]; onSelect: (id: string) => void; busy: boolean }): ReactElement | null {
  const model = suggestModel(models);
  if (!model) return null;
  return <div className="model-suggestion"><strong>Suggested starting point</strong><p>{model.name || model.id}</p><p>Prioritizes image support, then lower input price. This is a capability and price match, not a quality ranking.</p><ModelFacts model={model} /><button className="button ghost" type="button" disabled={busy} onClick={() => onSelect(model.id)}>Use this model</button></div>;
}

export function filterModels(models: readonly OpenRouterModel[], search: string, freeOnly: boolean, imagesOnly: boolean): OpenRouterModel[] {
  const query = search.trim().toLocaleLowerCase();
  return models.filter((model) => (!query || [model.name, model.id, model.description].some((value) => value?.toLocaleLowerCase().includes(query)))
    && (!freeOnly || (cataloguePrice(model.pricing.prompt) === 0 && cataloguePrice(model.pricing.completion) === 0))
    && (!imagesOnly || model.modalities.includes("image")));
}
