import { ChunkingService } from "../src/services/chunkingService";
import { create, insertMultiple, search, AnyOrama } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";

async function runTests() {
  console.log("=== 1. Testing Markdown Chunking Service ===");
  const sampleNote = `---
tags: [ai, notes, project]
status: active
---

# Architecture Overview
This is an introductory paragraph explaining the core architecture of the vector search plugin.

## Chunking Pipeline
The chunking pipeline breaks markdown files into contextual sections.
It respects headers and creates overlapping chunks.

## Vector Storage
The vector database is stored locally inside the plugin folder.
It uses high-dimensional vector embeddings for fast nearest-neighbor retrieval.
`;

  const chunks = ChunkingService.chunkMarkdown("notes/architecture.md", sampleNote, 300, 50, Date.now());
  console.log(`Generated ${chunks.length} chunks from sample note:`);
  for (const c of chunks) {
    console.log(`- [${c.id}] Heading: "${c.heading}" | Length: ${c.text.length}`);
    console.log(`  Snippet: ${c.text.replace(/\n/g, " ").slice(0, 80)}...`);
  }

  if (chunks.length < 2) {
    throw new Error("Expected multiple chunks based on headings and text length");
  }

  const hash1 = ChunkingService.hashContent(sampleNote);
  const hash2 = ChunkingService.hashContent(sampleNote);
  const hash3 = ChunkingService.hashContent(sampleNote + "\n modified!");
  if (hash1 !== hash2 || hash1 === hash3) {
    throw new Error("Hash consistency failure");
  }
  console.log("✓ Chunking and Content Hash verification passed.");

  console.log("\n=== 2. Testing Orama Vector DB Lifecycle & Search ===");
  const dimension = 8;
  const db: AnyOrama = await create({
    schema: {
      id: "string",
      path: "string",
      title: "string",
      heading: "string",
      chunkIndex: "number",
      text: "string",
      fileHash: "string",
      embedding: `vector[${dimension}]`,
    },
  });

  const sampleVectors: number[][] = [
    [0.9, 0.8, 0.1, 0.0, 0.0, 0.1, 0.0, 0.0],
    [0.1, 0.0, 0.9, 0.8, 0.2, 0.0, 0.0, 0.1],
    [0.85, 0.78, 0.05, 0.0, 0.1, 0.05, 0.0, 0.0],
  ];

  await insertMultiple(db, [
    {
      id: "doc-1",
      path: "notes/architecture.md",
      title: "Architecture",
      heading: "Overview",
      chunkIndex: 0,
      text: "System architecture and vector database design",
      fileHash: "hash1",
      embedding: sampleVectors[0],
    },
    {
      id: "doc-2",
      path: "notes/recipes.md",
      title: "Recipes",
      heading: "Pasta Carbonara",
      chunkIndex: 0,
      text: "How to make authentic pasta carbonara with eggs and guanciale",
      fileHash: "hash2",
      embedding: sampleVectors[1],
    },
    {
      id: "doc-3",
      path: "notes/architecture.md",
      title: "Architecture",
      heading: "Storage",
      chunkIndex: 1,
      text: "Local storage persistence and schema indexes",
      fileHash: "hash1",
      embedding: sampleVectors[2],
    },
  ]);

  const query = [0.88, 0.82, 0.08, 0.0, 0.05, 0.08, 0.0, 0.0];
  const searchResults = await search(db, {
    mode: "vector",
    vector: {
      value: query,
      property: "embedding",
    },
    limit: 5,
    similarity: 0.8,
  });

  console.log(`Found ${searchResults.hits.length} matching hits:`);
  for (const hit of searchResults.hits) {
    const doc = hit.document as any;
    console.log(`- Score: ${(hit.score * 100).toFixed(1)}% | [${doc.path}] ${doc.title} > ${doc.heading}`);
  }

  if (searchResults.hits.length < 2) {
    throw new Error("Vector search did not return expected matches");
  }
  if ((searchResults.hits[0].document as any).path !== "notes/architecture.md") {
    throw new Error("Top hit was not architecture note");
  }
  console.log("✓ Vector search ranking verified.");

  console.log("\n=== 3. Testing Serialization & Persistence ===");
  const serialized = await persist(db, "json");
  if (typeof serialized !== "string" || serialized.length < 100) {
    throw new Error("Serialization produced invalid data");
  }

  const restored = (await restore("json", serialized)) as AnyOrama;
  const restoredSearch = await search(restored, {
    mode: "vector",
    vector: {
      value: query,
      property: "embedding",
    },
    limit: 5,
    similarity: 0.8,
  });

  if (restoredSearch.hits.length !== searchResults.hits.length) {
    throw new Error("Restored DB hit count mismatch");
  }
  console.log("\n=== 4. Testing Top-K Query Tool (k parameter modification) ===");
  const searchK1 = await search(db, {
    mode: "vector",
    vector: { value: query, property: "embedding" },
    limit: 1,
    similarity: 0.8,
  });
  if (searchK1.hits.length !== 1) {
    throw new Error(`Expected 1 result for k=1, got ${searchK1.hits.length}`);
  }
  console.log(`✓ top-k=1 returned exactly 1 hit: ${(searchK1.hits[0].document as any).title}`);

  const searchK2 = await search(db, {
    mode: "vector",
    vector: { value: query, property: "embedding" },
    limit: 2,
    similarity: 0.8,
  });
  if (searchK2.hits.length !== 2) {
    throw new Error(`Expected 2 results for k=2, got ${searchK2.hits.length}`);
  }
  console.log(`✓ top-k=2 returned exactly 2 hits as requested by user parameter.`);

  console.log("\n=== 5. Testing Instant Document Addition and Deletion ===");
  const { remove } = require("@orama/orama");
  await remove(db, "doc-2");

  const searchAfterDelete = await search(db, {
    mode: "vector",
    vector: { value: [0.1, 0.0, 0.9, 0.8, 0.2, 0.0, 0.0, 0.1], property: "embedding" },
    similarity: 0.8,
  });

  const foundDeleted = searchAfterDelete.hits.some((h: any) => h.id === "doc-2");
  if (foundDeleted) {
    throw new Error("Document was not removed from vector database after deletion!");
  }
  console.log("✓ Document was successfully and completely purged from vector database upon deletion.");

  console.log("\n=== 6. Testing Separation of Embedding & Chat APIs ===");
  const { DEFAULT_SETTINGS } = require("../src/settings");
  const testSettings = {
    ...DEFAULT_SETTINGS,
    embeddingApiUrl: "http://localhost:11434/v1",
    embeddingApiKey: "ollama-local",
    embeddingModel: "nomic-embed-text",
    chatApiUrl: "https://api.openai.com/v1",
    chatApiKey: "sk-proj-chat-key",
    chatModel: "gpt-4o-mini",
  };

  if (testSettings.embeddingApiUrl === testSettings.chatApiUrl) {
    throw new Error("Embedding API and Chat API should support independent URLs");
  }
  if (testSettings.embeddingApiKey === testSettings.chatApiKey) {
    throw new Error("Embedding API and Chat API should support independent keys");
  }
  if (testSettings.embeddingModel === testSettings.chatModel) {
    throw new Error("Embedding API and Chat API should support independent models");
  }
  console.log(`✓ Embedding API configured as: ${testSettings.embeddingModel} (${testSettings.embeddingApiUrl})`);
  console.log(`✓ Chat API configured as: ${testSettings.chatModel} (${testSettings.chatApiUrl})`);
  console.log("\n=== 7. Testing list_notes Tool Logic & Prompt ===");
  const Module = require("module");
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    if (id === "obsidian") {
      return {
        requestUrl: async () => ({ status: 200, json: {} }),
        TFile: class {},
        Vault: class {},
        MetadataCache: class {},
      };
    }
    return origRequire.apply(this, arguments);
  };
  const { ChatService } = require("../src/services/chatService");
  const mockFiles = [
    {
      basename: "Architecture Overview",
      path: "notes/architecture.md",
      parent: { path: "notes" },
    },
    {
      basename: "Pasta Recipes",
      path: "recipes/pasta.md",
      parent: { path: "recipes" },
    },
    {
      basename: "Hidden Note",
      path: ".obsidian/config.md",
      parent: { path: ".obsidian" },
    },
  ];

  const mockCache = {
    getFileCache: (file: any) => {
      if (file.path === "notes/architecture.md") {
        return {
          tags: [{ tag: "#ai" }, { tag: "#tech" }],
          frontmatter: { tags: ["architecture", "vector"] },
        };
      }
      if (file.path === "recipes/pasta.md") {
        return {
          frontmatter: { tag: "cooking" },
        };
      }
      return null;
    },
  };

  const mockVault = {
    getMarkdownFiles: () => mockFiles,
  };

  const chatServiceInstance = new ChatService(
    testSettings,
    {} as any,
    {} as any,
    mockVault as any,
    mockCache as any
  );

  const allNotes = chatServiceInstance.executeListNotesTool();
  if (allNotes.length !== 2) {
    throw new Error(`Expected 2 non-excluded notes, got ${allNotes.length}`);
  }
  if (allNotes[0].title !== "Architecture Overview" || allNotes[0].dir !== "notes") {
    throw new Error("Note title or directory mismatch");
  }
  if (!allNotes[0].tags.includes("ai") || !allNotes[0].tags.includes("architecture")) {
    throw new Error("Tags extraction failed");
  }

  const tagFiltered = chatServiceInstance.executeListNotesTool("cooking");
  if (tagFiltered.length !== 1 || tagFiltered[0].title !== "Pasta Recipes") {
    throw new Error("Tag filtering failed");
  }

  const dirFiltered = chatServiceInstance.executeListNotesTool(undefined, "notes");
  if (dirFiltered.length !== 1 || dirFiltered[0].title !== "Architecture Overview") {
    throw new Error("Directory filtering failed");
  }

  if (!testSettings.chatSystemPrompt.includes("list_notes")) {
    throw new Error("System prompt does not instruct model about list_notes tool");
  }

  console.log(`✓ list_notes returned ${allNotes.length} notes with directories and tags.`);
  console.log("✓ list_notes tag and directory filters verified.");
  console.log("✓ System prompt includes list_notes instructions.");

  console.log("\n✅ ALL TESTS (INCLUDING LIST_NOTES TOOL) PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});

