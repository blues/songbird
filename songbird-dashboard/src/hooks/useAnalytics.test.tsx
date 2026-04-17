import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import {
  useChatQuery,
  useChatHistory,
  useAnalyticsSessions,
  useAnalyticsSession,
  useDeleteSession,
} from './useAnalytics';

vi.mock('@/api/analytics', () => ({
  chatQuery: vi.fn(),
  getChatHistory: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import {
  chatQuery,
  getChatHistory,
  listSessions,
  getSession,
  deleteSession,
} from '@/api/analytics';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useChatQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls chatQuery with request', async () => {
    const mockResponse = { answer: 'hello' };
    vi.mocked(chatQuery).mockResolvedValue(mockResponse as any);

    const { result } = renderHook(() => useChatQuery(), {
      wrapper: createWrapper(),
    });

    const request = { query: 'test question', userEmail: 'user@test.com' };
    await result.current.mutateAsync(request as any);

    expect(chatQuery).toHaveBeenCalledWith(request);
  });
});

describe('useChatHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getChatHistory with userEmail', async () => {
    const mockData = { messages: [{ id: '1', text: 'hello' }] };
    vi.mocked(getChatHistory).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useChatHistory('user@test.com'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getChatHistory).toHaveBeenCalledWith('user@test.com');
    expect(result.current.data).toEqual(mockData);
  });

  it('is disabled when userEmail is empty', async () => {
    const { result } = renderHook(() => useChatHistory(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getChatHistory).not.toHaveBeenCalled();
  });
});

describe('useAnalyticsSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls listSessions with userEmail and default limit', async () => {
    const mockData = { sessions: [{ id: 's1' }] };
    vi.mocked(listSessions).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useAnalyticsSessions('user@test.com'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSessions).toHaveBeenCalledWith('user@test.com', 20);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes custom limit', async () => {
    vi.mocked(listSessions).mockResolvedValue({ sessions: [] } as any);

    const { result } = renderHook(() => useAnalyticsSessions('user@test.com', 5), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listSessions).toHaveBeenCalledWith('user@test.com', 5);
  });

  it('is disabled when userEmail is empty', async () => {
    const { result } = renderHook(() => useAnalyticsSessions(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('useAnalyticsSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getSession with sessionId and userEmail', async () => {
    const mockData = { id: 's1', messages: [] };
    vi.mocked(getSession).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useAnalyticsSession('s1', 'user@test.com'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSession).toHaveBeenCalledWith('s1', 'user@test.com');
    expect(result.current.data).toEqual(mockData);
  });

  it('is disabled when sessionId is null', async () => {
    const { result } = renderHook(() => useAnalyticsSession(null, 'user@test.com'), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('is disabled when userEmail is empty', async () => {
    const { result } = renderHook(() => useAnalyticsSession('s1', ''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe('useDeleteSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls deleteSession with sessionId and userEmail', async () => {
    vi.mocked(deleteSession).mockResolvedValue({} as any);

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ sessionId: 's1', userEmail: 'user@test.com' });

    expect(deleteSession).toHaveBeenCalledWith('s1', 'user@test.com');
  });
});
