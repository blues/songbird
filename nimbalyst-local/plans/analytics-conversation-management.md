---
planStatus:
  planId: plan-analytics-conversation-management
  title: Analytics Conversation Management
  status: complete
  planType: feature
  priority: medium
  owner: developer
  tags:
    - analytics
    - conversations
    - dashboard
    - dynamodb
  created: "2026-01-10"
  updated: "2026-01-10T23:17:36.000Z"
  progress: 100
---
# Analytics Conversation Management

## Goals

- Allow users to save conversations for later reference
- Enable loading previous conversations to continue analysis
- Provide ability to delete unwanted conversations
- Improve the analytics user experience with persistent chat sessions

## Overview

The Analytics feature currently stores chat history in DynamoDB (`songbird-chat-history` table) but the UI doesn't expose this functionality. Users lose their conversation context when they close the page. This plan adds UI controls to manage conversations.

## Current State

**Backend (Already Implemented):**
- DynamoDB table: `songbird-chat-history`
  - Partition key: `user_email`
  - Sort key: `timestamp`
  - GSI: `session-index` (partition: `session_id`, sort: `timestamp`)
  - TTL: 90 days automatic expiration
- API endpoint: `GET /analytics/history?userEmail={email}&limit={limit}`
- Chat history is saved automatically after each query

**Frontend (Gaps):**
- No UI to view past conversations
- No way to load a previous session
- No delete functionality
- New session ID generated on every page load

---

## Implementation Plan

### Phase 1: Backend API Updates

**1.1 Add Delete Endpoint**

Create new Lambda: `lambda/analytics/delete-conversation.ts`

```typescript
// DELETE /analytics/conversations/{sessionId}
// Deletes all chat history items for a session
```

**1.2 Add Session List Endpoint**

Create new Lambda: `lambda/analytics/list-sessions.ts`

```typescript
// GET /analytics/sessions?userEmail={email}&limit={limit}
// Returns unique sessions with metadata (first question, timestamp, message count)
```

**1.3 Update API Routes**

In `api-construct.ts`:
```typescript
DELETE /analytics/conversations/{sessionId}  → deleteConversationLambda
GET    /analytics/sessions                   → listSessionsLambda
```

### Phase 2: Frontend API Client

**2.1 Update \****`src/api/analytics.ts`**

Add new functions:
```typescript
// List all sessions for current user
export async function listAnalyticsSessions(limit?: number): Promise<SessionListResponse>

// Delete a conversation session
export async function deleteAnalyticsSession(sessionId: string): Promise<void>

// Load messages for a specific session
export async function loadAnalyticsSession(sessionId: string): Promise<ChatHistoryItem[]>
```

**2.2 Update \****`src/hooks/useAnalytics.ts`**

Add hooks:
```typescript
export function useAnalyticsSessions()
export function useDeleteSession()
export function useLoadSession()
```

### Phase 3: UI Components

**3.1 Conversation Sidebar/Panel**

Create `src/components/analytics/ConversationList.tsx`:
- List of past conversations grouped by date
- Each item shows: first question (truncated), timestamp, message count
- Click to load conversation
- Delete button with confirmation

**3.2 Update Analytics Page**

Modify `src/pages/Analytics.tsx`:
- Add sidebar toggle button
- Add "New Conversation" button
- Load selected session's messages into chat
- Maintain current session ID across page reloads (localStorage)

**3.3 Session Persistence**

- Store current `sessionId` in localStorage
- On page load, check for existing session and offer to continue or start new
- Clear session on explicit "New Conversation" action

### Phase 4: UI Polish

**4.1 Conversation List Features**
- Search/filter conversations
- Sort by date (newest/oldest)
- Batch delete option
- Empty state for no conversations

**4.2 Visual Improvements**
- Slide-out sidebar on mobile
- Keyboard shortcuts (Ctrl+N for new, Ctrl+S for sidebar)
- Loading states for all operations

---

## Technical Details

### DynamoDB Queries

**List Sessions:**
```typescript
// Query by user_email, get distinct session_ids
// Use session-index GSI for efficient lookup
QueryCommand({
  TableName: 'songbird-chat-history',
  KeyConditionExpression: 'user_email = :email',
  ExpressionAttributeValues: { ':email': userEmail },
  ProjectionExpression: 'session_id, #ts, question',
  ScanIndexForward: false,
})
// Then group by session_id in code
```

**Delete Session:**
```typescript
// Query all items for session, then BatchWriteItem to delete
// Use session-index GSI
QueryCommand({
  TableName: 'songbird-chat-history',
  IndexName: 'session-index',
  KeyConditionExpression: 'session_id = :sid',
  ExpressionAttributeValues: { ':sid': sessionId },
  ProjectionExpression: 'user_email, #ts',
})
// BatchWriteItem with DeleteRequest for each item
```

### Session List Response

```typescript
interface AnalyticsSession {
  sessionId: string;
  firstQuestion: string;
  lastTimestamp: number;
  messageCount: number;
}

interface SessionListResponse {
  sessions: AnalyticsSession[];
  total: number;
}
```

---

## File Changes

### Infrastructure (songbird-infrastructure)

| File | Action |
| --- | --- |
| `lambda/analytics/list-sessions.ts` | Create |
| `lambda/analytics/delete-conversation.ts` | Create |
| `lib/api-construct.ts` | Add routes |
| `lib/analytics-construct.ts` | Add Lambda functions |

### Dashboard (songbird-dashboard)

| File | Action |
| --- | --- |
| `src/api/analytics.ts` | Add functions |
| `src/hooks/useAnalytics.ts` | Add hooks |
| `src/components/analytics/ConversationList.tsx` | Create |
| `src/components/analytics/ConversationItem.tsx` | Create |
| `src/pages/Analytics.tsx` | Update |

---

## Acceptance Criteria

- [x] Users can view a list of past conversations
- [x] Clicking a conversation loads its messages
- [x] Users can delete individual conversations
- [x] "New Conversation" button starts a fresh session
- [x] Current session persists across page reloads
- [x] Conversations are grouped/sorted by date
- [x] Delete shows confirmation dialog
- [x] Loading states shown during operations
- [x] Works on mobile (responsive sidebar)
- [x] Feature flag gated (behind `analytics` flag)

---

## Future Enhancements

- Export conversation as PDF/Markdown
- Share conversation link (read-only)
- Pin/favorite important conversations
- Conversation naming/renaming
- Multi-turn context (Claude remembers previous queries in session)

---

## Post-Implementation Update: Visualization Re-rendering

**Added**: Visualization data re-execution when loading historical conversations

When a conversation is loaded from history, the stored SQL queries are automatically re-executed to fetch fresh data for visualizations (charts, maps). This ensures:
- Maps and charts render correctly when loading old conversations
- Data reflects current state (not stale snapshots)
- No need to store large result sets in DynamoDB

**Implementation:**
- New Lambda: `lambda/analytics/rerun-query.ts`
- New API endpoint: `POST /analytics/rerun`
- Frontend: Analytics page re-executes stored SQL for each message when loading a session
- UI shows "Loading visualization data..." spinner while queries execute

---

## References

- Current Analytics page: `songbird-dashboard/src/pages/Analytics.tsx`
- Chat history Lambda: `songbird-infrastructure/lambda/analytics/chat-history.ts`
- DynamoDB table: `songbird-chat-history`
- API construct: `songbird-infrastructure/lib/api-construct.ts`
