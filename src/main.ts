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

  private statusBarItemEl: HTMLElement | null = null;
  private modifiedDebounceMap: Map<string, NodeJS.Timeout> = new Map();

  public async onload(): Promise<void> {
    console.log("[Cypher] Loading Cypher AI Vector Plugin...");

    // 1. Load Settings
    await this.loadSettings();

    // 2. Initialize Services
    const pluginDir = `${this.app.vault.configDir}/plugins/cypher`;
    this.embeddingService = new EmbeddingService(this.settings);
    this.vectorDbService = new VectorDbService(
      this.app.vault.adapter,
      pluginDir,
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
      this.vectorDbService
    );

    // Initialize the vector DB
    try {
      await this.vectorDbService.init(this.settings.dimension);
    } catch (err) {
      console.error("[Cypher] Error initializing vector database:", err);
    }

    // 3. Register Views
    this.registerView(
      VIEW_TYPE_CYPHER_CHAT,
      (leaf) => new CypherChatView(leaf, this)
    );

    // 4. Register UI Components
    this.addSettingTab(new CypherSettingsTab(this.app, this));

    // Status bar item
    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Ribbon icons
    this.addRibbonIcon("bot", "Cypher: AI Chat", () => {
      this.activateChatView();
    });

    this.addRibbonIcon("sparkles", "Cypher: Semantic Search", () => {
      this.openSearchModal();
    });

    // 5. Register Commands
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
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Cypher Indexing Error: ${msg}`);
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
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Cypher Rebuild Error: ${msg}`);
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

    // 6. Register Vault Event Listeners
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md" && this.settings.autoIndexOnSave) {
          this.queueFileIndexing(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.indexerService.handleFileDeleted(file.path);
          this.updateStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.indexerService.handleFileRenamed(oldPath, file.path);
        }
      })
    );

    // 7. First-Time Setup Launch
    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBar();
      if (!this.settings.hasCompletedInitialIndexing) {
        // Automatically open the guided onboarding modal on first run
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
    for (const timer of this.modifiedDebounceMap.values()) {
      clearTimeout(timer);
    }
    this.modifiedDebounceMap.clear();

    try {
      await this.vectorDbService.save();
    } catch (err) {
      console.error("[Cypher] Error saving DB on unload:", err);
    }
  }

  public async loadSettings(): Promise<void> {
    const loadedData = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
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
    if (!this.statusBarItemEl) return;
    const stats = this.vectorDbService?.getStats();
    if (!stats || stats.documentCount === 0) {
      this.statusBarItemEl.setText("⚡ Cypher: Not indexed");
    } else {
      this.statusBarItemEl.setText(`⚡ Cypher: ${stats.documentCount} chunks`);
    }
  }

  private queueFileIndexing(file: TFile): void {
    const existing = this.modifiedDebounceMap.get(file.path);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.modifiedDebounceMap.delete(file.path);
      const indexed = await this.indexerService.indexSingleFile(file);
      if (indexed) {
        this.updateStatusBar();
      }
    }, 2500);

    this.modifiedDebounceMap.set(file.path, timer);
  }
}
