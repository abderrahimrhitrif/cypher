import { create, insertMultiple, remove, removeMultiple, search, AnyOrama } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import type { DataAdapter } from "obsidian";
import { Notice } from "obsidian";
import { ChunkMetadata, SearchResult, VectorDbStats } from "../types";
import { DimensionMismatchError } from "../errors";

export interface FileIndexInfo {
  hash: string;
  chunkIds: string[];
  mtime: number;
}

interface IndexMeta {
  dimension: number | null;
  files: Map<string, FileIndexInfo>;
}

export interface SearchOptions {
  /** Keep only the best-scoring chunk per note. */
  dedupeByPath?: boolean;
}

const DB_FILE = "orama_db.json";
const META_FILE = "index_meta.json";

export class VectorDbService {
  private db: AnyOrama | null = null;
  private adapter: DataAdapter;
  private dir: string;
  private dimension: number;
  private fileMap: Map<string, FileIndexInfo> = new Map();

  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private lastSaved: number | undefined;

  constructor(adapter: DataAdapter, dir: string, dimension = 1536) {
    this.adapter = adapter;
    this.dir = dir;
    this.dimension = dimension;
  }

  private get dbPath(): string {
    return `${this.dir}/${DB_FILE}`;
  }

  private get metaPath(): string {
    return `${this.dir}/${META_FILE}`;
  }

  public getDimension(): number {
    return this.dimension;
  }

