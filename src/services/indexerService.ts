import type { TFile, Vault } from "obsidian";
import { Notice } from "obsidian";
import { ChunkMetadata, CypherSettings, IndexingProgress, IndexingStatus } from "../types";
import { describeError, DimensionMismatchError } from "../errors";
import { embeddingSignature } from "../settings";
import { isPathExcluded, sleep } from "../utils";
import { ChunkingService } from "./chunkingService";
import { EmbeddingService } from "./embeddingService";
import { VectorDbService } from "./vectorDbService";

export type ProgressCallback = (progress: IndexingProgress) => void;

interface QueuedFile {
  file: TFile;
  chunks: ChunkMetadata[];
}

const PAUSE_POLL_MS = 100;

export class IndexerService {
  private vault: Vault;
  private settings: CypherSettings;
  private embedSvc: EmbeddingService;
  private vecDb: VectorDbService;
  private onSettingsChanged?: () => Promise<void>;

  private isRunning = false;
  private isPaused = false;
  private abortRequested = false;

  private progress: IndexingProgress = this.emptyProgress();
  private listeners: Set<ProgressCallback> = new Set();

  constructor(
    vault: Vault,
    settings: CypherSettings,
    embedSvc: EmbeddingService,
    vecDb: VectorDbService,
    onSettingsChanged?: () => Promise<void>
  ) {
    this.vault = vault;
    this.settings = settings;
    this.embedSvc = embedSvc;
    this.vecDb = vecDb;
    this.onSettingsChanged = onSettingsChanged;
  }

  public updateSettings(settings: CypherSettings): void {
    this.settings = settings;
  }

  public onProgress(callback: ProgressCallback): () => void {
    this.listeners.add(callback);
    callback(this.getProgress());
    return () => {
      this.listeners.delete(callback);
    };
  }

  public getProgress(): IndexingProgress {
    return { ...this.progress, failedFiles: [...this.progress.failedFiles] };
  }

  public isIndexing(): boolean {
    return this.isRunning;
  }

