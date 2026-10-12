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
  private dir: string;
  private dimension: number;
  private fileMap: Map<string, FileIndexInfo> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(adapter: DataAdapter, dir: string, dimension = 1536) {
    this.adapter = adapter;
    this.dir = dir;
    this.dimension = dimension;
  }

  private get dbPath(): string {
    return `${this.dir}/orama_db.json`;
  }

  private get metaPath(): string {
    return `${this.dir}/index_meta.json`;
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
        console.log("[Cypher] Restoring vector database from disk...");
        const rawDb = await this.adapter.read(this.dbPath);
        this.db = (await restore("json", rawDb)) as AnyOrama;

        const rawMeta = await this.adapter.read(this.metaPath);
        const parsedMeta = JSON.parse(rawMeta) as [string, FileIndexInfo][];
        this.fileMap = new Map(parsedMeta);
        console.log(`[Cypher] Restored vector database with ${this.fileMap.size} files indexed.`);
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
    this.fileMap.clear();
  }

  public isFileUpToDate(path: string, hash: string): boolean {
    const info = this.fileMap.get(path);
    return !!info && info.hash === hash;
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

    await this.removeFileChunks(path);

    if (chunks.length === 0 || embeddings.length === 0) {
      return;
    }

    const docs = chunks.map((c, i) => ({
      id: c.id,
      path: c.path,
      title: c.title,
      heading: c.heading,
      chunkIndex: c.chunkIndex,
      text: c.text,
      fileHash: c.fileHash,
      embedding: embeddings[i],
    }));

    await insertMultiple(this.db, docs);

    this.fileMap.set(path, {
      hash: chunks[0].fileHash,
      chunkIds: chunks.map((c) => c.id),
      mtime: chunks[0].mtime,
    });
  }

  public async removeFileChunks(path: string): Promise<void> {
    if (!this.db) return;

    const info = this.fileMap.get(path);
    if (info && info.chunkIds.length > 0) {
      for (const id of info.chunkIds) {
        try {
          await remove(this.db, id);
        } catch {
        }
      }
      this.fileMap.delete(path);
    }
  }

  public async removeFileOrFolder(path: string): Promise<void> {
    if (!this.db) return;

    if (this.fileMap.has(path)) {
      await this.removeFileChunks(path);
      return;
    }

    const prefix = path.endsWith("/") ? path : `${path}/`;
    const toRemove: string[] = [];
    for (const key of this.fileMap.keys()) {
      if (key.startsWith(prefix) || key === path) {
        toRemove.push(key);
      }
    }

    for (const p of toRemove) {
      await this.removeFileChunks(p);
    }
  }

  public renameFile(oldPath: string, newPath: string): void {
    const info = this.fileMap.get(oldPath);
    if (info) {
      this.fileMap.delete(oldPath);
      this.fileMap.set(newPath, info);
    }
  }

  public async search(
    queryVec: number[],
    limit = 10,
    similarity = 0.5
  ): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error("Vector database is not initialized");
    }

    const res = await search(this.db, {
      mode: "vector",
      vector: {
        value: queryVec,
        property: "embedding",
      },
      similarity,
      limit,
    });

    if (!res || !res.hits) {
      return [];
    }

    return res.hits.map((hit) => {
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

  public scheduleSave(delayMs = 2000): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save().catch((err) => console.error("[Cypher] Autosave failed:", err));
    }, delayMs);
  }

  public async save(): Promise<void> {
    if (!this.db) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      if (!(await this.adapter.exists(this.dir))) {
        await this.adapter.mkdir(this.dir);
      }

      const rawDb = await persist(this.db, "json");
      await this.adapter.write(this.dbPath, rawDb as string);

      const rawMeta = JSON.stringify(Array.from(this.fileMap.entries()));
      await this.adapter.write(this.metaPath, rawMeta);
      console.log(`[Cypher] Successfully saved vector database (${this.fileMap.size} files).`);
    } catch (err) {
      console.error("[Cypher] Error saving vector database to disk:", err);
      throw err;
    }
  }

  public async clear(): Promise<void> {
    await this.createNewDb();
    if (await this.adapter.exists(this.dbPath)) {
      await this.adapter.remove(this.dbPath);
    }
    if (await this.adapter.exists(this.metaPath)) {
      await this.adapter.remove(this.metaPath);
    }
  }

  public getStats(): VectorDbStats {
    let count = 0;
    for (const info of this.fileMap.values()) {
      count += info.chunkIds.length;
    }

    return {
      documentCount: count,
      uniqueFilesCount: this.fileMap.size,
      dimension: this.dimension,
    };
  }
}
