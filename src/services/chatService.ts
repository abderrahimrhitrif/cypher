import type { MetadataCache, Vault } from "obsidian";
import { requestUrl } from "obsidian";
import type { TFile } from "obsidian";
import {
  ChatMessage,
  ChatToolResult,
  CypherSettings,
  NoteContent,
  NoteMeta,
  SearchResult,
  ToolCall,
} from "../types";
import {
  ApiError,
  describeError,
  GenerationCancelledError,
  isAbortError,
  StreamUnavailableError,
} from "../errors";
import { isPathExcluded, normalizeBaseUrl, truncate, uniqueId } from "../utils";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export interface SendMessageOptions {
  topK?: number;
  similarityThreshold?: number;
  /** Called for every streamed token when the provider supports SSE. */
  onToken?: (delta: string) => void;
  onToolCall?: (
    toolCall: ToolCall,
    data: {
      query?: string;
      k?: number;
      results?: SearchResult[];
      notes?: NoteMeta[];
      note?: NoteContent;
    }
  ) => void;
  /** Stop generation, e.g. from a Stop button. */
  signal?: AbortSignal;
}

interface ChatTurn {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  /** Raw assistant content, which is what tool-call turns must echo back. */
  rawContent: string;
}

interface ToolOutcome {
  result: ChatToolResult;
  text: string;
}

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_MESSAGES = 30;
const MAX_HISTORY_CHARS = 60_000;
const MAX_RESULT_CHARS = 1_800;
const MAX_TOTAL_CONTEXT_CHARS = 14_000;
const MAX_NOTE_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 180_000;

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
    const base = normalizeBaseUrl(urlOverride ?? this.settings.chatApiUrl);
    if (!base) {
      throw new Error("Chat API base URL is not configured. Set it in Cypher settings.");
    }
    return `${base}/chat/completions`;
  }

  public async testChatConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const endpoint = this.getChatEndpointUrl();
      const response = await this.postJson(endpoint, {
        model: this.getModel(),
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 5,
      });

      const choices = response.choices as unknown[] | undefined;
      if (!choices || choices.length === 0) {
        return { success: false, error: "The chat API returned no choices" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: describeError(error) };
    }
  }

  private getModel(): string {
    const model = this.settings.chatModel.trim();
    if (!model) {
      throw new Error("Chat model name is not configured. Set it in Cypher settings.");
    }
    return model;
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.settings.chatApiKey.trim();
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    return headers;
  }

  private getTools(): unknown[] {
    return [
      {
        type: "function",
        function: {
          name: "query_vault",
          description:
            "Semantic search over the user's notes. Returns the most relevant note excerpts. " +
            "Use it whenever an answer depends on facts, decisions, or ideas stored in the vault.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "What to look for, phrased as a concept or question",
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
            "Lists notes with their title, folder, and tags. Use it to browse the vault, " +
            "find notes in a folder, or filter notes by tag.",
          parameters: {
            type: "object",
            properties: {
              tag: { type: "string", description: "Optional tag filter, e.g. 'project'" },
              directory: {
                type: "string",
                description: "Optional folder filter, e.g. 'work' or 'daily'",
              },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_note",
          description:
            "Returns the full markdown of one note. Use it when a search excerpt is not enough. " +
            "Accepts an exact vault path, a note name, or a [[wikilink]].",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Vault-relative path, note name, or [[wikilink]]",
              },
            },
            required: ["path"],
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
    if (!query.trim()) {
      throw new Error("query_vault requires a non-empty query");
    }
    const vector = await this.embedSvc.getQueryEmbedding(query);
    return this.vecDb.search(vector, k, threshold);
  }

  public executeListNotesTool(tagFilter?: string, dirFilter?: string): NoteMeta[] {
    if (!this.vault) return [];

    const cleanTag = tagFilter ? tagFilter.trim().replace(/^#/, "").toLowerCase() : "";
    const cleanDir = dirFilter ? dirFilter.trim().replace(/^\/+|\/+$/g, "").toLowerCase() : "";
    const notes: NoteMeta[] = [];

    for (const file of this.vault.getMarkdownFiles()) {
      if (isPathExcluded(file.path, this.settings.excludedFolders)) continue;

      const dir = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "/";
      if (cleanDir && !dir.toLowerCase().includes(cleanDir)) continue;

      const tags = this.extractTags(file);
      if (cleanTag && !tags.some((tag) => tag.toLowerCase() === cleanTag)) continue;

      notes.push({ title: file.basename, path: file.path, dir, tags });
    }

    return notes;
  }

  public async executeReadNoteTool(notePath: string): Promise<NoteContent | null> {
    if (!this.vault || !notePath.trim()) return null;

    const requested = notePath
      .trim()
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .split("|")[0]
      .trim()
      .replace(/^\/+/, "");

    if (!requested) return null;

    const withExtension = /\.md$/i.test(requested) ? requested : `${requested}.md`;
    const files = this.vault.getMarkdownFiles();
    const lowerRequested = requested.replace(/\.md$/i, "").toLowerCase();

    const match =
      files.find((file) => file.path === withExtension) ??
      files.find((file) => file.name === withExtension) ??
      files.find((file) => file.basename.toLowerCase() === lowerRequested);

    if (!match || isPathExcluded(match.path, this.settings.excludedFolders)) {
      return null;
    }

    const raw = await this.vault.cachedRead(match);
    const truncated = raw.length > MAX_NOTE_CHARS;

    return {
      title: match.basename,
      path: match.path,
      content: truncated
        ? `${raw.slice(0, MAX_NOTE_CHARS)}\n\n[truncated: note continues]`
        : raw,
      truncated,
    };
  }

  public static extractThinkingAndContent(
    rawContent: string,
    rawReasoning?: string
  ): { content: string; thinking: string } {
    let content = rawContent || "";
    let thinking = (rawReasoning || "").trim();

    const match = content.match(/<think>([\s\S]*?)<\/think>/i);
    if (match) {
      const parsed = match[1].trim();
      thinking = thinking ? `${thinking}\n\n${parsed}` : parsed;
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    }

    return { content, thinking };
  }

  private extractTags(file: TFile): string[] {
    if (!this.metaCache) return [];

    const cache = this.metaCache.getFileCache(file);
    const tags = new Set<string>();

    for (const tag of cache?.tags ?? []) {
      const clean = tag.tag.replace(/^#/, "").trim();
      if (clean) tags.add(clean);
    }

    const raw = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
    const values = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];

    for (const value of values) {
      const clean = value.replace(/^#/, "").trim();
      if (clean) tags.add(clean);
    }

    return Array.from(tags);
  }

  private formatResults(query: string, results: SearchResult[]): string {
    if (results.length === 0) {
      return `No notes matched "${query}" above the similarity threshold.`;
    }

    let budget = MAX_TOTAL_CONTEXT_CHARS;
    const blocks: string[] = [];

    for (const [index, result] of results.entries()) {
      if (budget <= 0) break;

      const heading = result.heading ? ` > ${result.heading}` : "";
      const header = `[${index + 1}] ${result.path}${heading} (similarity ${Math.round(
        result.score * 100
      )}%)\n`;
      const body = truncate(result.text, Math.min(MAX_RESULT_CHARS, budget));
      budget -= header.length + body.length;

      blocks.push(`${header}${body}`);
    }

    return `Vault search results for "${query}":\n\n${blocks.join("\n\n---\n\n")}`;
  }

  private formatNotes(notes: NoteMeta[]): string {
    if (notes.length === 0) {
      return "No notes matched those filters.";
    }

    const lines = notes.map((note) => {
      const tags = note.tags.length > 0 ? note.tags.map((tag) => `#${tag}`).join(" ") : "none";
      return `- ${note.path} | title: ${note.title} | tags: ${tags}`;
    });

    return `Found ${notes.length} notes:\n${lines.join("\n")}`;
  }

  private formatNote(note: NoteContent | null, requestedPath: string): string {
    if (!note) {
      return `No note matches "${requestedPath}". Use list_notes to see available paths.`;
    }
    const suffix = note.truncated ? " [truncated]" : "";
    return `Full content of ${note.path}${suffix}:\n\n${note.content}`;
  }

  public async sendMessage(
    history: ChatMessage[],
    options: SendMessageOptions = {}
  ): Promise<ChatMessage> {
    const k = options.topK ?? this.settings.chatTopK ?? 5;
    const threshold =
      options.similarityThreshold ?? this.settings.chatSimilarityThreshold ?? 0.25;

    const messages: Record<string, unknown>[] = [
      {
        role: "system",
        content: this.settings.chatSystemPrompt.trim() || "Answer using only the provided notes.",
      },
      ...this.buildHistory(history),
    ];

    const toolResults: ChatToolResult[] = [];
    let thinking = "";
    let streamed = "";

    const notifyToken = options.onToken
      ? (delta: string) => {
          streamed += delta;
          options.onToken?.(delta);
        }
      : undefined;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const useTools = round < MAX_TOOL_ROUNDS;
        streamed = "";
        const turn = await this.complete(messages, {
          tools: useTools ? this.getTools() : undefined,
          signal: options.signal,
          onToken: notifyToken,
        });

        if (turn.thinking) {
          thinking = thinking ? `${thinking}\n\n${turn.thinking}` : turn.thinking;
        }

        // Without tools on the last round the model must answer; ignore any
        // stray tool calls so the request still ends with a usable message.
        if (turn.toolCalls.length === 0 || !useTools) {
          return this.assistantMessage(turn.content, thinking, toolResults);
        }

        messages.push({
          role: "assistant",
          content: turn.rawContent,
          tool_calls: turn.toolCalls,
        });

        for (const call of turn.toolCalls) {
          if (options.signal?.aborted) throw new GenerationCancelledError();

          const outcome = await this.runTool(call, k, threshold, options);
          toolResults.push(outcome.result);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: outcome.text,
          });
        }
      }

      throw new Error("The model kept requesting tools; no final answer was produced.");
    } catch (error) {
      if (isAbortError(error) || error instanceof GenerationCancelledError) {
        if (streamed.trim()) {
          const partial = this.assistantMessage(
            `${streamed.trim()}\n\n_(stopped)_`,
            thinking,
            toolResults
          );
          partial.stopped = true;
          return partial;
        }
        throw new GenerationCancelledError();
      }
      throw error;
    }
  }

  private assistantMessage(
    content: string,
    thinking: string,
    toolResults: ChatToolResult[]
  ): ChatMessage {
    return {
      id: uniqueId("msg"),
      role: "assistant",
      content,
      timestamp: Date.now(),
      thinking: thinking.trim() || undefined,
      toolResult: toolResults[0],
      toolResults: toolResults.length > 0 ? toolResults : undefined,
    };
  }

  /**
   * Drops persisted UI-only messages (errors, empty answers) and caps the
   * history so a long conversation cannot exceed the model's context window.
   */
  private buildHistory(history: ChatMessage[]): Record<string, unknown>[] {
    const usable = history.filter(
      (message) =>
        message.role !== "system" &&
        !message.isError &&
        !message.streaming &&
        (message.content.trim().length > 0 || (message.tool_calls?.length ?? 0) > 0)
    );

    const kept: ChatMessage[] = [];
    let characters = 0;

    for (let index = usable.length - 1; index >= 0; index--) {
      const message = usable[index];
      const cost = message.content.length;

      if (kept.length >= MAX_HISTORY_MESSAGES) break;
      if (characters + cost > MAX_HISTORY_CHARS && kept.length > 0) break;

      kept.push(message);
      characters += cost;
    }

    return kept.reverse().map((message) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
      name: message.name,
    }));
  }

  private async runTool(
    call: ToolCall,
    k: number,
    threshold: number,
    options: SendMessageOptions
  ): Promise<ToolOutcome> {
    const name = call.function?.name ?? "";
    const args = this.parseArguments(call.function?.arguments);

    try {
      if (name === "query_vault") {
        const query = String(args.query ?? "");
        const results = await this.executeQueryVaultTool(query, k, threshold);
        options.onToolCall?.(call, { query, k, results });
        return {
          result: { toolName: name, query, k, results },
          text: this.formatResults(query, results),
        };
      }

      if (name === "list_notes") {
        const tag = typeof args.tag === "string" ? args.tag : undefined;
        const directory = typeof args.directory === "string" ? args.directory : undefined;
        const notes = this.executeListNotesTool(tag, directory);
        options.onToolCall?.(call, { notes });
        return {
          result: { toolName: name, notes },
          text: this.formatNotes(notes),
        };
      }

      if (name === "read_note") {
        const path = String(args.path ?? "");
        const note = await this.executeReadNoteTool(path);
        options.onToolCall?.(call, { note: note ?? undefined });
        return {
          result: { toolName: name, note: note ?? undefined },
          text: this.formatNote(note, path),
        };
      }

      const message = `Unknown tool "${name}". Available tools: query_vault, list_notes, read_note.`;
      return { result: { toolName: name, error: message }, text: message };
    } catch (error) {
      const message = `Tool "${name}" failed: ${describeError(error)}`;
      return { result: { toolName: name, error: message }, text: message };
    }
  }

  private parseArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * One model round-trip. Streams when a token callback is present, and falls
   * back to a buffered request if the provider or the transport rejects SSE.
   */
  private async complete(
    messages: Record<string, unknown>[],
    options: { tools?: unknown[]; signal?: AbortSignal; onToken?: (delta: string) => void }
  ): Promise<ChatTurn> {
    const payload: Record<string, unknown> = {
      model: this.getModel(),
      messages,
      temperature: this.settings.chatTemperature,
      max_tokens: this.settings.chatMaxTokens,
    };

    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = "auto";
    }

    if (options.onToken) {
      try {
        return await this.streamCompletion(payload, options.signal, options.onToken);
      } catch (error) {
        const timedOut = error instanceof Error && /timed out/i.test(error.message);
        if (timedOut) throw error;

        const canFallback =
          (error instanceof StreamUnavailableError ||
            !(error instanceof ApiError) ||
            error.retryable ||
            error.status === 400 ||
            error.status === 422) &&
          !isAbortError(error) &&
          !(error instanceof GenerationCancelledError);

        if (!canFallback) throw error;
        console.warn(`[cypher] streaming unavailable, using a buffered response: ${describeError(error)}`);
      }
    }

    const response = await this.postJson(this.getChatEndpointUrl(), payload, options.signal);
    return this.parseCompletion(response);
  }

  private parseCompletion(response: Record<string, unknown>): ChatTurn {
    const choices = response.choices as Array<{ message?: Record<string, unknown> }> | undefined;
    const message = choices?.[0]?.message;
    if (!message) {
      throw new Error("The chat API returned an empty response");
    }

    const reasoning = (message.reasoning ??
      message.reasoning_content ??
      message.thinking) as string | undefined;
    const { content, thinking } = ChatService.extractThinkingAndContent(
      typeof message.content === "string" ? message.content : "",
      reasoning
    );

    return {
      content,
      thinking,
      toolCalls: (message.tool_calls as ToolCall[] | undefined) ?? [],
      rawContent: typeof message.content === "string" ? message.content : "",
    };
  }

  private async streamCompletion(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onToken: (delta: string) => void
  ): Promise<ChatTurn> {
    if (typeof fetch !== "function" || typeof AbortController === "undefined") {
      throw new StreamUnavailableError();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    let emitted = false;
    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];

    try {
      const response = await fetch(this.getChatEndpointUrl(), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ ...payload, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new ApiError(
          `Chat API error (HTTP ${response.status}): ${detail || response.statusText}`,
          response.status
        );
      }

      if (!response.body) {
        throw new StreamUnavailableError("The response has no readable body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleLine = (line: string) => {
        if (!line.startsWith("data:")) return false;

        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        if (!data) return false;

        let event: {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning?: string;
              reasoning_content?: string;
              thinking?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          error?: { message?: string } | string;
        };

        try {
          event = JSON.parse(data);
        } catch {
          return false;
        }

        if (event.error) {
          throw new ApiError(
            typeof event.error === "string"
              ? event.error
              : event.error.message ?? "Streaming error",
            500
          );
        }

        const delta = event.choices?.[0]?.delta;
        if (!delta) return false;

        const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        if (thought) {
          thinking += thought;
        }

        if (delta.content) {
          content += delta.content;
          emitted = true;
          onToken(delta.content);
        }

        for (const fragment of delta.tool_calls ?? []) {
          const index = fragment.index ?? 0;
          const existing = (toolCalls[index] ??= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });

          if (fragment.id) existing.id = fragment.id;
          if (fragment.function?.name) existing.function.name += fragment.function.name;
          if (fragment.function?.arguments) {
            existing.function.arguments += fragment.function.arguments;
          }
        }

        return false;
      };

      let done = false;
      while (!done) {
        const read = await reader.read();
        if (read.done) break;

        buffer += decoder.decode(read.value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (handleLine(line)) {
            done = true;
            break;
          }
          newline = buffer.indexOf("\n");
        }
      }

      if (buffer.trim()) {
        handleLine(buffer.trim());
      }

      const { content: cleanContent, thinking: cleanThinking } =
        ChatService.extractThinkingAndContent(content, thinking);

      return {
        content: cleanContent,
        thinking: cleanThinking,
        rawContent: content,
        toolCalls: toolCalls.filter((call) => call.function.name.length > 0),
      };
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new Error(`The chat request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      if (isAbortError(error)) {
        throw signal?.aborted ? new GenerationCancelledError() : error;
      }
      if (!emitted && !(error instanceof ApiError)) {
        throw new StreamUnavailableError(describeError(error));
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async postJson(
    endpoint: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new GenerationCancelledError();
    }

    const request = requestUrl({
      url: endpoint,
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
      throw: false,
    }).then((response) => {
      if (response.status === 200) {
        return response.json as Record<string, unknown>;
      }
      throw new ApiError(this.describeResponseError(response), response.status);
    });

    const response = await this.raceTimeout(request, signal);
    return response;
  }

  private async raceTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The chat request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
        REQUEST_TIMEOUT_MS
      );
    });

    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => reject(new GenerationCancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([promise, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private describeResponseError(response: { status: number; text: string; json: unknown }): string {
    let detail = response.text;
    try {
      const payload = response.json as { error?: { message?: string } | string } | null;
      if (payload?.error) {
        detail =
          typeof payload.error === "string"
            ? payload.error
            : payload.error.message ?? JSON.stringify(payload.error);
      }
    } catch {
      // Non-JSON error bodies are reported as raw text.
    }

    const hint =
      response.status === 401 || response.status === 403
        ? " Check the chat API key."
        : response.status === 404
        ? " Check the chat API URL and model name."
        : "";

    return `Chat API error (HTTP ${response.status}): ${detail}${hint}`;
  }
}
