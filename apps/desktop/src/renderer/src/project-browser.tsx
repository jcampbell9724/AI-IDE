import { memo, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type {
  DesktopProjectDirectory,
  DesktopProjectFile,
} from "../../shared/contracts";
import { CopyButton } from "./copy-button";

export interface CodeViewState {
  readonly path: string;
  readonly file?: DesktopProjectFile;
  readonly loading: boolean;
  readonly error?: string;
}

interface ProjectDirectoryProps {
  readonly projectName: string | null;
  readonly directory: DesktopProjectDirectory | null;
  readonly loading: boolean;
  readonly error: string;
  readonly selectedPath: string | null;
  readonly onOpenFile: (path: string) => void;
  readonly onRefresh: () => void;
  readonly onChooseProject: () => void;
}

export function ProjectDirectory(props: ProjectDirectoryProps): ReactElement {
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const treeRef = useRef<HTMLDivElement | null>(null);
  const treeScroll = useRef(0);
  useLayoutEffect(() => {
    if (!props.loading && treeRef.current) treeRef.current.scrollTop = treeScroll.current;
  }, [props.loading, props.directory]);

  useEffect(() => {
    if (!props.directory) return;
    const directories = new Set(props.directory.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path));
    // Preserve user-collapsed folders across refreshes, but never auto-collapse
    // new folders (previously every fresh directory started collapsed).
    setCollapsedDirectories((current) => new Set([...current].filter((path) => directories.has(path))));
  }, [props.directory]);

  const visibleEntries = useMemo(() => props.directory?.entries.filter((entry) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (query) return entry.path.toLocaleLowerCase().includes(query);
    const segments = entry.path.split("/");
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      parent = parent ? `${parent}/${segments[index]}` : segments[index] ?? "";
      if (collapsedDirectories.has(parent)) return false;
    }
    return true;
  }) ?? [], [collapsedDirectories, props.directory, searchQuery]);

  function toggleDirectory(path: string): void {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return <section className="project-directory" aria-label="Project directory">
    <header className="sidebar-panel-header">
      <div>
        <span>Project directory</span>
        <strong title={props.projectName ?? "No project selected"}>{props.projectName ?? "No project selected"}</strong>
      </div>
      <button type="button" onClick={props.onRefresh} disabled={!props.projectName || props.loading} aria-label="Refresh project directory" title="Refresh project directory">↻</button>
    </header>

    {!props.projectName && <div className="project-directory-empty">
      <span aria-hidden="true">⌁</span>
      <p>Choose a project to browse its files.</p>
      <button className="button ghost compact" type="button" onClick={props.onChooseProject}>Choose project</button>
    </div>}
    {props.projectName && props.loading && <div className="project-directory-status" role="status"><span aria-hidden="true" />Loading files…</div>}
    {props.error && <div className="project-directory-error" role="alert">{props.error}</div>}
    {props.projectName && !props.loading && !props.error && props.directory && <>
      <label className="project-search">
        <span aria-hidden="true">⌕</span>
        <span className="sr-only">Search project directory</span>
        <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search files…" spellCheck={false} />
      </label>
      <div className="project-root-label" title={props.directory.rootName}><span aria-hidden="true">▾</span>{props.directory.rootName}</div>
      <div ref={treeRef} onScroll={(event) => { treeScroll.current = event.currentTarget.scrollTop; }} className="project-tree" role="tree" aria-label={`${props.directory.rootName} files`}>
        {visibleEntries.map((entry) => {
          const directory = entry.kind === "directory";
          const expanded = directory && !collapsedDirectories.has(entry.path);
          return <button
            className={`project-tree-row ${entry.kind} ${props.selectedPath === entry.path ? "selected" : ""}`}
            style={{ "--tree-depth": entry.depth } as CSSProperties}
            type="button"
            role="treeitem"
            aria-selected={entry.kind === "file" ? props.selectedPath === entry.path : undefined}
            aria-expanded={directory ? expanded : undefined}
            disabled={entry.kind === "symlink"}
            onClick={() => directory ? toggleDirectory(entry.path) : entry.kind === "file" && props.onOpenFile(entry.path)}
            title={entry.kind === "symlink" ? `${entry.path} (linked files are not previewed)` : entry.path}
            key={entry.path}
          >
            {directory && <span className="tree-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
            {!directory && <span className={`tree-file-icon ${fileKind(entry.name)}`} aria-hidden="true">{entry.kind === "symlink" ? "↗" : "◇"}</span>}
            <span>{entry.name}</span>
          </button>;
        })}
        {searchQuery.trim() && !visibleEntries.length && <p className="project-search-empty">No matching files.</p>}
      </div>
      {props.directory.truncated && <p className="project-tree-limit">Showing the first 2,500 entries.</p>}
    </>}
  </section>;
}

export const CodeViewer = memo(function CodeViewer(props: {
  readonly view: CodeViewState;
  readonly initialScrollTop?: number;
  readonly onScrollPosition?: (position: number) => void;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (props.view.file && scrollRef.current) scrollRef.current.scrollTop = props.initialScrollTop ?? 0;
  }, [props.view.path, props.view.file, props.initialScrollTop]);
  const lines = props.view.file?.content.split("\n") ?? [];
  return <section className="code-viewer" aria-label={`Code viewer for ${props.view.path}`}>
    {props.view.loading && <div className="code-viewer-state" role="status"><span aria-hidden="true" />Opening {fileName(props.view.path)}…</div>}
    {props.view.error && <div className="code-viewer-state error" role="alert"><strong>Couldn’t preview this file</strong><p>{props.view.error}</p></div>}
    {props.view.file && <>
      <div className="code-viewer-meta">
        <span>{languageLabel(props.view.path)}</span>
        <span>{props.view.file.totalLines.toLocaleString()} lines</span>
        <span>{formatBytes(props.view.file.size)}</span>
      </div>
      <div className="code-scroll" ref={scrollRef} tabIndex={0} onScroll={() => props.onScrollPosition?.(scrollRef.current?.scrollTop ?? 0)}>
        <div className="code-lines" style={{ "--line-number-width": `${String(props.view.file.totalLines).length + 2}ch` } as CSSProperties}>
          {lines.map((line, index) => <div className="code-line" key={index}>
            <span aria-hidden="true">{index + 1}</span>
            <code>{line || " "}</code>
          </div>)}
        </div>
      </div>
      {props.view.file.truncated && <div className="code-truncated">Preview limited to the first 5,000 lines.</div>}
    </>}
  </section>;
});

export function fileName(path: string): string {
  return path.split("/").pop() || path;
}

function fileKind(name: string): string {
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? "")) return "script";
  if (["css", "scss", "sass", "less"].includes(extension ?? "")) return "style";
  if (["json", "yaml", "yml", "toml"].includes(extension ?? "")) return "data";
  if (["md", "mdx", "txt"].includes(extension ?? "")) return "text";
  return "default";
}

function languageLabel(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const labels: Record<string, string> = {
    cjs: "JavaScript",
    css: "CSS",
    html: "HTML",
    js: "JavaScript",
    json: "JSON",
    jsx: "JavaScript JSX",
    md: "Markdown",
    mdx: "MDX",
    mjs: "JavaScript",
    py: "Python",
    scss: "SCSS",
    ts: "TypeScript",
    tsx: "TypeScript JSX",
    yml: "YAML",
    yaml: "YAML",
  };
  return labels[extension] ?? (extension ? extension.toUpperCase() : "Plain text");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
