import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CypherPlugin from "../main";
import { ChatMessage, ChatToolResult, Conversation } from "../types";

export const VIEW_TYPE_CYPHER_CHAT = "cypher-chat-view";

export class CypherChatView extends ItemView {
  private plugin: CypherPlugin;
  private currentConversation: Conversation | null = null;
  private showHistory = false;
  private generating = false;
  private k: number;

  private containerArea: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private subheaderTitleEl: HTMLElement | null = null;
  private historyBtnEl: HTMLElement | null = null;
  private contentAreaEl: HTMLElement | null = null;
  private boxEl: HTMLElement | null = null;
  private historyDrawerEl: HTMLElement | null = null;
  private inputAreaEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private kInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CypherPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.k = this.plugin.settings.chatTopK || 5;
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
    this.containerArea = container;

    await this.loadInitialConversation();
    this.renderView();
  }

  public async onClose(): Promise<void> {
  }

  private async loadInitialConversation(): Promise<void> {
    try {
      const all = await this.plugin.conversationService.getAll();
      if (all.length > 0) {
        this.currentConversation = all[0];
      } else {
        this.currentConversation = await this.plugin.conversationService.create("New Chat");
      }
    } catch (err) {
      console.error("[Cypher] Error loading initial conversation:", err);
      this.currentConversation = await this.plugin.conversationService.create("New Chat");
    }
  }

  private renderView(): void {
    if (!this.containerArea) return;
    this.containerArea.empty();

    this.renderHeader(this.containerArea);

    this.contentAreaEl = this.containerArea.createDiv({ cls: "cypher-chat-content-area" });
    this.renderContentArea();

    this.renderInputArea(this.containerArea);
  }

  private renderHeader(container: HTMLElement): void {
    this.headerEl = container.createDiv({ cls: "cypher-chat-header cypher-chat-header-main" });

    const topRow = this.headerEl.createDiv({ cls: "cypher-chat-header-row" });

    const left = topRow.createDiv({ cls: "cypher-chat-header-left" });

    this.historyBtnEl = left.createEl("button", {
      cls: "cypher-btn-sm",
      text: "History",
      title: "Browse past conversations",
    });
    this.historyBtnEl.onclick = async () => {
      this.showHistory = !this.showHistory;
      this.renderContentArea();
    };

    const titleBox = left.createDiv({ cls: "cypher-chat-title-box" });
    titleBox.createSpan({ text: "Cypher", cls: "cypher-chat-title" });
    const badge = titleBox.createSpan({ cls: "cypher-chat-model-badge" });
    badge.setText(this.plugin.settings.chatModel || "gpt-4o-mini");
    badge.title = "Click to configure Chat Model in Settings";
    badge.style.cursor = "pointer";
    badge.onclick = () => {
      (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting?.open?.();
      (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting?.openTabById?.("cypher");
    };

    const controls = topRow.createDiv({ cls: "cypher-chat-header-controls" });

    const newBtn = controls.createEl("button", {
      cls: "cypher-btn-sm mod-cta",
      text: "+ New",
      title: "Start a new conversation",
    });
    newBtn.onclick = async () => {
      await this.startNewConversation();
    };

    const kBox = controls.createDiv({ cls: "cypher-k-control" });
    kBox.createSpan({ text: "Top K:", cls: "cypher-k-label", title: "Number of vault notes retrieved by query tool" });

    this.kInput = kBox.createEl("input", {
      type: "number",
      value: String(this.k),
      cls: "cypher-k-input",
    });
    this.kInput.min = "1";
    this.kInput.max = "25";
    this.kInput.step = "1";
    this.kInput.title = "Modify k: number of search results returned to the model";

    this.kInput.addEventListener("change", async () => {
      const val = parseInt(this.kInput?.value || "5", 10);
      if (!isNaN(val) && val >= 1 && val <= 50) {
        this.k = val;
        this.plugin.settings.chatTopK = val;
        await this.plugin.saveSettings();
        new Notice(`Vault query tool top-k set to ${val}`);
      }
    });

    const subheader = this.headerEl.createDiv({ cls: "cypher-chat-subheader" });
    this.subheaderTitleEl = subheader.createSpan({
      text: this.currentConversation?.title || "New Chat",
      cls: "cypher-current-title",
      title: "Click to rename conversation",
    });
    this.subheaderTitleEl.onclick = () => {
      this.promptRenameConversation();
    };

    const subActions = subheader.createDiv({ cls: "cypher-subheader-actions" });

    const renameBtn = subActions.createEl("button", {
      cls: "cypher-btn-sm",
      text: "Rename",
      title: "Rename this conversation",
    });
    renameBtn.onclick = () => {
      this.promptRenameConversation();
    };

    const deleteBtn = subActions.createEl("button", {
      cls: "cypher-btn-sm cypher-btn-danger",
      text: "Delete",
      title: "Delete this conversation",
    });
    deleteBtn.onclick = async () => {
      await this.deleteCurrentConversation();
    };

    this.updateHistoryButtonLabel();
  }

  private async updateHistoryButtonLabel(): Promise<void> {
    if (!this.historyBtnEl) return;
    const all = await this.plugin.conversationService.getAll();
    this.historyBtnEl.setText(`History (${all.length})`);
  }

  private updateSubheaderTitle(): void {
    if (this.subheaderTitleEl) {
      this.subheaderTitleEl.setText(this.currentConversation?.title || "New Chat");
    }
  }

  private renderContentArea(): void {
    if (!this.contentAreaEl) return;
    this.contentAreaEl.empty();

    if (this.showHistory) {
      if (this.inputAreaEl) this.inputAreaEl.style.display = "none";
      this.renderHistoryDrawer(this.contentAreaEl);
    } else {
      if (this.inputAreaEl) this.inputAreaEl.style.display = "flex";
      this.renderMessagesArea(this.contentAreaEl);
    }
    this.updateHistoryButtonLabel();
  }

  private async renderHistoryDrawer(container: HTMLElement): Promise<void> {
    this.historyDrawerEl = container.createDiv({ cls: "cypher-history-drawer" });

    const header = this.historyDrawerEl.createDiv({ cls: "cypher-history-header" });
    const all = await this.plugin.conversationService.getAll();
    header.createSpan({ text: `Past Conversations (${all.length})`, cls: "cypher-history-header-title" });

    const headerActions = header.createDiv({ cls: "cypher-history-actions" });
    const newChatBtn = headerActions.createEl("button", {
      cls: "cypher-btn-sm mod-cta",
      text: "+ New",
      title: "Start a new conversation",
    });
    newChatBtn.onclick = async () => {
      await this.startNewConversation();
    };

    const closeBtn = headerActions.createEl("button", {
      cls: "cypher-btn-sm",
      text: "Close",
      title: "Return to active chat",
    });
    closeBtn.onclick = () => {
      this.showHistory = false;
      this.renderContentArea();
    };

    const listEl = this.historyDrawerEl.createDiv({ cls: "cypher-history-list" });

    if (all.length === 0) {
      const empty = listEl.createDiv({ cls: "cypher-history-empty" });
      empty.createEl("p", { text: "No saved conversations yet." });
      return;
    }

    for (const conv of all) {
      const item = listEl.createDiv({ cls: "cypher-history-item" });
      if (this.currentConversation?.id === conv.id) {
        item.addClass("is-active");
      }

      const topRow = item.createDiv({ cls: "cypher-history-item-top" });
      const titleSpan = topRow.createSpan({ text: conv.title, cls: "cypher-history-item-title" });

      const actions = topRow.createDiv({ cls: "cypher-history-actions" });
      const itemRenameBtn = actions.createEl("button", {
        cls: "cypher-btn-sm",
        text: "✎",
        title: "Rename",
      });
      itemRenameBtn.onclick = async (e) => {
        e.stopPropagation();
        const newTitle = window.prompt("Enter new conversation title:", conv.title);
        if (newTitle && newTitle.trim()) {
          await this.plugin.conversationService.rename(conv.id, newTitle.trim());
          if (this.currentConversation?.id === conv.id) {
            this.currentConversation.title = newTitle.trim();
            this.updateSubheaderTitle();
          }
          await this.renderHistoryDrawer(container);
        }
      };

      const itemDeleteBtn = actions.createEl("button", {
        cls: "cypher-btn-sm cypher-btn-danger",
        text: "✕",
        title: "Delete",
      });
      itemDeleteBtn.onclick = async (e) => {
        e.stopPropagation();
        await this.deleteConversation(conv.id);
      };

      const metaRow = item.createDiv({ cls: "cypher-history-item-meta" });
      const dateStr = this.formatDate(conv.updatedAt);
      metaRow.createSpan({ text: dateStr });
      metaRow.createSpan({ text: `${conv.messages.length} msg${conv.messages.length === 1 ? "" : "s"}` });

      item.onclick = async () => {
        await this.selectConversation(conv.id);
      };
    }
  }

  private formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();

    if (isToday) {
      return `Today, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();

    if (isYesterday) {
      return `Yesterday, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  public async selectConversation(id: string): Promise<void> {
    const conv = await this.plugin.conversationService.get(id);
    if (conv) {
      this.currentConversation = conv;
      this.showHistory = false;
      this.updateSubheaderTitle();
      this.renderContentArea();
    }
  }

  public async startNewConversation(): Promise<void> {
    this.currentConversation = await this.plugin.conversationService.create("New Chat");
    this.showHistory = false;
    this.updateSubheaderTitle();
    this.renderContentArea();
    if (this.inputEl) {
      this.inputEl.focus();
    }
  }

  public async deleteCurrentConversation(): Promise<void> {
    if (!this.currentConversation) return;
    const toDeleteId = this.currentConversation.id;
    await this.deleteConversation(toDeleteId);
  }

  public async deleteConversation(id: string): Promise<void> {
    await this.plugin.conversationService.delete(id);
    new Notice("Conversation deleted.");

    if (this.currentConversation?.id === id) {
      const remaining = await this.plugin.conversationService.getAll();
      if (remaining.length > 0) {
        this.currentConversation = remaining[0];
      } else {
        this.currentConversation = await this.plugin.conversationService.create("New Chat");
      }
    }

    this.updateSubheaderTitle();
    this.renderContentArea();
  }

  private promptRenameConversation(): void {
    if (!this.currentConversation) return;
    const current = this.currentConversation.title;
    const newTitle = window.prompt("Rename conversation:", current);
    if (newTitle && newTitle.trim()) {
      this.currentConversation.title = newTitle.trim();
      this.plugin.conversationService.rename(this.currentConversation.id, newTitle.trim());
      this.updateSubheaderTitle();
    }
  }

  private renderMessagesArea(container: HTMLElement): void {
    this.boxEl = container.createDiv({ cls: "cypher-chat-messages" });
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.boxEl) return;
    this.boxEl.empty();

    const messages = this.currentConversation?.messages || [];

    if (messages.length === 0) {
      this.renderEmpty(this.boxEl);
      return;
    }

    for (const msg of messages) {
      if (msg.role === "system") continue;
      this.renderMessage(this.boxEl, msg);
    }

    this.scrollToBottom();
  }

  private renderEmpty(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-chat-empty-state" });
    box.createEl("h4", { text: "Chat with your Vault" });
    box.createEl("p", {
      text: "Ask questions about your notes, projects, ideas, or journal. Cypher will query your local vector database to answer with accurate citations.",
      cls: "cypher-empty-desc",
    });

    const suggestionsBox = box.createDiv({ cls: "cypher-suggestions" });
    const prompts = [
      "What are the main concepts in my notes?",
      "Summarize my recent project notes",
      "Find notes discussing my goals",
    ];

    for (const prompt of prompts) {
      const btn = suggestionsBox.createEl("button", {
        text: prompt,
        cls: "cypher-suggestion-btn",
      });
      btn.onclick = () => {
        if (this.inputEl) {
          this.inputEl.value = prompt;
          this.sendMessage();
        }
      };
    }
  }

  private renderMessage(container: HTMLElement, msg: ChatMessage): void {
    const msgEl = container.createDiv({
      cls: `cypher-message cypher-message-${msg.role}`,
    });

    if (msg.toolResult) {
      this.renderToolCard(msgEl, msg.toolResult);
    }

    if (msg.content) {
      const bubble = msgEl.createDiv({ cls: "cypher-message-bubble" });
      if (msg.role === "assistant") {
        MarkdownRenderer.render(
          this.app,
          msg.content,
          bubble,
          "",
          this
        ).catch(() => {
          bubble.setText(msg.content);
        });
      } else {
        bubble.setText(msg.content);
      }
    }
  }

  private renderToolCard(container: HTMLElement, result: ChatToolResult): void {
    const card = container.createDiv({ cls: "cypher-tool-card" });

    if (result.notes) {
      const header = card.createDiv({ cls: "cypher-tool-header" });
      const titleBox = header.createDiv({ cls: "cypher-tool-summary" });
      titleBox.createSpan({ text: "Vault Tool: ", cls: "cypher-tool-tag" });
      titleBox.createSpan({ text: "list_notes", cls: "cypher-tool-query" });
      titleBox.createSpan({
        text: ` (${result.notes.length} notes found)`,
        cls: "cypher-tool-count",
      });

      const toggleBtn = header.createEl("button", {
        text: "Show details ▾",
        cls: "cypher-tool-toggle-btn",
      });

      const details = card.createDiv({ cls: "cypher-tool-details is-collapsed" });

      toggleBtn.onclick = () => {
        const isCollapsed = details.hasClass("is-collapsed");
        if (isCollapsed) {
          details.removeClass("is-collapsed");
          toggleBtn.setText("Hide details ▴");
        } else {
          details.addClass("is-collapsed");
          toggleBtn.setText("Show details ▾");
        }
      };

      if (result.notes.length === 0) {
        details.createDiv({
          text: "No matching notes found.",
          cls: "cypher-tool-no-results",
        });
        return;
      }

      for (const n of result.notes) {
        const item = details.createDiv({ cls: "cypher-tool-item" });
        const topRow = item.createDiv({ cls: "cypher-tool-item-top" });

        const dirBadge = topRow.createSpan({ cls: "cypher-score-badge" });
        dirBadge.setText(n.dir);

        const link = topRow.createEl("a", {
          text: n.title,
          cls: "cypher-tool-link",
        });
        link.onclick = (e) => {
          e.preventDefault();
          this.openFile(n.path, e.metaKey || e.ctrlKey);
        };

        if (n.tags.length > 0) {
          const tagsBox = topRow.createSpan({ cls: "cypher-tool-heading" });
          tagsBox.setText(n.tags.map((t) => `#${t}`).join(" "));
        }
      }
      return;
    }

    if (result.results) {
      const header = card.createDiv({ cls: "cypher-tool-header" });
      const titleBox = header.createDiv({ cls: "cypher-tool-summary" });
      titleBox.createSpan({ text: "Queried Vault: ", cls: "cypher-tool-tag" });
      titleBox.createSpan({ text: `"${result.query || ""}"`, cls: "cypher-tool-query" });
      titleBox.createSpan({
        text: ` (${result.results.length} / top-${result.k || 5} notes)`,
        cls: "cypher-tool-count",
      });

      const toggleBtn = header.createEl("button", {
        text: "Show details ▾",
        cls: "cypher-tool-toggle-btn",
      });

      const details = card.createDiv({ cls: "cypher-tool-details is-collapsed" });

      toggleBtn.onclick = () => {
        const isCollapsed = details.hasClass("is-collapsed");
        if (isCollapsed) {
          details.removeClass("is-collapsed");
          toggleBtn.setText("Hide details ▴");
        } else {
          details.addClass("is-collapsed");
          toggleBtn.setText("Show details ▾");
        }
      };

      if (result.results.length === 0) {
        details.createDiv({
          text: "No matching notes found above similarity threshold.",
          cls: "cypher-tool-no-results",
        });
        return;
      }

      for (const r of result.results) {
        const item = details.createDiv({ cls: "cypher-tool-item" });
        const topRow = item.createDiv({ cls: "cypher-tool-item-top" });

        const pct = Math.round(r.score * 100);
        const badge = topRow.createSpan({ cls: "cypher-score-badge" });
        badge.setText(`${pct}%`);

        const link = topRow.createEl("a", {
          text: r.title,
          cls: "cypher-tool-link",
        });
        link.onclick = (e) => {
          e.preventDefault();
          this.openFile(r.path, e.metaKey || e.ctrlKey);
        };

        if (r.heading) {
          const heading = topRow.createSpan({ cls: "cypher-tool-heading" });
          heading.setText(`› ${r.heading}`);
        }

        const snippet = item.createDiv({ cls: "cypher-tool-snippet" });
        const clean = r.text.replace(/^\[Note:.*?\]\n*/, "");
        snippet.setText(clean.length > 200 ? clean.slice(0, 200) + "..." : clean);
      }
    }
  }

  private renderInputArea(container: HTMLElement): void {
    this.inputAreaEl = container.createDiv({ cls: "cypher-chat-input-area" });

    this.statusEl = this.inputAreaEl.createDiv({ cls: "cypher-chat-status is-hidden" });

    const row = this.inputAreaEl.createDiv({ cls: "cypher-chat-input-row" });

    this.inputEl = row.createEl("textarea", {
      placeholder: "Ask Cypher anything about your vault...",
      cls: "cypher-chat-textarea",
    });

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.sendBtn = row.createEl("button", {
      text: "Send",
      cls: "mod-cta cypher-send-btn",
    });

    this.sendBtn.onclick = () => {
      this.sendMessage();
    };
  }

  private async sendMessage(): Promise<void> {
    if (this.generating || !this.inputEl) return;

    const text = this.inputEl.value.trim();
    if (!text) return;

    if (!this.plugin.settings.hasCompletedInitialIndexing) {
      new Notice("Please index your vault first before chatting.");
      this.plugin.openOnboardingModal();
      return;
    }

    if (!this.currentConversation) {
      this.currentConversation = await this.plugin.conversationService.create("New Chat");
    }

    if (this.currentConversation.messages.length === 0 && this.currentConversation.title === "New Chat") {
      const generatedTitle = this.plugin.conversationService.generateTitleFromContent(text);
      this.currentConversation.title = generatedTitle;
      this.updateSubheaderTitle();
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    this.currentConversation.messages.push(userMsg);
    await this.plugin.conversationService.save(this.currentConversation);
    this.updateHistoryButtonLabel();

    this.inputEl.value = "";
    this.renderMessages();

    this.generating = true;
    this.updateSendBtn();
    this.setStatus("Cypher is thinking and querying vault...");

    try {
      const assistantMsg = await this.plugin.chatService.sendMessage(this.currentConversation.messages, {
        topK: this.k,
        similarityThreshold: this.plugin.settings.chatSimilarityThreshold,
        onToolCall: (_tc, data) => {
          if (data.notes) {
            this.setStatus(`Listed notes in vault (${data.notes.length} notes found)...`);
          } else if (data.query) {
            this.setStatus(`Queried vault for: "${data.query}" (${data.results?.length ?? 0} results)...`);
          }
        },
      });

      this.currentConversation.messages.push(assistantMsg);
      await this.plugin.conversationService.save(this.currentConversation);
      this.updateHistoryButtonLabel();
      this.renderMessages();
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[Cypher Chat] Error:", err);
      new Notice(`Chat error: ${error}`);

      let help = "Please check your API URL, key, and model name in settings.";
      if ((this.plugin.settings.chatApiUrl || "").includes("api.openai.com") && !this.plugin.settings.chatApiKey) {
        help = "Your Chat API is currently pointing to OpenAI (`gpt-4o-mini`), but no API key was provided.\n\nTo use your free local Ollama model, click the model badge above or go to Cypher Settings > Conversation / Chat Model & API, set URL to `http://localhost:11434/v1`, and choose your local chat model (e.g. `qwen3.5:2b`).";
      }

      const errMsg: ChatMessage = {
        id: `msg-err-${Date.now()}`,
        role: "assistant",
        content: `**Error communicating with AI model:**\n${error}\n\n${help}`,
        timestamp: Date.now(),
      };
      this.currentConversation.messages.push(errMsg);
      await this.plugin.conversationService.save(this.currentConversation);
      this.updateHistoryButtonLabel();
      this.renderMessages();
    } finally {
      this.generating = false;
      this.updateSendBtn();
      this.clearStatus();
    }
  }

  private updateSendBtn(): void {
    if (this.sendBtn) {
      this.sendBtn.disabled = this.generating;
      this.sendBtn.setText(this.generating ? "..." : "Send");
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.removeClass("is-hidden");
      this.statusEl.setText(text);
    }
  }

  private clearStatus(): void {
    if (this.statusEl) {
      this.statusEl.addClass("is-hidden");
      this.statusEl.empty();
    }
  }

  private scrollToBottom(): void {
    if (this.boxEl) {
      this.boxEl.scrollTop = this.boxEl.scrollHeight;
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
