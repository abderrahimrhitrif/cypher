import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors";
import { EmbeddingService } from "../src/services/embeddingService";
import { makeSettings } from "./helpers";

const mockedRequest = vi.mocked(requestUrl);

function reply(status: number, json: unknown, text = "") {
  return { status, json, text, arrayBuffer: new ArrayBuffer(0), headers: {} };
}

describe("EmbeddingService", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it("normalizes the endpoint", () => {
    const service = new EmbeddingService(
      makeSettings({ embeddingApiUrl: "http://localhost:11434/v1/" })
    );
    expect(service.getEndpoint()).toBe("http://localhost:11434/v1/embeddings");

    const withSuffix = new EmbeddingService(
      makeSettings({ embeddingApiUrl: "https://api.openai.com/v1/embeddings" })
    );
    expect(withSuffix.getEndpoint()).toBe("https://api.openai.com/v1/embeddings");
  });

  it("detects the dimension during a connection test", async () => {
    mockedRequest.mockResolvedValue(
      reply(200, { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })
    );

    const service = new EmbeddingService(makeSettings({ embeddingApiKey: "secret" }));
    const result = await service.testConnection();

    expect(result).toEqual({ success: true, dimension: 3 });
    expect(mockedRequest).toHaveBeenCalledTimes(1);

    const call = mockedRequest.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.headers.Authorization).toBe("Bearer secret");
  });

  it("reports a missing URL without making a request", async () => {
    const service = new EmbeddingService(
      makeSettings({ embeddingApiUrl: "", embeddingModel: "model" })
    );

    expect(await service.testConnection()).toEqual({
      success: false,
      error: "Embedding API URL is required",
    });
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("does not retry authentication failures", async () => {
    mockedRequest.mockResolvedValue(reply(401, { error: { message: "bad key" } }, "bad key"));

    const service = new EmbeddingService(makeSettings());
    const result = await service.testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain("bad key");
    expect(result.error).toContain("Check the embedding API key");
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it("retries transient server errors and then succeeds", async () => {
    vi.useFakeTimers();
    try {
      mockedRequest
        .mockResolvedValueOnce(reply(500, {}, "temporary"))
        .mockResolvedValueOnce(reply(503, {}, "temporary"))
        .mockResolvedValueOnce(reply(200, { data: [{ index: 0, embedding: [1, 2] }] }));

      const service = new EmbeddingService(makeSettings());
      const pending = service.testConnection();
      await vi.runAllTimersAsync();

      expect(await pending).toEqual({ success: true, dimension: 2 });
      expect(mockedRequest).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a response with the wrong number of vectors", async () => {
    mockedRequest.mockResolvedValue(
      reply(200, { data: [{ index: 0, embedding: [0.1] }] })
    );

    const service = new EmbeddingService(makeSettings());
    await expect(service.getEmbeddingsBatch(["one", "two"])).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects empty or malformed vectors", async () => {
    mockedRequest.mockResolvedValue(reply(200, { data: [{ index: 0, embedding: [] }] }));

    const service = new EmbeddingService(makeSettings());
    await expect(service.getQueryEmbedding("query")).rejects.toThrow(/empty or malformed/);
  });

  it("sorts vectors by their index before returning them", async () => {
    mockedRequest.mockResolvedValue(
      reply(200, {
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      })
    );

    const service = new EmbeddingService(makeSettings());
    expect(await service.getEmbeddingsBatch(["a", "b"])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("short-circuits an empty batch", async () => {
    const service = new EmbeddingService(makeSettings());
    expect(await service.getEmbeddingsBatch([])).toEqual([]);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("replaces blank text so the endpoint never receives an empty string", async () => {
    mockedRequest.mockResolvedValue(
      reply(200, { data: [{ index: 0, embedding: [1] }] })
    );

    const service = new EmbeddingService(makeSettings());
    await service.getEmbeddingsBatch(["   "]);

    const body = JSON.parse((mockedRequest.mock.calls[0][0] as { body: string }).body);
    expect(body.input).toEqual([" "]);
  });
});
