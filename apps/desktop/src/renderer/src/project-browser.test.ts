import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fileName } from "./project-browser";

const source = await readFile(new URL("./project-browser.tsx", import.meta.url), "utf8");

describe("project directory and code viewer", () => {
  it("shows nested directories as an accessible collapsible tree", () => {
    expect(source).toContain('role="tree"');
    expect(source).toContain('role="treeitem"');
    expect(source).toContain("collapsedDirectories.has(entry.path)");
    expect(source).toContain("toggleDirectory(entry.path)");
  });

  it("filters the project directory with a file search", () => {
    expect(source).toContain("const [searchQuery, setSearchQuery]");
    expect(source).toContain('placeholder="Search files…"');
    expect(source).toContain("entry.path.toLocaleLowerCase().includes(query)");
    expect(source).toContain("No matching files.");
  });

  it("renders code with line numbers and reports truncated previews", () => {
    expect(source).toContain('className="code-line"');
    expect(source).toContain("{index + 1}");
    expect(source).toContain("Preview limited to the first 5,000 lines.");
  });

  it("extracts portable file names from project paths", () => {
    expect(fileName("apps/desktop/src/App.tsx")).toBe("App.tsx");
    expect(fileName("README.md")).toBe("README.md");
  });
});