  public async init(dimension: number): Promise<void> {
    this.dimension = dimension;

    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir);
    }

    const hasDb = await this.adapter.exists(this.dbPath);
    const hasMeta = await this.adapter.exists(this.metaPath);

    if (hasDb && hasMeta) {
      try {
        const rawDb = await this.adapter.read(this.dbPath);
        const restored = (await restore("json", rawDb)) as AnyOrama;
        const meta = this.parseIndexMeta(JSON.parse(await this.adapter.read(this.metaPath)));
        const indexedDimension =
          this.readDbDimension(rawDb) ?? meta.dimension ?? this.dimension;

        if (indexedDimension === this.dimension) {
          this.db = restored;
          this.fileMap = meta.files;
          this.dirty = false;
          return;
        }

        console.warn(
          `[cypher] discarding ${indexedDimension}-dimensional index; the configured model now uses ${this.dimension}`
        );
        this.db = restored;
        this.fileMap = meta.files;
        await this.clear();
        new Notice(
          `Cypher: embedding dimension changed (${indexedDimension} → ${this.dimension}). ` +
            "The old index was removed; re-index the vault to search again."
        );
        return;
      } catch (error) {
        console.error("[cypher] could not restore the vector database, starting fresh:", error);
      }
    }

    await this.createNewDb();
  }

  /** Reads both meta formats: legacy `[path, info][]` and `{ dimension, files }`. */
  private parseIndexMeta(parsed: unknown): IndexMeta {
    if (Array.isArray(parsed)) {
      return { dimension: null, files: new Map(parsed as [string, FileIndexInfo][]) };
    }
    if (parsed && typeof parsed === "object" && "files" in parsed) {
      const record = parsed as { dimension?: unknown; files?: unknown };
      return {
        dimension: typeof record.dimension === "number" ? record.dimension : null,
        files: new Map(Array.isArray(record.files) ? (record.files as [string, FileIndexInfo][]) : []),
      };
    }
    return { dimension: null, files: new Map() };
  }

  /**
   * The authoritative vector size lives in the persisted Orama index rather
   * than in metadata, so indexes written by older versions are still detected.
   */
  private readDbDimension(rawDb: string): number | null {
    try {
      const parsed = JSON.parse(rawDb) as {
        index?: { vectorIndexes?: Record<string, { size?: unknown }> };
      };
      const size = parsed.index?.vectorIndexes?.embedding?.size;
      return typeof size === "number" && size > 0 ? size : null;
    } catch {
      return null;
    }
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
    this.fileMap.clear();
    this.dirty = false;
  }

  public isFileUpToDate(path: string, hash: string): boolean {
    return this.fileMap.get(path)?.hash === hash;
  }

  public getAllIndexedFiles(): Map<string, FileIndexInfo> {
    return new Map(this.fileMap);
  }

  public async upsertFileChunks(
    path: string,
    chunks: ChunkMetadata[],
    embeddings: number[][]
  ): Promise<void> {
    if (!this.db) {
      throw new Error("Vector database is not initialized");
    }

    if (chunks.length === 0) {
      await this.removeFileChunks(path);
      return;
    }

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count (${embeddings.length}) does not match chunk count (${chunks.length}) for "${path}"`
      );
    }

    // Validate before touching existing data: a failed upsert must not delete
    // the chunks that are already indexed for this note.
    for (const embedding of embeddings) {
      if (!Array.isArray(embedding) || embedding.length !== this.dimension) {
        throw new DimensionMismatchError(
          this.dimension,
          Array.isArray(embedding) ? embedding.length : 0
        );
      }
    }

    await this.removeFileChunks(path);

    await insertMultiple(
      this.db,
      chunks.map((chunk, index) => ({
        id: chunk.id,
        path: chunk.path,
        title: chunk.title,
        heading: chunk.heading,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        fileHash: chunk.fileHash,
        embedding: embeddings[index],
      }))
    );

    this.fileMap.set(path, {
      hash: chunks[0].fileHash,
      chunkIds: chunks.map((chunk) => chunk.id),
      mtime: chunks[0].mtime,
    });
    this.markDirty();
  }

  public async removeFileChunks(path: string): Promise<void> {
    if (!this.db) return;

    const info = this.fileMap.get(path);
    if (!info) return;

    if (info.chunkIds.length > 0) {
      try {
        await removeMultiple(this.db, info.chunkIds);
      } catch (error) {
        console.error("[cypher] batch delete failed, removing chunks one by one:", error);
        for (const id of info.chunkIds) {
          try {
            await remove(this.db as AnyOrama, id);
          } catch {
            // Chunks already gone; nothing left to clean up.
          }
        }
      }
    }

    this.fileMap.delete(path);
    this.markDirty();
  }

  /**
   * Drops every chunk stored for a note, or for a whole folder when the path
   * belongs to one. Returns the affected note paths so callers can re-index.
   */
  public async forgetPath(path: string): Promise<string[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const affected = Array.from(this.fileMap.keys()).filter(
      (key) => key === path || key.startsWith(prefix)
    );

    for (const key of affected) {
      await this.removeFileChunks(key);
    }

    return affected;
  }

  public async search(
    queryVec: number[],
    limit = 10,
    similarity = 0.5,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error("Vector database is not initialized");
    }
    if (queryVec.length !== this.dimension) {
      throw new DimensionMismatchError(this.dimension, queryVec.length);
    }

    const wanted = options.dedupeByPath ? Math.max(limit * 4, limit) : limit;
    const result = await search(this.db, {
      mode: "vector",
      vector: { value: queryVec, property: "embedding" },
      similarity,
      limit: wanted,
    });

    const hits = result?.hits ?? [];
    const mapped = hits.map((hit) => {
      const doc = hit.document as Record<string, unknown>;
      return {
        id: String(hit.id),
        score: hit.score,
        path: String(doc.path ?? ""),
        title: String(doc.title ?? ""),
        heading: String(doc.heading ?? ""),
        text: String(doc.text ?? ""),
        chunkIndex: Number(doc.chunkIndex ?? 0),
      } satisfies SearchResult;
    });

    if (!options.dedupeByPath) {
      return mapped.slice(0, limit);
    }

    const seen = new Set<string>();
    const unique: SearchResult[] = [];
    for (const hit of mapped) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      unique.push(hit);
      if (unique.length === limit) break;
    }
    return unique;
  }

  public markDirty(): void {
    this.dirty = true;
  }

  public scheduleSave(delayMs = 30_000): void {
    this.dirty = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch((error) => console.error("[cypher] autosave failed:", error));
    }, delayMs);
  }

  public cancelScheduledSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * Writes the whole index. Saves are serialized and skipped when nothing
   * changed, so streaming edits cannot interleave two half-written files.
   */
  public save(force = false): Promise<void> {
    const task = this.saveChain.then(async () => {
      if (!this.db) return;
      if (!this.dirty && !force) return;

      this.dirty = false;
      try {
        await this.writeSnapshot();
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });

    this.saveChain = task.catch(() => undefined);
    return task;
  }

  private async writeSnapshot(): Promise<void> {
    if (!this.db) return;

    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir);
    }

    const rawDb = (await persist(this.db, "json")) as string;
    await this.adapter.write(this.dbPath, rawDb);

    await this.adapter.write(
      this.metaPath,
      JSON.stringify({ dimension: this.dimension, files: Array.from(this.fileMap.entries()) })
    );

    this.lastSaved = Date.now();
  }

  public async clear(): Promise<void> {
    this.cancelScheduledSave();
    await this.createNewDb();

    if (await this.adapter.exists(this.dbPath)) {
      await this.adapter.remove(this.dbPath);
    }
    if (await this.adapter.exists(this.metaPath)) {
      await this.adapter.remove(this.metaPath);
    }

    this.lastSaved = undefined;
  }

  public getStats(): VectorDbStats {
    let chunkCount = 0;
    for (const info of this.fileMap.values()) {
      chunkCount += info.chunkIds.length;
    }

    return {
      documentCount: chunkCount,
      uniqueFilesCount: this.fileMap.size,
      dimension: this.dimension,
      lastSaved: this.lastSaved,
    };
  }
}
