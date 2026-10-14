import { App, Notice, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type CypherPlugin from "../main";
import {
  CHAT_PROVIDER_PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  EMBEDDING_PROVIDER_PRESETS,
  embeddingSignature,
} from "../settings";
import { normalizeBaseUrl, normalizeExcludedFolders, clamp } from "../utils";
import { confirmAction } from "./modals";
import { OnboardingModal } from "./onboardingModal";

const SAVE_DEBOUNCE_MS = 400;

export class CypherSettingsTab extends PluginSettingTab {
  private plugin: CypherPlugin;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: CypherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cypher-settings-tab");

    const header = containerEl.createDiv({ cls: "cypher-settings-header" });
    header.createEl("h2", { text: "Cypher" });
    header.createEl("p", {
      text: "Local vector search and vault-grounded chat for Obsidian.",
      cls: "setting-item-description",
    });

    this.renderSetupBanner(containerEl);
    this.renderEmbeddingSection(containerEl);
    this.renderChatSection(containerEl);
    this.renderIndexSection(containerEl);
    this.renderChunkingSection(containerEl);
  }

  public hide(): void {
    this.flushSave();
  }

  private queueSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveSettings();
    }, SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.plugin.saveSettings();
  }

  private renderSetupBanner(containerEl: HTMLElement): void {
    if (!this.plugin.needsOnboarding()) return;

    const banner = containerEl.createDiv({ cls: "cypher-notice-banner" });
    banner.createEl("strong", { text: "Vault not indexed. " });
    banner.createSpan({ text: "Run the setup wizard to embed your notes." });

    const button = banner.createEl("button", { text: "Run setup", cls: "mod-cta" });
    button.onclick = () => this.openWizard();
  }

  private openWizard(): void {
    new OnboardingModal(
      this.app,
      this.plugin.settings,
      () => this.plugin.saveSettings(),
      this.plugin.embeddingService,
      this.plugin.vectorDbService,
      this.plugin.indexerService,
      () => this.display()
    ).open();
  }

  private renderEmbeddingSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Embeddings").setHeading();

    containerEl.createEl("p", {
      text: "Notes are converted to vectors with an OpenAI-compatible embeddings endpoint. " +
        "Vectors are stored in this vault's plugin folder.",
      cls: "setting-item-description",
    });

    this.renderDimensionWarning(containerEl);

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc("Fills the URL and model below.")
      .addDropdown((dropdown) => {
        dropdown.addOption("custom", "Custom");
        for (const preset of EMBEDDING_PROVIDER_PRESETS) {
          dropdown.addOption(preset.name, preset.name);
        }

        const current = EMBEDDING_PROVIDER_PRESETS.find(
          (preset) =>
            preset.apiUrl === this.plugin.settings.embeddingApiUrl &&
            preset.model === this.plugin.settings.embeddingModel
        );
        dropdown.setValue(current?.name ?? "custom");

        dropdown.onChange((value) => {
          const preset = EMBEDDING_PROVIDER_PRESETS.find((item) => item.name === value);
          if (!preset) return;

          this.plugin.settings.embeddingApiUrl = preset.apiUrl;
          this.plugin.settings.embeddingModel = preset.model;
          this.flushSave();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("For example https://api.openai.com/v1 or http://localhost:11434/v1")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.embeddingApiUrl)
          .onChange((value) => {
            this.plugin.settings.embeddingApiUrl = normalizeBaseUrl(value);
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional for local endpoints. Stored in plain text in this vault's data.json.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.embeddingApiKey)
          .onChange((value) => {
            this.plugin.settings.embeddingApiKey = value.trim();
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("For example text-embedding-3-small, nomic-embed-text, bge-m3")
      .addText((text) => {
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.plugin.settings.embeddingModel)
          .onChange((value) => {
            this.plugin.settings.embeddingModel = value.trim();
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Dimensions")
      .setDesc(`Current index: ${this.plugin.vectorDbService.getDimension()} dimensions.`)
      .addButton((button) => {
        button.setButtonText("Test connection").onClick(async () => {
          button.setButtonText("Testing...").setDisabled(true);
          try {
            await this.testEmbeddingConnection();
          } finally {
            button.setButtonText("Test connection").setDisabled(false);
          }
        });
      });
  }

  private renderDimensionWarning(containerEl: HTMLElement): void {
    const signature = embeddingSignature(
      this.plugin.settings.embeddingApiUrl,
      this.plugin.settings.embeddingModel
    );

    if (!this.plugin.settings.dimensionSignature || signature === this.plugin.settings.dimensionSignature) {
      return;
    }

    const warning = containerEl.createDiv({ cls: "cypher-notice-banner" });
    warning.createEl("strong", { text: "Embedding model changed. " });
    warning.createSpan({
      text: "The existing index was built with another model. Test the connection to rebuild it.",
    });
  }

  private async testEmbeddingConnection(): Promise<void> {
    const result = await this.plugin.embeddingService.testConnection();
    if (!result.success || !result.dimension) {
      new Notice(`Cypher: embedding test failed — ${result.error ?? "unknown error"}`);
      return;
    }

    const previous = this.plugin.settings.dimension;
    const changed = result.dimension !== previous;

    if (changed && this.plugin.vectorDbService.getStats().documentCount > 0) {
      const confirmed = await confirmAction(
        this.app,
        "Rebuild the index?",
        `The model returns ${result.dimension}-dimensional vectors but the index uses ${previous}. ` +
          "Existing embeddings must be deleted and the vault re-indexed.",
        "Delete index and continue"
      );
      if (!confirmed) return;
    }

    this.plugin.settings.dimension = result.dimension;
    this.plugin.settings.dimensionSignature = embeddingSignature(
      this.plugin.settings.embeddingApiUrl,
      this.plugin.settings.embeddingModel
    );

    if (changed) {
      this.plugin.settings.hasCompletedInitialIndexing = false;
      await this.plugin.vectorDbService.clear();
      await this.plugin.vectorDbService.init(result.dimension);
      new Notice(`Cypher: ${result.dimension} dimensions detected. Run “Update index”.`);
    } else {
      new Notice(`Cypher: connected (${result.dimension} dimensions).`);
    }

    await this.plugin.saveSettings();
    this.display();
  }

  private renderChatSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Chat model").setHeading();

    containerEl.createEl("p", {
      text: "The chat endpoint can differ from the embedding endpoint. " +
        "The model must support OpenAI-style tool calling.",
      cls: "setting-item-description",
    });

    if (!this.plugin.settings.chatApiKey && this.plugin.settings.chatApiUrl.includes("api.openai.com")) {
      const banner = containerEl.createDiv({ cls: "cypher-notice-banner" });
      banner.createEl("strong", { text: "No chat API key. " });
      banner.createSpan({
        text: "OpenAI requires a key. Use an Ollama preset below to run fully locally.",
      });
    }

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc("Fills the URL and model below.")
      .addDropdown((dropdown) => {
        dropdown.addOption("custom", "Custom");
        for (const preset of CHAT_PROVIDER_PRESETS) {
          dropdown.addOption(preset.name, preset.name);
        }

        const current = CHAT_PROVIDER_PRESETS.find(
          (preset) =>
            preset.apiUrl === this.plugin.settings.chatApiUrl &&
            preset.model === this.plugin.settings.chatModel
        );
        dropdown.setValue(current?.name ?? "custom");

        dropdown.onChange((value) => {
          const preset = CHAT_PROVIDER_PRESETS.find((item) => item.name === value);
          if (!preset) return;

          this.plugin.settings.chatApiUrl = preset.apiUrl;
          this.plugin.settings.chatModel = preset.model;
          this.flushSave();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("For example https://api.openai.com/v1 or http://localhost:11434/v1")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.chatApiUrl)
          .onChange((value) => {
            this.plugin.settings.chatApiUrl = normalizeBaseUrl(value);
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Optional for local endpoints. Stored in plain text in this vault's data.json.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.chatApiKey)
          .onChange((value) => {
            this.plugin.settings.chatApiKey = value.trim();
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("For example qwen2.5:3b, llama3.2, gpt-4o-mini")
      .addText((text) => {
        text
          .setPlaceholder("qwen2.5:3b")
          .setValue(this.plugin.settings.chatModel)
          .onChange((value) => {
            this.plugin.settings.chatModel = value.trim();
            this.queueSave();
          });
      })
      .addButton((button) => {
        button.setButtonText("Test").onClick(async () => {
          button.setButtonText("Testing...").setDisabled(true);
          try {
            const result = await this.plugin.chatService.testChatConnection();
            new Notice(
              result.success
                ? "Cypher: chat endpoint reachable."
                : `Cypher: chat test failed — ${result.error ?? "unknown error"}`
            );
          } finally {
            button.setButtonText("Test").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Copy embedding credentials")
      .setDesc("Use the same base URL and key for chat.")
      .addButton((button) => {
        button.setButtonText("Copy").onClick(async () => {
          this.plugin.settings.chatApiUrl = this.plugin.settings.embeddingApiUrl;
          this.plugin.settings.chatApiKey = this.plugin.settings.embeddingApiKey;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Detect local models")
      .setDesc("Lists models exposed by the configured chat endpoint.")
      .addButton((button) => {
        button.setButtonText("Detect").onClick(async () => {
          button.setButtonText("Detecting...").setDisabled(true);
          try {
            await this.detectLocalModels();
          } finally {
            button.setButtonText("Detect").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Search results per query")
      .setDesc("How many chunks the query_vault tool returns. Lower uses fewer tokens.")
      .addSlider((slider) => {
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.chatTopK)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.chatTopK = value;
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Minimum similarity")
      .setDesc("Chunks below this score are ignored. Raise it for stricter answers.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 0.9, 0.05)
          .setValue(this.plugin.settings.chatSimilarityThreshold)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.chatSimilarityThreshold = value;
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("0 is deterministic, 1 is creative.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.chatTemperature)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.chatTemperature = value;
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Max response tokens")
      .setDesc("Upper bound for each model reply.")
      .addText((text) => {
        text
          .setPlaceholder("1024")
          .setValue(String(this.plugin.settings.chatMaxTokens))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isNaN(parsed)) {
              this.plugin.settings.chatMaxTokens = clamp(parsed, 128, 8192);
              this.queueSave();
            }
          });
      });

    const promptSetting = new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Instructions sent with every request. Edit it to change the assistant's behaviour.")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.chatSystemPrompt)
          .onChange((value) => {
            this.plugin.settings.chatSystemPrompt = value;
            this.plugin.settings.chatSystemPromptCustomized = true;
            this.queueSave();
          });
        text.inputEl.rows = 8;
        text.inputEl.addClass("cypher-prompt-textarea");
      });

    promptSetting.addButton((button) => {
      button.setButtonText("Reset").onClick(async () => {
        this.plugin.settings.chatSystemPrompt = DEFAULT_SYSTEM_PROMPT;
        this.plugin.settings.chatSystemPromptCustomized = false;
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  private async detectLocalModels(): Promise<void> {
    const base = normalizeBaseUrl(
      this.plugin.settings.chatApiUrl || this.plugin.settings.embeddingApiUrl
    );
    if (!base) {
      new Notice("Cypher: set a chat API URL first.");
      return;
    }

    const headers: Record<string, string> = {};
    if (this.plugin.settings.chatApiKey) {
      headers["Authorization"] = `Bearer ${this.plugin.settings.chatApiKey}`;
    }

    try {
      const response = await requestUrl({ url: `${base}/models`, method: "GET", headers, throw: false });
      const payload = response.json as { data?: Array<{ id?: string }> } | null;

      if (response.status !== 200 || !Array.isArray(payload?.data)) {
        new Notice(`Cypher: could not list models (HTTP ${response.status}).`);
        return;
      }

      const models = payload.data
        .map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && !id.includes("embed"));

      if (models.length === 0) {
        new Notice("Cypher: the endpoint did not report any chat models.");
        return;
      }

      this.plugin.settings.chatModel = models[0];
      await this.plugin.saveSettings();
      new Notice(`Cypher: found ${models.length} model(s), selected ${models[0]}.`);
      this.display();
    } catch (error) {
      new Notice(`Cypher: model detection failed — ${error instanceof Error ? error.message : error}`);
    }
  }

  private renderIndexSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Vault index").setHeading();

    const stats = this.plugin.vectorDbService.getStats();
    const card = containerEl.createDiv({ cls: "cypher-summary-card" });
    card.createDiv({
      text: `${stats.uniqueFilesCount} notes · ${stats.documentCount} chunks · ${stats.dimension} dimensions`,
      cls: "cypher-summary-text",
    });
    card.createDiv({
      text: stats.lastSaved
        ? `Last saved ${new Date(stats.lastSaved).toLocaleString()}`
        : "Not saved yet",
      cls: "cypher-summary-subtext",
    });

    new Setting(containerEl)
      .setName("Update index")
      .setDesc("Embeds new and modified notes. Unchanged notes are skipped.")
      .addButton((button) => {
        button.setButtonText("Update").onClick(async () => {
          button.setButtonText("Indexing...").setDisabled(true);
          try {
            const progress = await this.plugin.indexerService.indexVault(false);
            new Notice(
              progress.status === "cancelled"
                ? "Cypher: indexing cancelled."
                : `Cypher: indexed ${progress.indexedChunks} chunk(s).`
            );
            this.display();
          } catch (error) {
            new Notice(`Cypher: ${error instanceof Error ? error.message : error}`);
          } finally {
            button.setButtonText("Update").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Rebuild index")
      .setDesc("Re-embeds every note. Use it after changing the embedding model.")
      .addButton((button) => {
        button
          .setButtonText("Rebuild")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Rebuild the whole index?",
              "Every note is sent to the embedding endpoint again, which may cost money.",
              "Rebuild"
            );
            if (!confirmed) return;

            button.setButtonText("Indexing...").setDisabled(true);
            try {
              await this.plugin.indexerService.indexVault(true);
              new Notice("Cypher: index rebuilt.");
              this.display();
            } catch (error) {
              new Notice(`Cypher: ${error instanceof Error ? error.message : error}`);
            } finally {
              button.setButtonText("Rebuild").setDisabled(false);
            }
          });
      });

    new Setting(containerEl)
      .setName("Delete index")
      .setDesc("Removes all stored vectors. Your notes are not touched.")
      .addButton((button) => {
        button
          .setButtonText("Delete")
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmAction(
              this.app,
              "Delete the index?",
              "You will need to re-index the vault before searching or chatting.",
              "Delete"
            );
            if (!confirmed) return;

            await this.plugin.vectorDbService.clear();
            this.plugin.settings.hasCompletedInitialIndexing = false;
            await this.plugin.saveSettings();
            new Notice("Cypher: index deleted.");
            this.plugin.updateStatusBar();
            this.display();
          });
      });
  }

  private renderChunkingSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Indexing").setHeading();

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Target characters per chunk. Smaller chunks are more precise but more numerous.")
      .addText((text) => {
        text
          .setPlaceholder("800")
          .setValue(String(this.plugin.settings.chunkSize))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isNaN(parsed)) return;

            const size = clamp(parsed, 100, 8000);
            this.plugin.settings.chunkSize = size;
            if (this.plugin.settings.chunkOverlap >= size) {
              this.plugin.settings.chunkOverlap = Math.floor(size / 2);
            }
            this.queueSave();
          });
      });

    const maxOverlap = Math.floor(this.plugin.settings.chunkSize * 0.9);
    new Setting(containerEl)
      .setName("Chunk overlap")
      .setDesc(`Characters repeated between adjacent chunks (max ${maxOverlap}).`)
      .addText((text) => {
        text
          .setPlaceholder("150")
          .setValue(String(this.plugin.settings.chunkOverlap))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isNaN(parsed)) return;

            const limit = Math.floor(this.plugin.settings.chunkSize * 0.9);
            if (parsed > limit) {
              new Notice(`Cypher: overlap must stay below the chunk size (max ${limit}).`);
            }
            this.plugin.settings.chunkOverlap = clamp(parsed, 0, limit);
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Batch size")
      .setDesc("Chunks sent per embedding request. Reduce it if the endpoint rejects large batches.")
      .addText((text) => {
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.batchSize))
          .onChange((value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isNaN(parsed)) return;

            this.plugin.settings.batchSize = clamp(parsed, 1, 256);
            this.queueSave();
          });
      });

    new Setting(containerEl)
      .setName("Index on save")
      .setDesc("Update a note's embeddings whenever it is edited.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoIndexOnSave).onChange((value) => {
          this.plugin.settings.autoIndexOnSave = value;
          this.queueSave();
        });
      });

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folders that are never indexed.")
      .addText((text) => {
        text
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange((value) => {
            this.plugin.settings.excludedFolders = normalizeExcludedFolders(value.split(","));
            this.queueSave();
          });
      });
  }
}
