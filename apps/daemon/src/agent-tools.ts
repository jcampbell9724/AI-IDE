import type { OpenRouterToolDefinition } from "./openrouter.js";

const pathProperty = {
  type: "string",
  description: "A path inside the selected workspace. Relative paths are preferred.",
};

export const AGENT_TOOLS: OpenRouterToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "fs_list",
      description: "List a bounded portion of the selected project tree.",
      parameters: {
        type: "object",
        properties: {
          path: { ...pathProperty, default: "." },
          depth: { type: "integer", minimum: 0, maximum: 5, default: 2 },
          maxEntries: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read",
      description: "Read a bounded line range from a text file in the selected project.",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          startLine: { type: "integer", minimum: 1, default: 1 },
          endLine: { type: "integer", minimum: 1 },
          maxLines: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
          maxBytes: { type: "integer", minimum: 1, maximum: 5_000_000, default: 1_000_000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_search",
      description: "Search bounded project files for literal text or a regular expression.",
      parameters: {
        type: "object",
        properties: {
          path: { ...pathProperty, default: "." },
          query: { type: "string", minLength: 1, maxLength: 1000 },
          regex: { type: "boolean", default: false },
          caseSensitive: { type: "boolean", default: false },
          extensions: { type: "array", items: { type: "string" }, maxItems: 100, default: [] },
          maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_replace",
      description: "Replace an exact, expected number of text occurrences in one project file.",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1, default: 1 },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "Create a text file, or overwrite it only when overwrite=true.",
      parameters: {
        type: "object",
        properties: {
          path: pathProperty,
          content: { type: "string" },
          overwrite: { type: "boolean", default: false },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Read branch and working-tree status for the selected project.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Read a bounded local Git diff, optionally staged or limited to one path.",
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean", default: false }, path: pathProperty },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Read recent Git commit metadata.",
      parameters: {
        type: "object",
        properties: { maxCount: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_run",
      description: "Run one bounded command in the selected workspace without command chaining.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" }, maxItems: 128, default: [] },
          cwd: { ...pathProperty, default: "." },
          timeoutMs: { type: "integer", minimum: 100, maximum: 300_000, default: 60_000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser",
      description: "Inspect and control the project browser. Call context first, reuse its tab id and unique CSS selectors, and use wait_for after actions that update a dynamic page; ambiguous selectors are rejected.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "context", "inspect_element", "navigate", "back", "forward", "refresh",
              "tabs", "click", "type", "key", "scroll", "hover", "focus", "wait_for", "screenshot",
              "console", "network_errors",
            ],
          },
          arguments: {
            type: "object",
            description: "Action-specific values. Reuse tabId from context to lock later actions to the same tab. inspect_element/click/type/hover/focus/wait_for use selector; navigate uses url; type uses text or value; key uses key; scroll uses selector or x/y/deltaX/deltaY.",
            properties: {
              selector: { type: "string", description: "An exact CSS selector returned by context or inspect_element." },
              tabId: { type: "integer", minimum: 0, description: "Tab id returned by context or tabs. Reuse it for stable targeting." },
              url: { type: "string", description: "A localhost HTTP(S) URL for navigate." },
              text: { type: "string", description: "Text to enter for type." },
              value: { type: "string", description: "Alias for text when using type." },
              key: { type: "string", description: "Keyboard key, such as Enter or Escape." },
              x: { type: "number", description: "Horizontal scroll distance in pixels." },
              y: { type: "number", description: "Vertical scroll distance in pixels." },
              deltaX: { type: "number", description: "Alias for horizontal scroll distance." },
              deltaY: { type: "number", description: "Alias for vertical scroll distance." },
              timeoutMs: { type: "integer", minimum: 100, maximum: 15_000, description: "Maximum wait time for wait_for." },
              state: { type: "string", enum: ["attached", "visible", "hidden", "detached"], description: "Desired element state for wait_for; defaults to visible." },
            },
            additionalProperties: false,
            default: {},
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];
