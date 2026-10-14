# Cypher

Local-first Retrieval-Augmented Generation (RAG) and semantic vector search plugin for Obsidian.

## Overview

Cypher is an Obsidian plugin that builds a local vector database of Markdown notes and integrates with OpenAI-compatible APIs to provide semantic search and context-grounded chat.

Rather than sending an entire vault to an LLM or relying on external cloud vector databases, Cypher processes Markdown files locally: it parses document structure, splits text into contextual chunks, computes embeddings via configurable endpoints, stores vectors in an embedded database on disk, and exposes retrieval tools to the chat model via standard function calling.

The plugin supports both local inference engines (Ollama, LM Studio) and remote providers (OpenAI, OpenRouter), with independent configuration for embedding and chat models.

---

## How It Works

Cypher operates through two primary subsystems: the **Ingestion Pipeline** (indexing and syncing notes) and the **Retrieval & Inference Pipeline** (searching and chatting).

### 1. Ingestion Pipeline

```
[Markdown Note]
       │
       ▼
[Frontmatter Parser] ── Extracts metadata, strips YAML frontmatter
       │
       ▼
[Heading & Section Splitter] ── Partitions body by markdown headings (# to ######)
       │
       ▼
[Paragraph Chunker] ── Splits long sections at paragraph boundaries (\n\n)
       │                 with configurable size and overlap window
       ▼
[Context Injection] ── Prepends "[Note: {Title} | {Heading}]" to each chunk
       │
       ▼
[FNV-1a Hasher] ── Compares hash against index_meta.json to skip unchanged files
       │
       ▼
[Batch Embeddings] ── Dispatches batches to embedding endpoint with retry backoff
       │
       ▼
[Orama Vector DB] ── Inserts/upserts vectors and metadata into in-memory index
       │
       ▼
[Disk Persistence] ── Debounced flush (2s) writing orama_db.json and index_meta.json
```

#### Detailed Ingestion Steps

1. **Vault Scanning & File Filtering**:
   When indexing is triggered, Cypher scans all Markdown files in the vault. Folders specified in `excludedFolders` (such as `.obsidian` and `.trash`) are ignored.

2. **Change Detection via FNV-1a Hashing**:
   Before chunking or generating embeddings, Cypher computes a 32-bit FNV-1a hash of the raw note content. If the file path exists in the index and the hash matches, the file is skipped. This prevents unnecessary API requests on re-indexing runs.

3. **Frontmatter Stripping**:
   If the note starts with a YAML frontmatter block (`---`), the block is extracted separately so that frontmatter formatting does not pollute the embedding text chunks.

4. **Structure-Aware Section Splitting**:
   The remaining body is scanned line by line for Markdown headers (`#` through `######`). The document is partitioned into sections bounded by these headings.

5. **Paragraph-Level Chunking & Overlap**:
   Each section is evaluated against the configured `chunkSize` (default: 800 characters):
   - If a section fits within `chunkSize`, it becomes a single chunk.
   - If a section exceeds `chunkSize`, it is split on paragraph breaks (`\n\n`).
   - If an individual paragraph exceeds `chunkSize`, a sliding character window is applied with a configurable `chunkOverlap` (default: 150 characters).

6. **Context Header Injection**:
   Every generated chunk is prefixed with its document provenance:
   - With heading: `[Note: {title} | {heading}]\n{text}`
   - Without heading: `[Note: {title}]\n{text}`
   This ensures that isolated text chunks retain document-level and section-level context when converted to vector representations.

7. **Batch Embeddings with Exponential Backoff**:
   Chunks are batched according to `batchSize` (default: 20) and sent via HTTP POST to the configured embedding endpoint (`/embeddings`). If the server responds with HTTP 429 (Rate Limit) or 503 (Unavailable), the service retries up to 3 times with exponential backoff and randomized jitter:
   $$\text{delay} = \min(1000 \times 2^{\text{attempt}} + \text{random}(0, 500), 10000)\,\text{ms}$$

