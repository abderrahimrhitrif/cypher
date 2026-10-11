import { CypherSettings } from "./types";

export const DEFAULT_SETTINGS: CypherSettings = {
  // Embedding API (Dedicated)
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  dimension: 1536,

  // Chat / Conversation API (Dedicated)
  chatApiUrl: "https://api.openai.com/v1",
  chatApiKey: "",
  chatModel: "gpt-4o-mini",
  chatTopK: 5,
  chatSimilarityThreshold: 0.25,
  chatSystemPrompt:
    "You are Cypher, an intelligent AI assistant strictly grounded in the user's Obsidian vault.\n\n" +
    "CRITICAL RULES:\n" +
    "1. ONLY USE KNOWLEDGE FROM THE NOTES: You can ONLY answer questions using the knowledge and facts contained within the user's notes retrieved via the `query_vault` tool. Do NOT use any external, pre-trained, or outside world knowledge.\n" +
    "2. ALWAYS QUERY FIRST: Always call the `query_vault` tool to retrieve relevant notes before attempting to formulate any answer.\n" +
    "3. NO EXTERNAL INFORMATION OR ASSUMPTIONS: If the retrieved notes do not contain the answer, or if no relevant notes are found, you MUST state: \"I could not find this information in your notes.\" Never speculate, fabricate, or answer from general knowledge.\n" +
    "4. CITE SOURCES: Explicitly cite the note titles (e.g. `[[Note Title]]`) that provide the information in your answer.",

  // Chunking
  chunkSize: 800,
  chunkOverlap: 150,
  batchSize: 20,

  // Vault indexing options
  excludedFolders: [".obsidian", ".trash"],
  autoIndexOnSave: true,

  // State
  hasCompletedInitialIndexing: false,
  lastIndexedTime: 0,
};

export interface EmbeddingProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  dimension: number;
  apiKeyPlaceholder: string;
  description: string;
}

export interface ChatProviderPreset {
  name: string;
  apiUrl: string;
  model: string;
  apiKeyPlaceholder: string;
  description: string;
}

export const EMBEDDING_PROVIDER_PRESETS: EmbeddingProviderPreset[] = [
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

export const CHAT_PROVIDER_PRESETS: ChatProviderPreset[] = [
  {
    name: "OpenAI (Cloud)",
    apiUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyPlaceholder: "sk-...",
    description: "Fast, smart, and cost-effective OpenAI model",
  },
  {
    name: "OpenRouter (Claude 3.5 Sonnet)",
    apiUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-3.5-sonnet",
    apiKeyPlaceholder: "sk-or-...",
    description: "Top-tier reasoning via OpenRouter API",
  },
  {
    name: "Ollama (Local Llama 3.2)",
    apiUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Fully private local LLM running on your computer",
  },
  {
    name: "LM Studio (Local Server)",
    apiUrl: "http://localhost:1234/v1",
    model: "qwen2.5-7b-instruct",
    apiKeyPlaceholder: "lm-studio (or leave blank)",
    description: "Local model running via LM Studio Local Server",
  },
];

// Presets compatibility alias
export const PROVIDER_PRESETS = EMBEDDING_PROVIDER_PRESETS;
