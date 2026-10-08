import { CopyButton } from "./copy-button";
import {
  Fragment,
  createElement,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * A small, dependency-free Markdown renderer for agent chat messages.
 *
 * It deliberately emits React text nodes (never raw HTML), so untrusted model
 * output cannot inject markup or scripts. Supported: headings, fenced code
 * blocks, inline code, bold, italic, strikethrough, links (http/https/mailto
 * only), lists, block quotes, horizontal rules, and paragraphs.
 */

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; nodes: InlineNode[] }
  | { kind: "italic"; nodes: InlineNode[] }
  | { kind: "strike"; nodes: InlineNode[] }
  | { kind: "link"; href: string; nodes: InlineNode[] };

function parseInline(source: string, depth = 0): InlineNode[] {
  if (depth > 6) return [{ kind: "text", text: source }];
  const nodes: InlineNode[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) nodes.push({ kind: "text", text: buffer });
    buffer = "";
  };

  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      nodes.push({ kind: "code", text: code[1] ?? "" });
      index += code[0].length;
      continue;
    }
    const bold = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (bold) {
      flush();
      nodes.push({ kind: "bold", nodes: parseInline(bold[1] ?? "", depth + 1) });
      index += bold[0].length;
      continue;
    }
    const strike = /^~~([\s\S]+?)~~/.exec(rest);
    if (strike) {
      flush();
      nodes.push({ kind: "strike", nodes: parseInline(strike[1] ?? "", depth + 1) });
      index += strike[0].length;
      continue;
    }
    const italic = /^([*_])([\s\S]+?)\1/.exec(rest);
    if (italic) {
      flush();
      nodes.push({ kind: "italic", nodes: parseInline(italic[2] ?? "", depth + 1) });
      index += italic[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link && /^(https?:|mailto:)/i.test(link[2] ?? "")) {
      flush();
      nodes.push({ kind: "link", href: link[2] ?? "#", nodes: parseInline(link[1] ?? "", depth + 1) });
      index += link[0].length;
      continue;
    }

    buffer += rest[0] ?? "";
    index += 1;
  }
  flush();
  return nodes;
}

function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case "text":
        return <Fragment key={key}>{node.text}</Fragment>;
      case "code":
        return <code key={key}>{node.text}</code>;
      case "bold":
        return <strong key={key}>{renderInline(node.nodes, key)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(node.nodes, key)}</em>;
      case "strike":
        return <del key={key}>{renderInline(node.nodes, key)}</del>;
      case "link":
        return (
          <a key={key} href={node.href} rel="noreferrer" target="_blank">
            {renderInline(node.nodes, key)}
          </a>
        );
    }
  });
}

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph"; content: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; content: string }
  | { type: "hr" };

const ORDERED_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const UNORDERED_ITEM = /^\s*([-*+])\s+(.*)$/;
const HR_LINE = /^\s*[-*_]\s*[-*_]\s*[-*_]*\s*$/;
const FENCE_START = /^```([\w+-]*)\s*$/;
const FENCE_END = /^```\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE_START.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_END.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1; // skip the closing fence
      blocks.push({ type: "code", lang: fence[1] ?? "", content: content.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, content: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (HR_LINE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const content: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        content.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", content: content.join(" ") });
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    const unordered = UNORDERED_ITEM.exec(line);
    if (ordered || unordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const itemMatch = isOrdered
          ? ORDERED_ITEM.exec(lines[index] ?? "")
          : UNORDERED_ITEM.exec(lines[index] ?? "");
        if (!itemMatch) break;
        items.push(itemMatch[2] ?? "");
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        !current.trim()
        || FENCE_START.test(current)
        || HEADING.test(current)
        || HR_LINE.test(current)
        || ORDERED_ITEM.test(current)
        || UNORDERED_ITEM.test(current)
        || /^\s*>\s?/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", content: paragraph.join(" ") });
  }
  return blocks;
}

function renderBlock(block: Block, key: string): ReactElement {
  switch (block.type) {
    case "code": {
      const className = block.lang ? `code-block language-${block.lang}` : "code-block";
      return (
        <div key={key} className="code-snippet"><CopyButton text={block.content} label="Copy code" /><pre className={className}>
          <code>{block.content}</code>
        </pre></div>
      );
    }
    case "heading":
      return createElement(
        `h${Math.min(6, Math.max(1, block.level))}`,
        { key },
        renderInline(parseInline(block.content), key),
      );
    case "paragraph":
      return <p key={key}>{renderInline(parseInline(block.content), key)}</p>;
    case "list":
      return createElement(
        block.ordered ? "ol" : "ul",
        { key },
        block.items.map((item, itemIndex) => {
          const itemKey = `${key}-item-${itemIndex}`;
          return <li key={itemKey}>{renderInline(parseInline(item), itemKey)}</li>;
        }),
      );
    case "quote":
      return <blockquote key={key}>{renderInline(parseInline(block.content), key)}</blockquote>;
    case "hr":
      return <hr key={key} />;
  }
}

export function renderMarkdown(text: string): ReactElement {
  return (
    <div className="markdown">
      {splitBlocks(text).map((block, index) => renderBlock(block, `block-${index}`))}
    </div>
  );
}
