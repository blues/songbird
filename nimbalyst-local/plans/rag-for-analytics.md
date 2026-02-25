---
planStatus:
  planId: plan-rag-analytics
  title: RAG Integration for Analytics Chat Feature
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - rag
    - analytics
    - llm
    - bedrock
    - aurora
  created: "2026-02-23"
  updated: "2026-02-24T02:18:15.521Z"
  progress: 0
---
# RAG Integration for Analytics Chat Feature

## Background

The Songbird analytics feature already has a text-to-SQL chat pipeline:

1. User asks a natural language question
2. **`chat-query.ts`** calls Bedrock (Claude) with a hardcoded schema + few-shot examples as context
3. Claude generates SQL
4. SQL is validated and executed against Aurora Serverless PostgreSQL
5. A second LLM call generates a natural language insight summary
6. Results are returned and saved to DynamoDB chat history

The prompts (`songbird-sql-generator`, `songbird-insights-generator`) are managed in Phoenix Prompt Hub and fetched at runtime via `phoenix-prompts.ts`.

The current approach has limitations that RAG can address:
- The schema/context is static in the prompt — it doesn't adapt based on what the user is asking
- Few-shot examples are hardcoded — better examples for specific query patterns can't be retrieved dynamically
- No memory of past successful queries — the model has to "figure out" the same patterns repeatedly
- Schema context consumes a large portion of the prompt budget regardless of relevance

## Objective

Add a RAG layer to the analytics chat pipeline that dynamically retrieves relevant context before generating SQL. This would allow the model to benefit from:

1. **Similar past queries** — retrieve previously successful Q→SQL pairs from a vector store
2. **Relevant schema chunks** — only inject schema sections that are relevant to the question
3. **Domain-specific docs** — retrieve Songbird-specific knowledge (e.g., what "transit mode" means, how journeys work)

## Architecture Overview

```
User Question
    │
    ▼
┌─────────────────────────────┐
│  Retrieval Step (new)       │
│  ─ Embed question           │
│  ─ Search vector store      │
│  ─ Retrieve top-k docs      │
└─────────────────────────────┘
    │
    ▼ Retrieved context chunks
┌─────────────────────────────┐
│  Prompt Assembly (updated)  │
│  ─ Relevant schema chunks   │
│  ─ Similar past queries     │
│  ─ Domain knowledge         │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  SQL Generation (existing)  │
│  ─ Bedrock (Claude)         │
└─────────────────────────────┘
    │
    ▼
┌─────────────────────────────┐
│  Execute + Insights (exist) │
└─────────────────────────────┘
```

## Vector Store Options

### Option A: pgvector (Aurora PostgreSQL) — Recommended
- Aurora already exists in the stack (used for analytics data)
- Add pgvector extension to the same cluster
- Store embeddings alongside analytics data
- No new AWS services required
- Pros: Simple, cost-effective, already authenticated
- Cons: Slightly couples analytics data and RAG data

### Option B: Amazon OpenSearch Serverless
- Managed vector search service
- Native kNN support
- Pros: Dedicated vector search, scales independently
- Cons: Additional cost, new service to manage, more complex auth

### Option C: In-memory (Lambda-level cache)
- Load document embeddings into Lambda memory on cold start
- Pros: Zero latency, no external calls
- Cons: Not scalable, limited document count, cold start overhead

**Recommendation: Option A (pgvector)** — leverages existing Aurora infrastructure, minimal operational overhead.

## What Gets Vectorized

### 1. Schema Chunks
Split the schema context into per-table chunks (already defined in `chat-query.ts`):
- `analytics.devices` description + columns
- `analytics.telemetry` description + columns
- `analytics.locations` description + columns
- `analytics.alerts` description + columns
- `analytics.journeys` description + columns
- Query rules (device filter, time ranges, etc.)

### 2. Few-Shot Examples (Q→SQL pairs)
The 5 existing hardcoded examples, plus any new ones added over time:
- Recent Locations example
- Temperature Anomalies example
- Power Usage Over Time example
- Temperature Comparison example
- Alert Analysis example

### 3. Domain Knowledge Docs

Glossary entries are hardcoded as TypeScript objects in `seed-rag-documents.ts`, derived from CLAUDE.md. This keeps them version-controlled alongside code and simple to update as the project evolves. A developer re-runs the seed Lambda after any edits.

Initial entries to seed:

**Operating Modes**
> Songbird devices operate in one of four modes. **demo** mode uses cell-tower triangulation and syncs immediately — used during live customer demos. **transit** mode uses GPS tracking every 60 seconds and syncs every 15 minutes — used when assets are actively moving. **storage** mode uses triangulation and syncs every 60 minutes — used when assets are at rest. **sleep** mode disables location and only wakes on motion — used for long-term storage. The current mode is set via the `mode` environment variable in Notehub.

**Journeys**
> A journey is a sequence of GPS tracking points recorded while a device is in transit mode. Each journey has a unique `journey_id` (Unix timestamp of when transit started), and includes velocity, bearing, distance, and DOP (accuracy) data per point. Journeys have a status of `active` (currently in transit) or `completed`. The dashboard supports animated journey playback with road-snapping via the Mapbox Map Matching API.

**Device Aliasing / Notecard Swapping**
> Each Songbird device has a stable human-readable serial number (e.g., `songbird01-bds`) that is independent of the physical Notecard hardware. When a Notecard is replaced, the new Notecard sends data with the same serial number and the system auto-detects the swap, preserving all historical data. The `analytics.devices` table uses `serial_number` as the primary key for this reason — not `device_uid`, which can change.

