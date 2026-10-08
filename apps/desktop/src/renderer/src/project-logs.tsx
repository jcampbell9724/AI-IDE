import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import type { DevLogEntry } from "@browser-agent/shared";
import type { DesktopApi } from "../../shared/contracts";

const MAX_LOG_CHARACTERS = 200_000;

export function appendProjectLogs(current: string, entries: readonly DevLogEntry[]): string {
  const text = entries.map((entry) => entry.text).join("")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const combined = current + text;
  return combined.length > MAX_LOG_CHARACTERS
    ? `[Earlier output trimmed]\n${combined.slice(-MAX_LOG_CHARACTERS)}` : combined;
}

export function watchProjectLogs(
  read: DesktopApi["getProjectLogs"],
  received: (entries: readonly DevLogEntry[]) => void,
  failed: (message: string) => void,
): () => void {
  let disposed = false;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    try {
      const result = await read(cursor);
      if (disposed) return;
      cursor = result.next;
      received(result.logs);
    } catch (error) {
      if (!disposed) failed(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
  };
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}

export function ProjectLogs({ onClose }: { onClose: () => void }): ReactElement {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);

  useEffect(() => watchProjectLogs(
    (after) => window.browserAgent.getProjectLogs(after),
    (entries) => { setText((current) => appendProjectLogs(current, entries)); setError(""); setLoading(false); },
    (message) => { setError(message); setLoading(false); },
  ), []);

  useLayoutEffect(() => {
    if (followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [text]);

  return <section className="project-logs" id="project-logs" aria-label="Project logs">
    <header><strong>Project logs</strong><div>
      {!follow && <button type="button" onClick={() => {
        followRef.current = true; setFollow(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }}>Follow latest</button>}
      <button type="button" onClick={onClose} aria-label="Close project logs">Close</button>
    </div></header>
    {error && <p className="project-logs-error" role="alert">Could not load logs: {error}. Retrying…</p>}
    <pre ref={scrollRef} tabIndex={0} aria-label="Project output" onScroll={() => {
      const view = scrollRef.current;
      if (!view) return;
      followRef.current = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
      setFollow(followRef.current);
    }}>{text || (loading ? "Loading project output…" : "No output yet. Start the project to see its logs here.")}</pre>
  </section>;
}
