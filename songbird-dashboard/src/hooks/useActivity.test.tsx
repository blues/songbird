import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useActivity } from './useActivity';

vi.mock('@/api/activity', () => ({
  getActivity: vi.fn(),
}));

import { getActivity } from '@/api/activity';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getActivity with default args', async () => {
    const mockData = { activities: [{ id: '1', type: 'telemetry' }] };
    vi.mocked(getActivity).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getActivity).toHaveBeenCalledWith(24, 50);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes custom hours and limit', async () => {
    vi.mocked(getActivity).mockResolvedValue({ activities: [] } as any);

    const { result } = renderHook(() => useActivity(48, 100), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getActivity).toHaveBeenCalledWith(48, 100);
  });
});
