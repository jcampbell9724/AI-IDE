import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, and horizontal rules", () => {
    const html = renderToStaticMarkup(renderMarkdown("# Title\n\nSome text.\n\n---"));
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some text.</p>");
    expect(html).toContain("<hr/>");
  });

  it("renders fenced code blocks verbatim", () => {
    const html = renderToStaticMarkup(renderMarkdown("```ts\nconst x: number = 1;\n```"));
    expect(html).toContain("<pre class=\"code-block language-ts\"><code>const x: number = 1;</code></pre>");
  });

  it("renders inline code, bold, italic, and links", () => {
    const html = renderToStaticMarkup(
      renderMarkdown("Use `npm test` for **fast** checks and *careful* reviews. [Docs](https://example.com)."),
    );
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain("<strong>fast</strong>");
    expect(html).toContain("<em>careful</em>");
    expect(html).toContain("<a href=\"https://example.com\" rel=\"noreferrer\" target=\"_blank\">Docs</a>");
  });

  it("escapes hostile input instead of injecting markup", () => {
    const html = renderToStaticMarkup(renderMarkdown("<script>alert(1)</script>"));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders ordered and unordered lists", () => {
    const html = renderToStaticMarkup(renderMarkdown("- one\n- two\n\n1. first\n2. second"));
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders block quotes", () => {
    const html = renderToStaticMarkup(renderMarkdown("> be careful"));
    expect(html).toContain("<blockquote>be careful</blockquote>");
  });
});