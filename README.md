# Cypher

Vault-grounded chat and semantic search for Obsidian. Cypher indexes your Markdown notes with an OpenAI-compatible embedding model, stores the vectors inside the vault, and lets a chat model answer questions by calling retrieval tools instead of relying on its training data.

Works with local runtimes (Ollama, LM Studio) and hosted providers (OpenAI, OpenRouter). Embedding and chat endpoints are configured independently, so you can embed locally and chat remotely, or the other way around.

## Features

- **Semantic search** over the whole vault, with a command and a modal.
- **Chat that cites your notes.** The model can call `query_vault`, `list_notes`, and `read_note`, and is instructed to answer only from the returned content.
- **Incremental indexing.** A 32-bit content hash per note skips unchanged files. Vault create/modify/delete/rename events keep the index current.
- **Local persistence.** Vectors live in `<vault>/.obsidian/plugins/cypher/orama_db.json`; conversations live in IndexedDB.
- **Streaming responses** over SSE, with a buffered fallback for providers that do not support streaming, plus a Stop button.
- **Model switching handled safely.** The embedding dimension is detected and cached; a model change discards the stale index instead of producing dimension errors.
- **Conversation history** with rename, delete, regenerate, edit-and-resubmit, and copy.

## How it works

```
Markdown note
   │
   ├─ strip leading YAML frontmatter
   ├─ split into sections at ATX headings (# … ######), ignoring fences
   ├─ pack paragraphs into ~800-char chunks with overlap
   ├─ prefix each chunk with "[title › heading path]"
   ├─ hash the raw note with FNV-1a and skip unchanged files
   └─ embed in batches → Orama vector index → JSON on disk

User question
   │
   ├─ chat model chooses a tool
   │    ├─ query_vault → embed question → vector search → top-K excerpts
   │    ├─ list_notes  → filter vault notes by tag/folder
   │    └─ read_note   → read one note in full (capped at 12k chars)
   ├─ tool output is appended to the conversation
   └─ model produces a grounded answer with [[wikilinks]]
```

The chat loop allows up to four tool rounds. If the model asks for another tool after that, it gets one final round without tools so the request always ends with an answer.

## Installation

### Manual

