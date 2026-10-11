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
    "You are Cypher, an intelligent AI assistant strictly grounded in the user's Obsidian vault.\n\n" +
    "CRITICAL RULES:\n" +
    "1. ONLY USE KNOWLEDGE FROM THE NOTES: You can ONLY answer questions using the knowledge and facts contained within the user's notes retrieved via the `query_vault` tool. Do NOT use any external, pre-trained, or outside world knowledge.\n" +
    "2. ALWAYS QUERY FIRST: Always call the `query_vault` tool to retrieve relevant notes before attempting to formulate any answer.\n" +
    "3. NO EXTERNAL INFORMATION OR ASSUMPTIONS: If the retrieved notes do not contain the answer, or if no relevant notes are found, you MUST state: \"I could not find this information in your notes.\" Never speculate, fabricate, or answer from general knowledge.\n" +
    "4. CITE SOURCES: Explicitly cite the note titles (e.g. `[[Note Title]]`) that provide the information in your answer.",
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
