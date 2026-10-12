import { CypherSettings } from "./types";

export const DEFAULT_SETTINGS: CypherSettings = {
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  dimension: 1536,
  chatApiUrl: "https://api.openai.com/v1",
  chatApiKey: "",
  chatModel: "gpt-4o-mini",
  chatTopK: 5,
  chatSimilarityThreshold: 0.25,
  chatSystemPrompt:
    "You are Cypher, an intelligent AI assistant strictly grounded in the user's Obsidian vault.\n\n" +
    "CRITICAL RULES:\n" +
    "1. GROUNDED IN VAULT: You can ONLY answer questions using information retrieved from the user's notes via your tools (`query_vault` and `list_notes`). Do NOT use external, pre-trained, or outside world knowledge.\n" +
    "2. TOOL USAGE:\n" +
    "   - Call `list_notes` when the user asks what notes exist, lists of notes, vault outline/structure, or finding notes by tag/folder.\n" +
    "   - Call `query_vault` when answering questions about the specific contents, concepts, or facts inside notes.\n" +
    "3. NO EXTERNAL INFORMATION: If the retrieved notes do not contain the answer, you MUST state: \"I could not find this information in your notes.\" Never speculate or make up information.\n" +
    "4. CITE SOURCES: Always cite the note titles (e.g. `[[Note Title]]`) that provide information in your answer.",
  chunkSize: 800,
  chunkOverlap: 150,
  batchSize: 20,
  excludedFolders: [".obsidian", ".trash"],
  autoIndexOnSave: true,
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
    name: "Ollama (Local Qwen 3.5 2B)",
    apiUrl: "http://localhost:11434/v1",
    model: "qwen3.5:2b",
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Fast local chat model with function calling support",
  },
  {
    name: "Ollama (Local Qwen 3.5 4B)",
    apiUrl: "http://localhost:11434/v1",
    model: "qwen3.5:4b",
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Capable local chat model with function calling support",
  },
  {
    name: "Ollama (Local Llama 3.2)",
    apiUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    apiKeyPlaceholder: "ollama (or leave blank)",
    description: "Fully private local LLM running on your computer",
  },
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
    name: "LM Studio (Local Server)",
    apiUrl: "http://localhost:1234/v1",
    model: "qwen2.5-7b-instruct",
    apiKeyPlaceholder: "lm-studio (or leave blank)",
    description: "Local model running via LM Studio Local Server",
  },
];

export const PROVIDER_PRESETS = EMBEDDING_PROVIDER_PRESETS;
