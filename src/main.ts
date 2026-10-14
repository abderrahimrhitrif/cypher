import { Notice, Plugin, TFile, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, embeddingSignature } from "./settings";
import { ChatService } from "./services/chatService";
import { ConversationService } from "./services/conversationService";
import { EmbeddingService } from "./services/embeddingService";
import { IndexerService } from "./services/indexerService";
import { VectorDbService } from "./services/vectorDbService";
import type { CypherSettings, IndexingProgress } from "./types";
import { normalizeExcludedFolders } from "./utils";
import { CypherChatView, VIEW_TYPE_CYPHER_CHAT } from "./ui/chatView";
import { OnboardingModal } from "./ui/onboardingModal";
import { SearchModal } from "./ui/searchModal";
import { CypherSettingsTab } from "./ui/settingsTab";

const SAVE_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 1_000;
const RENAME_INDEX_DELAY_MS = 2_000;

export default class CypherPlugin extends Plugin {
  public settings: CypherSettings = { ...DEFAULT_SETTINGS };
  public embeddingService!: EmbeddingService;
  public vectorDbService!: VectorDbService;
  public indexerService!: IndexerService;
  public chatService!: ChatService;
  public conversationService!: ConversationService;

  private statusEl: HTMLElement | null = null;
  private pendingIndexes: Map<string, number> = new Map();
  private renameTimer: number | null = null;
  private pendingIncremental = false;
  private unsubscribeProgress: (() => void) | null = null;

