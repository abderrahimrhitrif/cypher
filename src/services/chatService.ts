import { MetadataCache, TFile, Vault, requestUrl } from "obsidian";
import { ChatMessage, ChatToolResult, CypherSettings, NoteMeta, SearchResult, ToolCall } from "../types";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export interface SendMessageOptions {
  topK?: number;
  similarityThreshold?: number;
  onToolCall?: (
    toolCall: ToolCall,
    data: { query?: string; k?: number; results?: SearchResult[]; notes?: NoteMeta[] }
  ) => void;
  signal?: AbortSignal;
}

export class ChatService {
  private settings: CypherSettings;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;
  private vault?: Vault;
  private metaCache?: MetadataCache;

  constructor(
    settings: CypherSettings,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService,
    vault?: Vault,
    metaCache?: MetadataCache
  ) {
    this.settings = settings;
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
    this.vault = vault;
    this.metaCache = metaCache;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  public getChatEndpointUrl(urlOverride?: string): string {
    const raw =
      urlOverride !== undefined
        ? urlOverride
        : this.settings.chatApiUrl || this.settings.apiUrl || "https://api.openai.com/v1";
    let url = raw.trim();
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    if (url.endsWith("/embeddings")) {
      url = url.slice(0, -"/embeddings".length);
    }
    if (url.endsWith("/chat/completions")) {
      return url;
    }
    return `${url}/chat/completions`;
  }

  public async testChatConnection(
    urlOverride?: string,
    keyOverride?: string,
    modelOverride?: string
  ): Promise<{ success: boolean; error?: string }> {
    const endpoint = this.getChatEndpointUrl(urlOverride);
    const key =
      keyOverride !== undefined
        ? keyOverride
        : this.settings.chatApiKey !== undefined
        ? this.settings.chatApiKey
        : this.settings.apiKey || "";
    const model =
      modelOverride !== undefined
        ? modelOverride
        : this.settings.chatModel || "gpt-4o-mini";

    if (!endpoint) {
      return { success: false, error: "Chat API URL is required" };
    }
    if (!model) {
      return { success: false, error: "Chat Model name is required" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key && key.trim().length > 0) {
      headers["Authorization"] = `Bearer ${key.trim()}`;
    }

    try {
      const res = await requestUrl({
        url: endpoint,
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.trim(),
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 5,
        }),
        throw: false,
      });

      if (res.status === 200) {
        return { success: true };
      }

      let detail = res.text;
      try {
        if (res.json && res.json.error) {
          detail = res.json.error.message || JSON.stringify(res.json.error);
        }
      } catch {
      }
      return { success: false, error: `HTTP ${res.status}: ${detail}` };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  private getTools(k: number) {
    return [
      {
        type: "function",
        function: {
          name: "query_vault",
          description:
            `Searches the user's Obsidian vault notes for relevant information using semantic vector embeddings. ` +
            `Returns the top ${k} most semantically relevant note excerpts. ` +
            `Call this tool whenever you need facts, personal notes, ideas, or context from the user's vault.`,
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query or concept to retrieve from vault notes (e.g. 'project goals', 'machine learning notes', 'meeting notes')",
              },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_notes",
          description:
            "Lists all notes in the vault with their title, directory relative to the vault, and tags. " +
            "Call this tool when the user asks what notes exist, what topics or tags are in the vault, for an overview or list of files, or to find notes in a folder.",
          parameters: {
            type: "object",
            properties: {
              tag: {
                type: "string",
                description: "Optional tag filter (e.g. 'project', 'ai')",
              },
              directory: {
                type: "string",
                description: "Optional directory/folder filter (e.g. 'work', 'daily')",
              },
            },
          },
        },
      },
    ];
  }

  public async executeQueryVaultTool(
    query: string,
    k: number,
    threshold: number
  ): Promise<SearchResult[]> {
    console.log(`[Cypher Chat] Executing query_vault tool for query: "${query}" (top-k=${k})`);
    const vec = await this.embedSvc.getQueryEmbedding(query);
    return this.vecDb.search(vec, k, threshold);
  }

  public executeListNotesTool(tagFilter?: string, dirFilter?: string): NoteMeta[] {
    if (!this.vault) return [];
    const files = this.vault.getMarkdownFiles();
    const results: NoteMeta[] = [];
    const cleanTag = tagFilter ? tagFilter.trim().replace(/^#/, "").toLowerCase() : "";
    const cleanDir = dirFilter ? dirFilter.trim().replace(/^\/+|\/+$/g, "").toLowerCase() : "";

    for (const file of files) {
      if (this.isExcluded(file.path)) continue;

      const dir = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "/";
      if (cleanDir && !dir.toLowerCase().includes(cleanDir)) {
        continue;
      }

      const tags = this.extractTags(file);
      if (cleanTag && !tags.some((t) => t.toLowerCase() === cleanTag)) {
        continue;
      }

      results.push({
        title: file.basename,
        path: file.path,
        dir,
        tags,
      });
    }

    return results;
  }

  private isExcluded(path: string): boolean {
    for (const folder of this.settings.excludedFolders) {
      const clean = folder.trim();
      if (!clean) continue;
      if (path.startsWith(clean + "/") || path === clean) {
        return true;
      }
    }
    return false;
  }

  private extractTags(file: TFile): string[] {
    if (!this.metaCache) return [];
    const cache = this.metaCache.getFileCache(file);
    const tags = new Set<string>();

    if (cache?.tags) {
      for (const t of cache.tags) {
        const clean = t.tag.replace(/^#/, "").trim();
        if (clean) tags.add(clean);
      }
    }

    const fm = cache?.frontmatter;
    if (fm) {
      const raw = fm.tags ?? fm.tag;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (typeof item === "string") {
            const clean = item.replace(/^#/, "").trim();
            if (clean) tags.add(clean);
          }
        }
      } else if (typeof raw === "string") {
        for (const item of raw.split(/[,\s]+/)) {
          const clean = item.replace(/^#/, "").trim();
          if (clean) tags.add(clean);
        }
      }
    }

    return Array.from(tags);
  }

  private formatResults(query: string, k: number, results: SearchResult[]): string {
    if (results.length === 0) {
      return `No notes found in the vault matching query "${query}" above the similarity threshold.`;
    }

    const items = results.map((r, i) => {
      const pct = Math.round(r.score * 100);
      const headingPart = r.heading ? ` > Heading: "${r.heading}"` : "";
      return `[Result ${i + 1} | Note: "${r.title}"${headingPart} | File: "${r.path}" | Similarity: ${pct}%]\n${r.text}`;
    });

    return (
      `Retrieved ${results.length} relevant note chunks from the user's vault for query "${query}":\n\n` +
      items.join("\n\n---\n\n")
    );
  }

  private formatNotes(notes: NoteMeta[]): string {
    if (notes.length === 0) {
      return "No notes found in the vault matching criteria.";
    }
    const lines = notes.map((n) => {
      const tagList = n.tags.length > 0 ? n.tags.map((t) => `#${t}`).join(" ") : "none";
      return `- Title: "${n.title}" | Directory: "${n.dir}" | Tags: [${tagList}] | Path: "${n.path}"`;
    });
    return `Found ${notes.length} notes in the vault:\n${lines.join("\n")}`;
  }

  public static extractThinkingAndContent(
    rawContent: string,
    rawReasoning?: string
  ): { content: string; thinking: string } {
    let content = rawContent || "";
    let thinking = (rawReasoning || "").trim();

    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
      const parsed = thinkMatch[1].trim();
      thinking = thinking ? `${thinking}\n\n${parsed}` : parsed;
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    return { content, thinking };
  }

  public async sendMessage(
    history: ChatMessage[],
    opts: SendMessageOptions = {}
  ): Promise<ChatMessage> {
    const k = opts.topK ?? this.settings.chatTopK ?? 5;
    const threshold = opts.similarityThreshold ?? this.settings.chatSimilarityThreshold ?? 0.25;

    const endpoint = this.getChatEndpointUrl();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const key =
      this.settings.chatApiKey !== undefined
        ? this.settings.chatApiKey
        : this.settings.apiKey || "";

    if (key && key.trim().length > 0) {
      headers["Authorization"] = `Bearer ${key.trim()}`;
    }

    const messages: Array<{
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      name?: string;
    }> = [
      {
        role: "system",
        content:
          this.settings.chatSystemPrompt ||
          "You are Cypher, an AI assistant strictly grounded in the user's Obsidian vault. You can ONLY answer using information found in the notes retrieved via `query_vault` or `list_notes`. Never use outside world knowledge or speculate. If the information is not in the notes, state: 'I could not find this information in your notes.'",
      },
    ];

    for (const msg of history) {
      if (msg.role === "system") continue;
      messages.push({
        role: msg.role,
        content: msg.content,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });
    }

    let turn = 0;
    const maxTurns = 3;
    const accumulatedToolResults: ChatToolResult[] = [];
    let accumulatedThinking = "";

    while (turn < maxTurns) {
      turn++;

      const payload = {
        model: this.settings.chatModel.trim(),
        messages,
        tools: this.getTools(k),
        tool_choice: "auto",
        temperature: 0.7,
      };

      const res = await requestUrl({
        url: endpoint,
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        throw: false,
      });

      if (res.status !== 200) {
        let detail = res.text;
        try {
          if (res.json && res.json.error) {
            detail = res.json.error.message || JSON.stringify(res.json.error);
          }
        } catch {
        }
        throw new Error(`Chat API error (HTTP ${res.status}): ${detail}`);
      }

      const resJson = res.json;
      if (!resJson || !resJson.choices || resJson.choices.length === 0) {
        throw new Error("Invalid response from chat API: no choices returned");
      }

      const choice = resJson.choices[0];
      const msg = choice.message;

      const { content: cleanContent, thinking: turnThinking } =
        ChatService.extractThinkingAndContent(
          msg.content || "",
          (msg as Record<string, unknown>).reasoning_content as string | undefined
        );

      if (turnThinking) {
        accumulatedThinking = accumulatedThinking
          ? `${accumulatedThinking}\n\n${turnThinking}`
          : turnThinking;
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls as ToolCall[]) {
          if (tc.function && tc.function.name === "query_vault") {
            let args: { query?: string } = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = { query: tc.function.arguments };
            }

            const query = args.query || "";
            const results = await this.executeQueryVaultTool(query, k, threshold);
            const toolResult: ChatToolResult = { toolName: "query_vault", query, k, results };
            accumulatedToolResults.push(toolResult);

            if (opts.onToolCall) {
              opts.onToolCall(tc, { query, k, results });
            }

            const out = this.formatResults(query, k, results);

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: out,
            });
          } else if (tc.function && tc.function.name === "list_notes") {
            let args: { tag?: string; directory?: string } = {};
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
            }

            const notes = this.executeListNotesTool(args.tag, args.directory);
            const toolResult: ChatToolResult = { toolName: "list_notes", notes };
            accumulatedToolResults.push(toolResult);

            if (opts.onToolCall) {
              opts.onToolCall(tc, { notes });
            }

            const out = this.formatNotes(notes);

            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: out,
            });
          }
        }

        continue;
      }

      return {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "assistant",
        content: cleanContent,
        timestamp: Date.now(),
        thinking: accumulatedThinking.trim() || undefined,
        toolResult: accumulatedToolResults[0],
        toolResults: accumulatedToolResults.length > 0 ? accumulatedToolResults : undefined,
      };
    }

    throw new Error("Exceeded maximum tool execution turns");
  }
}
