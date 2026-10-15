import { describe, expect, it } from "vitest";
import { ChunkingService } from "../src/services/chunkingService";

const sample = `---
tags: [ai, notes]
status: active
---

# Architecture

The indexer turns each markdown note into overlapping chunks.

## Chunking

Chunks keep the heading trail so an excerpt stays understandable on its own.

\`\`\`ts
# this is a comment inside a fence, not a heading
const value = 1;
\`\`\`

# Storage

Vectors are persisted inside the plugin folder.
`;

describe("ChunkingService", () => {
  it("hashes content deterministically and detects changes", () => {
    const hash = ChunkingService.hashContent("hello");
    expect(ChunkingService.hashContent("hello")).toBe(hash);
    expect(ChunkingService.hashContent("hello!")).not.toBe(hash);
  });

  it("removes only a leading frontmatter block", () => {
    const body = ChunkingService.stripFrontmatter(sample);
    expect(body).not.toContain("status: active");
    expect(body.trimStart().startsWith("# Architecture")).toBe(true);

    const inline = "Text\n\n---\n\nMore text";
    expect(ChunkingService.stripFrontmatter(inline)).toBe(inline);
  });

  it("keeps heading breadcrumbs and ignores headings inside fences", () => {
    const chunks = ChunkingService.chunkMarkdown("notes/arch.md", sample, 400, 50, 1);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.path === "notes/arch.md")).toBe(true);
    expect(chunks.every((chunk) => chunk.title === "arch")).toBe(true);

    const headings = chunks.map((chunk) => chunk.heading);
    expect(headings).toContain("Architecture");
    expect(headings).toContain("Architecture › Chunking");
    expect(headings).toContain("Storage");
    expect(headings).not.toContain("this is a comment inside a fence, not a heading");

    expect(chunks[0].text.startsWith("[arch › Architecture]")).toBe(true);
    expect(chunks[0].id).toBe("notes/arch.md#chunk-0");
    expect(chunks[0].totalChunks).toBe(chunks.length);
  });

  it("returns no chunks for empty notes and frontmatter-only files", () => {
    expect(ChunkingService.chunkMarkdown("a.md", "", 400, 50, 1)).toEqual([]);
    expect(ChunkingService.chunkMarkdown("a.md", "   \n\n ", 400, 50, 1)).toEqual([]);
    expect(ChunkingService.chunkMarkdown("a.md", "---\ntags: x\n---\n", 400, 50, 1)).toEqual([]);
  });

  it("clamps tiny chunk sizes instead of creating one chunk per word", () => {
    const text = "word ".repeat(120).trim();
    const chunks = ChunkingService.chunkMarkdown("a.md", text, 10, 0, 1);
    expect(chunks.length).toBeLessThan(10);
  });

  it("terminates when overlap is larger than the chunk size", () => {
    const text = "x".repeat(500);
    const chunks = ChunkingService.chunkMarkdown("a.md", text, 100, 1000, 1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
  });

  it("splits oversized paragraphs into bounded pieces", () => {
    const paragraph = "abcdefghij".repeat(50);
    const chunks = ChunkingService.chunkMarkdown("a.md", paragraph, 120, 20, 1);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const body = chunk.text.split("\n").slice(1).join("\n");
      expect(body.length).toBeLessThanOrEqual(120);
    }
  });
});
