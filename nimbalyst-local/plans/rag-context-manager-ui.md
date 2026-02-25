---
planStatus:
  planId: plan-rag-context-manager-ui
  title: RAG Context Manager UI
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - rag
    - analytics
    - dashboard
    - admin
  created: "2026-02-24"
  updated: "2026-02-24T03:30:00.000Z"
  progress: 0
---
# RAG Context Manager UI

## Overview

Add a RAG Context Manager tab inside the existing Analytics page (admin-only) where users can view, add, edit, and delete documents in the `analytics.rag_documents` vector store. This gives admins visibility into what context the LLM is retrieving, and the ability to add domain knowledge, new Q→SQL examples, or fix bad schema descriptions without redeploying.

## Mockup

![RAG Context Manager UI](screenshot.png){mockup:nimbalyst-local/mockups/rag-context-manager.mockup.html}

## Scope

### What's in scope
- Tab inside the Analytics page: "Context Manager" (admin-only, hidden for non-admins)
- List all RAG documents with type badge, title, and truncated content
- Filter by doc type (schema / example / domain)
- Add new document (type, title, content — embedding generated server-side)
- Delete a document
- Edit a document's title/content (re-embeds server-side)
- Re-seed button that invokes the seed Lambda (refreshes all built-in documents)

### What's out of scope
- Bulk import
- Viewing raw embedding vectors
- Similarity search preview from the UI

---

## Backend Changes

### New Lambda: `analytics/rag-documents.ts`

A single Lambda handling CRUD for `analytics.rag_documents`:

```
GET    /analytics/rag-documents          → list all documents
POST   /analytics/rag-documents          → create (title, content, doc_type) + embed
PUT    /analytics/rag-documents/{id}     → update content/title + re-embed
DELETE /analytics/rag-documents/{id}     → delete by id
POST   /analytics/rag-documents/reseed   → invoke seed Lambda
```

The create and update operations call `embedText()` from `shared/rag-retrieval.ts` to generate fresh embeddings server-side. The `reseed` endpoint invokes the `songbird-analytics-seed-rag-documents` Lambda via the AWS SDK.

**IAM**: The Lambda needs `bedrock:InvokeModel` (for embeddings), RDS Data API access, and `lambda:InvokeFunction` on the seed Lambda ARN.

### Infrastructure (`analytics-construct.ts`)

- Add `ragDocumentsLambda` (NodejsFunction)
- Export `seedRagLambda.functionArn` so the CRUD Lambda can invoke it
- Pass `SEED_LAMBDA_ARN` as env var to the CRUD Lambda

### API Construct (`api-construct.ts`)

Add routes (admin-only authorizer):
```
GET    /analytics/rag-documents
POST   /analytics/rag-documents
PUT    /analytics/rag-documents/{id}
DELETE /analytics/rag-documents/{id}
POST   /analytics/rag-documents/reseed
```

---

## Frontend Changes

### New API functions (`src/api/analytics.ts`)

```typescript
listRagDocuments(): Promise<RagDocument[]>
createRagDocument(doc: { doc_type, title, content }): Promise<RagDocument>
updateRagDocument(id: string, doc: { title, content }): Promise<RagDocument>
deleteRagDocument(id: string): Promise<void>
reseedRagDocuments(): Promise<{ seeded: number; failed: number }>
```

### New Types (`src/types/analytics.ts`)

```typescript
interface RagDocument {
  id: string;
  doc_type: 'schema' | 'example' | 'domain';
  title: string;
  content: string;
  metadata?: Record<string, string>;
  created_at: string;
  updated_at: string;
}
```

### New Component: `src/components/analytics/RagContextManager.tsx`

The main component. Rendered only when `isAdmin` is true.

**Layout:**
- Toolbar: filter tabs (All / Schema / Example / Domain), "Add Document" button, "Re-seed Built-ins" button
- Table/card list of documents with: type badge, title, content preview (2 lines), edit + delete actions
- Add/Edit: slide-in sheet with form (doc_type select, title input, content textarea)
- Delete: confirmation alert dialog
- Re-seed: confirmation dialog + loading state

**Hooks:**
```typescript
useRagDocuments()        // useQuery for list
useCreateRagDocument()   // useMutation
useUpdateRagDocument()   // useMutation
useDeleteRagDocument()   // useMutation
useReseedRagDocuments()  // useMutation
```

### Analytics Page (`src/pages/Analytics.tsx`)

Add a second tab "Context Manager" (visible only to admins) alongside the existing chat UI:

```tsx
<Tabs defaultValue="chat">
  <TabsList>
    <TabsTrigger value="chat">Analytics Chat</TabsTrigger>
    {isAdmin && <TabsTrigger value="context">Context Manager</TabsTrigger>}
  </TabsList>
  <TabsContent value="chat">
    {/* existing chat UI */}
  </TabsContent>
  {isAdmin && (
    <TabsContent value="context">
      <RagContextManager />
    </TabsContent>
  )}
</Tabs>
```

---

## Files to Create/Modify

| File | Change |
| --- | --- |
| `lambda/analytics/rag-documents.ts` | New: CRUD Lambda for rag_documents |
| `lib/analytics-construct.ts` | Add ragDocumentsLambda, export seed ARN |
| `lib/api-construct.ts` | Add 5 new routes |
| `src/api/analytics.ts` | Add 5 new API functions |
| `src/types/analytics.ts` | Add RagDocument type |
| `src/components/analytics/RagContextManager.tsx` | New: full CRUD UI component |
| `src/pages/Analytics.tsx` | Wrap in Tabs, add Context Manager tab |

---

## Doc Type Color Coding

| Type | Badge Color |
| --- | --- |
| schema | Blue |
| example | Green |
| domain | Purple |

---

## Notes

- Re-seed invokes the seed Lambda asynchronously (fire-and-forget from the CRUD Lambda, returns immediately) — the UI shows a toast "Re-seeding started, check back in ~30 seconds"
- Embedding is done server-side in the CRUD Lambda, not client-side
- Admin gate: `useIsAdmin()` hook already exists in `src/hooks/useAuth.ts`
- The tab is hidden (not just disabled) for non-admins to avoid confusion
