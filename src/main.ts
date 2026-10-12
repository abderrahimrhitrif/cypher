import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS } from "./settings";
import { ChatService } from "./services/chatService";
import { EmbeddingService } from "./services/embeddingService";
import { IndexerService } from "./services/indexerService";
import { VectorDbService } from "./services/vectorDbService";
import { CypherSettings } from "./types";
import { CypherChatView, VIEW_TYPE_CYPHER_CHAT } from "./ui/chatView";
import { OnboardingModal } from "./ui/onboardingModal";
import { SearchModal } from "./ui/searchModal";
import { CypherSettingsTab } from "./ui/settingsTab";

export default class CypherPlugin extends Plugin {
  public settings: CypherSettings = DEFAULT_SETTINGS;
  public embeddingService!: EmbeddingService;
  public vectorDbService!: VectorDbService;
  public indexerService!: IndexerService;
  public chatService!: ChatService;

  private statusEl: HTMLElement | null = null;
  private debounces: Map<string, NodeJS.Timeout> = new Map();

  public async onload(): Promise<void> {
    console.log("[Cypher] Loading Cypher AI Vector Plugin...");

    await this.loadSettings();

    const dir = `${this.app.vault.configDir}/plugins/cypher`;
    this.embeddingService = new EmbeddingService(this.settings);
    this.vectorDbService = new VectorDbService(
      this.app.vault.adapter,
      dir,
      this.settings.dimension
    );
    this.indexerService = new IndexerService(
      this.app.vault,
      this.settings,
      this.embeddingService,
      this.vectorDbService
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
    } catch (err) {
      console.error("[Cypher] Error initializing vector database:", err);
    }

    this.registerView(
      VIEW_TYPE_CYPHER_CHAT,
      (leaf) => new CypherChatView(leaf, this)
    );

    this.addSettingTab(new CypherSettingsTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.addRibbonIcon("bot", "Cypher: AI Chat", () => {
      this.activateChatView();
    });

    this.addRibbonIcon("sparkles", "Cypher: Semantic Search", () => {
      this.openSearchModal();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open AI Chat (with Vault Query Tool)",
      callback: () => {
        this.activateChatView();
      },
    });

    this.addCommand({
      id: "semantic-search",
      name: "Semantic Search Vault",
      callback: () => {
        this.openSearchModal();
      },
    });

    this.addCommand({
      id: "index-vault",
      name: "Update Vault Index (Incremental)",
      callback: async () => {
        new Notice("Starting incremental indexing...");
        try {
          await this.indexerService.indexVault(false);
          this.updateStatusBar();
          new Notice("Cypher: Vault index updated successfully!");
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          new Notice(`Cypher Indexing Error: ${error}`);
        }
      },
    });

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild Entire Vault Index",
      callback: async () => {
        new Notice("Rebuilding entire vault index...");
        try {
          await this.indexerService.indexVault(true);
          this.updateStatusBar();
          new Notice("Cypher: Vault index rebuilt!");
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          new Notice(`Cypher Rebuild Error: ${error}`);
        }
      },
    });

    this.addCommand({
      id: "setup-wizard",
      name: "Run First-Time Setup Wizard",
      callback: () => {
        this.openOnboardingModal();
      },
    });

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          setTimeout(async () => {
            const indexed = await this.indexerService.handleFileCreated(file);
            this.updateStatusBar();
            if (indexed) {
              new Notice(`Cypher: Added "${file.basename}" to vector DB`);
            }
          }, 100);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        const path = file.path;
        const timer = this.debounces.get(path);
        if (timer) {
          clearTimeout(timer);
          this.debounces.delete(path);
        }

        await this.indexerService.handleFileDeleted(path);
        this.updateStatusBar();
        new Notice(`Cypher: Removed "${file.name}" from vector DB`);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md" && this.settings.autoIndexOnSave) {
          this.queueIndex(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.indexerService.handleFileRenamed(oldPath, file.path);
          await this.vectorDbService.save();
          this.updateStatusBar();
        }
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBar();
      if (!this.settings.hasCompletedInitialIndexing) {
        setTimeout(() => {
          this.openOnboardingModal();
        }, 600);
      }
    });

    console.log("[Cypher] Plugin loaded successfully.");
  }

  public async onunload(): Promise<void> {
    console.log("[Cypher] Unloading Cypher plugin...");
    this.indexerService.cancel();
    for (const timer of this.debounces.values()) {
      clearTimeout(timer);
    }
    this.debounces.clear();

    try {
      await this.vectorDbService.save();
    } catch (err) {
      console.error("[Cypher] Error saving DB on unload:", err);
    }
  }

  public async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  public async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.embeddingService) {
      this.embeddingService.updateSettings(this.settings);
    }
    if (this.indexerService) {
      this.indexerService.updateSettings(this.settings);
    }
    if (this.chatService) {
      this.chatService.updateSettings(this.settings);
    }
  }

  public async activateChatView(): Promise<void> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CYPHER_CHAT);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CYPHER_CHAT, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  public openOnboardingModal(): void {
    new OnboardingModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      this.embeddingService,
      this.vectorDbService,
      this.indexerService,
      () => {
        this.updateStatusBar();
      }
    ).open();
  }

  public openSearchModal(): void {
    if (!this.settings.hasCompletedInitialIndexing) {
      new Notice("Please configure Cypher and index your vault first.");
      this.openOnboardingModal();
      return;
    }
    new SearchModal(this.app, this.embeddingService, this.vectorDbService).open();
  }

  public updateStatusBar(): void {
    if (!this.statusEl) return;
    const stats = this.vectorDbService?.getStats();
    if (!stats || stats.documentCount === 0) {
      this.statusEl.setText("Cypher: Not indexed");
    } else {
      this.statusEl.setText(`Cypher: ${stats.documentCount} chunks`);
    }
  }

  private queueIndex(file: TFile): void {
    const existing = this.debounces.get(file.path);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounces.delete(file.path);
      const indexed = await this.indexerService.indexSingleFile(file);
      if (indexed) {
        this.updateStatusBar();
      }
    }, 1000);

    this.debounces.set(file.path, timer);
  }
}
