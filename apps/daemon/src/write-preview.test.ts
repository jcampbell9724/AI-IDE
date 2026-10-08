import { describe, expect, it } from "vitest";
import { buildWriteApprovalDetails } from "./write-preview.js";

describe("buildWriteApprovalDetails", () => {
  it("produces a unified diff for a replace when the file exists", () => {
    const details = buildWriteApprovalDetails({
      path: "src/hello.ts",
      operation: "fs_replace",
      before: "console.log(\"one\");\nconsole.log(\"two\");\n",
      fsReplace: { oldText: "\"two\"", newText: "\"three\"" },
    });
    expect(details.mode).toBe("replace");
    expect(details.preview).toContain("--- a/src/hello.ts");
    expect(details.preview).toContain('+++ b/src/hello.ts');
    expect(details.preview).toContain('-console.log("two");');
    expect(details.preview).toContain('+console.log("three");');
  });

  it("marks a new write as create and omits old/new text", () => {
    const details = buildWriteApprovalDetails({
      path: "notes.md",
      operation: "fs_write",
      before: null,
      fsWrite: { content: "# Notes", overwrite: false },
    });
    expect(details.mode).toBe("create");
    expect(details.preview).toBeUndefined();
    expect(details.oldText).toBeUndefined();
  });

  it("differs an overwrite against the existing file", () => {
    const details = buildWriteApprovalDetails({
      path: "notes.md",
      operation: "fs_write",
      before: "old line",
      fsWrite: { content: "new line", overwrite: true },
    });
    expect(details.mode).toBe("overwrite");
    expect(details.preview).toContain("-old line");
    expect(details.preview).toContain("+new line");
  });

  it("bounds the echoed old/new payloads", () => {
    const long = "x".repeat(5_000);
    const details = buildWriteApprovalDetails({
      path: "big.ts",
      operation: "fs_replace",
      before: "aaa",
      fsReplace: { oldText: long, newText: long },
    });
    expect(details.oldText?.length).toBeLessThan(2_000);
    expect(details.oldText).toContain("more characters");
    expect(details.newText?.length).toBeLessThan(2_000);
  });

  it("returns no preview when the file is unchanged", () => {
    const details = buildWriteApprovalDetails({
      path: "same.ts",
      operation: "fs_replace",
      before: "same",
      fsReplace: { oldText: "x", newText: "x" },
    });
    expect(details.preview).toBeUndefined();
  });
});
