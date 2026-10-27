# Cypher — Local-first RAG & AI Agents for Obsidian

## Overview
Cypher is a local-first Retrieval-Augmented Generation (RAG) and semantic vector search plugin for Obsidian. It indexes Markdown vaults locally into an embedded vector database, performs semantic searches, and provides context-grounded AI chat via OpenAI-compatible APIs with full tool calling support.

## Architecture & Pipeline
1. **Ingestion Pipeline**: Scans vault Markdown notes, parses frontmatter, splits documents by headings and paragraphs, injects contextual headers, and runs FNV-1a hashing for change detection.
2. **Embedding & Vector DB**: Batches text chunks, fetches embeddings with exponential backoff, and stores vectors in an in-memory Orama vector database with disk persistence (`orama_db.json`, `index_meta.json`).
3. **Retrieval & Chat**: Handles user messages, triggers semantic Top-K retrieval via `query_vault` tool calls, appends grounded context, and persists conversations in IndexedDB.

## Data
- **Source**: Local Markdown notes within an Obsidian vault.

## Method & Algorithms
- **Structure-Aware Chunking**: Hierarchical splitting by markdown headers (`#` to `######`) and paragraph boundaries with configurable character size and overlap.
- **Change Detection**: Fast 32-bit FNV-1a hashing to skip unchanged files on re-indexing runs.
- **Vector Search**: Cosine similarity vector search via Orama database.

## Verified Results & Metrics
- Fully tested ingestion, FNV-1a hashing, Orama vector lifecycle, serialization, top-K search filtering, tool calling (`query_vault`, `list_notes`), and IndexedDB conversation storage.

## Limitations & Caveats
- Personal productivity and knowledge management plugin; not a multi-tenant enterprise search engine.

## Run Instructions
```bash
npm install
npm test
npm run build
```

## Claims to Avoid
- Do not claim commercial SaaS product deployment or multi-tenant cloud hosting.
