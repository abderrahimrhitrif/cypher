import { TFile, Vault } from "obsidian";
import { ChunkMetadata, CypherSettings, IndexingProgress } from "../types";
import { ChunkingService } from "./chunkingService";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export type ProgressCallback = (progress: IndexingProgress) => void;

export class IndexerService {
  private vault: Vault;
  private settings: CypherSettings;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;

  private isRunning = false;
  private isPaused = false;
  private abortRequested = false;

  private progress: IndexingProgress = {
    status: "idle",
    totalFiles: 0,
    processedFiles: 0,
    currentFile: "",
    totalChunks: 0,
    indexedChunks: 0,
    failedFiles: [],
  };

  private listeners: Set<ProgressCallback> = new Set();

  constructor(
    vault: Vault,
    settings: CypherSettings,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService
  ) {
    this.vault = vault;
    this.settings = settings;
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  public onProgress(cb: ProgressCallback): () => void {
    this.listeners.add(cb);
    cb(this.getProgress());
    return () => {
      this.listeners.delete(cb);
    };
  }

  public getProgress(): IndexingProgress {
    return { ...this.progress };
  }

  private notify(): void {
    const copy = this.getProgress();
    for (const listener of this.listeners) {
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
      this.progress.status = "paused";
      this.notify();
    }
  }

  public resume(): void {
    if (this.isRunning && this.isPaused) {
      this.isPaused = false;
      this.progress.status = "indexing";
      this.notify();
    }
  }

  public cancel(): void {
    if (this.isRunning) {
      this.abortRequested = true;
      this.isPaused = false;
    }
  }

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

  public async indexVault(forceAll = false): Promise<IndexingProgress> {
    if (this.isRunning) {
      throw new Error("Indexing is already in progress");
    }

    this.isRunning = true;
    this.isPaused = false;
    this.abortRequested = false;

    this.progress = {
      status: "scanning",
      totalFiles: 0,
      processedFiles: 0,
      currentFile: "",
      totalChunks: 0,
      indexedChunks: 0,
      failedFiles: [],
    };
    this.notify();

    try {
      const allFiles = this.vault.getMarkdownFiles().filter((f) => !this.isFileExcluded(f));
      this.progress.totalFiles = allFiles.length;

      const existingIndexed = this.vecDb.getAllIndexedFiles();
      const currentPaths = new Set(allFiles.map((f) => f.path));
      for (const [indexedPath] of existingIndexed.entries()) {
        if (!currentPaths.has(indexedPath)) {
          await this.vecDb.removeFileChunks(indexedPath);
        }
      }

      this.progress.status = "indexing";
      this.notify();

      const queue: { file: TFile; content: string; chunks: ChunkMetadata[] }[] = [];

      for (const file of allFiles) {
        if (this.abortRequested) break;

        const content = await this.vault.cachedRead(file);
        const hash = ChunkingService.hashContent(content);

        if (!forceAll && this.vecDb.isFileUpToDate(file.path, hash)) {
          this.progress.processedFiles++;
          this.notify();
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
          queue.push({ file, content, chunks });
          this.progress.totalChunks += chunks.length;
        } else {
          this.progress.processedFiles++;
        }
      }

      this.notify();

      for (const item of queue) {
        if (this.abortRequested) break;

        while (this.isPaused && !this.abortRequested) {
          await new Promise((r) => setTimeout(r, 300));
        }

        if (this.abortRequested) break;

        this.progress.currentFile = item.file.path;
        this.notify();

        try {
          await this.processChunks(item.file.path, item.chunks);
          this.progress.processedFiles++;
          this.progress.indexedChunks += item.chunks.length;
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[Cypher] Failed to index ${item.file.path}:`, err);
          this.progress.failedFiles.push({ path: item.file.path, error });
          this.progress.processedFiles++;
        }

        this.notify();
      }

      await this.vecDb.save();

      this.progress.status = this.abortRequested ? "idle" : "completed";
      this.notify();
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.progress.status = "error";
      this.progress.errorMessage = error;
      this.notify();
      throw err;
    } finally {
      this.isRunning = false;
      this.isPaused = false;
      this.abortRequested = false;
    }

    return this.getProgress();
  }

  private async processChunks(path: string, chunks: ChunkMetadata[]): Promise<void> {
    if (chunks.length === 0) {
      await this.vecDb.removeFileChunks(path);
      return;
    }

    const allEmbeddings: number[][] = [];
    const batchSize = Math.max(1, this.settings.batchSize);

    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);
      const texts = slice.map((c) => c.text);
      const embeddings = await this.embedSvc.getEmbeddingsBatch(texts);
      allEmbeddings.push(...embeddings);
    }

    await this.vecDb.upsertFileChunks(path, chunks, allEmbeddings);
  }

  public async indexSingleFile(file: TFile): Promise<boolean> {
    if (this.isFileExcluded(file) || file.extension !== "md") {
      return false;
    }

    try {
      const content = await this.vault.cachedRead(file);
      const hash = ChunkingService.hashContent(content);

      if (this.vecDb.isFileUpToDate(file.path, hash)) {
        return false;
      }

      const chunks = ChunkingService.chunkMarkdown(
        file.path,
        content,
        this.settings.chunkSize,
        this.settings.chunkOverlap,
        file.stat.mtime
      );

      await this.processChunks(file.path, chunks);
      this.vecDb.scheduleSave(2000);
      return true;
    } catch (err) {
      console.error(`[Cypher] Error auto-indexing file ${file.path}:`, err);
      return false;
    }
  }

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
        await this.processChunks(file.path, chunks);
        await this.vecDb.save();
        console.log(`[Cypher] Instantly indexed new document: ${file.path} (${chunks.length} chunks)`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[Cypher] Error indexing newly added file ${file.path}:`, err);
      return false;
    }
  }

  public async handleFileDeleted(path: string): Promise<void> {
    await this.vecDb.removeFileOrFolder(path);
    await this.vecDb.save();
    console.log(`[Cypher] Instantly removed deleted document from vector DB: ${path}`);
  }

  public handleFileRenamed(oldPath: string, newPath: string): void {
    this.vecDb.renameFile(oldPath, newPath);
    this.vecDb.scheduleSave(2000);
  }
}
