import { create, insertMultiple, remove, search, AnyOrama } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import { DataAdapter } from "obsidian";
import { ChunkMetadata, SearchResult, VectorDbStats } from "../types";

export interface FileIndexInfo {
  hash: string;
  chunkIds: string[];
  mtime: number;
}

export class VectorDbService {
  private db: AnyOrama | null = null;
  private adapter: DataAdapter;
  private pluginDir: string;
  private dimension: number;
  private fileIndexMap: Map<string, FileIndexInfo> = new Map();
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor(adapter: DataAdapter, pluginDir: string, dimension = 1536) {
    this.adapter = adapter;
    this.pluginDir = pluginDir;
    this.dimension = dimension;
  }

  private get dbFilePath(): string {
    return `${this.pluginDir}/orama_db.json`;
  }

  private get metaFilePath(): string {
    return `${this.pluginDir}/index_meta.json`;
  }

  /**
   * Initializes the vector database, restoring from disk if available or creating a new one.
   */
  public async init(dimension: number): Promise<void> {
    this.dimension = dimension;

    // Ensure plugin directory exists
    if (!(await this.adapter.exists(this.pluginDir))) {
      await this.adapter.mkdir(this.pluginDir);
    }

    const dbExists = await this.adapter.exists(this.dbFilePath);
    const metaExists = await this.adapter.exists(this.metaFilePath);

    if (dbExists && metaExists) {
      try {
        console.log("[Cypher] Restoring vector database from disk...");
        const rawDb = await this.adapter.read(this.dbFilePath);
        this.db = (await restore("json", rawDb)) as AnyOrama;

        const rawMeta = await this.adapter.read(this.metaFilePath);
        const parsedMeta = JSON.parse(rawMeta) as [string, FileIndexInfo][];
        this.fileIndexMap = new Map(parsedMeta);
        console.log(`[Cypher] Restored vector database with ${this.fileIndexMap.size} files indexed.`);
        return;
      } catch (err) {
        console.error("[Cypher] Failed to restore database from disk, creating fresh DB:", err);
      }
    }

    await this.createNewDb();
  }

  private async createNewDb(): Promise<void> {
    this.db = await create({
      schema: {
        id: "string",
        path: "string",
        title: "string",
        heading: "string",
        chunkIndex: "number",
        text: "string",
        fileHash: "string",
        embedding: `vector[${this.dimension}]`,
      },
    });
    this.fileIndexMap.clear();
  }

  /**
   * Checks if a file is already indexed with the exact same content hash.
   */
  public isFileUpToDate(path: string, contentHash: string): boolean {
    const info = this.fileIndexMap.get(path);
    return !!info && info.hash === contentHash;
  }

  /**
   * Returns a map of all indexed files and their hashes.
   */
  public getAllIndexedFiles(): Map<string, FileIndexInfo> {
    return new Map(this.fileIndexMap);
  }

  /**
   * Upserts chunks and their embeddings for a specific file.
   * Cleans up previous chunks of this file if present.
   */
  public async upsertFileChunks(
    path: string,
    chunks: ChunkMetadata[],
    embeddings: number[][]
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Vector database is not initialized");
    }

    // Remove old chunks for this file if already indexed
    await this.removeFileChunks(path);

    if (chunks.length === 0 || embeddings.length === 0) {
      return;
    }

    const documents = chunks.map((chunk, i) => ({
      id: chunk.id,
      path: chunk.path,
      title: chunk.title,
      heading: chunk.heading,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      fileHash: chunk.fileHash,
      embedding: embeddings[i],
    }));

    await insertMultiple(this.db, documents);

