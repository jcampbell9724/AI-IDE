import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");
const codebaseMapSource = await readFile(new URL("./codebase-map/CodebaseMapSettings.tsx", import.meta.url), "utf8");

function declarationsFor(selector: string): string {
  return [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]?.split(",").some((candidate) => candidate.trim() === selector))
    .map((match) => match[2] ?? "")
    .join("\n");
}

function expectNoCardChrome(rule: string): void {
  for (const declaration of rule.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (property === "border-radius" || property.endsWith("-radius")) {
      expect(value).toMatch(/^(?:0|0px|none)$/);
    } else if (property === "border" || property.startsWith("border-")) {
      expect(value).toMatch(/^(?:0|0px|none|transparent)$/);
    } else if (property === "background" || property.startsWith("background-")) {
      expect(value).toMatch(/^(?:none|transparent)$/);
    } else if (property === "box-shadow") {
      expect(value).toBe("none");
    }
  }
}

describe("desktop settings panel", () => {
  it("provides an accessible settings entry in expanded navigation", () => {
    expect(source).toContain('className="labeled-navigation" aria-label="Main navigation"');
    expect(source).toContain('aria-controls="settings-panel" onClick={openSettings}');
    expect(source).toContain('aria-current={settingsOpen ? "page" : undefined}');
    expect(source).toContain('<UiIcon name="settings" /><span>Settings</span>');
    expect(source).toContain('aria-label="Close settings"');
  });

  it("replaces the conversation and composer while settings are open", () => {
    expect(source).toMatch(/settingsOpen\s*\?\s*<SettingsPanel/);
    expect(source).toContain('id="settings-panel"');
    expect(source).toContain('className="settings-panel"');
    expect(source).toContain('aria-label="Settings"');
  });

  it("keeps Connection, Models, Projects, and Preferences tabs at the top of the settings area", () => {
    const tabListIndex = source.indexOf('role="tablist"');
    const firstPanelIndex = source.indexOf('role="tabpanel"');
    const tabButtons = [...source.matchAll(/<button\b(?:(?!<\/button>).)*id="settings-tab-[^"]+"(?:(?!<\/button>).)*<\/button>/gs)];

    expect(tabListIndex).toBeGreaterThan(-1);
    expect(firstPanelIndex).toBeGreaterThan(tabListIndex);
    expect(source).toContain('className="settings-tabs"');
    expect(source).toContain('aria-label="Settings sections"');
    expect(tabButtons).toHaveLength(4);
    expect(tabButtons.map((match) => match[0])).toEqual(expect.arrayContaining([
      expect.stringContaining(">Connection</span>"),
      expect.stringContaining(">Models</span>"),
      expect.stringContaining(">Preferences</span>"),
    ]));
    expect(source).not.toContain('id="settings-tab-project"');
  });

  it("links each accessible tab to one labelled tab panel", () => {
    const tabs = [
      ["api-key", "settings-panel-api-key"],
      ["model", "settings-panel-model"],
      ["settings", "settings-panel-settings"],
    ] as const;

    for (const [tab, panelId] of tabs) {
      const tabButton = source.match(new RegExp(`<button\\b(?:(?!<\\/button>).)*id="settings-tab-${tab}"(?:(?!<\\/button>).)*<\\/button>`, "s"))?.[0] ?? "";
      const panel = `${source}\n${codebaseMapSource}`.match(new RegExp(`<(?:section|div)\\b(?:(?!>).)*id="${panelId}"(?:(?!>).)*>`, "s"))?.[0] ?? "";

      expect(tabButton).toContain('role="tab"');
      expect(tabButton).toContain(`aria-controls="${panelId}"`);
      expect(tabButton).toContain("aria-selected={");
      expect(tabButton).toContain("tabIndex={");
      expect(tabButton).toContain("onClick={");
      expect(tabButton).toContain("onKeyDown={");
      expect(panel).toContain('role="tabpanel"');
      expect(panel).toContain(`aria-labelledby="settings-tab-${tab}"`);
    }
  });

  it("supports changing tabs with the mouse and standard tab-list keys", () => {
    expect(source).toContain("setActiveSettingsTab");
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key === "Home"');
    expect(source).toContain('event.key === "End"');
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("document.getElementById(`settings-tab-${nextTab}`)?.focus()");
  });

  it("allows the configured OpenRouter key to be replaced without revealing it", () => {
    expect(source).toContain('className="settings-api-key"');
    expect(source).toContain("OpenRouter API key");
    expect(source).toContain('type="password"');
    expect(source).toContain("Save API key");
    expect(source).toMatch(/savePreferences\(\{\s*apiKey:/);
  });

  it("shows a searchable, scrollable model list instead of a dropdown", () => {
    expect(source).toContain('id="settings-model-search"');
    expect(source).toMatch(/className="[^"]*\bmodel-search\b[^"]*"/);
    expect(source).toMatch(/placeholder="Search models/);
    expect(source).toContain("const [modelSearch, setModelSearch]");
    expect(source).toContain("const filteredModels = useMemo(");
    expect(source).toContain('className="model-list"');
    expect(source).toContain("model-option");
    expect(source).not.toMatch(/<select[^>]*className="settings-model"/);
    expect(source).toContain("window.browserAgent.listModels");
    expect(source).toMatch(/savePreferences\(\{\s*selectedModel:/);
  });

  it("lets models be starred and keeps a separate Starred section", () => {
    expect(source).toContain('title="Starred"');
    expect(source).toContain("model-star");
    expect(source).toMatch(/aria-label=\{[^}]*[Ss]tar/);
    expect(source).toMatch(/\bload(?:FavoriteModels|StarredModelIds)\b/);
    expect(source).toMatch(/save(?:FavoriteModels|StarredModelIds)\(/);
  });

  it("leaves project controls out of settings", () => {
    expect(source).not.toContain('id="settings-panel-project"');
    expect(source).not.toContain('id="settings-project-run-command"');
  });

  it("places the optional codebase map in the general Settings tab", () => {
    expect(source).toContain('id="settings-tab-settings"');
    expect(source).toContain("<CodebaseMapSettings");
    expect(source).toContain("codebaseMapEnabled");
    expect(codebaseMapSource).toContain('id="settings-panel-settings"');
    expect(codebaseMapSource).toContain('role="switch"');
    expect(codebaseMapSource).toContain("checked={props.enabled}");
    expect(codebaseMapSource).toContain("disabled={props.busy}");
  });

  it("connects the independent memory preference to saving and the settings snapshot", () => {
    expect(source).toMatch(/savePreferences\(\{\s*repositoryMemoryEnabled: enabled\s*\}\)/);
    expect(source).toContain("onRepositoryMemoryChange={(enabled) => void saveRepositoryMemoryEnabled(enabled)}");
    expect(source).toContain("repositoryMemoryEnabled={props.snapshot?.preferences.repositoryMemoryEnabled ?? false}");
    expect(source).toContain("onRepositoryMemoryChange={props.onRepositoryMemoryChange}");
  });

  it("keeps settings compact and contained within the chat pane", () => {
    const buttonRule = declarationsFor(".settings-button");
    const panelRule = declarationsFor(".settings-panel");
    const scrollRule = declarationsFor(".settings-scroll");
    const tabsRule = declarationsFor(".settings-tabs");
    const tabRule = declarationsFor(".settings-tabs button");
    const activeTabRule = declarationsFor(".settings-tabs button.active");
    const focusTabRule = declarationsFor(".settings-tabs button:focus-visible");
    const apiKeyRule = declarationsFor(".settings-control-row input");
    const modelSearchRule = `${declarationsFor(".model-search")}\n${declarationsFor(".settings-model-search")}`;
    const modelListRule = declarationsFor(".model-list");
    expect(buttonRule).toMatch(/width:\s*(?:3\d|40)px/);
    expect(buttonRule).toMatch(/height:\s*(?:3\d|40)px/);
    expect(scrollRule).toMatch(/min-height:\s*0/);
    expect(scrollRule).toMatch(/overflow-y:\s*auto/);
    expect(tabsRule).toMatch(/display:\s*grid/);
    expect(tabsRule).toMatch(/flex:\s*1/);
    expect(tabsRule).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(tabRule).toMatch(/min-width:\s*0/);
    expect(activeTabRule).toMatch(/(?:background|border-color|color):/);
    expect(focusTabRule).toMatch(/(?:outline|box-shadow):/);
    expect(apiKeyRule).toMatch(/min-width:\s*0/);
    expect(apiKeyRule).toMatch(/flex:\s*1/);
    expect(modelSearchRule).toMatch(/min-width:\s*0/);
    expect(modelListRule).toMatch(/min-height:\s*0/);
    expect(modelListRule).toMatch(/overflow-y:\s*auto/);
    expect(panelRule).not.toMatch(/position:\s*(?:fixed|absolute)/);
  });

  it("presents each settings tab as flat content instead of a card", () => {
    const groupRule = declarationsFor(".settings-group");
    const tabPanelRule = declarationsFor(".settings-tab-panel");

    for (const rule of [groupRule, tabPanelRule]) {
      expectNoCardChrome(rule);
    }
  });
});
