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
  private embeddingService: EmbeddingService;
  private vectorDbService: VectorDbService;

  constructor(
    settings: CypherSettings,
    embeddingService: EmbeddingService,
    vectorDbService: VectorDbService
  ) {
    this.settings = settings;
    this.embeddingService = embeddingService;
    this.vectorDbService = vectorDbService;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  /**
   * Normalizes the API URL for chat completions endpoint.
   */
  private getChatEndpointUrl(): string {
    let clean = this.settings.apiUrl.trim();
    if (clean.endsWith("/")) {
      clean = clean.slice(0, -1);
    }
    if (clean.endsWith("/embeddings")) {
      clean = clean.slice(0, -"/embeddings".length);
    }
    if (clean.endsWith("/chat/completions")) {
      return clean;
    }
    return `${clean}/chat/completions`;
  }

  /**
   * Defines the query tool schema for OpenAI-compatible function calling.
   */
  private getToolsDefinition(k: number) {
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

  /**
   * Executes the query tool against the local embedded vector database.
   */
  public async executeQueryVaultTool(
    query: string,
    k: number,
    similarityThreshold: number
  ): Promise<SearchResult[]> {
    console.log(`[Cypher Chat] Executing query_vault tool for query: "${query}" (top-k=${k})`);
    const queryEmbedding = await this.embeddingService.getQueryEmbedding(query);
    const results = await this.vectorDbService.search(queryEmbedding, k, similarityThreshold);
    return results;
  }

  /**
   * Formats search results into a clean string for the LLM tool response.
   */
  private formatSearchResultsForModel(query: string, k: number, results: SearchResult[]): string {
    if (results.length === 0) {
      return `No notes found in the vault matching query "${query}" above the similarity threshold.`;
    }

    const chunks = results.map((r, i) => {
      const scorePct = Math.round(r.score * 100);
      const headingPart = r.heading ? ` > Heading: "${r.heading}"` : "";
      return `[Result ${i + 1} | Note: "${r.title}"${headingPart} | File: "${r.path}" | Similarity: ${scorePct}%]\n${r.text}`;
    });

    return (
      `Retrieved ${results.length} relevant note chunks from the user's vault for query "${query}":\n\n` +
      chunks.join("\n\n---\n\n")
    );
  }

  /**
   * Sends the conversation to the chat completion API, handles tool calling loops,
   * and returns the final assistant message along with any tool results.
   */
  public async sendMessage(
    history: ChatMessage[],
    options: SendMessageOptions = {}
  ): Promise<ChatMessage> {
    const k = options.topK ?? this.settings.chatTopK ?? 5;
    const threshold = options.similarityThreshold ?? this.settings.chatSimilarityThreshold ?? 0.25;

    const endpoint = this.getChatEndpointUrl();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.settings.apiKey && this.settings.apiKey.trim().length > 0) {
      headers["Authorization"] = `Bearer ${this.settings.apiKey.trim()}`;
    }

    // Build the messages payload starting with system prompt
    const apiMessages: Array<{
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
      if (msg.role === "system") continue; // system prompt already added above
      apiMessages.push({
        role: msg.role,
        content: msg.content,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      });
    }

    let loopCount = 0;
    const maxToolTurns = 3;
    let accumulatedToolResult: ChatToolResult | undefined = undefined;

    while (loopCount < maxToolTurns) {
      loopCount++;

      const payload = {
        model: this.settings.chatModel.trim(),
        messages: apiMessages,
        tools: this.getToolsDefinition(k),
        tool_choice: "auto",
        temperature: 0.7,
      };

      const response = await requestUrl({
        url: endpoint,
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        throw: false,
      });

      if (response.status !== 200) {
        let errorDetail = response.text;
        try {
          if (response.json && response.json.error) {
            errorDetail = response.json.error.message || JSON.stringify(response.json.error);
          }
        } catch {
          // ignore
        }
        throw new Error(`Chat API error (HTTP ${response.status}): ${errorDetail}`);
      }

      const resData = response.json;
      if (!resData || !resData.choices || resData.choices.length === 0) {
        throw new Error("Invalid response from chat API: no choices returned");
      }

      const choice = resData.choices[0];
      const message = choice.message;

      // Check if model called a tool
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Model requested one or more tool calls
        apiMessages.push({
          role: "assistant",
          content: message.content || "",
          tool_calls: message.tool_calls,
        });

        for (const toolCall of message.tool_calls as ToolCall[]) {
          if (toolCall.function && toolCall.function.name === "query_vault") {
            let parsedArgs: { query?: string } = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments);
            } catch (err) {
              parsedArgs = { query: toolCall.function.arguments };
            }

            const query = parsedArgs.query || "";
            const searchResults = await this.executeQueryVaultTool(query, k, threshold);
            accumulatedToolResult = { query, k, results: searchResults };

            if (options.onToolCall) {
              options.onToolCall(toolCall, searchResults, query, k);
            }

            const toolOutput = this.formatSearchResultsForModel(query, k, searchResults);

            apiMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: toolOutput,
            });
          }
        }

        // Loop back to send tool result to LLM
        continue;
      }

      // Final assistant response with no more tool calls
      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "assistant",
        content: message.content || "",
        timestamp: Date.now(),
        toolResult: accumulatedToolResult,
      };

      return assistantMessage;
    }

    throw new Error("Exceeded maximum tool execution turns");
  }
}
