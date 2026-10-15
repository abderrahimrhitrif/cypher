import { DEFAULT_SETTINGS } from "../src/settings";
import type { ChunkMetadata, CypherSettings } from "../src/types";

/** In-memory replacement for Obsidian's DataAdapter. */
export class MemoryAdapter {
  public files = new Map<string, string>();
  public dirs = new Set<string>();

  public async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  public async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  public async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return value;
  }

  public async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  public async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }
}

export interface FakeVaultFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parent: { path: string } | null;
  stat: { mtime: number };
}

export class FakeVault {
  private contents = new Map<string, string>();
  public files: FakeVaultFile[] = [];

  public setFile(path: string, content: string, mtime = Date.now()): FakeVaultFile {
    const segments = path.split("/");
    const name = segments[segments.length - 1];
    const extension = name.includes(".") ? name.split(".").pop()! : "";
    const folder = segments.slice(0, -1).join("/");

    const file: FakeVaultFile = {
      path,
      name,
      basename: extension ? name.slice(0, -(extension.length + 1)) : name,
      extension,
      parent: folder ? { path: folder } : null,
      stat: { mtime },
    };

    const existingIndex = this.files.findIndex((item) => item.path === path);
    if (existingIndex >= 0) {
      this.files[existingIndex] = file;
    } else {
      this.files.push(file);
    }

    this.contents.set(path, content);
    return file;
  }

  public deleteFile(path: string): void {
    this.files = this.files.filter((item) => item.path !== path);
    this.contents.delete(path);
  }

  public getMarkdownFiles(): FakeVaultFile[] {
    return this.files.filter((file) => file.extension === "md");
  }

  public async cachedRead(file: FakeVaultFile): Promise<string> {
    return this.contents.get(file.path) ?? "";
  }
}

export function makeSettings(overrides: Partial<CypherSettings> = {}): CypherSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function makeChunks(
  path: string,
  count: number,
  fileHash = "hash"
): ChunkMetadata[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${path}#chunk-${index}`,
    path,
    title: path.split("/").pop()!.replace(/\.md$/, ""),
    heading: "",
    chunkIndex: index,
    totalChunks: count,
    text: `content ${index} of ${path}`,
    fileHash,
    mtime: 1,
  }));
}

/** Deterministic unit vectors of the requested size. */
export function unitVector(size: number, activeIndex = 0): number[] {
  return Array.from({ length: size }, (_, index) => (index === activeIndex ? 1 : 0));
}
