import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CypherPlugin from "../main";
import { ChatMessage, SearchResult } from "../types";

export const VIEW_TYPE_CYPHER_CHAT = "cypher-chat-view";

export class CypherChatView extends ItemView {
  private plugin: CypherPlugin;
  private messages: ChatMessage[] = [];
  private isGenerating = false;
  private currentK: number;

  private messageContainerEl: HTMLElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;
  private sendButtonEl: HTMLButtonElement | null = null;
  private kInputEl: HTMLInputElement | null = null;
  private statusIndicatorEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CypherPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentK = this.plugin.settings.chatTopK || 5;
  }

  public getViewType(): string {
    return VIEW_TYPE_CYPHER_CHAT;
  }

  public getDisplayText(): string {
    return "Cypher AI Chat";
  }

  public getIcon(): string {
    return "bot";
  }

  public async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("cypher-chat-container");

    this.renderHeader(container);
    this.renderMessageArea(container);
    this.renderInputArea(container);
  }

  public async onClose(): Promise<void> {
    // cleanup
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "cypher-chat-header" });

    // Left info
    const leftBox = header.createDiv({ cls: "cypher-chat-header-left" });
    const logo = leftBox.createSpan({ cls: "cypher-chat-logo" });
    logo.setText("⚡");
    const titleBox = leftBox.createDiv({ cls: "cypher-chat-title-box" });
    titleBox.createSpan({ text: "Cypher", cls: "cypher-chat-title" });
    const modelBadge = titleBox.createSpan({ cls: "cypher-chat-model-badge" });
    modelBadge.setText(this.plugin.settings.chatModel || "gpt-4o-mini");

    // Right Controls
    const rightControls = header.createDiv({ cls: "cypher-chat-header-controls" });

    // Configurable K Parameter Control
    const kControl = rightControls.createDiv({ cls: "cypher-k-control" });
    kControl.createSpan({ text: "Top K:", cls: "cypher-k-label", title: "Number of vault notes retrieved by query tool" });

    this.kInputEl = kControl.createEl("input", {
      type: "number",
      value: String(this.currentK),
      cls: "cypher-k-input",
    });
    this.kInputEl.min = "1";
    this.kInputEl.max = "25";
    this.kInputEl.step = "1";
    this.kInputEl.title = "Modify k: number of search results returned to the model";

    this.kInputEl.addEventListener("change", async () => {
      const val = parseInt(this.kInputEl?.value || "5", 10);
      if (!isNaN(val) && val >= 1 && val <= 50) {
        this.currentK = val;
        this.plugin.settings.chatTopK = val;
        await this.plugin.saveSettings();
        new Notice(`Vault query tool top-k set to ${val}`);
      }
    });

    // Clear Chat Button
    const clearBtn = rightControls.createEl("button", {
      cls: "cypher-chat-btn-icon",
      title: "Clear conversation",
    });
    clearBtn.setText("🗑️");
    clearBtn.onclick = () => {
      this.messages = [];
      this.renderMessages();
    };
  }

  private renderMessageArea(container: HTMLElement): void {
    this.messageContainerEl = container.createDiv({ cls: "cypher-chat-messages" });
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.messageContainerEl) return;
    this.messageContainerEl.empty();

    if (this.messages.length === 0) {
      this.renderEmptyState(this.messageContainerEl);
      return;
    }

    for (const msg of this.messages) {
      if (msg.role === "system") continue;
      this.renderSingleMessage(this.messageContainerEl, msg);
    }

    this.scrollToBottom();
  }

  private renderEmptyState(container: HTMLElement): void {
    const emptyBox = container.createDiv({ cls: "cypher-chat-empty-state" });
    emptyBox.createDiv({ text: "💬", cls: "cypher-empty-icon" });
    emptyBox.createEl("h4", { text: "Chat with your Vault" });
    emptyBox.createEl("p", {
      text: "Ask questions about your notes, projects, ideas, or journal. Cypher will query your local vector database to answer with accurate citations.",
      cls: "cypher-empty-desc",
    });

    // Sample prompts
    const suggestionsBox = emptyBox.createDiv({ cls: "cypher-suggestions" });
    const suggestions = [
      "What are the main concepts in my notes?",
      "Summarize my recent project notes",
      "Find notes discussing my goals",
    ];

    for (const prompt of suggestions) {
      const btn = suggestionsBox.createEl("button", {
        text: prompt,
        cls: "cypher-suggestion-btn",
      });
      btn.onclick = () => {
        if (this.textareaEl) {
          this.textareaEl.value = prompt;
          this.sendMessage();
        }
      };
    }
  }

  private renderSingleMessage(container: HTMLElement, msg: ChatMessage): void {
    const msgEl = container.createDiv({
      cls: `cypher-message cypher-message-${msg.role}`,
    });

    // If message contains a tool execution result, render the collapsible tool card
    if (msg.toolResult) {
      this.renderToolResultCard(msgEl, msg.toolResult);
    }

    // Message Content
    if (msg.content) {
      const bubbleEl = msgEl.createDiv({ cls: "cypher-message-bubble" });
      if (msg.role === "assistant") {
        MarkdownRenderer.render(
          this.app,
          msg.content,
          bubbleEl,
          "",
          this
        ).catch((err) => {
          bubbleEl.setText(msg.content);
        });
      } else {
        bubbleEl.setText(msg.content);
      }
    }
  }

  private renderToolResultCard(
    container: HTMLElement,
    toolResult: { query: string; k: number; results: SearchResult[] }
  ): void {
    const card = container.createDiv({ cls: "cypher-tool-card" });

    // Tool Header
    const toolHeader = card.createDiv({ cls: "cypher-tool-header" });
    const icon = toolHeader.createSpan({ cls: "cypher-tool-icon" });
    icon.setText("🔍");

    const titleBox = toolHeader.createDiv({ cls: "cypher-tool-summary" });
    titleBox.createSpan({ text: "Queried Vault: ", cls: "cypher-tool-tag" });
    titleBox.createSpan({ text: `"${toolResult.query}"`, cls: "cypher-tool-query" });
    titleBox.createSpan({
      text: ` (${toolResult.results.length} / top-${toolResult.k} notes)`,
      cls: "cypher-tool-count",
    });

    const toggleBtn = toolHeader.createEl("button", {
      text: "Show details ▾",
      cls: "cypher-tool-toggle-btn",
    });

    // Tool Content (collapsible)
    const detailsContainer = card.createDiv({
      cls: "cypher-tool-details is-collapsed",
    });

    toggleBtn.onclick = () => {
      const isCollapsed = detailsContainer.hasClass("is-collapsed");
      if (isCollapsed) {
        detailsContainer.removeClass("is-collapsed");
        toggleBtn.setText("Hide details ▴");
      } else {
        detailsContainer.addClass("is-collapsed");
        toggleBtn.setText("Show details ▾");
      }
    };

    if (toolResult.results.length === 0) {
      detailsContainer.createDiv({
        text: "No matching notes found above similarity threshold.",
        cls: "cypher-tool-no-results",
      });
      return;
    }

    for (const result of toolResult.results) {
      const item = detailsContainer.createDiv({ cls: "cypher-tool-item" });
      const topRow = item.createDiv({ cls: "cypher-tool-item-top" });

      const scorePct = Math.round(result.score * 100);
      const scoreBadge = topRow.createSpan({ cls: "cypher-score-badge" });
      scoreBadge.setText(`${scorePct}%`);

      const link = topRow.createEl("a", {
        text: result.title,
        cls: "cypher-tool-link",
      });
      link.onclick = (e) => {
        e.preventDefault();
        this.openFile(result.path, e.metaKey || e.ctrlKey);
      };

      if (result.heading) {
        const heading = topRow.createSpan({ cls: "cypher-tool-heading" });
        heading.setText(`› ${result.heading}`);
      }

      const snippet = item.createDiv({ cls: "cypher-tool-snippet" });
      // clean snippet
      const clean = result.text.replace(/^\[Note:.*?\]\n*/, "");
      snippet.setText(clean.length > 200 ? clean.slice(0, 200) + "..." : clean);
    }
  }

  private renderInputArea(container: HTMLElement): void {
    const inputArea = container.createDiv({ cls: "cypher-chat-input-area" });

    // Status indicator (loading / thinking)
    this.statusIndicatorEl = inputArea.createDiv({ cls: "cypher-chat-status is-hidden" });

    const inputRow = inputArea.createDiv({ cls: "cypher-chat-input-row" });

    this.textareaEl = inputRow.createEl("textarea", {
      placeholder: "Ask Cypher anything about your vault...",
      cls: "cypher-chat-textarea",
    });

    this.textareaEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendButtonEl = inputRow.createEl("button", {
      text: "Send",
      cls: "mod-cta cypher-send-btn",
    });

    this.sendButtonEl.onclick = () => {
      this.sendMessage();
    };
  }

  private async sendMessage(): Promise<void> {
    if (this.isGenerating || !this.textareaEl) return;

    const text = this.textareaEl.value.trim();
    if (!text) return;

    // Verify index exists
    if (!this.plugin.settings.hasCompletedInitialIndexing) {
      new Notice("Please index your vault first before chatting.");
      this.plugin.openOnboardingModal();
      return;
    }

    // Add user message
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    this.messages.push(userMessage);
    this.textareaEl.value = "";
    this.renderMessages();

    this.isGenerating = true;
    this.updateControlsState();
    this.setStatus("Cypher is thinking and querying vault...");

    try {
      const assistantMessage = await this.plugin.chatService.sendMessage(this.messages, {
        topK: this.currentK,
        similarityThreshold: this.plugin.settings.chatSimilarityThreshold,
        onToolCall: (toolCall, results, query, k) => {
          this.setStatus(`Queried vault for: "${query}" (Retrieved ${results.length} notes)...`);
        },
      });

      this.messages.push(assistantMessage);
      this.renderMessages();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Cypher Chat] Error:", err);
      new Notice(`Chat error: ${msg}`);

      const errMessage: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: "assistant",
        content: `⚠️ **Error communicating with AI model:**\n${msg}\n\nPlease check your API URL, key, and model name in settings.`,
        timestamp: Date.now(),
      };
      this.messages.push(errMessage);
      this.renderMessages();
    } finally {
      this.isGenerating = false;
      this.updateControlsState();
      this.clearStatus();
    }
  }

  private updateControlsState(): void {
    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = this.isGenerating;
      this.sendButtonEl.setText(this.isGenerating ? "..." : "Send");
    }
  }

  private setStatus(text: string): void {
    if (this.statusIndicatorEl) {
      this.statusIndicatorEl.removeClass("is-hidden");
      this.statusIndicatorEl.setText(text);
    }
  }

  private clearStatus(): void {
    if (this.statusIndicatorEl) {
      this.statusIndicatorEl.addClass("is-hidden");
      this.statusIndicatorEl.empty();
    }
  }

  private scrollToBottom(): void {
    if (this.messageContainerEl) {
      this.messageContainerEl.scrollTop = this.messageContainerEl.scrollHeight;
    }
  }

  private async openFile(path: string, newLeaf = false): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(newLeaf);
      await leaf.openFile(file);
    } else {
      new Notice(`File not found: ${path}`);
    }
  }
}
