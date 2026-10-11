import { requestUrl } from "obsidian";
import { ApiTestResult, CypherSettings } from "../types";
import { ApiError, describeError } from "../errors";
import { normalizeBaseUrl } from "../utils";

const TEST_TEXT = "Cypher connection test";
const MAX_RETRIES = 3;

interface EmbeddingResponseItem {
  index?: number;
  embedding?: unknown;
}

export class EmbeddingService {
  private settings: CypherSettings;

  constructor(settings: CypherSettings) {
    this.settings = settings;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  public getEndpoint(): string {
    const base = normalizeBaseUrl(this.settings.embeddingApiUrl);
    if (!base) {
      throw new Error("Embedding API base URL is not configured. Set it in Cypher settings.");
    }
    return `${base}/embeddings`;
  }

  public getModel(): string {
    return this.settings.embeddingModel.trim();
  }

  public async testConnection(): Promise<ApiTestResult> {
    if (!this.settings.embeddingApiUrl.trim()) {
      return { success: false, error: "Embedding API URL is required" };
    }
    if (!this.getModel()) {
      return { success: false, error: "Embedding model name is required" };
    }

    try {
      const vectors = await this.getEmbeddingsBatch([TEST_TEXT]);
      const dimension = vectors[0]?.length ?? 0;
      if (dimension === 0) {
        return { success: false, error: "The embedding model returned an empty vector" };
      }
      return { success: true, dimension };
    } catch (error) {
      return { success: false, error: describeError(error) };
    }
  }

  public async getQueryEmbedding(text: string): Promise<number[]> {
    const [vector] = await this.getEmbeddingsBatch([text]);
    if (!vector) {
      throw new Error("Failed to compute an embedding for the search query");
    }
    return vector;
  }

  public async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.requestEmbeddings(texts);
  }

  private async requestEmbeddings(texts: string[]): Promise<number[][]> {
    const endpoint = this.getEndpoint();
    const model = this.getModel();
    if (!model) {
      throw new Error("Embedding model name is not configured. Set it in Cypher settings.");
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.settings.embeddingApiKey.trim();
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }

    const body = JSON.stringify({
      model,
      input: texts.map((text) => {
        const trimmed = text.trim();
        return trimmed.length > 0 ? trimmed : " ";
      }),
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await requestUrl({
          url: endpoint,
          method: "POST",
          headers,
          body,
          throw: false,
        });

        if (response.status === 200) {
          return this.parseResponse(response.json, texts.length);
        }

        throw new ApiError(this.describeResponseError(response), response.status);
      } catch (error) {
        const retryable =
          !(error instanceof ApiError) || error.retryable;

        if (!retryable || attempt === MAX_RETRIES) {
          throw error;
        }

        const backoff = Math.min(800 * 2 ** attempt + Math.random() * 300, 10_000);
        console.warn(
          `[cypher] embedding request failed (${describeError(error)}); retrying in ${Math.round(backoff)}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error(`Embedding request failed after ${MAX_RETRIES + 1} attempts`);
  }

  private parseResponse(json: unknown, expectedCount: number): number[][] {
    const payload = json as { data?: EmbeddingResponseItem[] } | null;
    if (!payload || !Array.isArray(payload.data)) {
      throw new ApiError("Embedding API response is missing a `data` array", 200);
    }

    const items = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (items.length !== expectedCount) {
      throw new ApiError(
        `Embedding API returned ${items.length} vectors for ${expectedCount} inputs`,
        200
      );
    }

    return items.map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new ApiError("Embedding API returned an empty or malformed vector", 200);
      }
      return item.embedding as number[];
    });
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
        ? " Check the embedding API key."
        : response.status === 404
        ? " Check the embedding API URL and model name."
        : "";

    return `Embedding API error (HTTP ${response.status}): ${detail}${hint}`;
  }
}
