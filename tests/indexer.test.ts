import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexerService } from "../src/services/indexerService";
import { VectorDbService } from "../src/services/vectorDbService";
import { FakeVault, MemoryAdapter, makeSettings, unitVector } from "./helpers";

const DIR = ".obsidian/plugins/cypher";

function makeEmbedder(dimension = 4) {
  return {
    getEmbeddingsBatch: vi.fn(async (texts: string[]) =>
      texts.map((_, index) => unitVector(dimension, index % dimension))
    ),
  };
}

describe("IndexerService", () => {
  let adapter: MemoryAdapter;
  let vault: FakeVault;
  let vecDb: VectorDbService;

  beforeEach(async () => {
    adapter = new MemoryAdapter();
    vault = new FakeVault();
    vecDb = new VectorDbService(adapter as never, DIR, 4);
    await vecDb.init(4);
  });

  it("indexes markdown notes and records progress", async () => {
    vault.setFile("a.md", "# Alpha\n\nAlpha body");
    vault.setFile("b.md", "# Beta\n\nBeta body");

    const settings = makeSettings({ hasCompletedInitialIndexing: false });
    const embedder = makeEmbedder();
    const save = vi.fn(async () => undefined);
    const indexer = new IndexerService(
      vault as never,
      settings,
      embedder as never,
      vecDb,
      save
    );

    const progress = await indexer.indexVault(false);

    expect(progress.status).toBe("completed");
    expect(progress.totalFiles).toBe(2);
    expect(progress.processedFiles).toBe(2);
    expect(progress.failedFiles).toEqual([]);
    expect(progress.indexedChunks).toBeGreaterThan(0);
    expect(vecDb.getStats().uniqueFilesCount).toBe(2);
    expect(settings.hasCompletedInitialIndexing).toBe(true);
    expect(settings.lastIndexedTime).toBeGreaterThan(0);
    expect(save).toHaveBeenCalled();
  });

  it("skips unchanged notes on a second pass", async () => {
    vault.setFile("a.md", "# Alpha\n\nAlpha body");
    vault.setFile("b.md", "# Beta\n\nBeta body");

    const settings = makeSettings();
    const embedder = makeEmbedder();
    const indexer = new IndexerService(
      vault as never,
      settings,
      embedder as never,
      vecDb
    );

    await indexer.indexVault(false);
    const callsAfterFirst = embedder.getEmbeddingsBatch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await indexer.indexVault(false);
    expect(embedder.getEmbeddingsBatch.mock.calls.length).toBe(callsAfterFirst);
  });

  it("prunes notes that were deleted from the vault", async () => {
    vault.setFile("keep.md", "# Keep\n\nKeep body");
    vault.setFile("drop.md", "# Drop\n\nDrop body");

    const indexer = new IndexerService(
      vault as never,
      makeSettings(),
      makeEmbedder() as never,
      vecDb
    );

    await indexer.indexVault(false);
    expect(vecDb.getStats().uniqueFilesCount).toBe(2);

    vault.deleteFile("drop.md");
    await indexer.indexVault(false);

    expect(vecDb.getStats().uniqueFilesCount).toBe(1);
    expect(vecDb.isFileUpToDate("drop.md", "anything")).toBe(false);
  });

  it("stops early and reports a cancelled run", async () => {
    vault.setFile("a.md", "# Alpha\n\nAlpha body");
    vault.setFile("b.md", "# Beta\n\nBeta body");
    vault.setFile("c.md", "# Gamma\n\nGamma body");

    const settings = makeSettings({ hasCompletedInitialIndexing: false });
    const indexer = new IndexerService(
      vault as never,
      settings,
      makeEmbedder() as never,
      vecDb
    );

    indexer.onProgress((progress) => {
      if (progress.status === "indexing" && progress.currentFile) {
        indexer.cancel();
      }
    });

    const progress = await indexer.indexVault(false);

    expect(progress.status).toBe("cancelled");
    expect(settings.hasCompletedInitialIndexing).toBe(false);
  });

  it("recovers once when the embedding model changes dimension", async () => {
    vault.setFile("a.md", "# Alpha\n\nAlpha body");
    vault.setFile("b.md", "# Beta\n\nBeta body");

    const settings = makeSettings({ dimension: 4 });
    const embedder = makeEmbedder(8);
    const save = vi.fn(async () => undefined);
    const indexer = new IndexerService(
      vault as never,
      settings,
      embedder as never,
      vecDb,
      save
    );

    const progress = await indexer.indexVault(false);

    expect(progress.status).toBe("completed");
    expect(settings.dimension).toBe(8);
    expect(vecDb.getDimension()).toBe(8);
    expect(vecDb.getStats().documentCount).toBeGreaterThan(0);
    expect(embedder.getEmbeddingsBatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(save).toHaveBeenCalled();
  });

  it("ignores excluded folders", async () => {
    vault.setFile("notes/a.md", "# Alpha\n\nAlpha body");
    vault.setFile(".trash/old.md", "# Old\n\nOld body");

    const settings = makeSettings({ excludedFolders: [".trash"] });
    const indexer = new IndexerService(
      vault as never,
      settings,
      makeEmbedder() as never,
      vecDb
    );

    const progress = await indexer.indexVault(false);

    expect(progress.totalFiles).toBe(1);
    expect(vecDb.getStats().uniqueFilesCount).toBe(1);
  });

  it("indexes a single file and skips unchanged ones", async () => {
    const file = vault.setFile("a.md", "# Alpha\n\nAlpha body");
    const indexer = new IndexerService(
      vault as never,
      makeSettings(),
      makeEmbedder() as never,
      vecDb
    );

    expect(await indexer.indexSingleFile(file as never)).toBe(true);
    expect(await indexer.indexSingleFile(file as never)).toBe(false);
    expect(vecDb.getStats().documentCount).toBeGreaterThan(0);
  });

  it("drops index entries when a note or folder is renamed", async () => {
    vault.setFile("projects/plan.md", "# Plan\n\nPlan body");
    const indexer = new IndexerService(
      vault as never,
      makeSettings(),
      makeEmbedder() as never,
      vecDb
    );

    await indexer.indexVault(false);
    const affected = await indexer.handlePathRenamed("projects");

    expect(affected).toBe(1);
    expect(vecDb.getStats().uniqueFilesCount).toBe(0);
  });
});
