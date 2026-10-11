import { App, Modal, Notice, TFile } from "obsidian";
import { EmbeddingService } from "../services/embeddingService";
import { VectorDbService } from "../services/vectorDbService";
import { SearchResult } from "../types";

export class SearchModal extends Modal {
  private embeddingService: EmbeddingService;
  private vectorDbService: VectorDbService;

  private searchInputEl: HTMLInputElement | null = null;
  private resultsContainerEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private selectedIndex = 0;
  private currentResults: SearchResult[] = [];

  constructor(
    app: App,
    embeddingService: EmbeddingService,
    vectorDbService: VectorDbService
  ) {
    super(app);
    this.embeddingService = embeddingService;
    this.vectorDbService = vectorDbService;
  }

  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cypher-modal", "cypher-search-modal");

    // Header & Input
    const searchHeader = contentEl.createDiv({ cls: "cypher-search-header" });
    const searchIcon = searchHeader.createSpan({ cls: "cypher-search-icon" });
    searchIcon.setText("🔍");

    this.searchInputEl = searchHeader.createEl("input", {
      type: "text",
      placeholder: "Search notes semantically with AI vector embeddings...",
      cls: "cypher-search-input",
    });

    this.statusEl = contentEl.createDiv({ cls: "cypher-search-status" });
    this.statusEl.setText("Type a query to search your vector database");

    this.resultsContainerEl = contentEl.createDiv({ cls: "cypher-results-list" });

    // Key event listeners
    this.searchInputEl.focus();
    this.searchInputEl.addEventListener("input", () => {
      this.handleInput();
    });

    this.searchInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      this.handleKeydown(e);
    });
  }

  public onClose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const { contentEl } = this;
    contentEl.empty();
  }

  private handleInput(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const query = this.searchInputEl?.value.trim() ?? "";
    if (!query) {
      this.currentResults = [];
      this.renderResults();
      if (this.statusEl) {
        this.statusEl.setText("Type a query to search your vector database");
      }
      return;
    }

    if (this.statusEl) {
      this.statusEl.setText("Embedding query & searching vectors...");
    }

    this.debounceTimer = setTimeout(async () => {
      await this.performSearch(query);
    }, 400);
  }

  private async performSearch(query: string): Promise<void> {
    try {
      const queryEmbedding = await this.embeddingService.getQueryEmbedding(query);
      const results = await this.vectorDbService.search(queryEmbedding, 15, 0.25);

      this.currentResults = results;
      this.selectedIndex = 0;
      this.renderResults();

      if (this.statusEl) {
        if (results.length === 0) {
          this.statusEl.setText("No semantic matches found above threshold.");
        } else {
          this.statusEl.setText(`Found ${results.length} relevant note chunks:`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.setText(`Search error: ${msg}`);
      }
      console.error("[Cypher] Search error:", err);
    }
  }

  private renderResults(): void {
    if (!this.resultsContainerEl) return;
    this.resultsContainerEl.empty();

    if (this.currentResults.length === 0) {
      return;
    }

    this.currentResults.forEach((result, idx) => {
      const itemEl = this.resultsContainerEl!.createDiv({
        cls: `cypher-result-item ${idx === this.selectedIndex ? "is-selected" : ""}`,
      });

      // Top row: Score + Title + Heading
      const topRow = itemEl.createDiv({ cls: "cypher-result-top" });
      const scorePercent = Math.round(result.score * 100);
      const scoreBadge = topRow.createSpan({ cls: "cypher-score-badge" });
      scoreBadge.setText(`${scorePercent}%`);

      const titleEl = topRow.createSpan({ cls: "cypher-result-title" });
      titleEl.setText(result.title);

      if (result.heading) {
        const headingEl = topRow.createSpan({ cls: "cypher-result-heading" });
        headingEl.setText(`› ${result.heading}`);
      }

      // Snippet
      const snippetEl = itemEl.createDiv({ cls: "cypher-result-snippet" });
      snippetEl.setText(this.cleanSnippet(result.text));

      // Click handler
      itemEl.onclick = (e) => {
        this.openResult(result, e.metaKey || e.ctrlKey);
      };

      itemEl.onmouseenter = () => {
        this.selectedIndex = idx;
        this.updateSelectionClasses();
      };
    });
  }

  private cleanSnippet(text: string): string {
    // Remove context tag [Note: ...] if present
    const cleaned = text.replace(/^\[Note:.*?\]\n*/, "");
    if (cleaned.length > 250) {
      return cleaned.slice(0, 250) + "...";
    }
    return cleaned;
  }

  private updateSelectionClasses(): void {
    if (!this.resultsContainerEl) return;
    const items = this.resultsContainerEl.querySelectorAll(".cypher-result-item");
    items.forEach((el, idx) => {
      if (idx === this.selectedIndex) {
        el.addClass("is-selected");
        el.scrollIntoView({ block: "nearest" });
      } else {
        el.removeClass("is-selected");
      }
    });
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.currentResults.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.currentResults.length;
        this.updateSelectionClasses();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.currentResults.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.currentResults.length) % this.currentResults.length;
        this.updateSelectionClasses();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.currentResults[this.selectedIndex]) {
        this.openResult(this.currentResults[this.selectedIndex], e.metaKey || e.ctrlKey);
      }
    } else if (e.key === "Escape") {
      this.close();
    }
  }

  private async openResult(result: SearchResult, newLeaf = false): Promise<void> {
    this.close();

    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(newLeaf);
      await leaf.openFile(file);

      // Attempt to jump to heading or search occurrence
      const view = this.app.workspace.getActiveViewOfType(require("obsidian").MarkdownView);
      if (view && result.heading) {
        // Open file succeeded
      }
    } else {
      new Notice(`Could not open file: ${result.path}`);
    }
  }
}