1. Build the plugin (see [Development](#development)) or download a release.
2. Copy `main.js`, `manifest.json`, and `styles.css` into:
   ```
   <vault>/.obsidian/plugins/cypher/
   ```
3. Reload Obsidian and enable **Cypher** under **Settings → Community plugins**.

### First run

The setup wizard opens when the vault has no index. Enter an embedding endpoint, optionally test it, then index the vault. Chat settings can reuse the same endpoint, but the chat model must support OpenAI-style tool calling.

## Configuration

Settings live under **Obsidian Settings → Cypher**.

### Embeddings

| Setting | Default | Notes |
|---|---|---|
| API base URL | `https://api.openai.com/v1` | Any OpenAI-compatible `/embeddings` endpoint |
| API key | empty | Optional for local servers |
| Model | `text-embedding-3-small` | e.g. `nomic-embed-text`, `bge-m3` |
| Dimensions | `1536` | Detected from the endpoint; a change triggers a rebuild prompt |

### Chat

| Setting | Default | Notes |
|---|---|---|
| API base URL | `https://api.openai.com/v1` | Endpoint for `/chat/completions` |
| API key | empty | Optional for local servers |
| Model | `gpt-4o-mini` | Must support tool calling |
| Search results per query | `5` | Top-K passed to `query_vault` |
| Minimum similarity | `0.25` | Chunks below this score are ignored |
| Temperature | `0.7` | 0 is deterministic |
| Max response tokens | `1024` | Per model reply |
| System prompt | built-in | Editable; **Reset** restores the default |

### Indexing

| Setting | Default | Notes |
|---|---|---|
| Chunk size | `800` | Characters; clamped to 100–8000 |
| Chunk overlap | `150` | Clamped below the chunk size |
| Batch size | `20` | Chunks per embedding request |
| Excluded folders | `.obsidian, .trash` | Comma-separated |
| Index on save | `true` | One-second debounce after edits |

API keys are stored in the plugin's `data.json` in plain text, which is how Obsidian plugins normally persist secrets. Use a local endpoint if that is not acceptable.

## Providers

Cypher only requires OpenAI-compatible HTTP endpoints. These combinations are known to work:

| Provider | Embeddings | Chat |
|---|---|---|
| **Ollama** (local) | `nomic-embed-text` (768) | `qwen2.5:3b`, `qwen2.5:7b`, `llama3.2` |
| **LM Studio** (local) | `text-embedding-nomic-embed-text-v1.5` (768) | `qwen2.5-7b-instruct` |
| **OpenAI** | `text-embedding-3-small` (1536) | `gpt-4o-mini` |
| **OpenRouter** | `openai/text-embedding-3-small` (1536) | `anthropic/claude-3.5-sonnet` |

Small models with weak tool-calling support may ignore the retrieval tools or invent citations. For grounded answers, prefer a model that reliably emits tool calls.

## Commands and UI

| Command | Description |
|---|---|
| `Cypher: Open chat` | Open the chat sidebar |
| `Cypher: Semantic search` | Search without starting a chat |
| `Cypher: Update index (incremental)` | Embed new and modified notes only |
| `Cypher: Rebuild index` | Re-embed every note |
| `Cypher: Cancel running index` | Stop an in-progress run |
| `Cypher: Run setup wizard` | Reopen the onboarding modal |

The status bar shows the indexed note count, or live progress while indexing.

## Reliability details

- **Change detection** uses FNV-1a over the raw note, not the mtime, so touching a file does not trigger a re-embed.
- **Embedding retries** cover HTTP 408, 409, 425, 429, and 5xx responses with exponential backoff and jitter. Authentication and not-found errors fail immediately.
- **Dimension mismatch** is validated before an upsert deletes existing chunks. If the model changes mid-index, the indexer clears the old index once, updates the cached dimension, and retries the pass.
- **Index writes** are serialized and coalesced. The full index is flushed after a completed run, every 60 seconds, and on unload.
- **Chat context** is trimmed to the newest 30 messages / 60k characters. Retrieval context is capped at 14k characters, and `read_note` at 12k characters.
- **Tool failures** are returned to the model as tool messages instead of crashing the turn. Unknown tool names are reported the same way.

## Privacy

Notes are sent only to the embedding and chat endpoints you configure. Vectors, metadata, conversations, and settings stay on disk. With Ollama or LM Studio, the whole pipeline can run without leaving the machine.

## Limitations

- Markdown only; no PDFs, images, or OCR.
- The vector index is one JSON file in memory. Very large vaults (roughly 10k+ notes) will use a lot of RAM and make startup slower.
- Changing the embedding model requires a full re-index; the plugin detects and prompts for this, but cannot migrate vectors across dimensions.
- Similarity scores depend on the embedding model. The default `0.25` threshold is a starting point, not a universal value.
- Mobile is not explicitly tested. The plugin avoids desktop-only APIs, but IndexedDB and large indexes may behave differently on mobile.
- There is no built-in reranker or hybrid keyword search; retrieval is pure vector similarity.

## Development

Requires Node.js 22 or newer.

```bash
npm install

npm run dev       # watch build
npm run build     # typecheck + minified bundle
npm test          # vitest suite
npm run coverage  # coverage report
```

`npm run build` writes `main.js`, which is intentionally gitignored.

### Tests

The suite runs outside Obsidian with a mocked `obsidian` module and `fake-indexeddb`:

- chunking: frontmatter, fenced headings, breadcrumbs, clamping, overlap loops
- vector store: ranking, dedupe, dimension validation, delete/forget, persist/restore, legacy metadata
- indexer: incremental runs, pruning, cancellation, dimension recovery, exclusions, renames
- embeddings: endpoint normalization, retries, malformed responses, ordering
- chat: tool rounds, unknown tools, tool failures, SSE streaming, buffered fallback, auth errors
- conversations: IndexedDB CRUD, ordering, renaming, title generation

### Retrieval evaluation

`scripts/eval-retrieval.ts` measures retrieval quality against a query set, independent of the chat model. It reports hit rate@K and mean reciprocal rank (MRR).

```bash
CYPHER_EMBEDDING_URL=http://localhost:11434/v1 \
CYPHER_EMBEDDING_MODEL=nomic-embed-text \
npm run eval:retrieval -- \
  --vault ~/vaults/main \
  --queries scripts/eval-queries.example.json \
  --k 5
```

Each query lists the note paths that should be retrieved:

```json
[{ "query": "how are notes split into chunks", "relevant": ["Architecture.md"] }]
```

Use a query set written against your own vault; the example file is a template.

### Project structure

```
src/
  main.ts                    plugin lifecycle, commands, vault events
  settings.ts                defaults, provider presets, dimension signature
  types.ts                   settings, chunks, search results, chat messages
  errors.ts                  API, dimension, cancellation, and stream errors
  utils.ts                   URL/path normalization, clamping, ids
  services/
    chunkingService.ts       frontmatter stripping, heading sections, chunking
    embeddingService.ts      batched embedding requests with retries
    vectorDbService.ts       Orama lifecycle, search, persistence, dimension checks
    indexerService.ts        vault scanning, incremental indexing, recovery
    chatService.ts           tool definitions, SSE streaming, tool loop
    conversationService.ts   IndexedDB (or in-memory) conversation storage
  ui/
    chatView.ts              chat sidebar, message rendering, streaming
    searchModal.ts           semantic search modal
    onboardingModal.ts       setup wizard and first index
    settingsTab.ts           settings UI
    modals.ts                promise-based prompt/confirm dialogs
tests/                       vitest suites and the Obsidian mock
scripts/
  eval-retrieval.ts          offline retrieval quality evaluation
  eval-queries.example.json  query-set template
  sync-to-vault.sh           build + copy into a vault for manual testing
```

## License

MIT. See [LICENSE](LICENSE).
