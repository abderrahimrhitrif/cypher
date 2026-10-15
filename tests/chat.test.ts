import { requestUrl } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/services/chatService";
import type { ChatMessage, SearchResult } from "../src/types";
import { FakeVault, makeSettings } from "./helpers";

const mockedRequest = vi.mocked(requestUrl);

function reply(status: number, json: unknown, text = "") {
  return { status, json, text, arrayBuffer: new ArrayBuffer(0), headers: {} };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call-1") {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function chatReply(message: Record<string, unknown>) {
  return reply(200, { choices: [{ message }] });
}

const searchResult: SearchResult = {
  id: "notes/arch.md#chunk-0",
  score: 0.92,
  path: "notes/arch.md",
  title: "arch",
  heading: "Architecture",
  text: "[arch › Architecture]\nThe indexer stores vectors locally.",
  chunkIndex: 0,
};

function makeService(overrides: {
  vault?: FakeVault;
  metaCache?: unknown;
  search?: (vector: number[], k: number, threshold: number) => Promise<SearchResult[]>;
} = {}) {
  const settings = makeSettings();
  const embedSvc = {
    getQueryEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
  };
  const vecDb = {
    search: vi.fn(
      overrides.search ?? (async () => [searchResult])
    ),
  };
  const service = new ChatService(
    settings,
    embedSvc as never,
    vecDb as never,
    (overrides.vault as never) ?? undefined,
    (overrides.metaCache as never) ?? undefined
  );

  return { service, settings, embedSvc, vecDb };
}

const userMessage: ChatMessage = {
  id: "u1",
  role: "user",
  content: "What does my architecture note say?",
  timestamp: 1,
};

