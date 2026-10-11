import { TFile, Vault } from "obsidian";
import { ChunkMetadata, CypherSettings, IndexingProgress } from "../types";
import { ChunkingService } from "./chunkingService";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export type ProgressCallback = (progress: IndexingProgress) => void;

export class IndexerService {
  private vault: Vault;
  private settings: CypherSettings;
  private embeddingService: EmbeddingService;
  private vectorDbService: VectorDbService;

  private isRunning = false;
  private isPaused = false;
  private abortRequested = false;

  private currentProgress: IndexingProgress = {
    status: "idle",
    totalFiles: 0,
    processedFiles: 0,
    currentFile: "",
    totalChunks: 0,
    indexedChunks: 0,
    failedFiles: [],
  };

  private progressListeners: Set<ProgressCallback> = new Set();

  constructor(
    vault: Vault,
    settings: CypherSettings,
    embeddingService: EmbeddingService,
    vectorDbService: VectorDbService
  ) {
    this.vault = vault;
    this.settings = settings;
    this.embeddingService = embeddingService;
    this.vectorDbService = vectorDbService;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  public onProgress(callback: ProgressCallback): () => void {
    this.progressListeners.add(callback);
    callback(this.getProgress());
    return () => {
      this.progressListeners.delete(callback);
    };
  }

  public getProgress(): IndexingProgress {
    return { ...this.currentProgress };
  }

  private notifyProgress(): void {
    const copy = this.getProgress();
    for (const listener of this.progressListeners) {
      try {
        listener(copy);
      } catch (err) {
        console.error("[Cypher] Error in progress listener:", err);
      }
    }
  }

  public pause(): void {
    if (this.isRunning) {
      this.isPaused = true;
      this.currentProgress.status = "paused";
      this.notifyProgress();
    }
  }

  public resume(): void {
    if (this.isRunning && this.isPaused) {
      this.isPaused = false;
      this.currentProgress.status = "indexing";
      this.notifyProgress();
    }
  }

  public cancel(): void {
    if (this.isRunning) {
      this.abortRequested = true;
      this.isPaused = false;
    }
  }

  /**
   * Filters files that should not be indexed based on folder exclusion rules.
   */
  public isFileExcluded(file: TFile): boolean {
    const path = file.path;
    for (const folder of this.settings.excludedFolders) {
      const clean = folder.trim();
      if (!clean) continue;
      if (path.startsWith(clean + "/") || path === clean) {
        return true;
      }
    }
    return false;
  }

  /**
   * Scans and indexes the entire vault.
   * Performs incremental indexing: skips files whose content hash hasn't changed.
   */
  public async indexVault(forceReindexAll = false): Promise<IndexingProgress> {
    if (this.isRunning) {
      throw new Error("Indexing is already in progress");
    }

    this.isRunning = true;
    this.isPaused = false;
    this.abortRequested = false;

    this.currentProgress = {
      status: "scanning",
      totalFiles: 0,
      processedFiles: 0,
      currentFile: "",
      totalChunks: 0,
      indexedChunks: 0,
      failedFiles: [],
    };
    this.notifyProgress();

    try {
      const allFiles = this.vault.getMarkdownFiles().filter((f) => !this.isFileExcluded(f));
      this.currentProgress.totalFiles = allFiles.length;

      // Clean up deleted files from vector DB
      const existingIndexed = this.vectorDbService.getAllIndexedFiles();
      const currentPaths = new Set(allFiles.map((f) => f.path));
      for (const [indexedPath] of existingIndexed.entries()) {
        if (!currentPaths.has(indexedPath)) {
          await this.vectorDbService.removeFileChunks(indexedPath);
        }
      }

      this.currentProgress.status = "indexing";
      this.notifyProgress();

      // Collect files that need indexing
      const filesToIndex: { file: TFile; content: string; chunks: ChunkMetadata[] }[] = [];

      for (const file of allFiles) {
        if (this.abortRequested) break;

        const content = await this.vault.cachedRead(file);
        const hash = ChunkingService.hashContent(content);

        if (!forceReindexAll && this.vectorDbService.isFileUpToDate(file.path, hash)) {
          // Already up to date
          this.currentProgress.processedFiles++;
          this.notifyProgress();
          continue;
        }

        const chunks = ChunkingService.chunkMarkdown(
          file.path,
          content,
          this.settings.chunkSize,
          this.settings.chunkOverlap,
          file.stat.mtime
        );

        if (chunks.length > 0) {
          filesToIndex.push({ file, content, chunks });
          this.currentProgress.totalChunks += chunks.length;
        } else {
          // Empty note or no valid text
          this.currentProgress.processedFiles++;
        }
      }

      this.notifyProgress();

      // Now process files with embeddings in batches
      for (const item of filesToIndex) {
        if (this.abortRequested) {
          break;
        }

        while (this.isPaused && !this.abortRequested) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        if (this.abortRequested) break;

        this.currentProgress.currentFile = item.file.path;
        this.notifyProgress();

        try {
          await this.processFileChunks(item.file.path, item.chunks);
          this.currentProgress.processedFiles++;
          this.currentProgress.indexedChunks += item.chunks.length;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Cypher] Failed to index ${item.file.path}:`, err);
          this.currentProgress.failedFiles.push({ path: item.file.path, error: errMsg });
          this.currentProgress.processedFiles++;
        }

        this.notifyProgress();
      }

      // Final save to disk
      await this.vectorDbService.save();

      if (this.abortRequested) {
        this.currentProgress.status = "idle";
      } else {
        this.currentProgress.status = "completed";
      }
      this.notifyProgress();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.currentProgress.status = "error";
      this.currentProgress.errorMessage = errMsg;
      this.notifyProgress();
      throw err;
    } finally {
      this.isRunning = false;
      this.isPaused = false;
      this.abortRequested = false;
    }

    return this.getProgress();
  }

  /**
   * Helper to batch chunk texts, get embeddings, and upsert into DB.
   */
  private async processFileChunks(path: string, chunks: ChunkMetadata[]): Promise<void> {
    if (chunks.length === 0) {
      await this.vectorDbService.removeFileChunks(path);
      return;
    }

    const allEmbeddings: number[][] = [];
    const batchSize = Math.max(1, this.settings.batchSize);

    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);
      const texts = slice.map((c) => c.text);
      const embeddings = await this.embeddingService.getEmbeddingsBatch(texts);
      allEmbeddings.push(...embeddings);
    }

    await this.vectorDbService.upsertFileChunks(path, chunks, allEmbeddings);
  }

  /**
   * Incrementally indexes a single file (e.g. on file save).
   */
  public async indexSingleFile(file: TFile): Promise<boolean> {
    if (this.isFileExcluded(file) || file.extension !== "md") {
      return false;
    }

    try {
      const content = await this.vault.cachedRead(file);
      const hash = ChunkingService.hashContent(content);

      if (this.vectorDbService.isFileUpToDate(file.path, hash)) {
        return false;
      }

      const chunks = ChunkingService.chunkMarkdown(
        file.path,
        content,
        this.settings.chunkSize,
        this.settings.chunkOverlap,
        file.stat.mtime
      );

      await this.processFileChunks(file.path, chunks);
      this.vectorDbService.scheduleSave(2000);
      return true;
    } catch (err) {
      console.error(`[Cypher] Error auto-indexing file ${file.path}:`, err);
      return false;
    }
  }

  /**
   * Instantly indexes a newly created document and saves to database.
   */
  public async handleFileCreated(file: TFile): Promise<boolean> {
    if (this.isFileExcluded(file) || file.extension !== "md") {
      return false;
    }

    try {
      const content = await this.vault.cachedRead(file);
      const chunks = ChunkingService.chunkMarkdown(
        file.path,
        content,
        this.settings.chunkSize,
        this.settings.chunkOverlap,
        file.stat.mtime
      );

      if (chunks.length > 0) {
        await this.processFileChunks(file.path, chunks);
        await this.vectorDbService.save();
        console.log(`[Cypher] Instantly indexed new document: ${file.path} (${chunks.length} chunks)`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[Cypher] Error indexing newly added file ${file.path}:`, err);
      return false;
    }
  }

  /**
   * Instantly removes a deleted file or folder from the vector DB and saves to disk.
   */
  public async handleFileDeleted(path: string): Promise<void> {
    await this.vectorDbService.removeFileOrFolder(path);
    await this.vectorDbService.save();
    console.log(`[Cypher] Instantly removed deleted document from vector DB: ${path}`);
  }

  /**
   * Renames a file in the vector DB.
   */
  public handleFileRenamed(oldPath: string, newPath: string): void {
    this.vectorDbService.renameFile(oldPath, newPath);
    this.vectorDbService.scheduleSave(2000);
  }
}
