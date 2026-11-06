/**
 * Retrieval quality evaluation for Cypher's chunking + embedding pipeline.
 *
 * This runs outside Obsidian. It walks a vault, chunks every markdown note with
 * the same `ChunkingService` the plugin uses, embeds the chunks through an
 * OpenAI-compatible endpoint, and scores semantic search against a query set.
 *
 * Usage:
 *   npm run eval:retrieval -- --vault /path/to/vault --queries eval-queries.json
 *
 * Required environment:
 *   CYPHER_EMBEDDING_URL    e.g. http://localhost:11434/v1
 *   CYPHER_EMBEDDING_MODEL  e.g. nomic-embed-text
 *   CYPHER_EMBEDDING_KEY    optional
 *
 * Query file format:
 *   [{ "query": "how does chunking work", "relevant": ["notes/architecture.md"] }]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChunkingService } from "../src/services/chunkingService";

interface QueryCase {
  query: string;
  relevant: string[];
}

interface Chunk {
  path: string;
  text: string;
  vector: number[];
}

interface QueryResult {
  query: string;
  relevant: string[];
  ranked: string[];
  hit: boolean;
  reciprocalRank: number;
}

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : "true";
    if (value !== "true") index++;
    args.set(key, value);
  }

  return args;
}

function usage(): never {
  console.error(
    [
      "Usage: npm run eval:retrieval -- --vault <path> --queries <file> [options]",
      "",
      "Options:",
      "  --k <number>          results per query (default 5)",
      "  --chunk-size <n>      characters per chunk (default 800)",
      "  --overlap <n>         overlap between chunks (default 150)",
      "  --batch-size <n>      chunks per embedding request (default 32)",
      "  --json                print machine-readable results",
      "",
      "Environment: CYPHER_EMBEDDING_URL, CYPHER_EMBEDDING_MODEL, CYPHER_EMBEDDING_KEY",
    ].join("\n")
  );
  process.exit(1);
}

function walkMarkdown(root: string): string[] {
  const found: string[] = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          visit(join(directory, entry.name));
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(join(directory, entry.name));
      }
    }
  };

  visit(root);
  return found;
}

function relativePath(root: string, absolute: string): string {
  return absolute.slice(root.length + 1).split("\\").join("/");
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/embeddings$/, "");
}

async function embed(
  url: string,
  model: string,
  key: string,
  inputs: string[]
): Promise<number[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;

  const response = await fetch(`${normalizeBaseUrl(url)}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: inputs }),
  });

  if (!response.ok) {
    throw new Error(
      `Embedding request failed (HTTP ${response.status}): ${await response.text()}`
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };

  if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
    throw new Error(
      `Expected ${inputs.length} vectors, received ${payload.data?.length ?? 0}`
    );
  }

  return [...payload.data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
        throw new Error("The embedding endpoint returned a malformed vector");
      }
      return item.embedding;
    });
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector size mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesPath(candidate: string, relevant: string): boolean {
  const clean = relevant.replace(/^\.?\//, "");
  return candidate === clean || candidate.endsWith(`/${clean}`);
}

function rank(
  chunks: Chunk[],
  queryVector: number[],
  relevant: string[],
  k: number
): QueryResult {
  const bestPerPath = new Map<string, number>();

  for (const chunk of chunks) {
    const score = cosine(queryVector, chunk.vector);
    const current = bestPerPath.get(chunk.path);
    if (current === undefined || score > current) {
      bestPerPath.set(chunk.path, score);
    }
  }

  const ranked = [...bestPerPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([path]) => path);

  const firstRelevant = ranked.findIndex((path) =>
    relevant.some((expected) => matchesPath(path, expected))
  );

  return {
    query: "",
    relevant,
    ranked,
    hit: firstRelevant >= 0,
    reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vault = resolve(args.get("vault") ?? process.env.CYPHER_VAULT ?? "");
  const queriesPath = resolve(
    args.get("queries") ?? process.env.CYPHER_EVAL_QUERIES ?? "eval-queries.json"
  );

  if (!args.has("vault") && !process.env.CYPHER_VAULT) usage();
  if (!statSync(vault, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Vault not found: ${vault}`);
  }

  const url = args.get("url") ?? process.env.CYPHER_EMBEDDING_URL ?? "";
  const model = args.get("model") ?? process.env.CYPHER_EMBEDDING_MODEL ?? "";
  const key = args.get("key") ?? process.env.CYPHER_EMBEDDING_KEY ?? "";

  if (!url || !model) {
    throw new Error(
      "Set CYPHER_EMBEDDING_URL and CYPHER_EMBEDDING_MODEL (or pass --url/--model)."
    );
  }

  const k = Number.parseInt(args.get("k") ?? "5", 10);
  const chunkSize = Number.parseInt(args.get("chunk-size") ?? "800", 10);
  const overlap = Number.parseInt(args.get("overlap") ?? "150", 10);
  const batchSize = Math.max(1, Number.parseInt(args.get("batch-size") ?? "32", 10));

  const cases = JSON.parse(readFileSync(queriesPath, "utf8")) as QueryCase[];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`No queries found in ${queriesPath}`);
  }

  const files = walkMarkdown(vault);
  if (files.length === 0) {
    throw new Error(`No markdown notes found under ${vault}`);
  }

  const chunks: Chunk[] = [];
  for (const absolute of files) {
    const path = relativePath(vault, absolute);
    const content = readFileSync(absolute, "utf8");
    for (const piece of ChunkingService.chunkMarkdown(
      path,
      content,
      chunkSize,
      overlap,
      statSync(absolute).mtimeMs
    )) {
      chunks.push({ path: piece.path, text: piece.text, vector: [] });
    }
  }

  console.error(`Indexing ${chunks.length} chunks from ${files.length} notes...`);

  for (let index = 0; index < chunks.length; index += batchSize) {
    const batch = chunks.slice(index, index + batchSize);
    const vectors = await embed(
      url,
      model,
      key,
      batch.map((chunk) => chunk.text)
    );

    vectors.forEach((vector, offset) => {
      batch[offset].vector = vector;
    });
  }

  const results: QueryResult[] = [];
  for (const testCase of cases) {
    const [queryVector] = await embed(url, model, key, [testCase.query]);
    const result = rank(chunks, queryVector, testCase.relevant, k);
    results.push({ ...result, query: testCase.query });
  }

  const hitRate = results.filter((result) => result.hit).length / results.length;
  const mrr = results.reduce((sum, result) => sum + result.reciprocalRank, 0) / results.length;

  if (args.has("json")) {
    console.log(
      JSON.stringify(
        {
          notes: files.length,
          chunks: chunks.length,
          queries: results.length,
          k,
          hitRate: Number(hitRate.toFixed(4)),
          mrr: Number(mrr.toFixed(4)),
          results,
        },
        null,
        2
      )
    );
    return;
  }

  console.log("");
  console.log(`Notes: ${files.length}   Chunks: ${chunks.length}   Queries: ${results.length}   K: ${k}`);
  console.log(`Hit rate@${k}: ${(hitRate * 100).toFixed(1)}%`);
  console.log(`MRR@${k}:       ${mrr.toFixed(3)}`);
  console.log("");

  for (const result of results) {
    const mark = result.hit ? "hit " : "miss";
    console.log(`[${mark}] ${result.query}`);
    console.log(`  expected: ${result.relevant.join(", ") || "(none)"}`);
    console.log(`  ranked:   ${result.ranked.slice(0, k).join(", ") || "(no results)"}`);
  }
}

main().catch((error) => {
  console.error(`\nEvaluation failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
