import { apiFetch, apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client';
import type {
  ChatRequest,
  QueryResult,
  QueryRow,
  ChatHistoryResponse,
  SessionListResponse,
  SessionResponse,
  RagDocument,
  RagDocumentsResponse,
  FeedbackRequest,
  NegativeFeedbackResponse,
} from '@/types/analytics';

export async function chatQuery(request: ChatRequest): Promise<QueryResult> {
  return apiPost<QueryResult>('/analytics/chat', request);
}

export async function getChatHistory(userEmail: string, limit = 50): Promise<ChatHistoryResponse> {
  return apiGet<ChatHistoryResponse>('/analytics/history', { userEmail, limit });
}

/**
 * List all chat sessions for a user
 */
export async function listSessions(userEmail: string, limit = 20): Promise<SessionListResponse> {
  return apiGet<SessionListResponse>('/analytics/sessions', { userEmail, limit });
}

/**
 * Get a specific chat session with all messages
 */
export async function getSession(sessionId: string, userEmail: string): Promise<SessionResponse> {
  return apiGet<SessionResponse>(`/analytics/sessions/${encodeURIComponent(sessionId)}`, { userEmail });
}

/**
 * Delete a chat session
 */
export async function deleteSession(sessionId: string, userEmail: string): Promise<void> {
  return apiDelete<void>(
    `/analytics/sessions/${encodeURIComponent(sessionId)}?userEmail=${encodeURIComponent(userEmail)}`
  );
}

/**
 * List RAG documents, optionally filtered by type
 */
export async function listRagDocuments(docType?: string): Promise<RagDocumentsResponse> {
  return apiGet<RagDocumentsResponse>(
    '/analytics/rag-documents',
    docType ? { doc_type: docType } : undefined
  );
}

export async function createRagDocument(doc: {
  doc_type: 'schema' | 'example' | 'domain';
  title?: string;
  content: string;
  metadata?: Record<string, string>;
}): Promise<{ document: RagDocument }> {
  return apiPost<{ document: RagDocument }>('/analytics/rag-documents', doc);
}

export async function updateRagDocument(
  id: string,
  doc: { title?: string; content: string }
): Promise<{ document: RagDocument }> {
  return apiPut<{ document: RagDocument }>(
    `/analytics/rag-documents/${encodeURIComponent(id)}`,
    doc
  );
}

export async function deleteRagDocument(id: string): Promise<void> {
  return apiDelete<void>(`/analytics/rag-documents/${encodeURIComponent(id)}`);
}

export async function toggleRagDocumentPin(id: string, pinned: boolean): Promise<{ id: string; pinned: boolean }> {
  return apiPatch<{ id: string; pinned: boolean }>(
    `/analytics/rag-documents/${encodeURIComponent(id)}/pin`,
    { pinned }
  );
}

export async function reseedRagDocuments(): Promise<{ message: string }> {
  return apiPost<{ message: string }>('/analytics/rag-documents/reseed');
}

export async function rerunQuery(sql: string, userEmail: string): Promise<{ data: QueryRow[] }> {
  return apiPost<{ data: QueryRow[] }>('/analytics/rerun', { sql, userEmail });
}

export async function deleteNegativeFeedback(userEmail: string, ratedAt: number): Promise<void> {
  return apiFetch<void>('/analytics/feedback', {
    method: 'DELETE',
    body: JSON.stringify({ userEmail, ratedAt }),
  });
}

export async function listNegativeFeedback(limit = 100): Promise<NegativeFeedbackResponse> {
  return apiGet<NegativeFeedbackResponse>('/analytics/feedback', { limit });
}

export async function submitFeedback(req: FeedbackRequest): Promise<{ success: boolean; indexed: boolean }> {
  return apiPost<{ success: boolean; indexed: boolean }>('/analytics/feedback', req);
}
