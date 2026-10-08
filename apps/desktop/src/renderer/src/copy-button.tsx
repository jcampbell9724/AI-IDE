import { useEffect, useRef, useState, type ReactElement } from "react";

export function CopyButton(props: { text: string; label: string; disabled?: boolean }): ReactElement {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(): Promise<void> {
    clearTimeout(timer.current);
    try {
      await window.browserAgent.copyText(props.text);
      setStatus("Copied");
    } catch { setStatus("Copy failed. Try again."); }
    timer.current = setTimeout(() => setStatus(""), 2500);
  }
  return <span className="copy-control"><button type="button" disabled={props.disabled} onClick={() => void copy()}>{props.label}</button><span role="status">{status}</span></span>;
}
