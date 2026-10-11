export interface CypherSettings {
  embeddingApiUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  /** Vector size of the configured embedding model. */
  dimension: number;
  /**
   * `url|model` fingerprint of the embedding configuration the current vector
   * index was built with. Used to detect model switches without probing the API
   * on every startup.
   */
  dimensionSignature: string;
  chatApiUrl: string;
  chatApiKey: string;
  chatModel: string;
  chatTopK: number;
  chatSimilarityThreshold: number;
  chatMaxTokens: number;
  chatTemperature: number;
  chatSystemPrompt: string;
  /** True once the user edits the prompt, so upgrades never overwrite their text. */
  chatSystemPromptCustomized: boolean;
  chunkSize: number;
  chunkOverlap: number;
  batchSize: number;
  excludedFolders: string[];
  autoIndexOnSave: boolean;
  hasCompletedInitialIndexing: boolean;
  lastIndexedTime: number;
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

export type IndexingStatus =
  | "idle"
  | "scanning"
  | "indexing"
  | "completed"
  | "cancelled"
  | "error"
  | "paused";

export interface IndexingProgress {
  status: IndexingStatus;
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

export interface NoteContent {
  title: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface ChatToolResult {
  toolName?: string;
  query?: string;
  k?: number;
  results?: SearchResult[];
  notes?: NoteMeta[];
  note?: NoteContent;
  /** Set when the tool itself failed (bad path, embedding error, ...). */
  error?: string;
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
  /** UI marker for locally surfaced API failures; never sent back to the model. */
  isError?: boolean;
  /** True when the user stopped generation before the model finished. */
  stopped?: boolean;
  /** Set on the temporary message rendered while tokens stream in. */
  streaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
