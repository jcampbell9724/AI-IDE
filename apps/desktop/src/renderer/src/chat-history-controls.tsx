import { useState, type ReactElement } from "react";

export function RenameChat(props: { title: string; onSave: (title: string) => void }): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.title);
  if (!editing) return <button className="chat-rename" type="button" aria-label={`Rename ${props.title}`} onClick={() => { setValue(props.title); setEditing(true); }}>Rename</button>;
  return <form className="chat-rename-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) { props.onSave(value); setEditing(false); } }}>
    <input autoFocus aria-label="Chat title" maxLength={64} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} />
    <button type="submit" disabled={!value.trim()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button>
  </form>;
}
