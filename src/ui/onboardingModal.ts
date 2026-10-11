import { App, Modal, Notice, Setting } from "obsidian";
import { PROVIDER_PRESETS } from "../settings";
import { EmbeddingService } from "../services/embeddingService";
import { IndexerService } from "../services/indexerService";
import { VectorDbService } from "../services/vectorDbService";
import { CypherSettings, IndexingProgress } from "../types";

export class OnboardingModal extends Modal {
  private settings: CypherSettings;
  private saveSettings: () => Promise<void>;
  private embeddingService: EmbeddingService;
  private vectorDbService: VectorDbService;
  private indexerService: IndexerService;
  private onComplete?: () => void;

  private currentStep: "config" | "indexing" | "finished" = "config";
  private isTestingConnection = false;
  private connectionTested = false;
  private detectedDimension = 1536;
  private testStatusEl: HTMLElement | null = null;
  private progressBarEl: HTMLElement | null = null;
  private progressPercentEl: HTMLElement | null = null;
  private currentFileEl: HTMLElement | null = null;
  private chunkCountEl: HTMLElement | null = null;
  private statusBadgeEl: HTMLElement | null = null;
  private startButtonEl: HTMLButtonElement | null = null;
  private unsubscribeProgress: (() => void) | null = null;

  constructor(
    app: App,
    settings: CypherSettings,
    saveSettings: () => Promise<void>,
    embeddingService: EmbeddingService,
    vectorDbService: VectorDbService,
    indexerService: IndexerService,
    onComplete?: () => void
  ) {
    super(app);
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.embeddingService = embeddingService;
    this.vectorDbService = vectorDbService;
    this.indexerService = indexerService;
    this.onComplete = onComplete;
  }

  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cypher-modal", "cypher-onboarding-modal");

