import { beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionMismatchError } from "../src/errors";
import { VectorDbService } from "../src/services/vectorDbService";
import { MemoryAdapter, makeChunks, unitVector } from "./helpers";

const DIR = ".obsidian/plugins/cypher";
const DIMENSION = 4;

function createDb(adapter: MemoryAdapter, dimension = DIMENSION): VectorDbService {
  return new VectorDbService(adapter as never, DIR, dimension);
}

async function seed(service: VectorDbService): Promise<void> {
  await service.upsertFileChunks(
    "notes/alpha.md",
    makeChunks("notes/alpha.md", 2, "hash-alpha"),
    [unitVector(DIMENSION, 0), unitVector(DIMENSION, 0)]
  );
  await service.upsertFileChunks(
    "notes/beta.md",
    makeChunks("notes/beta.md", 1, "hash-beta"),
    [unitVector(DIMENSION, 1)]
  );
}

describe("VectorDbService", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  it("creates the database lazily and reports stats", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);

    expect(service.getStats()).toMatchObject({
      documentCount: 0,
      uniqueFilesCount: 0,
      dimension: DIMENSION,
    });

    await seed(service);
    expect(service.getStats()).toMatchObject({ documentCount: 3, uniqueFilesCount: 2 });
    expect(service.isFileUpToDate("notes/alpha.md", "hash-alpha")).toBe(true);
    expect(service.isFileUpToDate("notes/alpha.md", "other")).toBe(false);
  });

  it("ranks results and can keep one chunk per note", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);

    const hits = await service.search(unitVector(DIMENSION, 0), 5, 0.5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("notes/alpha.md");
    expect(hits[0].score).toBeGreaterThan(0.9);

    const deduped = await service.search(unitVector(DIMENSION, 0), 5, 0.5, {
      dedupeByPath: true,
    });
    expect(deduped.map((hit) => hit.path)).toEqual(["notes/alpha.md"]);
  });

  it("rejects wrong-sized vectors without deleting the existing chunks", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);

    await expect(
      service.upsertFileChunks(
        "notes/alpha.md",
        makeChunks("notes/alpha.md", 1, "new-hash"),
        [unitVector(8)]
      )
    ).rejects.toBeInstanceOf(DimensionMismatchError);

    expect(service.getStats().documentCount).toBe(3);
    expect(service.isFileUpToDate("notes/alpha.md", "hash-alpha")).toBe(true);
  });

  it("rejects search vectors of the wrong dimension", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);

    await expect(service.search(unitVector(8), 5, 0.1)).rejects.toBeInstanceOf(
      DimensionMismatchError
    );
  });

  it("removes single notes and whole folders", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);
    await service.upsertFileChunks(
      "archive/old.md",
      makeChunks("archive/old.md", 1, "hash-old"),
      [unitVector(DIMENSION, 2)]
    );

    await service.removeFileChunks("notes/beta.md");
    expect(service.isFileUpToDate("notes/beta.md", "hash-beta")).toBe(false);

    const affected = await service.forgetPath("archive");
    expect(affected).toEqual(["archive/old.md"]);
    expect(service.getStats()).toMatchObject({ documentCount: 2, uniqueFilesCount: 1 });
  });

  it("persists to disk and restores the index", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);
    await service.save(true);

    expect(adapter.files.has(`${DIR}/orama_db.json`)).toBe(true);
    expect(adapter.files.has(`${DIR}/index_meta.json`)).toBe(true);

    const restored = createDb(adapter);
    await restored.init(DIMENSION);

    expect(restored.getStats()).toMatchObject({ documentCount: 3, uniqueFilesCount: 2 });
    expect(restored.isFileUpToDate("notes/alpha.md", "hash-alpha")).toBe(true);

    const hits = await restored.search(unitVector(DIMENSION, 1), 1, 0.5);
    expect(hits[0].path).toBe("notes/beta.md");
  });

  it("discards an index built with a different dimension", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);
    await service.save(true);

    const changed = createDb(adapter, 8);
    await changed.init(8);

    expect(changed.getStats()).toMatchObject({ documentCount: 0, dimension: 8 });
    expect(adapter.files.has(`${DIR}/orama_db.json`)).toBe(false);
  });

  it("reads the legacy metadata array format", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);
    await service.save(true);

    const meta = JSON.parse(adapter.files.get(`${DIR}/index_meta.json`)!);
    adapter.files.set(`${DIR}/index_meta.json`, JSON.stringify(meta.files));

    const restored = createDb(adapter);
    await restored.init(DIMENSION);

    expect(restored.getStats().uniqueFilesCount).toBe(2);
  });

  it("skips redundant saves until the index is dirty", async () => {
    const service = createDb(adapter);
    await service.init(DIMENSION);
    await seed(service);
    await service.save(true);

    const write = vi.spyOn(adapter, "write");
    await service.save();
    expect(write).not.toHaveBeenCalled();

    await service.save(true);
    expect(write).toHaveBeenCalled();
  });
});
