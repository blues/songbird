import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatQuery, getChatHistory } from '@/api/analytics';
import type { ChatRequest } from '@/types/analytics';

export function useChatQuery() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: ChatRequest) => chatQuery(request),
    onSuccess: () => {
      // Invalidate chat history to refresh
      queryClient.invalidateQueries({ queryKey: ['chatHistory'] });
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
