import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CypherPlugin from "../main";
import type { ChatMessage, ChatToolResult, Conversation } from "../types";
import { describeError, GenerationCancelledError } from "../errors";
import { confirmAction, promptText } from "./modals";

export const VIEW_TYPE_CYPHER_CHAT = "cypher-chat-view";

export class CypherChatView extends ItemView {
  private plugin: CypherPlugin;
  private currentConversation: Conversation | null = null;
  private showHistory = false;
  private generating = false;
  private editingIndex: number | null = null;
  private k: number;
  private abortController: AbortController | null = null;

  private containerArea: HTMLElement | null = null;
  private subheaderTitleEl: HTMLElement | null = null;
  private historyBtnEl: HTMLElement | null = null;
  private contentAreaEl: HTMLElement | null = null;
  private boxEl: HTMLElement | null = null;
  private inputAreaEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private streamingEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CypherPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.k = this.plugin.settings.chatTopK || 5;
  }

  public getViewType(): string {
    return VIEW_TYPE_CYPHER_CHAT;
  }

  public getDisplayText(): string {
    return "Cypher chat";
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
    this.abortController?.abort();
    this.abortController = null;
  }

  private async loadInitialConversation(): Promise<void> {
    try {
      const conversations = await this.plugin.conversationService.getAll();
      this.currentConversation =
        conversations[0] ?? (await this.plugin.conversationService.create("New chat"));
    } catch (error) {
      console.error("[cypher] could not load conversations:", error);
      this.currentConversation = await this.plugin.conversationService.create("New chat");
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
    const header = container.createDiv({ cls: "cypher-chat-header cypher-chat-header-main" });
    const topRow = header.createDiv({ cls: "cypher-chat-header-row" });
    const left = topRow.createDiv({ cls: "cypher-chat-header-left" });

    this.historyBtnEl = left.createEl("button", {
      cls: "cypher-btn-sm",
      text: "History",
      attr: { type: "button" },
    });
    this.historyBtnEl.setAttr("aria-label", "Browse past conversations");
    this.historyBtnEl.onclick = () => {
      this.showHistory = !this.showHistory;
      this.renderContentArea();
    };

    const titleBox = left.createDiv({ cls: "cypher-chat-title-box" });
    titleBox.createSpan({ text: "Cypher", cls: "cypher-chat-title" });

    const badge = titleBox.createSpan({
      cls: "cypher-chat-model-badge",
      text: this.plugin.settings.chatModel || "no model",
    });
    badge.setAttr("role", "button");
    badge.setAttr("tabindex", "0");
    badge.setAttr("aria-label", "Open chat settings");
    badge.style.cursor = "pointer";
    badge.onclick = () => this.openChatSettings();
    badge.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") this.openChatSettings();
    };

    const controls = topRow.createDiv({ cls: "cypher-chat-header-controls" });

    const newButton = controls.createEl("button", {
      cls: "cypher-btn-sm mod-cta",
      text: "New",
      attr: { type: "button" },
    });
    newButton.setAttr("aria-label", "Start a new conversation");
    newButton.onclick = () => void this.startNewConversation();

    const kBox = controls.createDiv({ cls: "cypher-k-control" });
    kBox.createSpan({ text: "Top K", cls: "cypher-k-label" });

    const kInput = kBox.createEl("input", {
      type: "number",
      value: String(this.k),
      cls: "cypher-k-input",
      attr: { min: "1", max: "25", step: "1", "aria-label": "Search results per vault query" },
    });
    kInput.addEventListener("change", () => {
      const value = Number.parseInt(kInput.value, 10);
      if (Number.isNaN(value)) return;
      this.k = Math.min(25, Math.max(1, value));
      kInput.value = String(this.k);
      this.plugin.settings.chatTopK = this.k;
      void this.plugin.saveSettings();
    });

    const subheader = header.createDiv({ cls: "cypher-chat-subheader" });
    this.subheaderTitleEl = subheader.createSpan({
      text: this.currentConversation?.title || "New chat",
      cls: "cypher-current-title",
    });
    this.subheaderTitleEl.setAttr("role", "button");
    this.subheaderTitleEl.setAttr("tabindex", "0");
    this.subheaderTitleEl.onclick = () => void this.promptRenameConversation();
    this.subheaderTitleEl.onkeydown = (event) => {
      if (event.key === "Enter") void this.promptRenameConversation();
    };

    const actions = subheader.createDiv({ cls: "cypher-subheader-actions" });

    const renameButton = actions.createEl("button", {
      cls: "cypher-btn-sm",
      text: "Rename",
      attr: { type: "button" },
    });
    renameButton.onclick = () => void this.promptRenameConversation();

    const deleteButton = actions.createEl("button", {
      cls: "cypher-btn-sm cypher-btn-danger",
      text: "Delete",
      attr: { type: "button" },
    });
    deleteButton.onclick = () => void this.deleteCurrentConversation();

    void this.updateHistoryButtonLabel();
  }

  private openChatSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open: () => void; openTabById: (id: string) => void };
    }).setting;
    setting?.open();
    setting?.openTabById("cypher");
  }

  private async updateHistoryButtonLabel(): Promise<void> {
    if (!this.historyBtnEl) return;
    const conversations = await this.plugin.conversationService.getAll();
    this.historyBtnEl.setText(`History (${conversations.length})`);
  }

  private updateSubheaderTitle(): void {
    this.subheaderTitleEl?.setText(this.currentConversation?.title || "New chat");
  }

  private renderContentArea(): void {
    if (!this.contentAreaEl) return;
    this.contentAreaEl.empty();
    this.streamingEl = null;

    if (this.showHistory) {
      if (this.inputAreaEl) this.inputAreaEl.style.display = "none";
      void this.renderHistoryDrawer(this.contentAreaEl);
    } else {
      if (this.inputAreaEl) this.inputAreaEl.style.display = "flex";
      this.renderMessagesArea(this.contentAreaEl);
    }

    void this.updateHistoryButtonLabel();
  }

  private async renderHistoryDrawer(container: HTMLElement): Promise<void> {
    const drawer = container.createDiv({ cls: "cypher-history-drawer" });
    const header = drawer.createDiv({ cls: "cypher-history-header" });
    const conversations = await this.plugin.conversationService.getAll();

    header.createSpan({
      text: `Past conversations (${conversations.length})`,
      cls: "cypher-history-header-title",
    });

    const headerActions = header.createDiv({ cls: "cypher-history-actions" });

    const newButton = headerActions.createEl("button", {
      cls: "cypher-btn-sm mod-cta",
      text: "New",
      attr: { type: "button" },
    });
    newButton.onclick = () => void this.startNewConversation();

    const closeButton = headerActions.createEl("button", {
      cls: "cypher-btn-sm",
      text: "Close",
      attr: { type: "button" },
    });
    closeButton.onclick = () => {
      this.showHistory = false;
      this.renderContentArea();
    };

    const list = drawer.createDiv({ cls: "cypher-history-list" });

    if (conversations.length === 0) {
      list.createDiv({ cls: "cypher-history-empty", text: "No saved conversations yet." });
      return;
    }

    for (const conversation of conversations) {
      const item = list.createDiv({ cls: "cypher-history-item" });
      if (this.currentConversation?.id === conversation.id) {
        item.addClass("is-active");
      }
      item.setAttr("tabindex", "0");
      item.setAttr("role", "button");

      const topRow = item.createDiv({ cls: "cypher-history-item-top" });
      topRow.createSpan({ text: conversation.title, cls: "cypher-history-item-title" });

      const actions = topRow.createDiv({ cls: "cypher-history-actions" });

      const renameButton = actions.createEl("button", {
        cls: "cypher-btn-sm",
        text: "Rename",
        attr: { type: "button" },
      });
      renameButton.onclick = async (event) => {
        event.stopPropagation();
        const newTitle = await promptText(this.app, "Rename conversation", conversation.title);
        if (!newTitle) return;

        await this.plugin.conversationService.rename(conversation.id, newTitle);
        if (this.currentConversation?.id === conversation.id) {
          this.currentConversation.title = newTitle;
          this.updateSubheaderTitle();
        }
        await this.renderHistoryDrawer(container);
      };

      const deleteButton = actions.createEl("button", {
        cls: "cypher-btn-sm cypher-btn-danger",
        text: "Delete",
        attr: { type: "button" },
      });
      deleteButton.onclick = async (event) => {
        event.stopPropagation();
        await this.deleteConversation(conversation.id);
      };

      const meta = item.createDiv({ cls: "cypher-history-item-meta" });
      meta.createSpan({ text: this.formatDate(conversation.updatedAt) });
      meta.createSpan({
        text: `${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"}`,
      });

      const open = () => void this.selectConversation(conversation.id);
      item.onclick = open;
      item.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") open();
      };
    }
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    const sameDay = (a: Date, b: Date) =>
      a.getDate() === b.getDate() &&
      a.getMonth() === b.getMonth() &&
      a.getFullYear() === b.getFullYear();

    if (sameDay(date, now)) {
      return `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (sameDay(date, yesterday)) {
      return `Yesterday, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }

    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  public async selectConversation(id: string): Promise<void> {
    if (this.generating) return;

    const conversation = await this.plugin.conversationService.get(id);
    if (!conversation) return;

    this.currentConversation = conversation;
    this.showHistory = false;
    this.updateSubheaderTitle();
    this.renderContentArea();
  }

  public async startNewConversation(): Promise<void> {
    if (this.generating) return;

    this.currentConversation = await this.plugin.conversationService.create("New chat");
    this.showHistory = false;
    this.updateSubheaderTitle();
    this.renderContentArea();
    this.inputEl?.focus();
  }

  private async deleteCurrentConversation(): Promise<void> {
    if (!this.currentConversation) return;
    await this.deleteConversation(this.currentConversation.id);
  }

  private async deleteConversation(id: string): Promise<void> {
    const confirmed = await confirmAction(
      this.app,
      "Delete conversation",
      "This conversation will be removed from local storage.",
      "Delete"
    );
    if (!confirmed) return;

    await this.plugin.conversationService.delete(id);

    if (this.currentConversation?.id === id) {
      const remaining = await this.plugin.conversationService.getAll();
      this.currentConversation =
        remaining[0] ?? (await this.plugin.conversationService.create("New chat"));
    }

    this.updateSubheaderTitle();
    this.renderContentArea();
  }

  private async promptRenameConversation(): Promise<void> {
    if (!this.currentConversation) return;

    const newTitle = await promptText(
      this.app,
      "Rename conversation",
      this.currentConversation.title
    );
    if (!newTitle) return;

    this.currentConversation.title = newTitle;
    await this.plugin.conversationService.rename(this.currentConversation.id, newTitle);
    this.updateSubheaderTitle();
  }

  private renderMessagesArea(container: HTMLElement): void {
    this.boxEl = container.createDiv({ cls: "cypher-chat-messages" });
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.boxEl) return;

    this.boxEl.empty();
    this.streamingEl = null;

    const messages = this.currentConversation?.messages ?? [];
    if (messages.length === 0) {
      this.renderEmpty(this.boxEl);
      return;
    }

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "system") continue;
      this.renderMessage(this.boxEl, message, index);
    }

    this.scrollToBottom();
  }

  private renderEmpty(container: HTMLElement): void {
    const box = container.createDiv({ cls: "cypher-chat-empty-state" });
    box.createEl("h4", { text: "Chat with your notes" });

    if (!this.plugin.isReady()) {
      box.createEl("p", {
        text: "Index your vault first, then ask questions about your notes.",
        cls: "cypher-empty-desc",
      });
      const setup = box.createEl("button", { text: "Run setup", cls: "mod-cta" });
      setup.onclick = () => this.plugin.openOnboardingModal();
      return;
    }

    box.createEl("p", {
      text: "Ask about anything in your vault. Cypher answers from your notes and cites them.",
      cls: "cypher-empty-desc",
    });

    const suggestions = box.createDiv({ cls: "cypher-suggestions" });
    for (const prompt of [
      "What are the main ideas in my notes?",
      "Summarize my project notes",
      "Find notes about my goals",
    ]) {
      const button = suggestions.createEl("button", {
        text: prompt,
        cls: "cypher-suggestion-btn",
      });
      button.onclick = () => {
        if (!this.inputEl) return;
        this.inputEl.value = prompt;
        void this.sendMessage();
      };
    }
  }

  private renderMessage(container: HTMLElement, message: ChatMessage, index: number): void {
    const messageEl = container.createDiv({
      cls: `cypher-message cypher-message-${message.role}`,
    });

    if (this.editingIndex === index && message.role === "user") {
      this.renderEditor(messageEl, message, index);
      return;
    }

    if (message.thinking) {
      this.renderThinking(messageEl, message.thinking);
    }

    const toolResults = message.toolResults ?? (message.toolResult ? [message.toolResult] : []);
    for (const result of toolResults) {
      this.renderToolCard(messageEl, result);
    }

    if (message.content || message.streaming) {
      const bubble = messageEl.createDiv({ cls: "cypher-message-bubble" });

      if (message.streaming) {
        bubble.setText(message.content);
        bubble.addClass("is-streaming");
        this.streamingEl = bubble;
      } else if (message.role === "assistant") {
        void MarkdownRenderer.render(this.app, message.content, bubble, "", this).catch(() => {
          bubble.setText(message.content);
        });
      } else {
        bubble.setText(message.content);
      }
    }

    if (message.stopped) {
      messageEl.createDiv({ cls: "cypher-message-hint", text: "Stopped" });
    }

    if (!message.streaming) {
      this.renderMessageActions(messageEl, message, index);
    }
  }

  private renderEditor(container: HTMLElement, message: ChatMessage, index: number): void {
    const editor = container.createDiv({ cls: "cypher-edit-container" });
    const textarea = editor.createEl("textarea", { cls: "cypher-edit-textarea" });
    textarea.value = message.content;

    const buttons = editor.createDiv({ cls: "cypher-edit-buttons" });

    const cancel = buttons.createEl("button", {
      cls: "cypher-btn-sm",
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.onclick = () => {
      this.editingIndex = null;
      this.renderMessages();
    };

    const submit = buttons.createEl("button", {
      cls: "cypher-btn-sm mod-cta",
      text: "Save and resubmit",
      attr: { type: "button" },
    });
    submit.onclick = () => {
      const text = textarea.value.trim();
      if (!text) return;
      this.editingIndex = null;
      void this.modifyUserMessage(index, text);
    };

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit.click();
      } else if (event.key === "Escape") {
        cancel.click();
      }
    });

    window.setTimeout(() => textarea.focus(), 50);
  }

  private renderMessageActions(
    container: HTMLElement,
    message: ChatMessage,
    index: number
  ): void {
    if (message.isError) return;

    const actions = container.createDiv({ cls: "cypher-message-actions" });

    if (message.role === "user") {
      const edit = actions.createEl("button", {
        cls: "cypher-msg-action-btn",
        text: "Edit",
        attr: { type: "button" },
      });
      edit.onclick = () => {
        if (this.generating) return;
        this.editingIndex = index;
        this.renderMessages();
      };
      return;
    }

    if (message.role !== "assistant") return;

    const redo = actions.createEl("button", {
      cls: "cypher-msg-action-btn",
      text: "Regenerate",
      attr: { type: "button" },
    });
    redo.onclick = () => {
      if (this.generating) return;
      void this.redoFromMessage(index);
    };

    const copy = actions.createEl("button", {
      cls: "cypher-msg-action-btn",
      text: "Copy",
      attr: { type: "button" },
    });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(message.content);
      new Notice("Copied to clipboard");
    };
  }

  private renderThinking(container: HTMLElement, thinking: string): void {
    const block = container.createDiv({ cls: "cypher-thinking-block" });
    const header = block.createDiv({ cls: "cypher-thinking-header" });

    header.createSpan({ text: "Reasoning", cls: "cypher-thinking-label" });

    const toggle = header.createEl("button", {
      text: "Show",
      cls: "cypher-thinking-toggle-btn",
      attr: { type: "button" },
    });

    const body = block.createDiv({ cls: "cypher-thinking-body is-collapsed", text: thinking });

    const flip = () => {
      const collapsed = body.hasClass("is-collapsed");
      body.toggleClass("is-collapsed", !collapsed);
      toggle.setText(collapsed ? "Hide" : "Show");
    };

    header.onclick = (event) => {
      if (event.target !== toggle) flip();
    };
    toggle.onclick = (event) => {
      event.stopPropagation();
      flip();
    };
  }

  private renderToolCard(container: HTMLElement, result: ChatToolResult): void {
    const card = container.createDiv({ cls: "cypher-tool-card" });
    const header = card.createDiv({ cls: "cypher-tool-header" });
    const summary = header.createDiv({ cls: "cypher-tool-summary" });
    const details = card.createDiv({ cls: "cypher-tool-details is-collapsed" });
    let toggle: HTMLButtonElement | null = null;

    const addToggle = (showLabel: string) => {
      toggle = header.createEl("button", {
        text: showLabel,
        cls: "cypher-tool-toggle-btn",
        attr: { type: "button" },
      });
      const hideLabel = showLabel.replace("Show", "Hide");
      toggle.onclick = () => {
        const collapsed = details.hasClass("is-collapsed");
        details.toggleClass("is-collapsed", !collapsed);
        toggle?.setText(collapsed ? hideLabel : showLabel);
      };
    };

    if (result.error) {
      summary.createSpan({ text: result.toolName || "tool", cls: "cypher-tool-tag" });
      summary.createSpan({ text: " failed", cls: "cypher-tool-count" });
      details.createDiv({ text: result.error, cls: "cypher-tool-no-results" });
      addToggle("Show error");
      return;
    }

    if (result.toolName === "read_note" || result.note) {
      summary.createSpan({ text: "read_note", cls: "cypher-tool-tag" });
      summary.createSpan({
        text: result.note ? ` · ${result.note.path}` : " · not found",
        cls: "cypher-tool-count",
      });
      if (!result.note) return;

      addToggle("Show content");
      details.createDiv({ text: result.note.content, cls: "cypher-read-note-body" });
      return;
    }

    if (result.notes) {
      summary.createSpan({ text: "list_notes", cls: "cypher-tool-tag" });
      summary.createSpan({
        text: ` · ${result.notes.length} note${result.notes.length === 1 ? "" : "s"}`,
        cls: "cypher-tool-count",
      });
      addToggle("Show notes");

      if (result.notes.length === 0) {
        details.createDiv({ text: "No matching notes.", cls: "cypher-tool-no-results" });
        return;
      }

      for (const note of result.notes) {
        const item = details.createDiv({ cls: "cypher-tool-item" });
        const row = item.createDiv({ cls: "cypher-tool-item-top" });
        row.createSpan({ text: note.dir, cls: "cypher-score-badge" });

        const link = row.createEl("a", { text: note.title, cls: "cypher-tool-link" });
        link.onclick = (event) => {
          event.preventDefault();
          void this.openFile(note.path, event.metaKey || event.ctrlKey);
        };

        if (note.tags.length > 0) {
          row.createSpan({
            text: note.tags.map((tag) => `#${tag}`).join(" "),
            cls: "cypher-tool-heading",
          });
        }
      }
      return;
    }

    if (result.results) {
      summary.createSpan({ text: "query_vault", cls: "cypher-tool-tag" });
      summary.createSpan({
        text: ` · "${result.query ?? ""}" · ${result.results.length} result${
          result.results.length === 1 ? "" : "s"
        }`,
        cls: "cypher-tool-count",
      });
      addToggle("Show results");

      if (result.results.length === 0) {
        details.createDiv({
          text: "No chunks passed the similarity threshold.",
          cls: "cypher-tool-no-results",
        });
        return;
      }

      for (const hit of result.results) {
        const item = details.createDiv({ cls: "cypher-tool-item" });
        const row = item.createDiv({ cls: "cypher-tool-item-top" });
        row.createSpan({
          text: `${Math.round(hit.score * 100)}%`,
          cls: "cypher-score-badge",
        });

        const link = row.createEl("a", { text: hit.title, cls: "cypher-tool-link" });
        link.onclick = (event) => {
          event.preventDefault();
          void this.openFile(hit.path, event.metaKey || event.ctrlKey);
        };

        if (hit.heading) {
          row.createSpan({ text: hit.heading, cls: "cypher-tool-heading" });
        }

        const clean = hit.text.replace(/^\[[^\]]+\]\n/, "");
        item.createDiv({
          text: clean.length > 220 ? `${clean.slice(0, 220)}...` : clean,
          cls: "cypher-tool-snippet",
        });
      }
    }
  }

  private renderInputArea(container: HTMLElement): void {
    this.inputAreaEl = container.createDiv({ cls: "cypher-chat-input-area" });

    this.statusEl = this.inputAreaEl.createDiv({ cls: "cypher-chat-status is-hidden" });
    this.statusEl.setAttr("role", "status");
    this.statusEl.setAttr("aria-live", "polite");

    const row = this.inputAreaEl.createDiv({ cls: "cypher-chat-input-row" });

    this.inputEl = row.createEl("textarea", {
      placeholder: "Ask about your notes...",
      cls: "cypher-chat-textarea",
    });
    this.inputEl.setAttr("aria-label", "Message");
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
    });

    this.sendBtn = row.createEl("button", {
      text: "Send",
      cls: "mod-cta cypher-send-btn",
      attr: { type: "button" },
    });
    this.sendBtn.onclick = () => {
      if (this.generating) {
        this.abortController?.abort();
        return;
      }
      void this.sendMessage();
    };
  }

  public async modifyUserMessage(index: number, text: string): Promise<void> {
    if (this.generating || !this.currentConversation) return;

    this.currentConversation.messages = this.currentConversation.messages.slice(0, index);
    this.currentConversation.messages.push({
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    if (index === 0) {
      this.currentConversation.title =
        this.plugin.conversationService.generateTitleFromContent(text);
      this.updateSubheaderTitle();
    }

    await this.plugin.conversationService.save(this.currentConversation);
    this.renderMessages();
    await this.generate();
  }

  public async redoFromMessage(index: number): Promise<void> {
    if (this.generating || !this.currentConversation) return;

    this.currentConversation.messages = this.currentConversation.messages.slice(0, index);
    await this.plugin.conversationService.save(this.currentConversation);
    this.renderMessages();
    await this.generate();
  }

  private async sendMessage(): Promise<void> {
    if (this.generating || !this.inputEl || !this.currentConversation) return;

    const text = this.inputEl.value.trim();
    if (!text) return;

    if (!this.plugin.isReady()) {
      new Notice("Cypher: index your vault before chatting.");
      this.plugin.openOnboardingModal();
      return;
    }

    if (this.currentConversation.messages.length === 0) {
      this.currentConversation.title =
        this.plugin.conversationService.generateTitleFromContent(text);
      this.updateSubheaderTitle();
    }

    this.currentConversation.messages.push({
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    });

    this.inputEl.value = "";
    await this.plugin.conversationService.save(this.currentConversation);
    this.renderMessages();
    await this.generate();
  }

  private async generate(): Promise<void> {
    if (!this.currentConversation) return;

    this.generating = true;
    this.abortController = new AbortController();
    this.updateSendButton();
    this.setStatus("Searching your notes...");

    const placeholder: ChatMessage = {
      id: `stream-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    };

    this.currentConversation.messages.push(placeholder);
    this.renderMessages();

    let buffer = "";

    try {
      const message = await this.plugin.chatService.sendMessage(
        this.currentConversation.messages.filter((item) => !item.streaming),
        {
          topK: this.k,
          similarityThreshold: this.plugin.settings.chatSimilarityThreshold,
          signal: this.abortController.signal,
          onToken: (delta) => {
            buffer += delta;
            if (this.streamingEl) {
              this.streamingEl.setText(buffer);
            }
            this.setStatus("");
            this.scrollToBottom();
          },
          onToolCall: (_call, data) => {
            if (data.note) {
              this.setStatus(`Reading ${data.note.path}...`);
            } else if (data.notes) {
              this.setStatus(`Listing notes (${data.notes.length})...`);
            } else if (data.query) {
              this.setStatus(
                `Searching for "${data.query}" (${data.results?.length ?? 0} chunks)...`
              );
            }
          },
        }
      );

      this.currentConversation.messages = this.currentConversation.messages.filter(
        (item) => !item.streaming
      );
      this.currentConversation.messages.push(message);
    } catch (error) {
      this.currentConversation.messages = this.currentConversation.messages.filter(
        (item) => !item.streaming
      );

      if (!(error instanceof GenerationCancelledError)) {
        console.error("[cypher] chat request failed:", error);
        new Notice(`Cypher: ${describeError(error)}`);

        this.currentConversation.messages.push({
          id: `err-${Date.now()}`,
          role: "assistant",
          content: this.errorHelp(error),
          timestamp: Date.now(),
          isError: true,
        });
      } else {
        new Notice("Generation stopped.");
      }
    } finally {
      this.generating = false;
      this.abortController = null;
      this.updateSendButton();
      this.clearStatus();
      await this.plugin.conversationService.save(this.currentConversation);
      this.renderMessages();
      void this.updateHistoryButtonLabel();
    }
  }

  private errorHelp(error: unknown): string {
    const detail = describeError(error);
    const hint =
      "Check the chat API URL, key, and model in Cypher settings.";

    return `**Request failed**\n\n${detail}\n\n${hint}`;
  }

  private updateSendButton(): void {
    if (!this.sendBtn) return;
    this.sendBtn.setText(this.generating ? "Stop" : "Send");
    this.sendBtn.toggleClass("mod-warning", this.generating);
  }

  private setStatus(text: string): void {
    if (!this.statusEl) return;
    if (!text) {
      this.clearStatus();
      return;
    }
    this.statusEl.removeClass("is-hidden");
    this.statusEl.setText(text);
  }

  private clearStatus(): void {
    this.statusEl?.addClass("is-hidden");
    this.statusEl?.empty();
  }

  private scrollToBottom(): void {
    if (this.boxEl) {
      this.boxEl.scrollTop = this.boxEl.scrollHeight;
    }
  }

  private async openFile(path: string, newLeaf = false): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Cypher: note not found at ${path}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(newLeaf);
    await leaf.openFile(file);
  }
}
