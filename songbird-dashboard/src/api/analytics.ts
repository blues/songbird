import { fetchAuthSession } from 'aws-amplify/auth';
import { getApiBaseUrl } from './client';
import type {
  ChatRequest,
  QueryResult,
  ChatHistoryResponse,
  SessionListResponse,
  SessionResponse,
  RagDocument,
  RagDocumentsResponse,
  FeedbackRequest,
  NegativeFeedbackResponse,
} from '@/types/analytics';

export async function chatQuery(request: ChatRequest): Promise<QueryResult> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

export async function getChatHistory(userEmail: string, limit = 50): Promise<ChatHistoryResponse> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(
    `${getApiBaseUrl()}/analytics/history?userEmail=${encodeURIComponent(userEmail)}&limit=${limit}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch chat history: ${response.status}`);
  }

  return response.json();
}

/**
 * List all chat sessions for a user
 */
export async function listSessions(userEmail: string, limit = 20): Promise<SessionListResponse> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(
    `${getApiBaseUrl()}/analytics/sessions?userEmail=${encodeURIComponent(userEmail)}&limit=${limit}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch sessions: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific chat session with all messages
 */
export async function getSession(sessionId: string, userEmail: string): Promise<SessionResponse> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(
    `${getApiBaseUrl()}/analytics/sessions/${encodeURIComponent(sessionId)}?userEmail=${encodeURIComponent(userEmail)}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.status}`);
  }

  return response.json();
}

/**
 * Delete a chat session
 */
export async function deleteSession(sessionId: string, userEmail: string): Promise<void> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(
    `${getApiBaseUrl()}/analytics/sessions/${encodeURIComponent(sessionId)}?userEmail=${encodeURIComponent(userEmail)}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to delete session: ${response.status}`);
  }
}

/**
 * Re-execute a stored SQL query to get fresh visualization data
 */
export async function listRagDocuments(docType?: string): Promise<RagDocumentsResponse> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const params = docType ? `?doc_type=${encodeURIComponent(docType)}` : '';

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents${params}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch RAG documents: ${response.status}`);
  }
  return response.json();
}

export async function createRagDocument(doc: {
  doc_type: 'schema' | 'example' | 'domain';
  title?: string;
  content: string;
  metadata?: Record<string, string>;
}): Promise<{ document: RagDocument }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(doc),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to create RAG document: ${response.status}`);
  }
  return response.json();
}

export async function updateRagDocument(
  id: string,
  doc: { title?: string; content: string }
): Promise<{ document: RagDocument }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(doc),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to update RAG document: ${response.status}`);
  }
  return response.json();
}

export async function deleteRagDocument(id: string): Promise<void> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to delete RAG document: ${response.status}`);
  }
}

export async function toggleRagDocumentPin(id: string, pinned: boolean): Promise<{ id: string; pinned: boolean }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents/${encodeURIComponent(id)}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ pinned }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to toggle pin: ${response.status}`);
  }
  return response.json();
}

export async function reseedRagDocuments(): Promise<{ message: string }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rag-documents/reseed`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to reseed: ${response.status}`);
  }
  return response.json();
}

export async function rerunQuery(sql: string, userEmail: string): Promise<{ data: any[] }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/rerun`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ sql, userEmail }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to rerun query: ${response.status}`);
  }

  return response.json();
}

export async function deleteNegativeFeedback(userEmail: string, ratedAt: number): Promise<void> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/feedback`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ userEmail, ratedAt }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to delete feedback: ${response.status}`);
  }
}

export async function listNegativeFeedback(limit = 100): Promise<NegativeFeedbackResponse> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/feedback?limit=${limit}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feedback: ${response.status}`);
  }

  return response.json();
}

export async function submitFeedback(req: FeedbackRequest): Promise<{ success: boolean; indexed: boolean }> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${getApiBaseUrl()}/analytics/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to submit feedback: ${response.status}`);
  }

  return response.json();
}