**Notecard & Notehub**
> The Notecard is a cellular + GPS module made by Blues Inc. that handles all wireless communication. Notehub is Blues's cloud routing service that receives events from Notecards and forwards them to customer backends (in this case, the Songbird AWS Lambda ingest endpoint). Data flows: Notecard → Notehub → AWS Lambda `/ingest` → DynamoDB + Aurora. Environment variables set in Notehub are synced back to the device to control behavior.

**Alert Types**
> Songbird devices generate alerts when sensor readings exceed configured thresholds. Alert types include temperature threshold violations (`temp_high`, `temp_low`). Thresholds are set via `alert_temp_high` and `alert_temp_low` environment variables in Notehub. Alerts have a severity of `info`, `warning`, or `critical`, and can be acknowledged by users in the dashboard.

**Voltage / Battery**
> The `voltage` field in telemetry represents the device's battery voltage. Songbird is battery-powered, so declining voltage indicates battery depletion. A fully charged LiPo battery is ~4.2V; the device should be recharged below ~3.5V. Voltage readings are stored in the `analytics.telemetry` table.

## Implementation Plan

### Phase 1: Infrastructure

**1.1 Enable pgvector on Aurora**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**1.2 Create RAG tables in Aurora**
```sql
CREATE TABLE IF NOT EXISTS analytics.rag_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type VARCHAR(50) NOT NULL,  -- 'schema', 'example', 'domain'
  title VARCHAR(255),
  content TEXT NOT NULL,
  embedding vector(1536),         -- Amazon Titan Text Embeddings v2 (1536 dims)
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON analytics.rag_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);
```

**1.3 Update CDK to grant pgvector permissions**
- The Lambda's IAM role already has RDS Data API access
- Just needs the DDL executed (can be done in `init-schema.ts`)

### Phase 2: Embedding + Ingestion Lambda

Create a new Lambda `analytics/seed-rag-documents.ts`:
- Called once to seed initial documents (schema chunks, examples, domain docs)
- Uses Amazon Bedrock Titan Text Embeddings to vectorize each document
- Stores vectors in `analytics.rag_documents`
- Can be re-run to update documents (upserts by title to avoid duplicates)
- Domain glossary entries are hardcoded TypeScript objects in this file (see "Domain Knowledge Docs" section above); update them here and re-run the Lambda to refresh

```typescript
// Uses Bedrock Titan Embeddings
const embeddingResponse = await bedrock.send(new InvokeModelCommand({
  modelId: 'amazon.titan-embed-text-v2:0',
  body: JSON.stringify({ inputText: documentText, dimensions: 1536 }),
}));
```

### Phase 3: Retrieval Function (shared utility)

Create `lambda/shared/rag-retrieval.ts`:
```typescript
export async function retrieveRelevantContext(
  question: string,
  topK: number = 5
): Promise<string> {
  // 1. Embed the question using Titan Embeddings
  // 2. Query pgvector for top-k similar documents
  // 3. Format and return retrieved chunks
}
```

Query pattern:
```sql
SELECT title, content, doc_type,
       1 - (embedding <=> :queryEmbedding) AS similarity
FROM analytics.rag_documents
ORDER BY embedding <=> :queryEmbedding
LIMIT :topK;
```

### Phase 4: Update `chat-query.ts`

Modify `generateSQL()` to:
1. Call `retrieveRelevantContext(question)` before building the prompt
2. Inject retrieved chunks into the prompt instead of (or in addition to) the static schema context

The prompt template in Phoenix would be updated to accept a `{{retrieved_context}}` variable:

```
{{retrieved_context}}

Based on the user's question, generate a PostgreSQL query...

User Question: "{{question}}"
```

### Phase 5: Feedback Loop — Index Successful Queries

Optionally, when a query succeeds and the user doesn't flag it as incorrect:
- Add the Q→SQL pair as a new document in `rag_documents` (type: `example`)
- Re-embed it for future retrieval

This creates a self-improving system where the retrieval gets better over time.

### Phase 6: Phoenix Tracing for RAG

Add a new `RETRIEVER` span around the retrieval step (OpenInference convention):
```typescript
span.setAttribute('openinference.span.kind', 'RETRIEVER');
span.setAttribute('input.value', question);
span.setAttribute('retrieval.documents', JSON.stringify(retrievedDocs));
```

Phoenix natively supports `RETRIEVER` spans and will show retrieved documents in the trace UI — making it easy to evaluate retrieval quality alongside generation quality.

## Files to Create/Modify

| File | Change |
| --- | --- |
| `lambda/analytics/init-schema.ts` | Add pgvector extension + `rag_documents` table |
| `lambda/analytics/seed-rag-documents.ts` | New: seed initial RAG corpus |
| `lambda/shared/rag-retrieval.ts` | New: embedding + vector search utility |
| `lambda/analytics/chat-query.ts` | Add retrieval step to `generateSQL()` |
| `lib/analytics-construct.ts` | Add new Lambda for seed function |
| Phoenix Prompt Hub | Update `songbird-sql-generator` template to use `{{retrieved_context}}` |

## Tracing & Evaluation

Since Phoenix is already integrated:
- Add `RETRIEVER` span kind to make retrieval visible in Phoenix traces
- Add `retrieval.top_k` and `retrieval.similarity_threshold` as span attributes
- Use Phoenix evaluators to measure retrieval relevance (not just generation quality)
- The golden dataset can include expected retrieval results to evaluate the full RAG pipeline

## Open Questions

1. **Embedding dimensions**: Titan Text Embeddings v2 supports 256, 512, or 1536 dims. Higher is more accurate but slower/larger. 1536 is recommended for this use case.
2. **Top-k value**: Start with 5 retrieved documents. Tune based on Phoenix evaluation results.
3. **Static schema in fallback**: If pgvector retrieval fails, fall back to the current static schema in the prompt.
4. **Re-seeding cadence**: Schema rarely changes, but successful Q→SQL pairs should be indexed continuously.
