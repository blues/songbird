import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useDevices, useDevice, useUpdateDevice, useMergeDevices } from './useDevices';

vi.mock('@/api/devices', () => ({
  getDevices: vi.fn(),
  getDevice: vi.fn(),
  updateDevice: vi.fn(),
  mergeDevices: vi.fn(),
}));

import { getDevices, getDevice, updateDevice, mergeDevices } from '@/api/devices';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getDevices and returns data', async () => {
    const mockData = { devices: [{ serial_number: 'sb01' }], count: 1 };
    vi.mocked(getDevices).mockResolvedValue(mockData as any);

    const { result } = renderHook(() => useDevices(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getDevices).toHaveBeenCalledWith(undefined);
    expect(result.current.data).toEqual(mockData);
  });

  it('has correct queryKey', async () => {
    vi.mocked(getDevices).mockResolvedValue({ devices: [], count: 0 } as any);

    const { result } = renderHook(() => useDevices(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // queryKey is ['devices', undefined] when no fleetUid
    expect(getDevices).toHaveBeenCalledWith(undefined);
  });

  it('passes fleetUid to getDevices', async () => {
    vi.mocked(getDevices).mockResolvedValue({ devices: [], count: 0 } as any);

    const { result } = renderHook(() => useDevices('fleet-123'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getDevices).toHaveBeenCalledWith('fleet-123');
  });
});

describe('useDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls getDevice with serialNumber', async () => {
    const mockDevice = { serial_number: 'sb01', name: 'Songbird 01' };
    vi.mocked(getDevice).mockResolvedValue(mockDevice as any);

    const { result } = renderHook(() => useDevice('sb01'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getDevice).toHaveBeenCalledWith('sb01');
    expect(result.current.data).toEqual(mockDevice);
  });

  it('is disabled when serialNumber is empty', async () => {
    const { result } = renderHook(() => useDevice(''), {
      wrapper: createWrapper(),
    });

    // Should not fetch when disabled
    expect(result.current.fetchStatus).toBe('idle');
    expect(getDevice).not.toHaveBeenCalled();
  });
});

describe('useUpdateDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls updateDevice with correct args', async () => {
    vi.mocked(updateDevice).mockResolvedValue({} as any);

    const { result } = renderHook(() => useUpdateDevice(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({
      serialNumber: 'sb01',
      updates: { name: 'New Name' },
    });

    expect(updateDevice).toHaveBeenCalledWith('sb01', { name: 'New Name' });
  });
});

describe('useMergeDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls mergeDevices with correct args', async () => {
    vi.mocked(mergeDevices).mockResolvedValue({} as any);

    const { result } = renderHook(() => useMergeDevices(), {
      wrapper: createWrapper(),
    });

    await result.current.mutateAsync({
      sourceSerialNumber: 'sb01',
      targetSerialNumber: 'sb02',
    });

    expect(mergeDevices).toHaveBeenCalledWith('sb01', 'sb02');
  });
});
