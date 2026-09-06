# ADR 019: SQLite FTS5 Full-Text Indexing and Recursive CTE Graph Traversal

## Status
Accepted

## Date
2026-09-06

## Context
SQLite serves as the zero-dependency embedded database and offline fallback in MemoryGraph. Prior to this optimization:

1. **Unindexed String Scans**: Memory search evaluated unindexed `LIKE '%token%'` expressions with leading wildcards across four text columns (`title`, `content`, `summary`, `tags`). On corpora of 10,000 documents, this generated an O(N) CPU table scan bottleneck (~260ms latency per query).
2. **No Stemming or Linguistic Normalization**: Simple substring matching failed on grammatical inflections (e.g., a search for "configuring ingresses" returned 0 hits for "configure ingress").
3. **Iterative Multi-Hop Traversal**: Multi-hop relationship queries in `getRelatedMemories` executed breadth-first loops crossing the application-to-database boundary multiple times.
4. **Sequential Write Overhead**: Batch ingestion suffered from per-insert SQLite transaction fsyncs.

## Decision

We optimize `SQLiteBackend` (`ts/src/backends/sqlite.ts`) by introducing native FTS5 full-text indexing, batched transactions, and recursive CTE graph traversal.

### 1. FTS5 Virtual Table & Automated Synchronization
We create an SQLite FTS5 virtual table using the Porter stemmer and unicode61 tokenizer:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  summary,
  tags,
  tokenize = 'porter unicode61'
);
```
Automated SQLite triggers (`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE` on `memories`) maintain `memories_fts` in lockstep without requiring application-side dual-write logic.

### 2. Zero-Migration Startup Backfill
On connection (`initializeSchema()`), SQLiteBackend checks for unindexed rows and backfills them immediately:
```sql
INSERT INTO memories_fts(id, title, content, summary, tags)
SELECT id, title, content, COALESCE(summary, ''), tags FROM memories
WHERE id NOT IN (SELECT id FROM memories_fts);
```
Pre-existing databases created on previous versions are automatically upgraded on startup with zero data loss and without manual migration scripts.

### 3. Graph-Aware BM25 Reranking
FTS5 search uses BM25 relevance scoring weighted across fields (boosting `title` over `content` and `summary`) combined with active relationship connectivity boosts for connected solution and problem nodes.

### 4. Single-Query Recursive CTE Graph Traversal
Iterative BFS traversal in `getRelatedMemories` is replaced by an SQLite `WITH RECURSIVE` Common Table Expression, delegating traversal entirely to SQLite's C engine in a single query execution.

### 5. Bulk Ingestion & High-Performance PRAGMAs
- `bulkStoreMemories` uses prepared statements wrapped in an explicit `BEGIN TRANSACTION / COMMIT` block, achieving 3,000+ docs/sec.
- Runtime PRAGMAs are tuned for local agent workloads: `PRAGMA synchronous=NORMAL;`, `PRAGMA temp_store=MEMORY;`, `PRAGMA mmap_size=67108864;`.

## Consequences

### Positive
- **50x Search Acceleration**: Search latency dropped from ~260ms to <5ms on 10,000-document benchmarks.
- **Linguistic Precision**: Accurately matches inflected search terms (singular/plural, verb tenses).
- **Single-Query Traversal**: Recursive CTE cuts traversal overhead to sub-millisecond execution.
- **Zero External Dependencies**: Operates entirely using native Bun/SQLite built-in FTS5 capabilities.

### Trade-offs
- Modest database file size increase (~15-20%) to store the FTS5 index tables.
