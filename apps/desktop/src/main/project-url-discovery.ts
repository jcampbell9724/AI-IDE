import { readFile } from "node:fs/promises";
import type { DaemonRuntime } from "@browser-agent/daemon";

/** Only use a port explicitly present in the command or its Node entry point. */
export async function inferLocalUrl(workspace: Awaited<ReturnType<DaemonRuntime["projects"]["workspace"]>>, command: string): Promise<string | null> {
  const commandPort = /(?:--port(?:=|\s+)|-p(?:=|\s*)|runserver\s+(?:(?:127\.0\.0\.1|0\.0\.0\.0|localhost):)?|:(?=\d{2,5}(?:\s|$)))(\d{2,5})(?=\s|$)/.exec(command)?.[1]
    ?? /(?:^|\s)(?:PORT|port)\s*=\s*(\d{2,5})\b/.exec(command)?.[1];
  if (commandPort && Number(commandPort) > 0 && Number(commandPort) <= 65535) return `http://127.0.0.1:${commandPort}/`;
  // Support common launchers with flags, e.g. `node --watch server.js`,
  // `bun --hot ./src/index.ts`, `python server.py`, `tsx watch src/index.ts`.
  // Only the final entry file is inspected; never executed.
  const entry = /^(?:node|bun|python|python3|tsx|ts-node|nodemon|deno)\s+.*?["']?([\w./\- ]+\.(?:js|mjs|cjs|ts|mts|cts|py))["']?\s*$/.exec(command.trim())?.[1]?.trim();
  if (!entry) return null;
  try {
    const source = await readFile(await workspace.resolvePath(entry, { mustExist: true }), "utf8");
    const argument = /\.listen\s*\(\s*(\d{2,5}|[A-Za-z_$][\w$]*)\s*[,)]/.exec(source)?.[1];
    const literal = argument && /^\d+$/.test(argument) ? argument : null;
    const bindings = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d{2,5})\s*[;\r\n]/g)];
    const port = literal ?? bindings.find((binding) => binding[1] === argument)?.[2];
    return port && Number(port) > 0 && Number(port) <= 65535 ? `http://127.0.0.1:${port}/` : null;
  } catch { return null; }
}

export function discoverLocalUrl(output: readonly { text: string }[]): string | null {
  const matches = output.map((entry) => entry.text).join("\n").match(/(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]|::1|::):\d{2,5}(?:\/[^\s\u001b<>"']*)?/gi) ?? [];
  for (const raw of matches.reverse()) {
    try {
      let match = raw.replace(/^ws(s)?:\/\//i, (_m, secure: string) => (secure ? "https://" : "http://"));
      // Normalize bare IPv6 (`http://::1:3000`, `http://:::3000`) for URL parsing.
      match = match.replace("://::1:", "://[::1]:").replace("://:::", "://[::]:");
      // Treat all-interfaces binds as loopback for preview.
      match = match.replace("[::]", "127.0.0.1").replace("0.0.0.0", "127.0.0.1");
      const url = new URL(match);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (Number(url.port) > 0 && Number(url.port) <= 65535) return url.toString();
    } catch { /* Ignore incomplete output. */ }
  }
  return null;
}