8. **In-Memory Storage & Persistence**:
   Vectors and chunk metadata are written into an in-memory Orama database instance. Cypher persists two files inside `<vault>/.obsidian/plugins/cypher/`:
   - `orama_db.json`: Serialized Orama vector database.
   - `index_meta.json`: Key-value mapping of file paths to their chunk IDs, content hashes, and modification timestamps.
   Disk writes are debounced by 2 seconds to avoid filesystem bottlenecks during batch operations.

9. **Live Vault Event Synchronization**:
   Cypher registers event listeners on Obsidian's vault lifecycle:
   - `create`: Chunks and indexes newly created `.md` files immediately.
   - `modify`: Queues a debounced 1-second re-index of the edited file if `autoIndexOnSave` is enabled.
   - `delete`: Removes all associated chunk IDs from the vector database and deletes the file entry from metadata. If a folder is deleted, all notes prefixed by that folder path are purged.
   - `rename`: Updates the indexed file path mappings without re-computing embeddings.

---

### 2. Retrieval & Chat Pipeline

```
[User Message]
       │
       ▼
[Chat Service] ── Prepares messages, system prompt, and tool definitions
       │
       ▼
[LLM Call] ── Sends request to chat completions endpoint (tool_choice: "auto")
       │
       ├─────────────────────────────────┬─────────────────────────────────┐
       ▼                                 ▼                                 ▼
[Tool: query_vault]              [Tool: list_notes]               [Direct Text Response]
       │                                 │                                 │
       ▼                                 ▼                                 ▼
1. Fetch query vector            1. Read metadata cache            Format markdown
2. Run vector search in Orama    2. Filter by tag / folder         and display in UI
3. Format top-K chunks           3. Format note inventory                  │
       │                                 │                                 │
       └────────────────┬────────────────┘                                 │
                        ▼                                                  │
             [Append Tool Results]                                         │
                        │                                                  │
                        ▼                                                  │
             [Follow-up LLM Call] ─────────────────────────────────────────┘
```

#### Tool Definitions

Cypher provides two functions to the LLM via standard OpenAI tool calling schemas:

1. **`query_vault`**:
   - Parameters: `query` (string)
   - Function: Generates an embedding vector for the search query, then queries the local Orama database for the top-$K$ nearest neighbors (filtered by a minimum similarity threshold, default `0.25`).
   - Output format returned to model:
     ```
     Retrieved N relevant note chunks from the user's vault for query "{query}":
     [Result 1 | Note: "{title}" > Heading: "{heading}" | File: "{path}" | Similarity: 87%]
     {chunk text}
     ```

2. **`list_notes`**:
   - Parameters: `tag` (optional string), `directory` (optional string)
   - Function: Inspects Obsidian's internal `MetadataCache` and `Vault` to list matching files, their folder locations, and tags (both YAML frontmatter tags and inline `#tags`).
   - Output format returned to model:
     ```
     Found N notes in the vault:
     - Title: "{title}" | Directory: "{dir}" | Tags: [#tag1 #tag2] | Path: "{path}"
     ```

#### Grounding Constraints

The chat service uses a strict grounding system prompt:
- Answers must rely strictly on information returned by the retrieval tools (`query_vault`, `list_notes`).
- If the retrieved context does not contain the answer, the model is instructed to output: `"I could not find this information in your notes."`
- The model is instructed to cite sources using Obsidian wikilinks: `[[Note Title]]`.
- The chat UI includes an interactive Top-$K$ input ($1 \le K \le 25$) allowing users to adjust retrieval depth per request.

---

### 3. Conversation Storage & History Browsing

