import { ChunkMetadata } from "../types";

export class ChunkingService {
  public static hashContent(content: string): string {
    let h = 2166136261;
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  private static parseFrontmatter(md: string): { body: string; frontmatter: string } {
    const trimmed = md.trim();
    if (!trimmed.startsWith("---")) {
      return { body: md, frontmatter: "" };
    }

    const end = trimmed.indexOf("---", 3);
    if (end === -1) {
      return { body: md, frontmatter: "" };
    }

    const frontmatter = trimmed.slice(3, end).trim();
    const body = trimmed.slice(end + 3).trim();
    return { body, frontmatter };
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

    const { body } = this.parseFrontmatter(content);
    if (!body || body.trim().length === 0) {
      return [];
    }

    const lines = body.split("\n");
    const sections: { heading: string; lines: string[] }[] = [];

    let curHeading = "";
    let curLines: string[] = [];

    for (const line of lines) {
      const match = line.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        if (curLines.length > 0) {
          sections.push({ heading: curHeading, lines: curLines });
          curLines = [];
        }
        curHeading = match[2].trim();
      } else {
        curLines.push(line);
      }
    }

    if (curLines.length > 0) {
      sections.push({ heading: curHeading, lines: curLines });
    }

    const rawChunks: { heading: string; text: string }[] = [];

    for (const sec of sections) {
      const secText = sec.lines.join("\n").trim();
      if (!secText) continue;

      if (secText.length <= size) {
        rawChunks.push({ heading: sec.heading, text: secText });
      } else {
        const paras = secText.split(/\n\s*\n/);
        let curChunk = "";

        for (const p of paras) {
          const trimmedP = p.trim();
          if (!trimmedP) continue;

          if (curChunk.length + trimmedP.length + 2 <= size) {
            curChunk = curChunk ? `${curChunk}\n\n${trimmedP}` : trimmedP;
          } else {
            if (curChunk) {
              rawChunks.push({ heading: sec.heading, text: curChunk });
            }

            if (trimmedP.length > size) {
              let start = 0;
              while (start < trimmedP.length) {
                const end = Math.min(start + size, trimmedP.length);
                const slice = trimmedP.slice(start, end).trim();
                if (slice) {
                  rawChunks.push({ heading: sec.heading, text: slice });
                }
                start += size - overlap;
              }
              curChunk = "";
            } else {
              curChunk = trimmedP;
            }
          }
        }

        if (curChunk) {
          rawChunks.push({ heading: sec.heading, text: curChunk });
        }
      }
    }

    if (rawChunks.length === 0 && body.trim().length > 0) {
      rawChunks.push({ heading: "", text: body.trim().slice(0, size) });
    }

    const total = rawChunks.length;
    return rawChunks.map((chunk, idx) => {
      const prefix = chunk.heading ? `[Note: ${title} | ${chunk.heading}]\n` : `[Note: ${title}]\n`;

      return {
        id: `${path}#chunk-${idx}`,
        path,
        title,
        heading: chunk.heading,
        chunkIndex: idx,
        totalChunks: total,
        text: `${prefix}${chunk.text}`,
        fileHash,
        mtime,
      };
    });
  }
}
