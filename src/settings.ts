import { CypherSettings } from "./types";

export const DEFAULT_SETTINGS: CypherSettings = {
  apiUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "text-embedding-3-small",
  dimension: 1536,
  chunkSize: 800,
  chunkOverlap: 150,
  batchSize: 20,
  excludedFolders: [".obsidian", ".trash"],
  autoIndexOnSave: true,
  hasCompletedInitialIndexing: false,
  lastIndexedTime: 0,
};

export interface ProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  dimension: number;
  apiKeyPlaceholder: string;
  description: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: "OpenAI (Cloud)",
    apiUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimension: 1536,
    apiKeyPlaceholder: "sk-...",
    description: "Industry standard high-quality embeddings (1536 dim)",
  },
  {
    name: "Ollama (Local)",
    apiUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    dimension: 768,
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Private local embedding model running on your machine",
  },
  {
    name: "LM Studio (Local)",
    apiUrl: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    dimension: 768,
    apiKeyPlaceholder: "lm-studio (or leave blank)",
    description: "Local model running via LM Studio Local Server",
  },
  {
    name: "OpenRouter (Cloud)",
    apiUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    dimension: 1536,
    apiKeyPlaceholder: "sk-or-...",
    description: "Multi-provider AI routing platform",
  },
];