Cypher persists chat conversations locally using **IndexedDB** (`cypher_db`), avoiding full-file JSON serialization on every turn:
- **Object Store**: `conversations` store keyed by unique conversation ID (`conv-{timestamp}-{rand}`).
- **Index**: Numeric index on `updatedAt` for retrieval of conversation lists ordered from newest to oldest.
- **State Preservation**: Persists complete message histories and structured `toolResult` metadata (queries, matched chunks, similarity scores, tags). When an old conversation is reopened, all past tool cards and assistant citations are fully restored.
- **Auto-Titling**: New conversations automatically derive their title from the first user prompt (truncated to ~40 characters on word boundaries).
- **History Drawer**: An in-place drawer enables browsing past conversations, viewing timestamps and message counts, renaming titles, deleting individual chats, and resuming previous interactions.

---

### 4. Quick Semantic Search Modal

For searching without chatting, Cypher provides a dedicated modal (`Ctrl/Cmd + P` -> `Cypher: Semantic Search Vault`):
1. User types a query.
2. The query is embedded and searched against Orama in real-time.
3. Results display note title, section heading, similarity score, and excerpt.
4. Selecting a result opens the target note directly in the active editor.

---

## Technical Specifications

| Component | Implementation | Notes |
|---|---|---|
| Vector Database | `@orama/orama` v3.1.18 | Runs in-memory in the Obsidian Electron/browser thread |
| DB Persistence | `@orama/plugin-data-persistence` | Serializes schema and vector index to JSON |
| Conversation Store | IndexedDB (`cypher_db`) | Object store with `updatedAt` index and atomic transactions |
| Similarity Metric | Cosine similarity | Supported natively by Orama vector property |
| Change Detection | FNV-1a 32-bit hash | Fast non-cryptographic hash evaluated per note |
| API Format | OpenAI-compatible HTTP | Endpoints: `/embeddings` and `/chat/completions` |
| Chunking Logic | Structure-aware regex parser | Splits by headings, paragraphs, sliding window |
| Rate Limit Handling | Exponential backoff + jitter | Handles HTTP 429 and 503 |
| UI Framework | Native Obsidian DOM API | Lightweight DOM construction, MarkdownRenderer |


---

## Configuration

Settings are accessible via **Obsidian Settings -> Cypher**:

### Embedding Configuration
- **API URL**: Endpoint URL (e.g., `http://localhost:11434/v1` or `https://api.openai.com/v1`).
- **API Key**: Bearer token (optional for local providers like Ollama).
- **Model Name**: Embedding model identifier (e.g., `nomic-embed-text`, `text-embedding-3-small`).
- **Vector Dimension**: Dimension size of the model output (e.g., 768 for nomic-embed-text, 1536 for OpenAI small). Auto-detected via the test connection button.

### Chat Configuration
- **API URL**: Endpoint URL for chat completions.
- **API Key**: Bearer token for chat endpoint.
- **Model Name**: Chat model identifier (e.g., `qwen3.5:4b`, `llama3.2`, `gpt-4o-mini`).
- **Top K**: Default number of chunks retrieved by `query_vault` (default: `5`).
- **Similarity Threshold**: Minimum cosine similarity score required for retrieval hits (default: `0.25`).
- **System Prompt**: Editable prompt defining grounding constraints and citation instructions.

### Indexing Parameters
- **Chunk Size**: Target character length per chunk (default: `800`).
- **Chunk Overlap**: Overlapping character count between consecutive chunks (default: `150`).
- **Batch Size**: Number of text chunks sent per embedding API request (default: `20`).
- **Excluded Folders**: Comma-separated list of folders omitted from indexing (default: `.obsidian, .trash`).
- **Auto-Index on Save**: Automatically re-indexes notes on save with a 1-second debounce (default: `true`).

---

## Provider Compatibility

Because Cypher uses standard OpenAI-compatible REST endpoints, it works with multiple backend providers:

