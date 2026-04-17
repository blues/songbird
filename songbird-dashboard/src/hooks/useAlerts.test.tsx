import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import {
  useAlerts,
  useActiveAlerts,
  useDeviceAlerts,
  useAlert,
  useAcknowledgeAlert,
  useBulkAcknowledgeAlerts,
} from './useAlerts';

vi.mock('@/api/alerts', () => ({
  getAlerts: vi.fn(),
  getAlert: vi.fn(),
  acknowledgeAlert: vi.fn(),
  acknowledgeAllAlerts: vi.fn(),
}));

import { getAlerts, getAlert, acknowledgeAlert, acknowledgeAllAlerts } from '@/api/alerts';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getAlerts with no params', async () => {
    const mockData = { alerts: [], count: 0, active_count: 0 };
    vi.mocked(getAlerts).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useAlerts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAlerts).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(mockData);
  });

  it('passes params to getAlerts', async () => {
    vi.mocked(getAlerts).mockResolvedValue({ alerts: [], count: 0, active_count: 0 } as any);

    const { result } = renderHook(() => useAlerts({ serial_number: 'sb01' }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAlerts).toHaveBeenCalledWith({ serial_number: 'sb01' });
  });
});

describe('useActiveAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getAlerts with acknowledged: false', async () => {
    vi.mocked(getAlerts).mockResolvedValue({ alerts: [], count: 0, active_count: 0 } as any);

    const { result } = renderHook(() => useActiveAlerts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAlerts).toHaveBeenCalledWith({ acknowledged: false });
  });
});

describe('useDeviceAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getAlerts with serial_number', async () => {
    vi.mocked(getAlerts).mockResolvedValue({ alerts: [], count: 0, active_count: 0 } as any);

    const { result } = renderHook(() => useDeviceAlerts('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAlerts).toHaveBeenCalledWith({ serial_number: 'sb01' });
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useDeviceAlerts(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getAlerts).not.toHaveBeenCalled();
  });
});

describe('useAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getAlert with alertId', async () => {
    const mockAlert = { id: 'alert-1', type: 'temp_high' };
    vi.mocked(getAlert).mockResolvedValue(mockAlert as any);

    const { result } = renderHook(() => useAlert('alert-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAlert).toHaveBeenCalledWith('alert-1');
    expect(result.current.data).toEqual(mockAlert);
  });

  it('is disabled when alertId is empty', async () => {
    const { result } = renderHook(() => useAlert(''), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getAlert).not.toHaveBeenCalled();
  });
});

describe('useAcknowledgeAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls acknowledgeAlert with correct args', async () => {
    vi.mocked(acknowledgeAlert).mockResolvedValue({} as any);

    const { result } = renderHook(() => useAcknowledgeAlert(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({ alertId: 'alert-1', acknowledgedBy: 'user@test.com' });

    expect(acknowledgeAlert).toHaveBeenCalledWith('alert-1', 'user@test.com');
  });
});

describe('useBulkAcknowledgeAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls acknowledgeAllAlerts with correct args', async () => {
    vi.mocked(acknowledgeAllAlerts).mockResolvedValue({
      acknowledged: 2,
      failed: 0,
      total: 2,
    } as any);

    const { result } = renderHook(() => useBulkAcknowledgeAlerts(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({
      alertIds: ['alert-1', 'alert-2'],
      acknowledgedBy: 'admin@test.com',
    });

    expect(acknowledgeAllAlerts).toHaveBeenCalledWith(
      ['alert-1', 'alert-2'],
      'admin@test.com'
    );
  });
});
