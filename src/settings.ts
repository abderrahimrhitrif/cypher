import { CypherSettings } from "./types";
import { normalizeBaseUrl } from "./utils";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Cypher, an AI assistant that answers questions using the user's Obsidian vault.\n\n" +
  "RULES:\n" +
  "1. Use only the tool results as evidence. Do not rely on outside knowledge.\n" +
  "2. Choose the right tool:\n" +
  "   - `list_notes` to browse, list, or locate notes by title, folder, or tag.\n" +
  "   - `query_vault` to retrieve excerpts about a concept, fact, or topic.\n" +
  "   - `read_note` to read one specific note in full, or when an excerpt is not enough.\n" +
  "3. If the notes do not contain the answer, reply exactly: \"I could not find this information in your notes.\" Do not guess.\n" +
  "4. Cite the notes you used as Obsidian wikilinks, e.g. [[Note Title]].";

export const DEFAULT_SETTINGS: CypherSettings = {
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  dimension: 1536,
  dimensionSignature: "",
  chatApiUrl: "https://api.openai.com/v1",
  chatApiKey: "",
  chatModel: "gpt-4o-mini",
  chatTopK: 5,
  chatSimilarityThreshold: 0.25,
  chatMaxTokens: 1024,
  chatTemperature: 0.7,
  chatSystemPrompt: DEFAULT_SYSTEM_PROMPT,
  chatSystemPromptCustomized: false,
  chunkSize: 800,
  chunkOverlap: 150,
  batchSize: 20,
  excludedFolders: [".obsidian", ".trash"],
  autoIndexOnSave: true,
  hasCompletedInitialIndexing: false,
  lastIndexedTime: 0,
};

export function embeddingSignature(url: string, model: string): string {
  return `${normalizeBaseUrl(url)}|${model.trim().toLowerCase()}`;
}

export interface EmbeddingProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  dimension: number;
  description: string;
}

export interface ChatProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  description: string;
}

export const EMBEDDING_PROVIDER_PRESETS: EmbeddingProviderPreset[] = [
  {
    name: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimension: 1536,
    description: "Hosted embeddings, 1536 dimensions",
  },
  {
    name: "Ollama",
    apiUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    dimension: 768,
    description: "Runs locally, 768 dimensions",
  },
  {
    name: "LM Studio",
    apiUrl: "http://localhost:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    dimension: 768,
    description: "Runs locally through the LM Studio server",
  },
  {
    name: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    dimension: 1536,
    description: "Routes to hosted embedding providers",
  },
];

export const CHAT_PROVIDER_PRESETS: ChatProviderPreset[] = [
  {
    name: "Ollama · qwen2.5 3B",
    apiUrl: "http://localhost:11434/v1",
    model: "qwen2.5:3b",
    description: "Small local model with tool-calling support",
  },
  {
    name: "Ollama · qwen2.5 7B",
    apiUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    description: "Larger local model, better tool use",
  },
  {
    name: "Ollama · llama3.2",
    apiUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    description: "Local Llama model with tool-calling support",
  },
  {
    name: "OpenAI · gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    description: "Hosted, fast, inexpensive",
  },
  {
    name: "OpenRouter · Claude 3.5 Sonnet",
    apiUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
    description: "Hosted through OpenRouter",
  },
  {
    name: "LM Studio",
    apiUrl: "http://localhost:1234/v1",
    model: "qwen2.5-7b-instruct",
    description: "Local model served by LM Studio",
  },
];