| Provider | Type | Embedding Setup | Chat Setup |
|---|---|---|---|
| **Ollama** | Local | URL: `http://localhost:11434/v1`<br>Model: `nomic-embed-text`<br>Dim: `768` | URL: `http://localhost:11434/v1`<br>Model: `qwen3.5:4b` or `llama3.2` |
| **LM Studio** | Local | URL: `http://localhost:1234/v1`<br>Model: `text-embedding-nomic-embed-text-v1.5`<br>Dim: `768` | URL: `http://localhost:1234/v1`<br>Model: `qwen2.5-7b-instruct` |
| **OpenAI** | Remote | URL: `https://api.openai.com/v1`<br>Model: `text-embedding-3-small`<br>Dim: `1536` | URL: `https://api.openai.com/v1`<br>Model: `gpt-4o-mini` |
| **OpenRouter** | Remote | URL: `https://openrouter.ai/api/v1`<br>Model: `openai/text-embedding-3-small`<br>Dim: `1536` | URL: `https://openrouter.ai/api/v1`<br>Model: `anthropic/claude-3.5-sonnet` |

---

## Project Structure

```
cypher/
├── src/
│   ├── main.ts                    # Plugin initialization, commands, and vault event listeners
│   ├── types.ts                   # Interfaces for settings, chunks, search results, and tool calls
│   ├── settings.ts                # Default values and provider presets
│   ├── services/
│   │   ├── chunkingService.ts     # Markdown parser, heading splitter, context injector, FNV-1a
│   │   ├── conversationService.ts # IndexedDB conversation storage, history CRUD, auto-titling
│   │   ├── embeddingService.ts    # HTTP client for embeddings with rate-limit retry logic
│   │   ├── vectorDbService.ts     # Orama lifecycle: init, insert, remove, search, persistence
│   │   ├── indexerService.ts      # Vault indexing coordinator, file hashing, pause/cancel
│   │   └── chatService.ts         # Chat completions client, tool definitions, tool execution loop
│   └── ui/
│       ├── chatView.ts            # Sidebar chat view, message list, history drawer, tool cards
│       ├── searchModal.ts         # Quick vector search modal dialog
│       ├── onboardingModal.ts     # Initial setup modal with connection test & dimension discovery
│       └── settingsTab.ts         # Settings tab UI
├── tests/
│   └── test-pipeline.ts           # Test suite covering chunking, Orama, tools, conversation lifecycle
├── esbuild.config.mjs             # esbuild configuration
├── manifest.json                  # Obsidian plugin manifest
├── package.json                   # Dependencies and scripts
└── styles.css                     # Custom styles for chat view, modals, and tool cards
```

---

## Testing

The project includes an automated test script (`tests/test-pipeline.ts`) verifying core pipeline behavior independently of the Obsidian UI:

```bash
npm test
```

### Verified Behaviors

1. **Chunking Logic**: Validates frontmatter stripping, heading boundary detection, and paragraph splitting.
2. **Hash Verification**: Tests FNV-1a consistency across unchanged content and differentiation on modifications.
3. **Vector Database Operations**: Creates an in-memory Orama instance, inserts vectors, and tests similarity ranking.
4. **Serialization**: Verifies that `persist` and `restore` maintain index integrity without data loss.
5. **Top-K Modification**: Confirms search result count accurately respects the `limit` parameter.
6. **Document Deletion**: Ensures deleted document chunks are fully evicted from the vector index.
7. **Dual-API Separation**: Confirms embedding and chat configurations can use separate URLs and keys.
8. **Tool Routing**: Verifies `list_notes` tag extraction (frontmatter and inline) and directory filtering.
9. **Conversation Storage Lifecycle**: Tests IndexedDB store transactions, chronological sorting by `updatedAt`, `toolResult` persistence, prompt auto-titling, renaming, and atomic deletions.


---

## Development

### Prerequisites
- Node.js (v18 or higher)
- Obsidian (v1.0.0 or higher)

### Build Commands

```bash
# Install dependencies
npm install

# Run automated tests
npm test

# Development build with watch mode
npm run dev

# Production build (type-check + minify)
npm run build
```

### Vault Installation

Copy `main.js`, `manifest.json`, and `styles.css` to your Obsidian plugins directory:

```bash
<vault>/.obsidian/plugins/cypher/
```

Reload Obsidian and enable **Cypher** in **Settings -> Community Plugins**.

---

## License

MIT
