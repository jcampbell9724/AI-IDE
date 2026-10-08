import type { DaemonRuntime } from "@browser-agent/daemon";
import type { DesktopBrowserState } from "../shared/contracts";
import { loopbackUrl } from "./browser-url";

export async function openProjectPreview(
  projects: DaemonRuntime["projects"],
  navigate: (url: string) => Promise<DesktopBrowserState>,
  value: string,
): Promise<DesktopBrowserState> {
  const url = loopbackUrl(value).toString();
  await projects.setPreviewUrl(url);
  return navigate(url);
}
