import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useVisitedCities } from './useVisitedCities';

vi.mock('@/api/visitedCities', () => ({
  getVisitedCities: vi.fn(),
}));

import { getVisitedCities } from '@/api/visitedCities';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useVisitedCities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getVisitedCities and returns data', async () => {
    const mockData = { cities: [{ city: 'Austin', count: 3 }] };
    vi.mocked(getVisitedCities).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useVisitedCities('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getVisitedCities).toHaveBeenCalledWith('sb01', undefined, undefined);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes from and to parameters', async () => {
    vi.mocked(getVisitedCities).mockResolvedValue({ cities: [] } as any);

    const { result } = renderHook(
      () => useVisitedCities('sb01', '2025-01-01', '2025-12-31'),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getVisitedCities).toHaveBeenCalledWith('sb01', '2025-01-01', '2025-12-31');
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useVisitedCities(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getVisitedCities).not.toHaveBeenCalled();
  });
});
