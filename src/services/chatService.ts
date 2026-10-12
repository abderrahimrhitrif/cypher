import { requestUrl } from "obsidian";
import { ChatMessage, ChatToolResult, CypherSettings, SearchResult, ToolCall } from "../types";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export interface SendMessageOptions {
  topK?: number;
  similarityThreshold?: number;
  onToolCall?: (toolCall: ToolCall, results: SearchResult[], query: string, k: number) => void;
  signal?: AbortSignal;
}

export class ChatService {
  private settings: CypherSettings;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;

  constructor(
    settings: CypherSettings,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService
  ) {
    this.settings = settings;
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
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
          "You are Cypher, an AI assistant strictly grounded in the user's Obsidian vault. You can ONLY answer using information found in the notes retrieved via `query_vault`. Never use outside world knowledge or speculate. If the information is not in the notes, state: 'I could not find this information in your notes.'",
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
    let toolResult: ChatToolResult | undefined = undefined;

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
            toolResult = { query, k, results };

            if (opts.onToolCall) {
              opts.onToolCall(tc, results, query, k);
            }

            const out = this.formatResults(query, k, results);

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
        content: msg.content || "",
        timestamp: Date.now(),
        toolResult,
      };
    }

    throw new Error("Exceeded maximum tool execution turns");
  }
}
