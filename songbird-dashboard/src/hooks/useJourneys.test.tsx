import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import {
  useJourneys,
  useJourneyDetail,
  useLocationHistoryFull,
  useLatestJourney,
  useMapMatch,
  useDeleteJourney,
} from './useJourneys';

vi.mock('@/api/journeys', () => ({
  getJourneys: vi.fn(),
  getJourneyDetail: vi.fn(),
  getLocationHistoryFull: vi.fn(),
  matchJourney: vi.fn(),
  deleteJourney: vi.fn(),
}));

import {
  getJourneys,
  getJourneyDetail,
  getLocationHistoryFull,
  matchJourney,
  deleteJourney,
} from '@/api/journeys';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useJourneys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getJourneys and returns data', async () => {
    const mockData = { journeys: [{ journey_id: 1 }], count: 1 };
    vi.mocked(getJourneys).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useJourneys('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getJourneys).toHaveBeenCalledWith('sb01', undefined, 50);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes status and limit', async () => {
    vi.mocked(getJourneys).mockResolvedValue({ journeys: [], count: 0 } as any);

    const { result } = renderHook(() => useJourneys('sb01', 'active', 10), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getJourneys).toHaveBeenCalledWith('sb01', 'active', 10);
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useJourneys(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getJourneys).not.toHaveBeenCalled();
  });
});

describe('useJourneyDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getJourneyDetail with serialNumber and journeyId', async () => {
    const mockData = { journey_id: 123, points: [] };
    vi.mocked(getJourneyDetail).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useJourneyDetail('sb01', 123), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getJourneyDetail).toHaveBeenCalledWith('sb01', 123);
    expect(result.current.data).toEqual(mockData);
  });

  it('is disabled when journeyId is null', async () => {
    const { result } = renderHook(() => useJourneyDetail('sb01', null), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getJourneyDetail).not.toHaveBeenCalled();
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useJourneyDetail('', 123), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getJourneyDetail).not.toHaveBeenCalled();
  });
});

describe('useLocationHistoryFull', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getLocationHistoryFull with defaults', async () => {
    const mockData = { locations: [] };
    vi.mocked(getLocationHistoryFull).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useLocationHistoryFull('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getLocationHistoryFull).toHaveBeenCalledWith('sb01', 24, undefined);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes hours and source', async () => {
    vi.mocked(getLocationHistoryFull).mockResolvedValue({ locations: [] } as any);

    const { result } = renderHook(() => useLocationHistoryFull('sb01', 48, 'gps'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getLocationHistoryFull).toHaveBeenCalledWith('sb01', 48, 'gps');
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useLocationHistoryFull(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getLocationHistoryFull).not.toHaveBeenCalled();
  });
});

describe('useLatestJourney', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first journey from useJourneys', async () => {
    const mockJourney = { journey_id: 99, status: 'completed' };
    vi.mocked(getJourneys).mockResolvedValue({ journeys: [mockJourney], count: 1 } as any);

    const { result } = renderHook(() => useLatestJourney('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getJourneys).toHaveBeenCalledWith('sb01', undefined, 1);
    expect(result.current.data).toEqual(mockJourney);
  });

  it('returns null when no journeys exist', async () => {
    vi.mocked(getJourneys).mockResolvedValue({ journeys: [], count: 0 } as any);

    const { result } = renderHook(() => useLatestJourney('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useMapMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls matchJourney with serialNumber and journeyId', async () => {
    vi.mocked(matchJourney).mockResolvedValue({} as any);

    const { result } = renderHook(() => useMapMatch('sb01', 123), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync();

    expect(matchJourney).toHaveBeenCalledWith('sb01', 123);
  });

  it('throws when journeyId is null', async () => {
    const { result } = renderHook(() => useMapMatch('sb01', null), {
      wrapper: createWrapper(),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow('Journey ID required');
    expect(matchJourney).not.toHaveBeenCalled();
  });
});

describe('useDeleteJourney', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls deleteJourney with serialNumber and journeyId', async () => {
    vi.mocked(deleteJourney).mockResolvedValue({} as any);

    const { result } = renderHook(() => useDeleteJourney(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ serialNumber: 'sb01', journeyId: 123 });

    expect(deleteJourney).toHaveBeenCalledWith('sb01', 123);
  });
});
