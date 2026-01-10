import { fetchAuthSession } from 'aws-amplify/auth';
import { getApiBaseUrl } from './client';
import type {
  ChatRequest,
  QueryResult,
  ChatHistoryResponse,
  SessionListResponse,
  SessionResponse,
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
