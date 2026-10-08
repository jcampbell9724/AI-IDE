import type { ReactElement } from "react";

const paths = {
  projects: "M3 7h6l2 2h10v11H3z M3 7V4h6l2 3",
  chats: "M4 4h16v12H9l-5 4z",
  files: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  models: "M12 3 3 8l9 5 9-5z M3 8v9l9 5 9-5V8 M12 13v9",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  pin: "M9 3h6l-1 6 4 4v2H6v-2l4-4z M12 15v7",
  close: "M6 6l12 12 M18 6 6 18",
  plus: "M12 4v16 M4 12h16",
} as const;

export function UiIcon({ name }: { readonly name: keyof typeof paths }): ReactElement {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
