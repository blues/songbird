import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  chatQuery,
  getChatHistory,
  listSessions,
  getSession,
  deleteSession,
} from '@/api/analytics';
import type { ChatRequest } from '@/types/analytics';

export function useChatQuery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: ChatRequest) => chatQuery(request),
    onSuccess: () => {
      // Invalidate chat history and sessions to refresh
      queryClient.invalidateQueries({ queryKey: ['chatHistory'] });
      queryClient.invalidateQueries({ queryKey: ['analyticsSessions'] });
    },
  });
}

export function useChatHistory(userEmail: string) {
  return useQuery({
    queryKey: ['chatHistory', userEmail],
    queryFn: () => getChatHistory(userEmail),
    enabled: !!userEmail,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * List all chat sessions for the current user
 */
export function useAnalyticsSessions(userEmail: string, limit = 20) {
  return useQuery({
    queryKey: ['analyticsSessions', userEmail, limit],
    queryFn: () => listSessions(userEmail, limit),
    enabled: !!userEmail,
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Get a specific session with all messages
 */
export function useAnalyticsSession(sessionId: string | null, userEmail: string) {
  return useQuery({
    queryKey: ['analyticsSession', sessionId, userEmail],
    queryFn: () => getSession(sessionId!, userEmail),
    enabled: !!sessionId && !!userEmail,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Delete a chat session
 */
export function useDeleteSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, userEmail }: { sessionId: string; userEmail: string }) =>
      deleteSession(sessionId, userEmail),
    onSuccess: () => {
      // Invalidate sessions list to refresh
      queryClient.invalidateQueries({ queryKey: ['analyticsSessions'] });
      queryClient.invalidateQueries({ queryKey: ['chatHistory'] });
    },
  });
}
