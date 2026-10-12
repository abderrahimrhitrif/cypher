import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type CypherPlugin from "../main";
import { ChatMessage, ChatToolResult } from "../types";

export const VIEW_TYPE_CYPHER_CHAT = "cypher-chat-view";

export class CypherChatView extends ItemView {
  private plugin: CypherPlugin;
  private messages: ChatMessage[] = [];
  private generating = false;
  private k: number;

  private boxEl: HTMLElement | null = null;
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

    this.renderHeader(container);
    this.renderMessagesArea(container);
    this.renderInputArea(container);
  }

  public async onClose(): Promise<void> {
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "cypher-chat-header" });

    const left = header.createDiv({ cls: "cypher-chat-header-left" });
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

    const controls = header.createDiv({ cls: "cypher-chat-header-controls" });

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

    const clearBtn = controls.createEl("button", {
      cls: "cypher-chat-btn-clear",
      text: "Clear",
      title: "Clear conversation",
    });
    clearBtn.onclick = () => {
      this.messages = [];
      this.renderMessages();
    };
  }

  private renderMessagesArea(container: HTMLElement): void {
    this.boxEl = container.createDiv({ cls: "cypher-chat-messages" });
    this.renderMessages();
  }

  private renderMessages(): void {
    if (!this.boxEl) return;
    this.boxEl.empty();

    if (this.messages.length === 0) {
      this.renderEmpty(this.boxEl);
      return;
    }

    for (const msg of this.messages) {
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
    const area = container.createDiv({ cls: "cypher-chat-input-area" });

    this.statusEl = area.createDiv({ cls: "cypher-chat-status is-hidden" });

    const row = area.createDiv({ cls: "cypher-chat-input-row" });

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

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    this.messages.push(userMsg);
    this.inputEl.value = "";
    this.renderMessages();

    this.generating = true;
    this.updateSendBtn();
    this.setStatus("Cypher is thinking and querying vault...");

    try {
      const assistantMsg = await this.plugin.chatService.sendMessage(this.messages, {
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

      this.messages.push(assistantMsg);
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
      this.messages.push(errMsg);
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
