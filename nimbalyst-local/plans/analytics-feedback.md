---
planStatus:
  planId: plan-analytics-feedback
  title: Analytics Chat Feedback & RAG Self-Improvement
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - analytics
    - rag
    - feedback
    - llm
  created: "2026-02-24"
  updated: "2026-02-24T20:00:00.000Z"
  progress: 0
---
# Analytics Chat Feedback & RAG Self-Improvement

## Overview

Add a thumbs up / thumbs down feedback mechanism to each assistant message in the analytics chat. Positive feedback automatically indexes the Q→SQL pair as an `example` document in the RAG corpus, making future similar questions better. Negative feedback flags the result for review and optionally prompts the user for a correction.

## Mockup

![Feedback UI](screenshot.png){mockup:nimbalyst-local/mockups/analytics-feedback.mockup.html}{760x1100}

---

## User Flow

### Thumbs Up
1. User clicks 👍 on an assistant message
2. Button turns green (optimistic UI)
3. Backend: upsert the Q→SQL pair into `analytics.rag_documents` as `doc_type = 'example'`
4. Toast: "Thanks! This query has been saved to improve future results."

### Thumbs Down
1. User clicks 👎 on an assistant message
2. A small inline form appears below the message:
  - Optional text field: "What was wrong?" (placeholder: "e.g. wrong device, wrong time range, incorrect columns...")
  - "Submit" and "Cancel" buttons
3. On submit: backend records the negative feedback; the Q→SQL pair is NOT added to RAG
4. Toast: "Thanks for the feedback. We'll use this to improve results."

### Already Rated
- Once rated either way, the buttons stay in their rated state (no re-rating)
- Rating is persisted in the chat message metadata so it survives page refresh

---

## Architecture

### Data Model

Add `feedback` field to the `songbird-chat-history` DynamoDB table item:

```
feedback: {
  rating: 'positive' | 'negative',
  comment?: string,     // for negative feedback
  rated_at: number,     // Unix timestamp
}
```

This is added via `UpdateItem` on the existing record (identified by `user_email` + `timestamp`).

### New API Endpoints

**POST /analytics/feedback**

```json
{
  "userEmail": "user@example.com",
  "timestamp": 1708800000000,
  "rating": "positive",
  "question": "...",
  "sql": "...",
  "comment": ""
}
```

Handler logic:
1. Write feedback to DynamoDB (`UpdateItem` on the chat history record)
2. If `rating === 'positive'`: upsert Q→SQL pair into `analytics.rag_documents` as `doc_type = 'example'` with embedding (calls `embedText`)
3. If `rating === 'negative'`: just record feedback (no RAG write)
4. Return `{ success: true }`

### RAG Example Format (on positive feedback)

The new example document follows the same format as the seeded examples:

```
Q: "{{question}}"
SQL:
```sql
{{sql}}
```
Visualization: {{visualizationType}}
```
Title: `User example: {{question truncated to 80 chars}}`
`doc_type`: `example`
`metadata`: `{ source: 'user_feedback', rated_by: userEmail, rated_at: timestamp }`

Duplicates are handled by the existing `DELETE + INSERT` pattern (upsert by title).

---

## Frontend Changes

### `ChatMessage.tsx`

Add a feedback row below the insights card (assistant messages only, when `result` is present):

```tsx
<div className="flex items-center gap-2 mt-2">
  <span className="text-xs text-muted-foreground">Was this helpful?</span>
  <Button size="icon" variant="ghost" onClick={() => handleFeedback('positive')}>
    <ThumbsUp className={cn("h-3.5 w-3.5", rating === 'positive' && "text-green-500 fill-current")} />
  </Button>
  <Button size="icon" variant="ghost" onClick={() => handleFeedback('negative')}>
    <ThumbsDown className={cn("h-3.5 w-3.5", rating === 'negative' && "text-red-400 fill-current")} />
  </Button>
</div>

{/* Negative feedback form — inline, only when thumbs down clicked */}
{showFeedbackForm && (
  <div className="mt-2 space-y-2">
    <Input placeholder="What was wrong? (optional)" ... />
    <div className="flex gap-2">
      <Button size="sm" onClick={submitNegativeFeedback}>Submit</Button>
      <Button size="sm" variant="ghost" onClick={() => setShowFeedbackForm(false)}>Cancel</Button>
    </div>
  </div>
)}
```

The feedback UI only appears after the result has loaded (not during loading state).

**State management:**
- `rating: 'positive' | 'negative' | null` — local state per message
- `showFeedbackForm: boolean` — shown when thumbs down clicked and not yet submitted
- Once submitted, both buttons become disabled/inert

**Message needs \****`timestamp`**\*\* to identify the DynamoDB record for update.** `ChatMessage` already receives `message.timestamp` — pass it to the feedback API.

### `Analytics.tsx`

`ChatMessage` needs to pass enough context for feedback: `question`, `sql`, `visualizationType`, `userEmail`, `timestamp`. These are all already in the message object or available in the parent. Pass `userEmail` as a prop to `ChatMessage`.

### New files

- `src/api/analytics.ts` — add `submitFeedback()` function
- `src/hooks/useAnalytics.ts` — add `useSubmitFeedback()` mutation hook

---

## Infrastructure Changes

### New Lambda: `analytics/feedback.ts`

- Reads `userEmail`, `timestamp`, `rating`, `question`, `sql`, `visualizationType`, `comment` from body
- Updates DynamoDB chat history item with feedback field
- On positive: calls `embedText(content)` and upserts into `rag_documents`
- Needs: DynamoDB read/write on `songbird-chat-history`, RDS Data API access, Bedrock `InvokeModel`

### `analytics-construct.ts`

Add `feedbackLambda` NodejsFunction with appropriate env vars and permissions.

### `api-construct.ts`

```
POST /analytics/feedback
```

---

## Files to Create/Modify

| File | Change |
| --- | --- |
| `lambda/analytics/feedback.ts` | New: feedback handler + RAG indexing |
| `lib/analytics-construct.ts` | Add feedbackLambda |
| `lib/api-construct.ts` | Add POST /analytics/feedback route |
| `src/api/analytics.ts` | Add submitFeedback() |
| `src/hooks/useAnalytics.ts` | Add useSubmitFeedback() |
| `src/components/analytics/ChatMessage.tsx` | Add thumbs up/down UI |
| `src/pages/Analytics.tsx` | Pass userEmail to ChatMessage |
| `src/types/analytics.ts` | Add FeedbackRequest type |

---

## What's Out of Scope

- Negative feedback → automatic RAG removal (too aggressive; a bad result doesn't mean the existing example is wrong)
- Admin review queue for negative feedback (future iteration)
- Editing the SQL before indexing (future iteration — would be a great admin feature in the Context Manager)
- Re-rating (once rated, locked)

---

## Notes

- The feedback button should only appear on assistant messages that have a `result` (i.e. successful SQL execution), not on error messages
- User-generated examples are NOT pinned by default — they participate in similarity retrieval only
- The title format `User example: {{question}}` makes them visually distinct in the Context Manager
- The same deduplication strategy used in the seed Lambda applies: DELETE existing by title then INSERT, so re-running the same Q→SQL pair doesn't create duplicates