  public async onload(): Promise<void> {
    await this.loadSettings();

    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;

    this.embeddingService = new EmbeddingService(this.settings);
    this.vectorDbService = new VectorDbService(
      this.app.vault.adapter,
      pluginDir,
      this.settings.dimension
    );
    this.conversationService = new ConversationService();
    this.indexerService = new IndexerService(
      this.app.vault,
      this.settings,
      this.embeddingService,
      this.vectorDbService,
      () => this.saveSettings()
    );
    this.chatService = new ChatService(
      this.settings,
      this.embeddingService,
      this.vectorDbService,
      this.app.vault,
      this.app.metadataCache
    );

    try {
      await this.vectorDbService.init(this.settings.dimension);
    } catch (error) {
      console.error("[cypher] could not initialize the vector database:", error);
      new Notice("Cypher: the vector index could not be loaded. Re-index the vault.");
    }

    try {
      await this.conversationService.init();
    } catch (error) {
      console.error("[cypher] could not initialize chat storage:", error);
    }

    this.registerView(VIEW_TYPE_CYPHER_CHAT, (leaf) => new CypherChatView(leaf, this));
    this.addSettingTab(new CypherSettingsTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.updateStatusBar();
    this.unsubscribeProgress = this.indexerService.onProgress((progress) =>
      this.renderProgress(progress)
    );

    this.registerCommands();
    this.registerVaultEvents();
    this.registerInterval(
      window.setInterval(() => {
        void this.vectorDbService.save().catch((error) =>
          console.error("[cypher] periodic save failed:", error)
        );
      }, SAVE_INTERVAL_MS)
    );

    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBar();

      if (this.needsOnboarding()) {
        window.setTimeout(() => this.openOnboardingModal(), 800);
      }

      // Runs in the background: a slow or offline embedding endpoint must never
      // block the rest of the plugin from loading.
      void this.verifyEmbeddingDimension();
    });
  }

  public async onunload(): Promise<void> {
    this.indexerService.cancel();
    this.unsubscribeProgress?.();

    for (const timer of this.pendingIndexes.values()) {
      window.clearTimeout(timer);
    }
    this.pendingIndexes.clear();

    if (this.renameTimer) {
      window.clearTimeout(this.renameTimer);
      this.renameTimer = null;
    }

    await this.vectorDbService.save().catch((error) =>
      console.error("[cypher] could not save the index on unload:", error)
    );
  }

  private registerCommands(): void {
    this.addRibbonIcon("bot", "Cypher: open chat", () => void this.activateChatView());
    this.addRibbonIcon("sparkles", "Cypher: semantic search", () => this.openSearchModal());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateChatView(),
    });

    this.addCommand({
      id: "semantic-search",
      name: "Semantic search",
      callback: () => this.openSearchModal(),
    });

    this.addCommand({
      id: "index-vault",
      name: "Update index (incremental)",
      callback: () => void this.runIndexing(false),
    });

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild index",
      callback: () => void this.runIndexing(true),
    });

    this.addCommand({
      id: "cancel-index",
      name: "Cancel running index",
      checkCallback: (checking) => {
        if (!this.indexerService.isIndexing()) return false;
        if (!checking) this.indexerService.cancel();
        return true;
      },
    });

    this.addCommand({
      id: "setup-wizard",
      name: "Run setup wizard",
      callback: () => this.openOnboardingModal(),
    });
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.queueIndex(file, 300);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (
          file instanceof TFile &&
          file.extension === "md" &&
          this.settings.autoIndexOnSave
        ) {
          this.queueIndex(file, DEBOUNCE_MS);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const timer = this.pendingIndexes.get(file.path);
        if (timer) {
          clearTimeout(timer);
          this.pendingIndexes.delete(file.path);
        }

        void this.indexerService.handleFileDeleted(file.path).then(() => {
          this.updateStatusBar();
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) && !(file instanceof TFolder)) return;

        void this.indexerService.handlePathRenamed(oldPath).then((affected) => {
          if (affected > 0) {
            this.scheduleIncrementalIndex();
          }
          this.updateStatusBar();
        });
      })
    );
  }

  /** Batches the re-index that follows a rename or a burst of new notes. */
  private scheduleIncrementalIndex(): void {
    if (this.renameTimer) {
      window.clearTimeout(this.renameTimer);
    }

    this.renameTimer = window.setTimeout(() => {
      this.renameTimer = null;
      void this.indexerService
        .indexVault(false)
        .then(() => this.updateStatusBar())
        .catch((error) => {
          if (this.indexerService.isIndexing()) {
            this.pendingIncremental = true;
            return;
          }
          console.error("[cypher] incremental index after rename failed:", error);
        });
    }, RENAME_INDEX_DELAY_MS);
  }

  private queueIndex(file: TFile, delay: number): void {
    const existing = this.pendingIndexes.get(file.path);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.pendingIndexes.delete(file.path);

      void this.indexerService.indexSingleFile(file).then((indexed) => {
        if (indexed) {
          this.updateStatusBar();
        } else if (this.indexerService.isIndexing()) {
          // A full scan is running and has already read this file; index it
          // again once the scan finishes so edits are never lost.
          this.pendingIncremental = true;
        }
      });
    }, delay);

    this.pendingIndexes.set(file.path, timer);
  }

  private async runIndexing(force: boolean): Promise<void> {
    if (this.indexerService.isIndexing()) {
      new Notice("Cypher: indexing is already running.");
      return;
    }

    new Notice(force ? "Cypher: rebuilding the vault index..." : "Cypher: updating the vault index...");
    try {
      const progress = await this.indexerService.indexVault(force);
      if (progress.status === "cancelled") {
        new Notice("Cypher: indexing cancelled.");
      } else if (progress.failedFiles.length > 0) {
        new Notice(
          `Cypher: indexed with ${progress.failedFiles.length} failure(s). See the developer console for details.`
        );
      } else {
        new Notice("Cypher: vault index is up to date.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Cypher: indexing failed — ${message}`);
    } finally {
      this.updateStatusBar();
    }
  }

  public async loadSettings(): Promise<void> {
    // Early versions stored a single embedding endpoint as `apiUrl/apiKey/model`.
    type PersistedSettings = Partial<CypherSettings> & {
      apiUrl?: string;
      apiKey?: string;
      model?: string;
    };

    const data = (await this.loadData()) as PersistedSettings | null;
    const settings: CypherSettings = {
      ...DEFAULT_SETTINGS,
      ...data,
      excludedFolders: normalizeExcludedFolders(
        data?.excludedFolders ?? DEFAULT_SETTINGS.excludedFolders
      ),
    };

    if (data) {
      if (data.embeddingApiUrl === undefined && data.apiUrl) {
        settings.embeddingApiUrl = data.apiUrl;
      }
      if (data.embeddingApiKey === undefined && data.apiKey) {
        settings.embeddingApiKey = data.apiKey;
      }
      if (data.embeddingModel === undefined && data.model) {
        settings.embeddingModel = data.model;
      }
    }

    // Prompts are only auto-upgraded while the user has never edited them.
    if (data?.chatSystemPromptCustomized !== true) {
      settings.chatSystemPrompt = DEFAULT_SETTINGS.chatSystemPrompt;
      settings.chatSystemPromptCustomized = false;
    }

    this.settings = settings;
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.embeddingService?.updateSettings(this.settings);
    this.indexerService?.updateSettings(this.settings);
    this.chatService?.updateSettings(this.settings);
  }

  /**
   * Detects the embedding dimension once per configured model. The result is
   * cached in `dimensionSignature`, so normal startups make no network calls.
   */
  private async verifyEmbeddingDimension(): Promise<void> {
    const url = this.settings.embeddingApiUrl;
    const model = this.settings.embeddingModel;
    if (!url.trim() || !model.trim()) return;

    const signature = embeddingSignature(url, model);
    if (signature === this.settings.dimensionSignature) return;

    const result = await this.embeddingService.testConnection();
    if (!result.success || !result.dimension) {
      return;
    }

    const previous = this.settings.dimension;
    this.settings.dimensionSignature = signature;
    this.settings.dimension = result.dimension;

    if (result.dimension !== previous) {
      this.settings.hasCompletedInitialIndexing = false;
      await this.vectorDbService.clear();
      await this.vectorDbService.init(result.dimension);
      new Notice(
        `Cypher: the embedding model now returns ${result.dimension} dimensions (was ${previous}). ` +
          "The old index was removed and the vault needs to be re-indexed."
      );
    }

    await this.saveSettings();
    this.updateStatusBar();
  }

  public needsOnboarding(): boolean {
    return (
      !this.settings.hasCompletedInitialIndexing &&
      this.vectorDbService.getStats().documentCount === 0
    );
  }

  public isReady(): boolean {
    return this.vectorDbService.getStats().documentCount > 0;
  }

  public async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CYPHER_CHAT);

    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: VIEW_TYPE_CYPHER_CHAT, active: true });
    await workspace.revealLeaf(leaf);
  }

  public openOnboardingModal(): void {
    new OnboardingModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      this.embeddingService,
      this.vectorDbService,
      this.indexerService,
      () => this.updateStatusBar()
    ).open();
  }

  public openSearchModal(): void {
    if (!this.isReady()) {
      new Notice("Cypher: index your vault before searching.");
      this.openOnboardingModal();
      return;
    }

    new SearchModal(
      this.app,
      this.embeddingService,
      this.vectorDbService,
      this.settings
    ).open();
  }

  public updateStatusBar(): void {
    if (!this.statusEl) return;

    const stats = this.vectorDbService.getStats();
    this.statusEl.setText(
      stats.documentCount === 0
        ? "Cypher: not indexed"
        : `Cypher: ${stats.uniqueFilesCount} notes`
    );
    this.statusEl.setAttr("aria-label", `${stats.documentCount} indexed chunks`);
  }

  private renderProgress(progress: IndexingProgress): void {
    if (!this.statusEl) return;

    if (progress.status === "indexing" || progress.status === "scanning") {
      const total = progress.totalFiles || 0;
      this.statusEl.setText(
        total > 0 ? `Cypher: indexing ${progress.processedFiles}/${total}` : "Cypher: scanning"
      );
      return;
    }

    if (progress.status === "paused") {
      this.statusEl.setText("Cypher: indexing paused");
      return;
    }

    if (progress.status === "error") {
      this.statusEl.setText("Cypher: index failed");
      return;
    }

    this.updateStatusBar();

    if (this.pendingIncremental && progress.status !== "idle") {
      this.pendingIncremental = false;
      this.scheduleIncrementalIndex();
    }
  }
}
