export interface CypherSettings {
  // API Configuration
  apiUrl: string;
  apiKey: string;
  model: string;
  dimension: number;

  // Chunking Configuration
  chunkSize: number; // in characters
  chunkOverlap: number; // in characters
  batchSize: number; // number of chunks per embedding request

  // Vault indexing options
  excludedFolders: string[];
  autoIndexOnSave: boolean;

  // State
  hasCompletedInitialIndexing: boolean;
  lastIndexedTime: number;
}

export interface ChunkMetadata {
  id: string; // e.g., "notes/idea.md#chunk-0"
  path: string; // relative path within vault
  title: string; // file name without extension
  heading: string; // current heading context
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
  score: number; // cosine similarity (0 to 1)
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
