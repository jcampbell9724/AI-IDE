import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const storedSettingsSchema = z.object({
  version: z.literal(1),
  encryptedApiKey: z.string().min(1).optional(),
  provider: z.enum(["openrouter", "openai", "anthropic"]).default("openrouter"),
  providerKeys: z.object({ openai: z.string().optional(), anthropic: z.string().optional() }).default({}),
  providerModels: z.object({ openrouter: z.string().default(""), openai: z.string().default(""), anthropic: z.string().default("") }).default({ openrouter: "", openai: "", anthropic: "" }),
  selectedModel: z.string().max(500).default(""),
  approvalMode: z.enum(["ask", "auto-safe", "deny"]).default("ask"),
  launchAtLogin: z.boolean().default(false),
  codebaseMapEnabled: z.boolean().default(false),
  repositoryMemoryEnabled: z.boolean().default(false),
});

export type StoredSettings = z.infer<typeof storedSettingsSchema>;

export interface SecretCodec {
  readonly available: boolean;
  readonly backend: string;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

export interface SettingsUpdate {
  readonly provider?: StoredSettings["provider"];
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly selectedModel?: string;
  readonly approvalMode?: StoredSettings["approvalMode"];
  readonly launchAtLogin?: boolean;
  readonly codebaseMapEnabled?: boolean;
  readonly repositoryMemoryEnabled?: boolean;
}

const DEFAULT_SETTINGS: StoredSettings = {
  version: 1,
  provider: "openrouter",
  providerKeys: {},
  providerModels: { openrouter: "", openai: "", anthropic: "" },
  selectedModel: "",
  approvalMode: "ask",
  launchAtLogin: false,
  codebaseMapEnabled: false,
  repositoryMemoryEnabled: false,
};

export class DesktopSettingsStore {
  private current: StoredSettings | undefined;

  constructor(
    private readonly path: string,
    readonly codec: SecretCodec,
  ) {}

  async load(): Promise<StoredSettings> {
    if (this.current) return structuredClone(this.current);
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.current = storedSettingsSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.current = { ...DEFAULT_SETTINGS };
    }
    return structuredClone(this.current);
  }

  async getApiKey(): Promise<string | undefined> {
    const settings = await this.load();
    const encrypted = settings.provider === "openrouter" ? settings.encryptedApiKey : settings.providerKeys[settings.provider];
    if (!encrypted) return undefined;
    if (!this.codec.available) {
      throw new Error("Secure credential storage is unavailable on this computer.");
    }
    const decoded = Buffer.from(encrypted, "base64");
    const decrypted = await this.codec.decrypt(decoded);
    if (decrypted.shouldReEncrypt) {
      await this.update({ apiKey: decrypted.value });
    }
    return decrypted.value;
  }

  async update(input: SettingsUpdate): Promise<StoredSettings> {
    const current = await this.load();
    const provider = input.provider ?? current.provider;
    const providerKeys = { ...current.providerKeys };
    const providerModels = { ...current.providerModels, [current.provider]: current.selectedModel };
    let encryptedApiKey = provider === "openrouter" ? current.encryptedApiKey : providerKeys[provider];
    if (input.clearApiKey) encryptedApiKey = undefined;
    if (input.apiKey !== undefined) {
      const apiKey = input.apiKey.trim();
      if (!apiKey) throw new Error("Enter a provider API key.");
      if (!this.codec.available) {
        throw new Error("Secure credential storage is unavailable; the key was not saved.");
      }
      encryptedApiKey = (await this.codec.encrypt(apiKey)).toString("base64");
    }

    if (provider !== "openrouter") {
      if (encryptedApiKey === undefined) delete providerKeys[provider];
      else providerKeys[provider] = encryptedApiKey;
    }
    const selectedModel = input.selectedModel?.trim() ?? providerModels[provider];
    providerModels[provider] = selectedModel;
    const next = storedSettingsSchema.parse({
      ...current,
      provider,
      providerKeys,
      providerModels,
      encryptedApiKey: provider === "openrouter" ? encryptedApiKey : current.encryptedApiKey,
      selectedModel,
      ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
      ...(input.launchAtLogin === undefined ? {} : { launchAtLogin: input.launchAtLogin }),
      ...(input.codebaseMapEnabled === undefined ? {} : { codebaseMapEnabled: input.codebaseMapEnabled }),
      ...(input.repositoryMemoryEnabled === undefined ? {} : { repositoryMemoryEnabled: input.repositoryMemoryEnabled }),
    });
    if (provider === "openrouter" && encryptedApiKey === undefined) delete next.encryptedApiKey;
    await this.persist(next);
    this.current = next;
    return structuredClone(next);
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}
