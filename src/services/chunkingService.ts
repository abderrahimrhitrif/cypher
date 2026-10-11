import { ChunkMetadata } from "../types";

export class ChunkingService {
  /**
   * Fast 32-bit FNV-1a hash implementation for checking if note contents have changed.
   */
  public static hashContent(content: string): string {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) {
      hash ^= content.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Extracts frontmatter metadata and cleans body.
   */
  private static parseFrontmatter(markdown: string): { body: string; frontmatter: string } {
    const trimmed = markdown.trim();
    if (!trimmed.startsWith("---")) {
      return { body: markdown, frontmatter: "" };
    }

    const endIdx = trimmed.indexOf("---", 3);
    if (endIdx === -1) {
      return { body: markdown, frontmatter: "" };
    }

    const frontmatter = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 3).trim();
    return { body, frontmatter };
  }

  /**
   * Chunks a markdown note into semantically meaningful pieces.
   */
  public static chunkMarkdown(
    path: string,
    content: string,
    chunkSize: number,
    chunkOverlap: number,
    mtime: number
  ): ChunkMetadata[] {
    const fileHash = this.hashContent(content);
    const fileName = path.split("/").pop() ?? path;
    const title = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

    const { body } = this.parseFrontmatter(content);
    if (!body || body.trim().length === 0) {
      return [];
    }

    // Split markdown by headings or section blocks
    const lines = body.split("\n");
    const sections: { heading: string; lines: string[] }[] = [];

    let currentHeading = "";
    let currentLines: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (currentLines.length > 0) {
          sections.push({ heading: currentHeading, lines: currentLines });
          currentLines = [];
        }
        currentHeading = headingMatch[2].trim();
      } else {
        currentLines.push(line);
      }
    }

    if (currentLines.length > 0) {
      sections.push({ heading: currentHeading, lines: currentLines });
    }

    // Now subdivide sections into chunks respecting chunkSize and overlap
    const rawChunks: { heading: string; text: string }[] = [];

    for (const section of sections) {
      const sectionText = section.lines.join("\n").trim();
      if (!sectionText) continue;

      if (sectionText.length <= chunkSize) {
        rawChunks.push({
          heading: section.heading,
          text: sectionText,
        });
      } else {
        // Split section text by paragraphs
        const paragraphs = sectionText.split(/\n\s*\n/);
        let currentChunk = "";

        for (const p of paragraphs) {
          const trimmedP = p.trim();
          if (!trimmedP) continue;

          if (currentChunk.length + trimmedP.length + 2 <= chunkSize) {
            currentChunk = currentChunk ? `${currentChunk}\n\n${trimmedP}` : trimmedP;
          } else {
            if (currentChunk) {
              rawChunks.push({ heading: section.heading, text: currentChunk });
            }

            // If a single paragraph is longer than chunkSize, split it by sentences or characters
            if (trimmedP.length > chunkSize) {
              let start = 0;
              while (start < trimmedP.length) {
                const end = Math.min(start + chunkSize, trimmedP.length);
                const chunkSlice = trimmedP.slice(start, end).trim();
                if (chunkSlice) {
                  rawChunks.push({ heading: section.heading, text: chunkSlice });
                }
                start += chunkSize - chunkOverlap;
              }
              currentChunk = "";
            } else {
              currentChunk = trimmedP;
            }
          }
        }

        if (currentChunk) {
          rawChunks.push({ heading: section.heading, text: currentChunk });
        }
      }
    }

    // In case no chunks were produced (e.g. only headings)
    if (rawChunks.length === 0 && body.trim().length > 0) {
      rawChunks.push({ heading: "", text: body.trim().slice(0, chunkSize) });
    }

    // Format final chunk metadata
    const totalChunks = rawChunks.length;
    return rawChunks.map((chunk, idx) => {
      // Build a contextual prefix (note title and heading)
      const contextPrefix = chunk.heading
        ? `[Note: ${title} | ${chunk.heading}]\n`
        : `[Note: ${title}]\n`;

      return {
        id: `${path}#chunk-${idx}`,
        path,
        title,
        heading: chunk.heading,
        chunkIndex: idx,
        totalChunks,
        text: `${contextPrefix}${chunk.text}`,
        fileHash,
        mtime,
      };
    });
  }
}
