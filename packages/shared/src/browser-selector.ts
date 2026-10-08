/**
 * Build a unique CSS selector without relying on generated DOM node ids.
 *
 * Keep this function self-contained: the desktop app serializes it into the
 * isolated project page, while the extension calls it directly.
 */
export function buildRobustSelector(
  element: Element,
  root: ParentNode = element.ownerDocument ?? document,
): string {
  const maximumLength = 4096;
  const preferredAttributes = [
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "aria-label",
    "name",
  ];

  const escapeIdentifier = (value: string): string => {
    const nativeEscape = globalThis.CSS?.escape;
    if (nativeEscape) return nativeEscape(value);

    const characters = Array.from(value);
    return characters.map((character, index) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0) return "\uFFFD";
      if (
        (code >= 1 && code <= 31)
        || code === 127
        || (index === 0 && code >= 48 && code <= 57)
        || (index === 1 && code >= 48 && code <= 57 && characters[0] === "-")
      ) {
        return `\\${code.toString(16)} `;
      }
      if (index === 0 && character === "-" && characters.length === 1) return "\\-";
      if (
        code >= 128
        || character === "-"
        || character === "_"
        || (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
      ) {
        return character;
      }
      return `\\${character}`;
    }).join("");
  };

  const escapeAttribute = (value: string): string => Array.from(value).map((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) return "\uFFFD";
    if (character === "\\") return "\\\\";
    if (character === '"') return '\\"';
    if ((code >= 1 && code <= 31) || code === 127) return `\\${code.toString(16)} `;
    return character;
  }).join("");

  const isUsable = (selector: string): boolean => selector.length > 0 && selector.length <= maximumLength;
  const isUnique = (selector: string): boolean => {
    if (!isUsable(selector)) return false;
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };

  const looksGenerated = (value: string): boolean => (
    value.length > 96
    || /^:r[\w-]*:$/i.test(value)
    || /^(?:ember|headlessui|radix|react-select|mui)-?\d+/i.test(value)
    || /(?:^|[-_:])\d{5,}(?:$|[-_:])/i.test(value)
    || /(?:^|[-_])[a-f0-9]{10,}(?:$|[-_])/i.test(value)
  );

  const stableId = (candidate: Element): string | undefined => {
    const id = candidate.getAttribute("id")?.trim();
    return id && !looksGenerated(id) ? id : undefined;
  };

  const stableClasses = (candidate: Element): string[] => Array.from(candidate.classList)
    .filter((name) => (
      name.length > 0
      && name.length <= 80
      && !/(?:^|[-_])[a-f0-9]{10,}(?:$|[-_])/i.test(name)
      && !/^(?:css|sc|jsx)-[a-z0-9]{6,}$/i.test(name)
      && !/(?:^|[-_:])\d{5,}(?:$|[-_:])/i.test(name)
    ))
    .slice(0, 6);

  const tag = (candidate: Element): string => candidate.tagName.toLowerCase();
  const attributeSegment = (candidate: Element): string | undefined => {
    for (const name of preferredAttributes) {
      const value = candidate.getAttribute(name)?.trim();
      if (!value || value.length > 300) continue;
      return `${tag(candidate)}[${name}="${escapeAttribute(value)}"]`;
    }
    return undefined;
  };

  const id = stableId(element);
  if (id) {
    const selector = `#${escapeIdentifier(id)}`;
    if (isUnique(selector)) return selector;
  }

  for (const name of preferredAttributes) {
    const value = element.getAttribute(name)?.trim();
    if (!value || value.length > 300) continue;
    const selector = `${tag(element)}[${name}="${escapeAttribute(value)}"]`;
    if (isUnique(selector)) return selector;
  }

  const classes = stableClasses(element);
  const classSelectors: string[] = [];
  for (const name of classes) classSelectors.push(`${tag(element)}.${escapeIdentifier(name)}`);
  for (let left = 0; left < classes.length; left += 1) {
    for (let right = left + 1; right < classes.length; right += 1) {
      classSelectors.push(
        `${tag(element)}.${escapeIdentifier(classes[left] ?? "")}.${escapeIdentifier(classes[right] ?? "")}`,
      );
    }
  }
  classSelectors.sort((left, right) => left.length - right.length);
  for (const selector of classSelectors) {
    if (isUnique(selector)) return selector;
  }

  const baseSegment = (candidate: Element): string => {
    const candidateId = stableId(candidate);
    if (candidateId) return `#${escapeIdentifier(candidateId)}`;
    const attribute = attributeSegment(candidate);
    if (attribute) return attribute;
    const candidateClasses = stableClasses(candidate).slice(0, 2);
    return tag(candidate) + candidateClasses.map((name) => `.${escapeIdentifier(name)}`).join("");
  };

  const chain: string[] = [];
  let current: Element | null = element;
  while (current) {
    chain.unshift(baseSegment(current));
    const selector = chain.join(" > ");
    if (isUnique(selector)) return selector;
    current = current.parentElement;
  }

  const positionalSegment = (candidate: Element): string => {
    const base = baseSegment(candidate);
    const parent = candidate.parentElement;
    if (!parent) return base;
    const sameTag = Array.from(parent.children).filter((sibling) => sibling.tagName === candidate.tagName);
    if (sameTag.length < 2) return base;
    return `${base}:nth-of-type(${sameTag.indexOf(candidate) + 1})`;
  };

  const positionalChain: string[] = [];
  current = element;
  while (current) {
    positionalChain.unshift(positionalSegment(current));
    const selector = positionalChain.join(" > ");
    if (isUnique(selector)) return selector;
    current = current.parentElement;
  }

  throw new Error("Unable to create a unique CSS selector for the selected element.");
}
