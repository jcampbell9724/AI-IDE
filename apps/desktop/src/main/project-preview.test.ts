import { describe, expect, it, vi } from "vitest";
import type { DaemonRuntime } from "@browser-agent/daemon";
import type { DesktopBrowserState } from "../shared/contracts";
import { openProjectPreview } from "./project-preview";

describe("project preview URL", () => {
  it("saves the normalized URL before loading it, including when the server is not ready", async () => {
    const setPreviewUrl = vi.fn().mockResolvedValue({});
    const navigate = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const projects = { setPreviewUrl } as unknown as DaemonRuntime["projects"];
    await expect(openProjectPreview(projects, navigate, " http://localhost:5173 ")).rejects.toThrow("Connection refused");
    expect(setPreviewUrl).toHaveBeenCalledWith("http://localhost:5173/");
    expect(navigate).toHaveBeenCalledWith("http://localhost:5173/");
    expect(setPreviewUrl.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
  });

  it.each(["https://example.com", "file:///secret", "http://user:pass@localhost:5173"])("rejects %s before saving or loading", async (url) => {
    const setPreviewUrl = vi.fn();
    const navigate = vi.fn<() => Promise<DesktopBrowserState>>();
    await expect(openProjectPreview({ setPreviewUrl } as unknown as DaemonRuntime["projects"], navigate, url)).rejects.toThrow();
    expect(setPreviewUrl).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