    this.fileIndexMap.set(path, {
      hash: chunks[0].fileHash,
      chunkIds: chunks.map((c) => c.id),
      mtime: chunks[0].mtime,
    });
  }

  /**
   * Removes all chunks of a file from the database.
   */
  public async removeFileChunks(path: string): Promise<void> {
    if (!this.db) return;

    const existingInfo = this.fileIndexMap.get(path);
    if (existingInfo && existingInfo.chunkIds.length > 0) {
      for (const chunkId of existingInfo.chunkIds) {
        try {
          await remove(this.db, chunkId);
        } catch {
          // Chunk might already be removed
        }
      }
      this.fileIndexMap.delete(path);
    }
  }

  /**
   * Removes all chunks of a file, or all files within a folder if path is a directory.
   */
  public async removeFileOrFolder(path: string): Promise<void> {
    if (!this.db) return;

    if (this.fileIndexMap.has(path)) {
      await this.removeFileChunks(path);
      return;
    }

    // Check if path is a folder containing indexed files
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const pathsToRemove: string[] = [];
    for (const indexedPath of this.fileIndexMap.keys()) {
      if (indexedPath.startsWith(prefix) || indexedPath === path) {
        pathsToRemove.push(indexedPath);
      }
    }

    for (const p of pathsToRemove) {
      await this.removeFileChunks(p);
    }
  }

  /**
   * Renames a file's path in the metadata map.
   */
  public renameFile(oldPath: string, newPath: string): void {
    const info = this.fileIndexMap.get(oldPath);
    if (info) {
      this.fileIndexMap.delete(oldPath);
      this.fileIndexMap.set(newPath, info);
    }
  }

  /**
   * Searches the vector database using cosine similarity.
   */
  public async search(
    queryEmbedding: number[],
    limit = 10,
    similarity = 0.5
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error("Vector database is not initialized");
    }

    const response = await search(this.db, {
      mode: "vector",
      vector: {
        value: queryEmbedding,
        property: "embedding",
      },
      similarity,
      limit,
    });

    if (!response || !response.hits) {
      return [];
    }

    return response.hits.map((hit) => {
      const doc = hit.document as Record<string, unknown>;
      return {
        id: String(hit.id),
        score: hit.score,
        path: String(doc.path ?? ""),
        title: String(doc.title ?? ""),
        heading: String(doc.heading ?? ""),
        text: String(doc.text ?? ""),
        chunkIndex: Number(doc.chunkIndex ?? 0),
      };
    });
  }

  /**
   * Schedules a debounced save to disk.
   */
  public scheduleSave(delayMs = 2000): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.save().catch((err) => console.error("[Cypher] Autosave failed:", err));
    }, delayMs);
  }

  /**
   * Immediately persists the vector database and metadata to disk.
   */
  public async save(): Promise<void> {
    if (!this.db) return;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    try {
      if (!(await this.adapter.exists(this.pluginDir))) {
        await this.adapter.mkdir(this.pluginDir);
      }

      const serializedDb = await persist(this.db, "json");
      await this.adapter.write(this.dbFilePath, serializedDb as string);

      const serializedMeta = JSON.stringify(Array.from(this.fileIndexMap.entries()));
      await this.adapter.write(this.metaFilePath, serializedMeta);
      console.log(`[Cypher] Successfully saved vector database (${this.fileIndexMap.size} files).`);
    } catch (err) {
      console.error("[Cypher] Error saving vector database to disk:", err);
      throw err;
    }
  }

  /**
   * Clears all documents and resets the database.
   */
  public async clear(): Promise<void> {
    await this.createNewDb();
    if (await this.adapter.exists(this.dbFilePath)) {
      await this.adapter.remove(this.dbFilePath);
    }
    if (await this.adapter.exists(this.metaFilePath)) {
      await this.adapter.remove(this.metaFilePath);
    }
  }

  /**
   * Returns current statistics of the vector database.
   */
  public getStats(): VectorDbStats {
    let totalChunks = 0;
    for (const info of this.fileIndexMap.values()) {
      totalChunks += info.chunkIds.length;
    }

    return {
      documentCount: totalChunks,
      uniqueFilesCount: this.fileIndexMap.size,
      dimension: this.dimension,
    };
  }
}