describe("ChatService", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("tool execution", () => {
    it("lists notes, filters by tag and folder, and respects exclusions", () => {
      const vault = new FakeVault();
      vault.setFile("work/plan.md", "# Plan");
      vault.setFile("personal/diary.md", "# Diary");
      vault.setFile(".trash/old.md", "# Old");

      const metaCache = {
        getFileCache: (file: { path: string }) => {
          if (file.path === "work/plan.md") {
            return { tags: [{ tag: "#project" }], frontmatter: {} };
          }
          if (file.path === "personal/diary.md") {
            return { tags: [], frontmatter: { tags: ["home"] } };
          }
          return null;
        },
      };

      const { service } = makeService({ vault, metaCache });

      const all = service.executeListNotesTool();
      expect(all.map((note) => note.path).sort()).toEqual([
        "personal/diary.md",
        "work/plan.md",
      ]);

      expect(service.executeListNotesTool("project")).toEqual([
        expect.objectContaining({ path: "work/plan.md", tags: ["project"] }),
      ]);
      expect(service.executeListNotesTool(undefined, "work")).toEqual([
        expect.objectContaining({ path: "work/plan.md", dir: "work" }),
      ]);
      expect(service.executeListNotesTool("#home")).toEqual([
        expect.objectContaining({ path: "personal/diary.md" }),
      ]);
    });

    it("reads notes by path, name, or wikilink", async () => {
      const vault = new FakeVault();
      vault.setFile("projects/roadmap.md", "# Roadmap\n\nShip it.");

      const { service } = makeService({ vault });

      expect(await service.executeReadNoteTool("projects/roadmap.md")).toMatchObject({
        path: "projects/roadmap.md",
        content: "# Roadmap\n\nShip it.",
        truncated: false,
      });

      expect(await service.executeReadNoteTool("roadmap")).toMatchObject({
        path: "projects/roadmap.md",
      });

      expect(await service.executeReadNoteTool("[[roadmap|this quarter]]")).toMatchObject({
        path: "projects/roadmap.md",
      });

      expect(await service.executeReadNoteTool("missing")).toBeNull();
    });

    it("truncates very long notes", async () => {
      const vault = new FakeVault();
      vault.setFile("big.md", "x".repeat(13_000));

      const { service } = makeService({ vault });
      const note = await service.executeReadNoteTool("big");

      expect(note?.truncated).toBe(true);
      expect(note?.content).toContain("[truncated: note continues]");
    });
  });

  it("extracts reasoning tags and explicit reasoning fields", () => {
    expect(
      ChatService.extractThinkingAndContent("<think>step 1</think>Final answer")
    ).toEqual({ content: "Final answer", thinking: "step 1" });

    expect(
      ChatService.extractThinkingAndContent("Answer", "provider reasoning")
    ).toEqual({ content: "Answer", thinking: "provider reasoning" });
  });

  it("runs a tool round and returns the final answer", async () => {
    mockedRequest
      .mockResolvedValueOnce(chatReply({ content: "", tool_calls: [toolCall("query_vault", { query: "architecture" })] }))
      .mockResolvedValueOnce(chatReply({ content: "The vectors are stored locally." }));

    const { service, embedSvc, vecDb, settings } = makeService();
    const onToolCall = vi.fn();

    const answer = await service.sendMessage([userMessage], { onToolCall });

    expect(answer.role).toBe("assistant");
    expect(answer.content).toBe("The vectors are stored locally.");
    expect(answer.toolResults?.[0].toolName).toBe("query_vault");
    expect(answer.toolResults?.[0].results).toEqual([searchResult]);

    expect(embedSvc.getQueryEmbedding).toHaveBeenCalledWith("architecture");
    expect(vecDb.search).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      settings.chatTopK,
      settings.chatSimilarityThreshold
    );
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ id: "call-1" }),
      expect.objectContaining({ query: "architecture", results: [searchResult] })
    );

    const secondBody = JSON.parse(
      (mockedRequest.mock.calls[1][0] as { body: string }).body
    ) as { messages: Array<{ role: string; tool_call_id?: string }> };

    expect(secondBody.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(secondBody.messages[3].tool_call_id).toBe("call-1");
  });

  it("sends unknown tool calls back as a tool error instead of crashing", async () => {
    mockedRequest
      .mockResolvedValueOnce(chatReply({ content: "", tool_calls: [toolCall("drop_database", {})] }))
      .mockResolvedValueOnce(chatReply({ content: "I could not find this information in your notes." }));

    const { service } = makeService();
    const answer = await service.sendMessage([userMessage]);

    expect(answer.content).toContain("could not find");
    expect(answer.toolResults?.[0].error).toContain('Unknown tool "drop_database"');

    const secondBody = JSON.parse(
      (mockedRequest.mock.calls[1][0] as { body: string }).body
    ) as { messages: Array<{ role: string; content: string }> };

    expect(secondBody.messages[3].content).toContain("Unknown tool");
  });

  it("reports a failed tool as an error result", async () => {
    mockedRequest
      .mockResolvedValueOnce(chatReply({ content: "", tool_calls: [toolCall("query_vault", { query: "x" })] }))
      .mockResolvedValueOnce(chatReply({ content: "Done." }));

    const { service } = makeService({
      search: async () => {
        throw new Error("index unavailable");
      },
    });

    const answer = await service.sendMessage([userMessage]);

    expect(answer.content).toBe("Done.");
    expect(answer.toolResults?.[0].error).toContain("index unavailable");
  });

  it("streams tokens and reasoning when the provider supports SSE", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"planning"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { service } = makeService();
    const tokens: string[] = [];
    const answer = await service.sendMessage([userMessage], {
      onToken: (delta) => tokens.push(delta),
    });

    expect(tokens).toEqual(["Hello", " world"]);
    expect(answer.content).toBe("Hello world");
    expect(answer.thinking).toBe("planning");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("falls back to a buffered response when streaming is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("streaming not supported", { status: 400 }))
    );
    mockedRequest.mockResolvedValueOnce(chatReply({ content: "Buffered answer." }));

    const { service } = makeService();
    const answer = await service.sendMessage([userMessage], { onToken: () => undefined });

    expect(answer.content).toBe("Buffered answer.");
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("reports chat endpoint errors with an actionable hint", async () => {
    mockedRequest.mockResolvedValue(reply(401, { error: { message: "invalid key" } }, "invalid key"));

    const { service } = makeService();
    const result = await service.testChatConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain("Check the chat API key");
  });
});
