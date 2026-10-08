import type { OpenRouterModel } from "@browser-agent/shared";

export interface SearchableMessage {
  role: "user" | "assistant";
  content: string;
}

export function filterModels<T extends Pick<OpenRouterModel, "id" | "name" | "description">>(
  models: readonly T[],
  query: string,
): T[] {
  const terms = searchTerms(query);
  if (!terms.length) return [...models];

  return models.filter((model) => {
    const provider = model.id.split("/")[0] ?? "";
    return matchesEveryTerm([model.name, model.id, provider, model.description], terms);
  });
}

export function filterMessages<T extends SearchableMessage>(messages: readonly T[], query: string): T[] {
  const terms = searchTerms(query);
  if (!terms.length) return [...messages];

  return messages.filter((message) => matchesEveryTerm([
    message.content,
    message.role,
    message.role === "user" ? "you" : "agent",
  ], terms));
}

function searchTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function matchesEveryTerm(values: Array<string | null | undefined>, terms: string[]): boolean {
  const searchable = values.filter((value): value is string => Boolean(value)).join(" ").toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}
