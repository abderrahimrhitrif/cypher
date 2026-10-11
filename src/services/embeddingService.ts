import { requestUrl } from "obsidian";
import { ApiTestResult, CypherSettings } from "../types";

export class EmbeddingService {
  private settings: CypherSettings;

  constructor(settings: CypherSettings) {
    this.settings = settings;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  /**
   * Cleans and normalizes the API base URL to ensure proper endpoint path.
   */
  private getEndpointUrl(base: string): string {
    let clean = base.trim();
    if (clean.endsWith("/")) {
      clean = clean.slice(0, -1);
    }
    if (clean.endsWith("/embeddings")) {
      return clean;
    }
    return `${clean}/embeddings`;
  }

  /**
   * Tests connection with user's settings and auto-detects embedding dimension.
   */
  public async testConnection(
    overrideUrl?: string,
    overrideKey?: string,
    overrideModel?: string
  ): Promise<ApiTestResult> {
    const url =
      overrideUrl !== undefined
        ? overrideUrl
        : this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const key =
      overrideKey !== undefined
        ? overrideKey
        : this.settings.embeddingApiKey !== undefined
        ? this.settings.embeddingApiKey
        : this.settings.apiKey || "";
    const model =
      overrideModel !== undefined
        ? overrideModel
        : this.settings.embeddingModel || this.settings.model || "";

    if (!url) {
      return { success: false, error: "Embedding API URL is required" };
    }
    if (!model) {
      return { success: false, error: "Embedding Model name is required" };
    }

    try {
      const embeddings = await this.fetchEmbeddingsWithConfig(
        ["Cypher connection test"],
        url,
        key,
        model
      );

      if (!embeddings || embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
        return { success: false, error: "Received empty embedding vector from model" };
      }

      return {
        success: true,
        dimension: embeddings[0].length,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Fetches embeddings for a single text query (e.g. for search).
   */
  public async getQueryEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddingsBatch([text]);
    if (!results || results.length === 0) {
      throw new Error("Failed to compute embedding for query");
    }
    return results[0];
  }

  /**
   * Fetches embeddings for a batch of texts using current settings, with retry on rate-limit.
   */
  public async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const url = this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const key =
      this.settings.embeddingApiKey !== undefined
        ? this.settings.embeddingApiKey
        : this.settings.apiKey || "";
    const model = this.settings.embeddingModel || this.settings.model || "";

    return this.fetchEmbeddingsWithConfig(texts, url, key, model);
  }

  /**
   * Core network request handler with retries and exponential backoff.
   */
  private async fetchEmbeddingsWithConfig(
    texts: string[],
    apiUrl: string,
    apiKey: string,
    model: string,
    maxRetries = 3
  ): Promise<number[][]> {
    const endpoint = this.getEndpointUrl(apiUrl);
    
    // Sanitize texts: avoid empty strings which cause some APIs to return 400 Bad Request
    const sanitizedTexts = texts.map((t) => {
      const trimmed = t.trim();
      return trimmed.length > 0 ? trimmed : " ";
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey && apiKey.trim().length > 0) {
      headers["Authorization"] = `Bearer ${apiKey.trim()}`;
    }

    const payload = {
      model: model.trim(),
      input: sanitizedTexts,
    };

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const response = await requestUrl({
          url: endpoint,
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          throw: false,
        });

        if (response.status === 200) {
          const json = response.json;
          if (!json || !Array.isArray(json.data)) {
            throw new Error(`Invalid response format from embedding API: missing 'data' array`);
          }

          // Sort by index in case embeddings are returned out-of-order
          const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          return sorted.map((item) => item.embedding);
        }

        // Handle Rate Limits (429) and Server Overload (503)
        if (response.status === 429 || response.status === 503) {
          attempt++;
          if (attempt > maxRetries) {
            throw new Error(`API rate limit exceeded (HTTP ${response.status}): ${response.text}`);
          }
          const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
          console.warn(`[Cypher] Rate limited (HTTP ${response.status}). Retrying in ${Math.round(backoffMs)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // Other HTTP error
        let errorDetail = response.text;
        try {
          if (response.json && response.json.error) {
            errorDetail = response.json.error.message || JSON.stringify(response.json.error);
          }
        } catch {
          // ignore json parse error
        }
        throw new Error(`Embedding API error (HTTP ${response.status}): ${errorDetail}`);
      } catch (err: unknown) {
        if (attempt >= maxRetries) {
          throw err;
        }
        attempt++;
        const backoffMs = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error(`Failed to fetch embeddings after ${maxRetries} attempts`);
  }
}
