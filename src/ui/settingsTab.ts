import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CypherPlugin from "../main";
import { EMBEDDING_PROVIDER_PRESETS, CHAT_PROVIDER_PRESETS, PROVIDER_PRESETS } from "../settings";
import { OnboardingModal } from "./onboardingModal";

export class CypherSettingsTab extends PluginSettingTab {
  private plugin: CypherPlugin;

  constructor(app: App, plugin: CypherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cypher-settings-tab");

    // Header
    const header = containerEl.createDiv({ cls: "cypher-settings-header" });
    header.createEl("h2", { text: "Cypher - AI Vector Search Settings" });
    header.createEl("p", {
      text: "Configure your OpenAI-compatible embedding model and manage your vault vector database.",
      cls: "setting-item-description",
    });

    // Onboarding Banner if not completed
    if (!this.plugin.settings.hasCompletedInitialIndexing) {
      const banner = containerEl.createDiv({ cls: "cypher-notice-banner" });
      banner.createEl("strong", { text: "⚡ First-Time Setup Required: " });
      banner.createSpan({ text: "Your vault notes haven't been indexed into the vector DB yet." });
      const launchBtn = banner.createEl("button", {
        text: "Launch Setup Wizard",
        cls: "mod-cta",
      });
      launchBtn.onclick = () => {
        new OnboardingModal(
          this.app,
          this.plugin.settings,
          () => this.plugin.saveSettings(),
          this.plugin.embeddingService,
          this.plugin.vectorDbService,
          this.plugin.indexerService,
          () => this.display()
        ).open();
      };
    }

    // SECTION: API Configuration
    // SECTION: Embedding API Configuration
    containerEl.createEl("h3", { text: "1. Embedding Model & Vector API" });
    containerEl.createEl("p", {
      text: "Configure the API and model used to convert your notes into vector embeddings.",
      cls: "setting-item-description",
    });

    // Embedding Presets
    new Setting(containerEl)
      .setName("Embedding Provider Preset")
      .setDesc("Quickly fill settings for embedding models (e.g. OpenAI, local Ollama, LM Studio)")
      .addDropdown((dropdown) => {
        dropdown.addOption("custom", "Custom / Other");
        for (const preset of EMBEDDING_PROVIDER_PRESETS) {
          dropdown.addOption(preset.name, preset.name);
        }

        dropdown.onChange(async (val) => {
          const found = EMBEDDING_PROVIDER_PRESETS.find((p) => p.name === val);
          if (found) {
            this.plugin.settings.embeddingApiUrl = found.apiUrl;
            this.plugin.settings.embeddingModel = found.model;
            this.plugin.settings.dimension = found.dimension;
            await this.plugin.saveSettings();
            this.display();
          }
        });
      });

    // Embedding API URL
    new Setting(containerEl)
      .setName("Embedding API Base URL")
      .setDesc("OpenAI-compatible embeddings endpoint (e.g., https://api.openai.com/v1 or http://localhost:11434/v1)")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.embeddingApiUrl || this.plugin.settings.apiUrl || "")
          .onChange(async (val) => {
            this.plugin.settings.embeddingApiUrl = val.trim();
            await this.plugin.saveSettings();
          });
      });

    // Embedding API Key
    new Setting(containerEl)
      .setName("Embedding API Key")
      .setDesc("API key for embedding model (optional for local Ollama / LM Studio)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(
            this.plugin.settings.embeddingApiKey !== undefined
              ? this.plugin.settings.embeddingApiKey
              : this.plugin.settings.apiKey || ""
          )
          .onChange(async (val) => {
            this.plugin.settings.embeddingApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    // Embedding Model Name
    new Setting(containerEl)
      .setName("Embedding Model Name")
      .setDesc("e.g. text-embedding-3-small, nomic-embed-text, bge-m3")
      .addText((text) => {
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.plugin.settings.embeddingModel || this.plugin.settings.model || "")
          .onChange(async (val) => {
            this.plugin.settings.embeddingModel = val.trim();
            await this.plugin.saveSettings();
          });
      });

    // Dimensions & Test Embedding Button
    new Setting(containerEl)
      .setName("Vector Dimension")
      .setDesc(`Current dimension: ${this.plugin.settings.dimension}. Test connection to auto-detect.`)
      .addButton((btn) => {
        btn.setButtonText("Test Embedding Connection").setCta().onClick(async () => {
          btn.setButtonText("Testing...").setDisabled(true);
          try {
            const res = await this.plugin.embeddingService.testConnection();
            if (res.success && res.dimension) {
              this.plugin.settings.dimension = res.dimension;
              await this.plugin.saveSettings();
              new Notice(`Embedding connected! Model dimensions: ${res.dimension}`);
              this.display();
            } else {
              new Notice(`Embedding test failed: ${res.error || "Unknown error"}`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Error: ${msg}`);
          } finally {
            btn.setButtonText("Test Embedding Connection").setDisabled(false);
          }
        });
      });

    // SECTION: Conversation / Chat API Configuration
    containerEl.createEl("h3", { text: "2. Conversation / Chat Model & API" });
    containerEl.createEl("p", {
      text: "Configure the separate API and model used for AI chat and answering questions with the query tool.",
      cls: "setting-item-description",
    });

    // Chat Presets
    new Setting(containerEl)
      .setName("Chat Provider Preset")
      .setDesc("Quickly fill settings for conversation models (e.g. GPT-4o-mini, Claude, local Llama 3.2)")
      .addDropdown((dropdown) => {
        dropdown.addOption("custom", "Custom / Other");
        for (const preset of CHAT_PROVIDER_PRESETS) {
          dropdown.addOption(preset.name, preset.name);
        }

        dropdown.onChange(async (val) => {
          const found = CHAT_PROVIDER_PRESETS.find((p) => p.name === val);
          if (found) {
            this.plugin.settings.chatApiUrl = found.apiUrl;
            this.plugin.settings.chatModel = found.model;
            await this.plugin.saveSettings();
            this.display();
          }
        });
      });

    // Quick helper: Copy from Embedding API
    new Setting(containerEl)
      .setName("Use Same API as Embedding")
      .setDesc("Copy the base URL and API key from your Embedding API configuration")
      .addButton((btn) => {
        btn.setButtonText("Copy from Embedding API").onClick(async () => {
          this.plugin.settings.chatApiUrl =
            this.plugin.settings.embeddingApiUrl || this.plugin.settings.apiUrl || "";
          this.plugin.settings.chatApiKey =
            this.plugin.settings.embeddingApiKey !== undefined
              ? this.plugin.settings.embeddingApiKey
              : this.plugin.settings.apiKey || "";
          await this.plugin.saveSettings();
          new Notice("Copied Embedding API credentials to Chat API");
          this.display();
        });
      });

    // Chat API URL
    new Setting(containerEl)
      .setName("Chat API Base URL")
      .setDesc("OpenAI-compatible chat completions endpoint (e.g., https://api.openai.com/v1 or http://localhost:11434/v1)")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.chatApiUrl || this.plugin.settings.apiUrl || "")
          .onChange(async (val) => {
            this.plugin.settings.chatApiUrl = val.trim();
            await this.plugin.saveSettings();
          });
      });

    // Chat API Key
    new Setting(containerEl)
      .setName("Chat API Key")
      .setDesc("API key for chat model (optional for local Ollama / LM Studio)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(
            this.plugin.settings.chatApiKey !== undefined
              ? this.plugin.settings.chatApiKey
              : this.plugin.settings.apiKey || ""
          )
          .onChange(async (val) => {
            this.plugin.settings.chatApiKey = val.trim();
            await this.plugin.saveSettings();
          });
      });

    // Chat Model Name
    new Setting(containerEl)
      .setName("Chat Model Name")
      .setDesc("e.g. gpt-4o-mini, llama3.2, mistral, anthropic/claude-3.5-sonnet")
      .addText((text) => {
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.chatModel)
          .onChange(async (val) => {
            this.plugin.settings.chatModel = val.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Test Chat API").onClick(async () => {
          btn.setButtonText("Testing...").setDisabled(true);
          try {
            const res = await this.plugin.chatService.testChatConnection();
            if (res.success) {
              new Notice("Chat API connection successful!");
            } else {
              new Notice(`Chat API test failed: ${res.error || "Unknown error"}`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Chat API Error: ${msg}`);
          } finally {
            btn.setButtonText("Test Chat API").setDisabled(false);
          }
        });
      });

    // Chat Top K Query Tool Parameter
    new Setting(containerEl)
      .setName("Default Top-K Query Tool Results (k)")
      .setDesc("Number of most relevant note excerpts retrieved when the model queries your vault")
      .addSlider((slider) => {
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.chatTopK || 5)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.chatTopK = val;
            await this.plugin.saveSettings();
          });
      });

    // Chat System Prompt
    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Instructions strictly restricting model to knowledge from your notes only.")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.chatSystemPrompt)
          .onChange(async (val) => {
            this.plugin.settings.chatSystemPrompt = val;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
      });

    // SECTION: Database Management & Stats
    containerEl.createEl("h3", { text: "Vector Database Status & Actions" });

    const stats = this.plugin.vectorDbService.getStats();
    const statsBox = containerEl.createDiv({ cls: "cypher-summary-card" });
    statsBox.createDiv({
      text: `📊 Indexed Notes: ${stats.uniqueFilesCount} | Vector Chunks: ${stats.documentCount} | Dimensions: ${stats.dimension}`,
      cls: "cypher-summary-text",
    });
    statsBox.createDiv({
      text: `💾 Storage File: .obsidian/plugins/cypher/orama_db.json`,
      cls: "cypher-summary-subtext",
    });

    // Actions
    new Setting(containerEl)
      .setName("Update Index (Incremental)")
      .setDesc("Scans vault and embeds only newly added or modified notes")
      .addButton((btn) => {
        btn.setButtonText("Update Index").onClick(async () => {
          btn.setButtonText("Updating...").setDisabled(true);
          try {
            new Notice("Starting incremental indexing...");
            await this.plugin.indexerService.indexVault(false);
            new Notice("Vault index updated successfully!");
            this.display();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Indexing error: ${msg}`);
          } finally {
            btn.setButtonText("Update Index").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Rebuild Entire Index")
      .setDesc("Forces a complete re-embedding of all markdown notes in your vault")
      .addButton((btn) => {
        btn.setButtonText("Rebuild All").setWarning().onClick(async () => {
          btn.setButtonText("Rebuilding...").setDisabled(true);
          try {
            new Notice("Rebuilding entire vault index...");
            await this.plugin.indexerService.indexVault(true);
            new Notice("Entire vault index rebuilt!");
            this.display();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Rebuild error: ${msg}`);
          } finally {
            btn.setButtonText("Rebuild All").setDisabled(false);
          }
        });
      });

    new Setting(containerEl)
      .setName("Clear Vector Database")
      .setDesc("Deletes all stored embeddings from the local vector database")
      .addButton((btn) => {
        btn.setButtonText("Clear Database").setWarning().onClick(async () => {
          if (confirm("Are you sure you want to clear the vector database? You will need to re-index your vault.")) {
            await this.plugin.vectorDbService.clear();
            this.plugin.settings.hasCompletedInitialIndexing = false;
            await this.plugin.saveSettings();
            new Notice("Vector database cleared.");
            this.display();
          }
        });
      });

    // SECTION: Advanced Chunking & Vault Settings
    containerEl.createEl("h3", { text: "Chunking & Vault Configuration" });

    new Setting(containerEl)
      .setName("Chunk Size")
      .setDesc("Approximate characters per note chunk (default: 800)")
      .addText((text) => {
        text
          .setPlaceholder("800")
          .setValue(String(this.plugin.settings.chunkSize))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 100) {
              this.plugin.settings.chunkSize = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Chunk Overlap")
      .setDesc("Character overlap between adjacent chunks (default: 150)")
      .addText((text) => {
        text
          .setPlaceholder("150")
          .setValue(String(this.plugin.settings.chunkOverlap))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.chunkOverlap = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Batch Size")
      .setDesc("Number of text chunks to send in each API request (default: 20)")
      .addText((text) => {
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.batchSize))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.batchSize = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Auto-index on File Save")
      .setDesc("Automatically update vector embeddings when an existing note is edited")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoIndexOnSave)
          .onChange(async (val) => {
            this.plugin.settings.autoIndexOnSave = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Excluded Folders")
      .setDesc("Comma-separated list of folders to ignore (e.g., .obsidian, .trash, templates)")
      .addText((text) => {
        text
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange(async (val) => {
            this.plugin.settings.excludedFolders = val
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
      });
  }
}