  public pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
    this.updateStatus("paused");
  }

  public resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    this.updateStatus("indexing");
  }

  public cancel(): void {
    if (!this.isRunning) return;
    this.abortRequested = true;
    this.isPaused = false;
  }

  public isFileExcluded(file: TFile): boolean {
    return isPathExcluded(file.path, this.settings.excludedFolders);
  }

  public async indexVault(forceAll = false): Promise<IndexingProgress> {
    if (this.isRunning) {
      throw new Error("Indexing is already in progress");
    }

    this.isRunning = true;
    this.isPaused = false;
    this.abortRequested = false;
    this.progress = this.emptyProgress();
    this.updateStatus("scanning");

    try {
      let pass = 0;
      while (pass < 2) {
        pass++;
        try {
          await this.runPass(forceAll);
          break;
        } catch (error) {
          const recoverable =
            pass === 1 && error instanceof DimensionMismatchError && error.actual > 0;
          if (!recoverable) throw error;

          await this.recoverFromDimensionChange(error as DimensionMismatchError);
          forceAll = true;
        }
      }

      if (!this.abortRequested) {
        this.settings.lastIndexedTime = Date.now();
        this.settings.hasCompletedInitialIndexing =
          this.vecDb.getStats().documentCount > 0;
        await this.onSettingsChanged?.();
      }

      this.updateStatus(this.abortRequested ? "cancelled" : "completed");
    } catch (error) {
      this.progress.status = "error";
      this.progress.errorMessage = describeError(error);
      this.notify();
      throw error;
    } finally {
      this.isRunning = false;
      this.isPaused = false;
      this.abortRequested = false;
      await this.vecDb.save().catch((error) => {
        console.error("[cypher] could not persist the index:", error);
      });
    }

    return this.getProgress();
  }

  private async runPass(forceAll: boolean): Promise<void> {
    const files = this.vault.getMarkdownFiles().filter((file) => !this.isFileExcluded(file));
    this.progress.totalFiles = files.length;
    this.updateStatus("indexing");

    await this.pruneDeletedEntries(files.map((file) => file.path));

    const queue: QueuedFile[] = [];

    for (const file of files) {
      if (this.abortRequested) return;
      await this.waitWhilePaused();
      if (this.abortRequested) return;

      const content = await this.vault.cachedRead(file);
      const hash = ChunkingService.hashContent(content);

      if (!forceAll && this.vecDb.isFileUpToDate(file.path, hash)) {
        this.progress.processedFiles++;
        this.notify();
        continue;
      }

      const chunks = this.chunkFile(file, content);
      if (chunks.length === 0) {
        // An emptied note must not leave its old chunks behind.
        await this.vecDb.removeFileChunks(file.path);
        this.progress.processedFiles++;
        this.notify();
        continue;
      }

      queue.push({ file, chunks });
      this.progress.totalChunks += chunks.length;
    }

    this.notify();

    for (const item of queue) {
      if (this.abortRequested) return;
      await this.waitWhilePaused();
      if (this.abortRequested) return;

      this.progress.currentFile = item.file.path;
      this.notify();

      try {
        await this.processChunks(item.file.path, item.chunks);
        this.progress.indexedChunks += item.chunks.length;
      } catch (error) {
        if (error instanceof DimensionMismatchError) throw error;

        console.error(`[cypher] failed to index ${item.file.path}:`, error);
        this.progress.failedFiles.push({ path: item.file.path, error: describeError(error) });
      }

      this.progress.processedFiles++;
      this.notify();
    }

    this.vecDb.markDirty();
  }

  /** Removes index entries for notes that no longer exist in the vault. */
  private async pruneDeletedEntries(currentPaths: string[]): Promise<void> {
    const current = new Set(currentPaths);
    for (const indexedPath of this.vecDb.getAllIndexedFiles().keys()) {
      if (!current.has(indexedPath)) {
        await this.vecDb.removeFileChunks(indexedPath);
      }
    }
  }

  private async processChunks(path: string, chunks: ChunkMetadata[]): Promise<void> {
    if (chunks.length === 0) {
      await this.vecDb.removeFileChunks(path);
      return;
    }

    const batchSize = Math.max(1, this.settings.batchSize);
    const embeddings: number[][] = [];

    for (let index = 0; index < chunks.length; index += batchSize) {
      if (this.abortRequested) return;
      await this.waitWhilePaused();
      if (this.abortRequested) return;

      const batch = chunks.slice(index, index + batchSize);
      const vectors = await this.embedSvc.getEmbeddingsBatch(batch.map((chunk) => chunk.text));
      embeddings.push(...vectors);
    }

    await this.vecDb.upsertFileChunks(path, chunks, embeddings);
  }

  /**
   * The configured model started returning vectors of a different size. Drop
   * the stale index once and let `indexVault` retry with the new dimension.
   */
  private async recoverFromDimensionChange(error: DimensionMismatchError): Promise<void> {
    this.vecDb.cancelScheduledSave();
    this.settings.dimension = error.actual;
    this.settings.dimensionSignature = embeddingSignature(
      this.settings.embeddingApiUrl,
      this.settings.embeddingModel
    );
    this.settings.hasCompletedInitialIndexing = false;
    await this.onSettingsChanged?.();

    await this.vecDb.clear();
    await this.vecDb.init(error.actual);

    this.progress = this.emptyProgress();
    this.updateStatus("indexing");

    new Notice(
      `Cypher: the embedding model returns ${error.actual}-dimensional vectors (index had ${error.expected}). ` +
        "The index was reset and the vault is being re-indexed."
    );
  }

  private chunkFile(file: TFile, content: string): ChunkMetadata[] {
    return ChunkingService.chunkMarkdown(
      file.path,
      content,
      this.settings.chunkSize,
      this.settings.chunkOverlap,
      file.stat.mtime
    );
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.isPaused && !this.abortRequested) {
      await sleep(PAUSE_POLL_MS);
    }
  }

  public async indexSingleFile(file: TFile): Promise<boolean> {
    if (this.isRunning || this.isFileExcluded(file) || file.extension !== "md") {
      return false;
    }

    try {
      const content = await this.vault.cachedRead(file);
      const hash = ChunkingService.hashContent(content);
      if (this.vecDb.isFileUpToDate(file.path, hash)) {
        return false;
      }

      const chunks = this.chunkFile(file, content);
      await this.processChunks(file.path, chunks);
      this.vecDb.scheduleSave();
      return true;
    } catch (error) {
      console.error(`[cypher] could not index ${file.path}:`, error);
      return false;
    }
  }

  public async handleFileCreated(file: TFile): Promise<boolean> {
    return this.indexSingleFile(file);
  }

  public async handleFileDeleted(path: string): Promise<void> {
    const affected = await this.vecDb.forgetPath(path);
    if (affected.length > 0) {
      this.vecDb.scheduleSave(5_000);
    }
  }

  /**
   * Renamed notes keep their old path in the index, which would break result
   * links, so the entries are dropped and the caller re-indexes the new paths.
   */
  public async handlePathRenamed(oldPath: string): Promise<number> {
    const affected = await this.vecDb.forgetPath(oldPath);
    if (affected.length > 0) {
      this.vecDb.scheduleSave(5_000);
    }
    return affected.length;
  }

  private emptyProgress(): IndexingProgress {
    return {
      status: "idle",
      totalFiles: 0,
      processedFiles: 0,
      currentFile: "",
      totalChunks: 0,
      indexedChunks: 0,
      failedFiles: [],
    };
  }

  private updateStatus(status: IndexingStatus): void {
    this.progress.status = status;
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getProgress();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[cypher] progress listener failed:", error);
      }
    }
  }
}
