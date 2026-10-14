import { App, Modal, Notice, Setting } from "obsidian";
import type { EmbeddingService } from "../services/embeddingService";
import type { IndexerService } from "../services/indexerService";
import type { VectorDbService } from "../services/vectorDbService";
import type { CypherSettings, IndexingProgress } from "../types";
import { describeError } from "../errors";
import { normalizeBaseUrl } from "../utils";
import { confirmAction } from "./modals";

type Step = "config" | "indexing" | "finished";

export class OnboardingModal extends Modal {
  private settings: CypherSettings;
  private saveSettings: () => Promise<void>;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;
  private indexer: IndexerService;
  private onComplete?: () => void;

  private step: Step = "config";
  private testing = false;
  private statusEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private pctEl: HTMLElement | null = null;
  private fileEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private unsubscribe: (() => void) | null = null;

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
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
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
    } else {
      this.renderFinished(contentEl);
    }
  }

  private renderConfig(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-step-container" });

    new Setting(box)
      .setName("API base URL")
      .setDesc("OpenAI-compatible embeddings endpoint")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.settings.embeddingApiUrl)
          .onChange((value) => {
            this.settings.embeddingApiUrl = normalizeBaseUrl(value);
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    new Setting(box)
      .setName("API key")
      .setDesc("Leave empty for local endpoints like Ollama")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.settings.embeddingApiKey)
          .onChange((value) => {
            this.settings.embeddingApiKey = value.trim();
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    new Setting(box)
      .setName("Embedding model")
      .setDesc("For example text-embedding-3-small or nomic-embed-text")
      .addText((text) => {
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.settings.embeddingModel)
          .onChange((value) => {
            this.settings.embeddingModel = value.trim();
            this.updateStartBtn();
          });
        text.inputEl.addClass("cypher-input-wide");
      });

    const testRow = box.createDiv({ cls: "cypher-test-row" });
    const testButton = testRow.createEl("button", {
      text: "Test connection",
      cls: "cypher-btn-secondary",
      attr: { type: "button" },
    });
    this.statusEl = testRow.createSpan({ cls: "cypher-test-status" });
    testButton.onclick = () => void this.testConnection(testButton);

    const footer = box.createDiv({ cls: "cypher-footer-actions" });
    this.startBtn = footer.createEl("button", {
      text: "Index vault",
      cls: "mod-cta cypher-start-btn",
      attr: { type: "button" },
    });
    this.updateStartBtn();
    this.startBtn.onclick = () => void this.startIndexing();

    const hint = footer.createSpan({
      text: "Notes stay on disk; only text is sent to your embedding endpoint.",
      cls: "cypher-modal-hint",
    });
    hint.setAttr("aria-hidden", "true");
  }

  private updateStartBtn(): void {
    if (!this.startBtn) return;
    const valid =
      this.settings.embeddingApiUrl.trim().length > 0 &&
      this.settings.embeddingModel.trim().length > 0;
    this.startBtn.disabled = !valid || this.testing;
  }

  /** Detects the vector size and clears a stale index only after confirmation. */
  private async testConnection(button: HTMLButtonElement): Promise<void> {
    if (this.testing) return;

    this.testing = true;
    button.disabled = true;
    button.setText("Testing...");
    this.updateStartBtn();
    this.setStatus("Connecting...", "loading");

    try {
      this.embedSvc.updateSettings(this.settings);
      const result = await this.embedSvc.testConnection();

      if (!result.success || !result.dimension) {
        this.setStatus(`Failed: ${result.error ?? "unknown error"}`, "error");
        return;
      }

      const changed = result.dimension !== this.settings.dimension;
      const hasData = this.vecDb.getStats().documentCount > 0;

      if (changed && hasData) {
        const confirmed = await confirmAction(
          this.app,
          "Rebuild the index?",
          `The model returns ${result.dimension}-dimensional vectors but the current index uses ` +
            `${this.settings.dimension}. The existing index must be deleted and the vault re-indexed.`,
          "Delete index"
        );
        if (!confirmed) {
          this.setStatus("Connection works. Index kept unchanged.", "success");
          return;
        }
      }

      this.settings.dimension = result.dimension;
      await this.saveSettings();

      if (changed) {
        this.settings.hasCompletedInitialIndexing = false;
        await this.vecDb.clear();
        await this.vecDb.init(result.dimension);
      }

      this.setStatus(`Connected (${result.dimension} dimensions)`, "success");
    } catch (error) {
      this.setStatus(describeError(error), "error");
    } finally {
      this.testing = false;
      button.disabled = false;
      button.setText("Test connection");
      this.updateStartBtn();
    }
  }

  private setStatus(text: string, state: "loading" | "success" | "error"): void {
    if (!this.statusEl) return;
    this.statusEl.className = `cypher-test-status cypher-status-${state}`;
    this.statusEl.setText(text);
  }

  private async startIndexing(): Promise<void> {
    // Chat defaults follow the embedding endpoint unless the user configured
    // chat separately. The model is intentionally left for the user to choose.
    if (!this.settings.chatApiUrl.trim()) {
      this.settings.chatApiUrl = this.settings.embeddingApiUrl;
    }
    if (!this.settings.chatApiKey.trim()) {
      this.settings.chatApiKey = this.settings.embeddingApiKey;
    }
    await this.saveSettings();

    this.step = "indexing";
    this.render();

    this.unsubscribe = this.indexer.onProgress((progress) => this.updateProgress(progress));

    try {
      this.embedSvc.updateSettings(this.settings);
      const probe = await this.embedSvc.testConnection();

      if (probe.success && probe.dimension) {
        const changed = probe.dimension !== this.settings.dimension;
        this.settings.dimension = probe.dimension;
        await this.saveSettings();

        if (changed) {
          await this.vecDb.clear();
          await this.vecDb.init(probe.dimension);
        }
      } else {
        // The indexer recovers from a dimension mismatch on its own, so a
        // failed probe is reported here but never blocks the first index.
        console.warn(`[cypher] embedding probe failed: ${probe.error ?? "unknown error"}`);
      }

      await this.vecDb.init(this.settings.dimension);
      const progress = await this.indexer.indexVault(false);

      if (progress.status === "completed") {
        this.settings.hasCompletedInitialIndexing = true;
        this.settings.lastIndexedTime = Date.now();
        await this.saveSettings();
        this.step = "finished";
        this.render();
      } else if (progress.status === "cancelled") {
        new Notice("Cypher: indexing cancelled.");
        this.close();
      } else {
        this.showError(progress.errorMessage ?? "Indexing did not finish.");
      }
    } catch (error) {
      this.showError(describeError(error));
    }
  }

  private showError(message: string): void {
    new Notice(`Cypher: ${message}`);
    if (!this.badgeEl) return;
    this.badgeEl.setText("Error");
    this.badgeEl.className = "cypher-pill-badge cypher-pill-error";
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
    this.fileEl = fileRow.createSpan({ text: "Preparing...", cls: "cypher-detail-value" });

    const controls = card.createDiv({ cls: "cypher-indexing-controls" });

    let paused = false;
    const pauseButton = controls.createEl("button", {
      text: "Pause",
      cls: "cypher-btn-secondary",
      attr: { type: "button" },
    });
    pauseButton.onclick = () => {
      if (paused) {
        this.indexer.resume();
        pauseButton.setText("Pause");
      } else {
        this.indexer.pause();
        pauseButton.setText("Resume");
      }
      paused = !paused;
    };

    const cancelButton = controls.createEl("button", {
      text: "Cancel",
      cls: "cypher-btn-danger",
      attr: { type: "button" },
    });
    cancelButton.onclick = () => {
      this.indexer.cancel();
      new Notice("Cypher: indexing cancelled.");
      this.close();
    };
  }

  private renderFinished(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-step-container cypher-step-finished" });

    box.createEl("h3", { text: "Indexing complete" });
    box.createEl("p", {
      text: "Your notes are now stored as vectors inside this vault's plugin folder.",
      cls: "cypher-modal-subtitle",
    });

    const stats = this.vecDb.getStats();
    const card = box.createDiv({ cls: "cypher-summary-card" });
    card.createDiv({
      text: `${stats.uniqueFilesCount} notes · ${stats.documentCount} chunks · ${stats.dimension} dimensions`,
    });

    const next = box.createDiv({ cls: "cypher-summary-subtext" });
    next.setText("Next: open the chat view, ask a question, and mention the notes you want cited.");

    const footer = box.createDiv({ cls: "cypher-footer-actions" });
    const doneButton = footer.createEl("button", {
      text: "Done",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    doneButton.onclick = () => {
      this.close();
      this.onComplete?.();
    };

    const openChat = footer.createEl("button", {
      text: "Open chat",
      cls: "cypher-btn-secondary",
      attr: { type: "button" },
    });
    openChat.onclick = () => {
      this.close();
      this.onComplete?.();
      const commands = (this.app as unknown as {
        commands?: { executeCommandById: (id: string) => boolean };
      }).commands;
      commands?.executeCommandById("cypher:open-chat");
    };
  }

  private updateProgress(progress: IndexingProgress): void {
    if (!this.barEl || !this.pctEl) return;

    const percent =
      progress.totalFiles > 0
        ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
        : 0;

    this.barEl.style.width = `${percent}%`;
    this.pctEl.setText(`${percent}%`);

    if (this.fileEl) {
      this.fileEl.setText(
        progress.currentFile
          ? `${progress.currentFile} (${progress.processedFiles}/${progress.totalFiles})`
          : "Processing..."
      );
    }

    if (!this.badgeEl) return;

    const states: Record<string, [string, string]> = {
      paused: ["Paused", "cypher-pill-paused"],
      error: ["Error", "cypher-pill-error"],
      completed: ["Complete", "cypher-pill-success"],
      cancelled: ["Cancelled", "cypher-pill-paused"],
    };

    const [label, cls] = states[progress.status] ?? ["Indexing", "cypher-pill-active"];
    this.badgeEl.setText(label);
    this.badgeEl.className = `cypher-pill-badge ${cls}`;
  }
}
