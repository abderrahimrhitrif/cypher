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
  chatModel: "gpt-4o-mini",
  chatTopK: 5,
  chatSimilarityThreshold: 0.25,
  chatSystemPrompt:
    "You are Cypher, an intelligent AI assistant integrated into the user's Obsidian vault.\n" +
    "You have access to a powerful `query_vault` tool that retrieves semantically relevant notes from the user's vault.\n" +
    "Guidelines:\n" +
    "1. Whenever the user asks about their notes, projects, ideas, journal, or knowledge, CALL `query_vault` to retrieve relevant notes.\n" +
    "2. Base your answers on the retrieved context whenever possible and cite the note titles (e.g. `[[Note Title]]`).\n" +
    "3. If the retrieved notes don't contain enough information, state what you found and answer to the best of your ability.",
  hasCompletedInitialIndexing: false,
  lastIndexedTime: 0,
};

export interface ProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  chatModel: string;
  dimension: number;
  apiKeyPlaceholder: string;
  description: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: "OpenAI (Cloud)",
    apiUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    chatModel: "gpt-4o-mini",
    dimension: 1536,
    apiKeyPlaceholder: "sk-...",
    description: "Industry standard high-quality embeddings & GPT-4o-mini chat",
  },
  {
    name: "Ollama (Local)",
    apiUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    chatModel: "llama3.2",
    dimension: 768,
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Private local embedding & chat models running on your machine",
  },
  {
    name: "LM Studio (Local)",
    apiUrl: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    chatModel: "qwen2.5-7b-instruct",
    dimension: 768,
    apiKeyPlaceholder: "lm-studio (or leave blank)",
    description: "Local models running via LM Studio Local Server",
  },
  {
    name: "OpenRouter (Cloud)",
    apiUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    chatModel: "openai/gpt-4o-mini",
    dimension: 1536,
    apiKeyPlaceholder: "sk-or-...",
    description: "Multi-provider AI routing platform",
  },
];