    this.render();
  }

  public onClose(): void {
    if (this.unsubscribeProgress) {
      this.unsubscribeProgress();
      this.unsubscribeProgress = null;
    }
    const { contentEl } = this;
    contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Modal Header
    const headerEl = contentEl.createDiv({ cls: "cypher-header" });
    const iconEl = headerEl.createDiv({ cls: "cypher-logo-icon" });
    iconEl.setText("⚡");
    const titleBox = headerEl.createDiv({ cls: "cypher-title-box" });
    titleBox.createEl("h2", { text: "Welcome to Cypher", cls: "cypher-modal-title" });
    titleBox.createEl("p", {
      text: "First-time setup: Connect your embedding model to index your vault into an embedded vector database.",
      cls: "cypher-modal-subtitle",
    });

    if (this.currentStep === "config") {
      this.renderConfigStep(contentEl);
    } else if (this.currentStep === "indexing") {
      this.renderIndexingStep(contentEl);
    } else if (this.currentStep === "finished") {
      this.renderFinishedStep(contentEl);
    }
  }

  private renderConfigStep(container: HTMLElement): void {
    const stepContainer = container.createDiv({ cls: "cypher-step-container" });

    // Step Indicator
    const stepBadge = stepContainer.createDiv({ cls: "cypher-step-badge" });
    stepBadge.setText("Step 1 of 2: API & Embedding Model Setup");

    // Provider Presets Dropdown
    new Setting(stepContainer)
      .setName("Provider Preset")
      .setDesc("Quickly fill standard settings for cloud or local AI servers")
      .addDropdown((dropdown) => {
        dropdown.addOption("custom", "Custom / Other");
        for (const preset of PROVIDER_PRESETS) {
          dropdown.addOption(preset.name, preset.name);
        }

        dropdown.onChange((val) => {
          const found = PROVIDER_PRESETS.find((p) => p.name === val);
          if (found) {
            this.settings.embeddingApiUrl = found.apiUrl;
            this.settings.embeddingModel = found.model;
            this.settings.dimension = found.dimension;
            // Also sync chat settings as a default if they are empty
            if (!this.settings.chatApiUrl) this.settings.chatApiUrl = found.apiUrl;
            this.detectedDimension = found.dimension;
            this.connectionTested = false;
            this.render();
          }
        });
      });

    // Embedding API URL Setting
    new Setting(stepContainer)
      .setName("Embedding API Base URL")
      .setDesc("OpenAI-compatible embeddings endpoint (e.g., https://api.openai.com/v1 or http://localhost:11434/v1)")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.settings.embeddingApiUrl || this.settings.apiUrl || "")
          .onChange((val) => {
            this.settings.embeddingApiUrl = val.trim();
            this.connectionTested = false;
            this.updateStartButtonState();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    // Embedding API Key Setting
    new Setting(stepContainer)
      .setName("Embedding API Key")
      .setDesc("API Key for embeddings (leave empty if using local Ollama / LM Studio without auth)")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(
            this.settings.embeddingApiKey !== undefined
              ? this.settings.embeddingApiKey
              : this.settings.apiKey || ""
          )
          .onChange((val) => {
            this.settings.embeddingApiKey = val.trim();
            this.connectionTested = false;
            this.updateStartButtonState();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    // Embedding Model Setting
    new Setting(stepContainer)
      .setName("Embedding Model")
      .setDesc("Name of the embedding model (e.g., text-embedding-3-small, nomic-embed-text)")
      .addText((text) => {
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.settings.embeddingModel || this.settings.model || "")
          .onChange((val) => {
            this.settings.embeddingModel = val.trim();
            this.connectionTested = false;
            this.updateStartButtonState();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    // Test Connection Container
    const testBox = stepContainer.createDiv({ cls: "cypher-test-box" });
    const testBtn = testBox.createEl("button", {
      text: "Test Connection & Auto-Detect Dimensions",
      cls: "mod-cta cypher-test-btn",
    });

    this.testStatusEl = testBox.createDiv({ cls: "cypher-test-status" });

    testBtn.onclick = async () => {
      await this.runConnectionTest(testBtn);
    };

    // Notes summary
    const totalFiles = this.app.vault.getMarkdownFiles().length;
    const summaryCard = stepContainer.createDiv({ cls: "cypher-summary-card" });
    summaryCard.createEl("div", {
      text: `📁 Detected ${totalFiles} markdown notes in your vault ready to index.`,
      cls: "cypher-summary-text",
    });
    summaryCard.createEl("div", {
      text: `💡 Note: You can configure a separate API & model for conversation / chat in Settings anytime.`,
      cls: "cypher-summary-subtext",
    });

    // Footer actions
    const footer = stepContainer.createDiv({ cls: "cypher-footer-actions" });

    this.startButtonEl = footer.createEl("button", {
      text: "Start Vault Indexing →",
      cls: "mod-cta cypher-start-btn",
    });

    this.updateStartButtonState();

    this.startButtonEl.onclick = async () => {
      await this.saveSettings();
      this.currentStep = "indexing";
      this.render();
      this.startIndexingProcess();
    };
  }

  private updateStartButtonState(): void {
    if (!this.startButtonEl) return;
    const url = this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const model = this.settings.embeddingModel || this.settings.model || "";
    const canStart = url.trim().length > 0 && model.trim().length > 0;
    this.startButtonEl.disabled = !canStart;
  }

  private async runConnectionTest(btnEl: HTMLButtonElement): Promise<void> {
    if (this.isTestingConnection) return;
    this.isTestingConnection = true;
    btnEl.disabled = true;
    btnEl.setText("Testing connection...");

    if (this.testStatusEl) {
      this.testStatusEl.empty();
      this.testStatusEl.className = "cypher-test-status cypher-status-loading";
      this.testStatusEl.setText("Connecting to API and generating test vector...");
    }

    try {
      this.embeddingService.updateSettings(this.settings);
      const res = await this.embeddingService.testConnection(
        this.settings.embeddingApiUrl || this.settings.apiUrl,
        this.settings.embeddingApiKey !== undefined
          ? this.settings.embeddingApiKey
          : this.settings.apiKey,
        this.settings.embeddingModel || this.settings.model
      );

      if (res.success && res.dimension) {
        this.connectionTested = true;
        this.detectedDimension = res.dimension;
        this.settings.dimension = res.dimension;
        await this.saveSettings();

        if (this.testStatusEl) {
          this.testStatusEl.empty();
          this.testStatusEl.className = "cypher-test-status cypher-status-success";
          this.testStatusEl.setText(`✓ Connection successful! Model dimensions: ${res.dimension}`);
        }
        new Notice(`Connected to ${this.settings.model} (${res.dimension} dims)`);
      } else {
        this.connectionTested = false;
        if (this.testStatusEl) {
          this.testStatusEl.empty();
          this.testStatusEl.className = "cypher-test-status cypher-status-error";
          this.testStatusEl.setText(`✗ Connection failed: ${res.error || "Unknown error"}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connectionTested = false;
      if (this.testStatusEl) {
        this.testStatusEl.empty();
        this.testStatusEl.className = "cypher-test-status cypher-status-error";
        this.testStatusEl.setText(`✗ Error: ${msg}`);
      }
    } finally {
      this.isTestingConnection = false;
      btnEl.disabled = false;
      btnEl.setText("Test Connection & Auto-Detect Dimensions");
      this.updateStartButtonState();
    }
  }

  private renderIndexingStep(container: HTMLElement): void {
    const stepContainer = container.createDiv({ cls: "cypher-step-container" });

    const stepBadge = stepContainer.createDiv({ cls: "cypher-step-badge" });
    stepBadge.setText("Step 2 of 2: Indexing Vault Notes");

    const card = stepContainer.createDiv({ cls: "cypher-indexing-card" });

    const statusRow = card.createDiv({ cls: "cypher-status-row" });
    this.statusBadgeEl = statusRow.createDiv({ cls: "cypher-pill-badge" });
    this.statusBadgeEl.setText("Scanning notes...");
    this.progressPercentEl = statusRow.createDiv({ cls: "cypher-progress-percent" });
    this.progressPercentEl.setText("0%");

    // Progress Bar Track
    const track = card.createDiv({ cls: "cypher-progress-track" });
    this.progressBarEl = track.createDiv({ cls: "cypher-progress-fill" });
    this.progressBarEl.style.width = "0%";

    // Info rows
    const detailsGrid = card.createDiv({ cls: "cypher-details-grid" });
    
    const fileRow = detailsGrid.createDiv({ cls: "cypher-detail-item" });
    fileRow.createSpan({ text: "Current file: ", cls: "cypher-detail-label" });
    this.currentFileEl = fileRow.createSpan({ text: "Initializing...", cls: "cypher-detail-value" });

    const chunkRow = detailsGrid.createDiv({ cls: "cypher-detail-item" });
    chunkRow.createSpan({ text: "Vector chunks: ", cls: "cypher-detail-label" });
    this.chunkCountEl = chunkRow.createSpan({ text: "0", cls: "cypher-detail-value" });

    // Controls: Pause / Cancel
    const controls = card.createDiv({ cls: "cypher-indexing-controls" });
    const pauseBtn = controls.createEl("button", { text: "Pause", cls: "cypher-btn-secondary" });
    let isPaused = false;
    pauseBtn.onclick = () => {
      if (!isPaused) {
        this.indexerService.pause();
        pauseBtn.setText("Resume");
        isPaused = true;
      } else {
        this.indexerService.resume();
        pauseBtn.setText("Pause");
        isPaused = false;
      }
    };

    const cancelBtn = controls.createEl("button", { text: "Cancel", cls: "cypher-btn-danger" });
    cancelBtn.onclick = () => {
      this.indexerService.cancel();
      this.close();
      new Notice("Vault indexing cancelled.");
    };
  }

  private renderFinishedStep(container: HTMLElement): void {
    const stepContainer = container.createDiv({ cls: "cypher-step-container cypher-step-finished" });

    const checkIcon = stepContainer.createDiv({ cls: "cypher-success-icon" });
    checkIcon.setText("🎉");

    stepContainer.createEl("h3", { text: "Your Vault is Indexed & Vectorized!" });
    stepContainer.createEl("p", {
      text: "Every note in your vault has been converted into high-dimensional vector embeddings and safely stored in your local vector database.",
      cls: "cypher-modal-subtitle",
    });

    const stats = this.vectorDbService.getStats();
    const statsCard = stepContainer.createDiv({ cls: "cypher-summary-card" });
    statsCard.createDiv({ text: `📊 ${stats.uniqueFilesCount} notes processed into ${stats.documentCount} vector chunks.` });
    statsCard.createDiv({ text: `⚡ Stored locally in .obsidian/plugins/cypher/orama_db.json` });

    const footer = stepContainer.createDiv({ cls: "cypher-footer-actions" });
    const doneBtn = footer.createEl("button", { text: "Finish & Close", cls: "mod-cta" });
    doneBtn.onclick = () => {
      this.close();
      if (this.onComplete) {
        this.onComplete();
      }
    };
  }

  private async startIndexingProcess(): Promise<void> {
    // Subscribe to progress
    this.unsubscribeProgress = this.indexerService.onProgress((p) => {
      this.updateProgressUi(p);
    });

    try {
      // Re-init Vector DB with dimension
      await this.vectorDbService.init(this.settings.dimension);

      const progress = await this.indexerService.indexVault(false);
      this.settings.hasCompletedInitialIndexing = true;
      this.settings.lastIndexedTime = Date.now();
      await this.saveSettings();

      if (progress.status === "completed") {
        this.currentStep = "finished";
        this.render();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Indexing error: ${msg}`);
      if (this.statusBadgeEl) {
        this.statusBadgeEl.setText("Error occurred");
        this.statusBadgeEl.className = "cypher-pill-badge cypher-pill-error";
      }
    }
  }

  private updateProgressUi(progress: IndexingProgress): void {
    if (!this.progressBarEl || !this.progressPercentEl) return;

    const percent =
      progress.totalFiles > 0
        ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
        : 0;

    this.progressBarEl.style.width = `${percent}%`;
    this.progressPercentEl.setText(`${percent}%`);

    if (this.currentFileEl) {
      this.currentFileEl.setText(progress.currentFile || "Processing...");
    }

    if (this.chunkCountEl) {
      this.chunkCountEl.setText(`${progress.indexedChunks} chunks (${progress.processedFiles}/${progress.totalFiles} files)`);
    }

    if (this.statusBadgeEl) {
      if (progress.status === "paused") {
        this.statusBadgeEl.setText("Paused");
        this.statusBadgeEl.className = "cypher-pill-badge cypher-pill-paused";
      } else if (progress.status === "error") {
        this.statusBadgeEl.setText("Error");
        this.statusBadgeEl.className = "cypher-pill-badge cypher-pill-error";
      } else if (progress.status === "completed") {
        this.statusBadgeEl.setText("Done!");
        this.statusBadgeEl.className = "cypher-pill-badge cypher-pill-success";
      } else {
        this.statusBadgeEl.setText("Indexing...");
        this.statusBadgeEl.className = "cypher-pill-badge cypher-pill-active";
      }
    }
  }
}
