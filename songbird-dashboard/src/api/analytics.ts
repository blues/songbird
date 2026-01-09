import { fetchAuthSession } from 'aws-amplify/auth';
import { getApiBaseUrl } from './client';
import type { ChatRequest, QueryResult, ChatHistoryResponse } from '@/types/analytics';

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
