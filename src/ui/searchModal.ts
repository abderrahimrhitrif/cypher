import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { EmbeddingService } from "../services/embeddingService";
import { VectorDbService } from "../services/vectorDbService";
import { SearchResult } from "../types";

export class SearchModal extends Modal {
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;

  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private timer: NodeJS.Timeout | null = null;
  private selectedIdx = 0;
  private results: SearchResult[] = [];

  constructor(
    app: App,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService
  ) {
    super(app);
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
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
      placeholder: "Search notes semantically with AI vector embeddings...",
      cls: "cypher-search-input",
    });

    this.statusEl = contentEl.createDiv({ cls: "cypher-search-status" });
    this.statusEl.setText("Type a query to search your vector database");

    this.listEl = contentEl.createDiv({ cls: "cypher-results-list" });

    this.inputEl.focus();
    this.inputEl.addEventListener("input", () => {
      this.onInput();
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      this.onKeydown(e);
    });
  }

  public onClose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const { contentEl } = this;
    contentEl.empty();
  }

  private onInput(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    const query = this.inputEl?.value.trim() ?? "";
    if (!query) {
      this.results = [];
      this.render();
      if (this.statusEl) {
        this.statusEl.setText("Type a query to search your vector database");
      }
      return;
    }

    if (this.statusEl) {
      this.statusEl.setText("Embedding query & searching vectors...");
    }

    this.timer = setTimeout(async () => {
      await this.doSearch(query);
    }, 400);
  }

  private async doSearch(query: string): Promise<void> {
    try {
      const vec = await this.embedSvc.getQueryEmbedding(query);
      const hits = await this.vecDb.search(vec, 15, 0.25);

      this.results = hits;
      this.selectedIdx = 0;
      this.render();

      if (this.statusEl) {
        if (hits.length === 0) {
          this.statusEl.setText("No semantic matches found above threshold.");
        } else {
          this.statusEl.setText(`Found ${hits.length} relevant note chunks:`);
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      if (this.statusEl) {
        this.statusEl.setText(`Search error: ${error}`);
      }
      console.error("[Cypher] Search error:", err);
    }
  }

  private render(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    if (this.results.length === 0) {
      return;
    }

    this.results.forEach((r, idx) => {
      const itemEl = this.listEl!.createDiv({
        cls: `cypher-result-item ${idx === this.selectedIdx ? "is-selected" : ""}`,
      });

      const topRow = itemEl.createDiv({ cls: "cypher-result-top" });
      const scorePct = Math.round(r.score * 100);
      const badge = topRow.createSpan({ cls: "cypher-score-badge" });
      badge.setText(`${scorePct}%`);

      const titleEl = topRow.createSpan({ cls: "cypher-result-title" });
      titleEl.setText(r.title);

      if (r.heading) {
        const headingEl = topRow.createSpan({ cls: "cypher-result-heading" });
        headingEl.setText(`› ${r.heading}`);
      }

      const snippetEl = itemEl.createDiv({ cls: "cypher-result-snippet" });
      snippetEl.setText(this.cleanSnippet(r.text));

      itemEl.onclick = (e) => {
        this.openResult(r, e.metaKey || e.ctrlKey);
      };

      itemEl.onmouseenter = () => {
        this.selectedIdx = idx;
        this.updateSelection();
      };
    });
  }

  private cleanSnippet(text: string): string {
    const cleaned = text.replace(/^\[Note:.*?\]\n*/, "");
    if (cleaned.length > 250) {
      return cleaned.slice(0, 250) + "...";
    }
    return cleaned;
  }

  private updateSelection(): void {
    if (!this.listEl) return;
    const items = this.listEl.querySelectorAll(".cypher-result-item");
    items.forEach((el, idx) => {
      if (idx === this.selectedIdx) {
        el.addClass("is-selected");
        el.scrollIntoView({ block: "nearest" });
      } else {
        el.removeClass("is-selected");
      }
    });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.results.length > 0) {
        this.selectedIdx = (this.selectedIdx + 1) % this.results.length;
        this.updateSelection();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.results.length > 0) {
        this.selectedIdx =
          (this.selectedIdx - 1 + this.results.length) % this.results.length;
        this.updateSelection();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.results[this.selectedIdx]) {
        this.openResult(this.results[this.selectedIdx], e.metaKey || e.ctrlKey);
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
    } else {
      new Notice(`Could not open file: ${result.path}`);
    }
  }
}
