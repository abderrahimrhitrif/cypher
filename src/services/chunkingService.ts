import { ChunkMetadata } from "../types";
import { clamp } from "../utils";

interface Section {
  /** Breadcrumb of the enclosing markdown headings, outermost first. */
  headingPath: string;
  text: string;
}

/** Hard limits that keep a misconfigured vault from freezing the app. */
const MIN_CHUNK_SIZE = 100;
const MAX_CHUNK_SIZE = 8000;
const MAX_OVERLAP_RATIO = 0.9;

export class ChunkingService {
  /** FNV-1a, 32-bit. Fast content fingerprint used for change detection. */
  public static hashContent(content: string): string {
    let h = 2166136261;
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /**
   * Removes a leading YAML block. Only a fence that starts the file and closes
   * on its own line counts, so `---` inside a document body is left untouched.
   */
  public static stripFrontmatter(markdown: string): string {
    const match = markdown.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return markdown;
    return markdown.slice(match[0].length);
  }

  public static chunkMarkdown(
    path: string,
    content: string,
    size: number,
    overlap: number,
    mtime: number
  ): ChunkMetadata[] {
    const fileHash = this.hashContent(content);
    const fileName = path.split("/").pop() ?? path;
    const title = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;

    const body = this.stripFrontmatter(content);
    if (!body.trim()) return [];

    const safeSize = clamp(Math.round(size), MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
    const safeOverlap = clamp(Math.round(overlap), 0, Math.floor(safeSize * MAX_OVERLAP_RATIO));

    const texts: { headingPath: string; text: string }[] = [];
    for (const section of this.splitSections(body)) {
      for (const text of this.splitText(section.text, safeSize, safeOverlap)) {
        texts.push({ headingPath: section.headingPath, text });
      }
    }

    if (texts.length === 0) {
      const fallback = body.trim().slice(0, safeSize);
      if (!fallback) return [];
      texts.push({ headingPath: "", text: fallback });
    }

    return texts.map((chunk, index) => {
      const context = chunk.headingPath ? `${title} › ${chunk.headingPath}` : title;
      return {
        id: `${path}#chunk-${index}`,
        path,
        title,
        heading: chunk.headingPath,
        chunkIndex: index,
        totalChunks: texts.length,
        text: `[${context}]\n${chunk.text}`,
        fileHash,
        mtime,
      };
    });
  }

  /**
   * Splits markdown into heading-scoped sections while ignoring `#` lines inside
   * fenced code blocks. Nested headings keep their parent trail as context.
   */
  private static splitSections(markdown: string): Section[] {
    const lines = markdown.split("\n");
    const sections: Section[] = [];
    const headingStack: string[] = [];

    let currentHeading = "";
    let currentLines: string[] = [];
    let fence: string | null = null;

    const flush = () => {
      const text = currentLines.join("\n").trim();
      if (text) {
        sections.push({ headingPath: currentHeading, text });
      }
      currentLines = [];
    };

    for (const line of lines) {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        currentLines.push(line);
        continue;
      }

      if (fenceMatch) {
        fence = fenceMatch[1];
        currentLines.push(line);
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        headingStack.length = Math.min(headingStack.length, level - 1);
        headingStack.push(headingMatch[2].trim());
        currentHeading = headingStack.join(" › ");
        continue;
      }

      currentLines.push(line);
    }

    flush();
    return sections;
  }

  /** Packs paragraphs up to `size` characters and carries an overlap tail over. */
  private static splitText(text: string, size: number, overlap: number): string[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);

    const chunks: string[] = [];
    let current = "";

    for (const paragraph of paragraphs) {
      if (paragraph.length >= size) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(...this.hardSplit(paragraph, size, overlap));
        continue;
      }

      if (!current) {
        current = paragraph;
        continue;
      }

      if (current.length + 2 + paragraph.length <= size) {
        current = `${current}\n\n${paragraph}`;
        continue;
      }

      chunks.push(current);
      const budget = size - paragraph.length - 2;
      const tail = budget > 0 ? this.overlapTail(current, Math.min(overlap, budget)) : "";
      current = tail ? `${tail}\n\n${paragraph}` : paragraph;
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.filter((chunk) => chunk.trim().length > 0);
  }

  /**
   * Splits a single oversized paragraph. The step is clamped to at least one
   * character so `overlap >= size` can never produce an infinite loop.
   */
  private static hardSplit(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    const step = Math.max(1, size - overlap);
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + size, text.length);

      if (end < text.length) {
        const windowStart = start + Math.floor(size * 0.6);
        const boundary = text.lastIndexOf(" ", end);
        if (boundary > windowStart) {
          end = boundary;
        }
      }

      const piece = text.slice(start, end).trim();
      if (piece) chunks.push(piece);
      if (end >= text.length) break;
      start += step;
    }

    return chunks;
  }

  /** Last `max` characters of a chunk, trimmed to a word boundary. */
  private static overlapTail(text: string, max: number): string {
    if (max <= 0) return "";
    const tail = text.slice(-max);
    const space = tail.indexOf(" ");
    const trimmed = space >= 0 ? tail.slice(space + 1) : tail;
    return trimmed.trim();
  }
}
