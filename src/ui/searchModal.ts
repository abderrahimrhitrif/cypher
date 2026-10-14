import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type { EmbeddingService } from "../services/embeddingService";
import type { VectorDbService } from "../services/vectorDbService";
import type { CypherSettings, SearchResult } from "../types";
import { describeError } from "../errors";

const DEBOUNCE_MS = 350;
const RESULT_LIMIT = 15;

export class SearchModal extends Modal {
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;
  private settings: CypherSettings;

  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selectedIndex = 0;
  private results: SearchResult[] = [];
  /** Incremented per query so a slow response cannot overwrite a newer one. */
  private queryToken = 0;

  constructor(
    app: App,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService,
    settings: CypherSettings
  ) {
    super(app);
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
    this.settings = settings;
  }

  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cypher-modal", "cypher-search-modal");

    const header = contentEl.createDiv({ cls: "cypher-search-header" });
    const icon = header.createSpan({ cls: "cypher-search-icon" });
    setIcon(icon, "search");

    this.inputEl = header.createEl("input", {
      type: "text",
      placeholder: "Search your notes semantically...",
      cls: "cypher-search-input",
    });
    this.inputEl.setAttr("aria-label", "Semantic search query");

    this.statusEl = contentEl.createDiv({ cls: "cypher-search-status" });
    this.statusEl.setAttr("role", "status");
    this.statusEl.setAttr("aria-live", "polite");
    this.statusEl.setText("Type a query to search your notes");

    this.listEl = contentEl.createDiv({ cls: "cypher-results-list" });

    this.inputEl.addEventListener("input", () => this.onInput());
    this.inputEl.addEventListener("keydown", (event) => this.onKeydown(event));

    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  public onClose(): void {
    this.queryToken++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }

  private onInput(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const query = this.inputEl?.value.trim() ?? "";

    if (!query) {
      this.queryToken++;
      this.results = [];
      this.render();
      this.statusEl?.setText("Type a query to search your notes");
      return;
    }

    this.statusEl?.setText("Searching...");

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.doSearch(query);
    }, DEBOUNCE_MS);
  }

  private async doSearch(query: string): Promise<void> {
    const token = ++this.queryToken;

    try {
      const vector = await this.embedSvc.getQueryEmbedding(query);
      const hits = await this.vecDb.search(
        vector,
        RESULT_LIMIT,
        this.settings.chatSimilarityThreshold,
        { dedupeByPath: true }
      );

      if (token !== this.queryToken) return;

      this.results = hits;
      this.selectedIndex = 0;
      this.render();
      this.statusEl?.setText(
        hits.length === 0
          ? "No notes matched above the similarity threshold."
          : `${hits.length} matching note${hits.length === 1 ? "" : "s"}:`
      );
    } catch (error) {
      if (token !== this.queryToken) return;

      this.results = [];
      this.render();
      this.statusEl?.setText(`Search failed: ${describeError(error)}`);
      console.error("[cypher] semantic search failed:", error);
    }
  }

  private render(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    this.results.forEach((result, index) => {
      const item = this.listEl!.createDiv({
        cls: `cypher-result-item ${index === this.selectedIndex ? "is-selected" : ""}`,
      });
      item.setAttr("role", "button");
      item.setAttr("tabindex", "0");

      const topRow = item.createDiv({ cls: "cypher-result-top" });
      topRow.createSpan({ cls: "cypher-score-badge", text: `${Math.round(result.score * 100)}%` });
      topRow.createSpan({ cls: "cypher-result-title", text: result.title });

      if (result.heading) {
        topRow.createSpan({ cls: "cypher-result-heading", text: `› ${result.heading}` });
      }

      item.createDiv({ cls: "cypher-result-snippet", text: this.cleanSnippet(result.text) });

      const open = (newLeaf: boolean) => void this.openResult(result, newLeaf);
      item.onclick = (event) => open(event.metaKey || event.ctrlKey);
      item.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open(event.metaKey || event.ctrlKey);
        }
      };
      item.onmouseenter = () => {
        this.selectedIndex = index;
        this.updateSelection();
      };
    });
  }

  private cleanSnippet(text: string): string {
    const cleaned = text.replace(/^\[[^\]]+\]\n/, "");
    return cleaned.length > 250 ? `${cleaned.slice(0, 250)}...` : cleaned;
  }

  private updateSelection(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll(".cypher-result-item").forEach((element, index) => {
      element.toggleClass("is-selected", index === this.selectedIndex);
      if (index === this.selectedIndex) {
        element.scrollIntoView({ block: "nearest" });
      }
    });
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this.results.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
        this.updateSelection();
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (this.results.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.results.length) % this.results.length;
        this.updateSelection();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const selected = this.results[this.selectedIndex];
      if (selected) {
        void this.openResult(selected, event.metaKey || event.ctrlKey);
      }
      return;
    }

    if (event.key === "Escape") {
      this.close();
    }
  }

  private async openResult(result: SearchResult, newLeaf = false): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!(file instanceof TFile)) {
      new Notice(`Cypher: note not found at ${result.path}`);
      return;
    }

    this.close();
    await this.app.workspace.getLeaf(newLeaf).openFile(file);
  }
}
