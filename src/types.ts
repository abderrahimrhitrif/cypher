export interface CypherSettings {
  embeddingApiUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  dimension: number;
  chatApiUrl: string;
  chatApiKey: string;
  chatModel: string;
  chatTopK: number;
  chatSimilarityThreshold: number;
  chatSystemPrompt: string;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  excludedFolders: string[];
  autoIndexOnSave: boolean;
  hasCompletedInitialIndexing: boolean;
  lastIndexedTime: number;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface ChunkMetadata {
  id: string;
  path: string;
  title: string;
  heading: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  fileHash: string;
  mtime: number;
}

export interface StoredDocument {
  id: string;
  path: string;
  title: string;
  heading: string;
  chunkIndex: number;
  text: string;
  fileHash: string;
  embedding: number[];
}

export interface IndexingProgress {
  status: "idle" | "scanning" | "indexing" | "completed" | "error" | "paused";
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  totalChunks: number;
  indexedChunks: number;
  failedFiles: { path: string; error: string }[];
  errorMessage?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  path: string;
  title: string;
  heading: string;
  text: string;
  chunkIndex: number;
}

export interface ApiTestResult {
  success: boolean;
  dimension?: number;
  error?: string;
}

export interface VectorDbStats {
  documentCount: number;
  uniqueFilesCount: number;
  dimension: number;
  lastSaved?: number;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface NoteMeta {
  title: string;
  path: string;
  dir: string;
  tags: string[];
}

export interface ChatToolResult {
  toolName?: string;
  query?: string;
  k?: number;
  results?: SearchResult[];
  notes?: NoteMeta[];
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  toolResult?: ChatToolResult;
  toolResults?: ChatToolResult[];
}


export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

