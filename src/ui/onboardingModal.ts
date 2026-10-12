import { App, Modal, Notice, Setting } from "obsidian";
import { EmbeddingService } from "../services/embeddingService";
import { IndexerService } from "../services/indexerService";
import { VectorDbService } from "../services/vectorDbService";
import { CypherSettings, IndexingProgress } from "../types";

export class OnboardingModal extends Modal {
  private settings: CypherSettings;
  private saveSettings: () => Promise<void>;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;
  private indexer: IndexerService;
  private onComplete?: () => void;

  private step: "config" | "indexing" | "finished" = "config";
  private testing = false;
  private statusEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private pctEl: HTMLElement | null = null;
  private fileEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private unsub: (() => void) | null = null;

  constructor(
    app: App,
    settings: CypherSettings,
    saveSettings: () => Promise<void>,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService,
    indexer: IndexerService,
    onComplete?: () => void
  ) {
    super(app);
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
    this.indexer = indexer;
    this.onComplete = onComplete;
  }

  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cypher-modal", "cypher-onboarding-modal");
    this.render();
  }

  public onClose(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    const { contentEl } = this;
    contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "cypher-header-minimal" });
    header.createEl("h2", { text: "Cypher Setup", cls: "cypher-modal-title" });
    header.createEl("p", {
      text: "Configure an embedding model to index your vault into a local vector database.",
      cls: "cypher-modal-subtitle",
    });

    if (this.step === "config") {
      this.renderConfig(contentEl);
    } else if (this.step === "indexing") {
      this.renderIndexing(contentEl);
    } else if (this.step === "finished") {
      this.renderFinished(contentEl);
    }
  }

  private renderConfig(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-step-container" });

    new Setting(box)
      .setName("API Base URL")
      .setDesc("OpenAI-compatible embeddings endpoint")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.settings.embeddingApiUrl || this.settings.apiUrl || "")
          .onChange((val) => {
            this.settings.embeddingApiUrl = val.trim();
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    new Setting(box)
      .setName("API Key")
      .setDesc("Leave empty for local endpoints like Ollama")
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
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    new Setting(box)
      .setName("Embedding Model")
      .setDesc("e.g. text-embedding-3-small, nomic-embed-text")
      .addText((text) => {
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.settings.embeddingModel || this.settings.model || "")
          .onChange((val) => {
            this.settings.embeddingModel = val.trim();
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    const testRow = box.createDiv({ cls: "cypher-test-row" });
    const btn = testRow.createEl("button", {
      text: "Test Connection",
      cls: "cypher-btn-secondary",
    });

    this.statusEl = testRow.createSpan({ cls: "cypher-test-status" });

    btn.onclick = async () => {
      await this.testConn(btn);
    };

    const footer = box.createDiv({ cls: "cypher-footer-actions" });

    this.startBtn = footer.createEl("button", {
      text: "Index Vault",
      cls: "mod-cta cypher-start-btn",
    });

    this.updateStartBtn();

    this.startBtn.onclick = async () => {
      const embedUrl = this.settings.embeddingApiUrl || this.settings.apiUrl || "";
      if (embedUrl.includes("11434") || embedUrl.includes("1234")) {
        if (!this.settings.chatApiUrl || this.settings.chatApiUrl.includes("api.openai.com")) {
          this.settings.chatApiUrl = embedUrl;
          this.settings.chatApiKey = this.settings.embeddingApiKey || "";
          this.settings.chatModel = "qwen3.5:2b";
        }
      } else if (!this.settings.chatApiUrl) {
        this.settings.chatApiUrl = embedUrl;
      }
      if (this.settings.chatApiKey === "" && this.settings.embeddingApiKey) {
        this.settings.chatApiKey = this.settings.embeddingApiKey;
      }
      await this.saveSettings();
      this.step = "indexing";
      this.render();
      this.startIndexing();
    };
  }

  private updateStartBtn(): void {
    if (!this.startBtn) return;
    const url = this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const model = this.settings.embeddingModel || this.settings.model || "";
    const valid = url.trim().length > 0 && model.trim().length > 0;
    this.startBtn.disabled = !valid;
  }

  private async testConn(btn: HTMLButtonElement): Promise<void> {
    if (this.testing) return;
    this.testing = true;
    btn.disabled = true;
    btn.setText("Testing...");

    if (this.statusEl) {
      this.statusEl.empty();
      this.statusEl.className = "cypher-test-status cypher-status-loading";
      this.statusEl.setText("Connecting...");
    }

    try {
      this.embedSvc.updateSettings(this.settings);
      const res = await this.embedSvc.testConnection(
        this.settings.embeddingApiUrl || this.settings.apiUrl,
        this.settings.embeddingApiKey !== undefined
          ? this.settings.embeddingApiKey
          : this.settings.apiKey,
        this.settings.embeddingModel || this.settings.model
      );

      if (res.success && res.dimension) {
        this.settings.dimension = res.dimension;
        await this.saveSettings();

        if (this.statusEl) {
          this.statusEl.className = "cypher-test-status cypher-status-success";
          this.statusEl.setText(`Connected (${res.dimension} dimensions)`);
        }
      } else {
        if (this.statusEl) {
          this.statusEl.className = "cypher-test-status cypher-status-error";
          this.statusEl.setText(`Failed: ${res.error || "Unknown error"}`);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.className = "cypher-test-status cypher-status-error";
        this.statusEl.setText(`Error: ${error}`);
      }
    } finally {
      this.testing = false;
      btn.disabled = false;
      btn.setText("Test Connection");
      this.updateStartBtn();
    }
  }

  private renderIndexing(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-step-container" });
    const card = box.createDiv({ cls: "cypher-indexing-card" });

    const statusRow = card.createDiv({ cls: "cypher-status-row" });
    this.badgeEl = statusRow.createDiv({ cls: "cypher-pill-badge" });
    this.badgeEl.setText("Scanning notes...");
    this.pctEl = statusRow.createDiv({ cls: "cypher-progress-percent" });
    this.pctEl.setText("0%");

    const track = card.createDiv({ cls: "cypher-progress-track" });
    this.barEl = track.createDiv({ cls: "cypher-progress-fill" });
    this.barEl.style.width = "0%";

    const details = card.createDiv({ cls: "cypher-details-grid" });
    const fileRow = details.createDiv({ cls: "cypher-detail-item" });
    fileRow.createSpan({ text: "File: ", cls: "cypher-detail-label" });
    this.fileEl = fileRow.createSpan({ text: "Initializing...", cls: "cypher-detail-value" });

    const controls = card.createDiv({ cls: "cypher-indexing-controls" });
    const pauseBtn = controls.createEl("button", { text: "Pause", cls: "cypher-btn-secondary" });
    let paused = false;
    pauseBtn.onclick = () => {
      if (!paused) {
        this.indexer.pause();
        pauseBtn.setText("Resume");
        paused = true;
      } else {
        this.indexer.resume();
        pauseBtn.setText("Pause");
        paused = false;
      }
    };

    const cancelBtn = controls.createEl("button", { text: "Cancel", cls: "cypher-btn-danger" });
    cancelBtn.onclick = () => {
      this.indexer.cancel();
      this.close();
      new Notice("Vault indexing cancelled.");
    };
  }

  private renderFinished(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-step-container cypher-step-finished" });

    box.createEl("h3", { text: "Indexing Complete" });
    box.createEl("p", {
      text: "Your vault notes have been converted to vector embeddings and stored locally.",
      cls: "cypher-modal-subtitle",
    });

    const stats = this.vecDb.getStats();
    const card = box.createDiv({ cls: "cypher-summary-card" });
    card.createDiv({ text: `${stats.uniqueFilesCount} notes indexed (${stats.documentCount} vector chunks)` });
    card.createDiv({ text: `Stored locally in .obsidian/plugins/cypher/orama_db.json`, cls: "cypher-summary-subtext" });

    const footer = box.createDiv({ cls: "cypher-footer-actions" });
    const doneBtn = footer.createEl("button", { text: "Done", cls: "mod-cta" });
    doneBtn.onclick = () => {
      this.close();
      if (this.onComplete) {
        this.onComplete();
      }
    };
  }

  private async startIndexing(): Promise<void> {
    this.unsub = this.indexer.onProgress((p) => {
      this.updateProgress(p);
    });

    try {
      try {
        const testRes = await this.embedSvc.testConnection(
          this.settings.embeddingApiUrl || this.settings.apiUrl,
          this.settings.embeddingApiKey !== undefined
            ? this.settings.embeddingApiKey
            : this.settings.apiKey,
          this.settings.embeddingModel || this.settings.model
        );
        if (testRes.success && testRes.dimension) {
          this.settings.dimension = testRes.dimension;
          await this.saveSettings();
        }
      } catch (err) {
        console.warn("[Cypher Onboarding] Could not pre-detect dimension:", err);
      }

      await this.vecDb.init(this.settings.dimension);

      const progress = await this.indexer.indexVault(false);
      this.settings.hasCompletedInitialIndexing = true;
      this.settings.lastIndexedTime = Date.now();
      await this.saveSettings();

      if (progress.status === "completed") {
        this.step = "finished";
        this.render();
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      new Notice(`Indexing error: ${error}`);
      if (this.badgeEl) {
        this.badgeEl.setText("Error");
        this.badgeEl.className = "cypher-pill-badge cypher-pill-error";
      }
    }
  }

  private updateProgress(p: IndexingProgress): void {
    if (!this.barEl || !this.pctEl) return;

    const pct = p.totalFiles > 0 ? Math.round((p.processedFiles / p.totalFiles) * 100) : 0;

    this.barEl.style.width = `${pct}%`;
    this.pctEl.setText(`${pct}%`);

    if (this.fileEl) {
      this.fileEl.setText(
        p.currentFile ? `${p.currentFile} (${p.processedFiles}/${p.totalFiles})` : "Processing..."
      );
    }

    if (this.badgeEl) {
      if (p.status === "paused") {
        this.badgeEl.setText("Paused");
        this.badgeEl.className = "cypher-pill-badge cypher-pill-paused";
      } else if (p.status === "error") {
        this.badgeEl.setText("Error");
        this.badgeEl.className = "cypher-pill-badge cypher-pill-error";
      } else if (p.status === "completed") {
        this.badgeEl.setText("Complete");
        this.badgeEl.className = "cypher-pill-badge cypher-pill-success";
      } else {
        this.badgeEl.setText("Indexing");
        this.badgeEl.className = "cypher-pill-badge cypher-pill-active";
      }
    }
  }
}
