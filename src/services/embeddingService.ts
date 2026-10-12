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

  private getEndpoint(base: string): string {
    let url = base.trim();
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    if (url.endsWith("/embeddings")) {
      return url;
    }
    return `${url}/embeddings`;
  }

  public async testConnection(
    urlOverride?: string,
    keyOverride?: string,
    modelOverride?: string
  ): Promise<ApiTestResult> {
    const url =
      urlOverride !== undefined
        ? urlOverride
        : this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const key =
      keyOverride !== undefined
        ? keyOverride
        : this.settings.embeddingApiKey !== undefined
        ? this.settings.embeddingApiKey
        : this.settings.apiKey || "";
    const model =
      modelOverride !== undefined
        ? modelOverride
        : this.settings.embeddingModel || this.settings.model || "";

    if (!url) {
      return { success: false, error: "Embedding API URL is required" };
    }
    if (!model) {
      return { success: false, error: "Embedding Model name is required" };
    }

    try {
      const vecs = await this.fetchEmbeddings(["Cypher connection test"], url, key, model);

      if (!vecs || vecs.length === 0 || !vecs[0] || vecs[0].length === 0) {
        return { success: false, error: "Received empty embedding vector from model" };
      }

      return {
        success: true,
        dimension: vecs[0].length,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }

  public async getQueryEmbedding(text: string): Promise<number[]> {
    const results = await this.getEmbeddingsBatch([text]);
    if (!results || results.length === 0) {
      throw new Error("Failed to compute embedding for query");
    }
    return results[0];
  }

  public async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    const url = this.settings.embeddingApiUrl || this.settings.apiUrl || "";
    const key =
      this.settings.embeddingApiKey !== undefined
        ? this.settings.embeddingApiKey
        : this.settings.apiKey || "";
    const model = this.settings.embeddingModel || this.settings.model || "";

    return this.fetchEmbeddings(texts, url, key, model);
  }

  private async fetchEmbeddings(
    texts: string[],
    url: string,
    key: string,
    model: string,
    maxRetries = 3
  ): Promise<number[][]> {
    const endpoint = this.getEndpoint(url);

    const input = texts.map((t) => {
      const trimmed = t.trim();
      return trimmed.length > 0 ? trimmed : " ";
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (key && key.trim().length > 0) {
      headers["Authorization"] = `Bearer ${key.trim()}`;
    }

    const payload = {
      model: model.trim(),
      input,
    };

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const res = await requestUrl({
          url: endpoint,
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          throw: false,
        });

        if (res.status === 200) {
          const json = res.json;
          if (!json || !Array.isArray(json.data)) {
            throw new Error("Invalid response format from embedding API: missing data array");
          }

          const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          return sorted.map((item) => item.embedding);
        }

        if (res.status === 429 || res.status === 503) {
          attempt++;
          if (attempt > maxRetries) {
            throw new Error(`API rate limit exceeded (HTTP ${res.status}): ${res.text}`);
          }
          const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
          console.warn(`[Cypher] Rate limited (HTTP ${res.status}). Retrying in ${Math.round(backoff)}ms...`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        let detail = res.text;
        try {
          if (res.json && res.json.error) {
            detail = res.json.error.message || JSON.stringify(res.json.error);
          }
        } catch {
        }
        throw new Error(`Embedding API error (HTTP ${res.status}): ${detail}`);
      } catch (err: unknown) {
        if (attempt >= maxRetries) {
          throw err;
        }
        attempt++;
        const backoff = 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw new Error(`Failed to fetch embeddings after ${maxRetries} attempts`);
  }
}
