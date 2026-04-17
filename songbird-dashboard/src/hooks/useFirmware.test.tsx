import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('@/api/firmware', () => ({
  getHostFirmware: vi.fn(),
  queueFirmwareUpdate: vi.fn(),
  cancelFirmwareUpdate: vi.fn(),
  getDfuStatus: vi.fn(),
}));

import { getHostFirmware, queueFirmwareUpdate, cancelFirmwareUpdate, getDfuStatus } from '@/api/firmware';
import { useHostFirmware, useDfuStatus, useQueueFirmwareUpdate, useCancelFirmwareUpdate } from './useFirmware';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const mockFirmwareList = [
  { version: '1.2.0', filename: 'firmware-1.2.0.bin', size: 102400 },
  { version: '1.1.0', filename: 'firmware-1.1.0.bin', size: 98304 },
];

const mockDfuStatus = {
  status: 'idle',
  devices: [],
};

describe('useHostFirmware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches host firmware list', async () => {
    vi.mocked(getHostFirmware).mockResolvedValue(mockFirmwareList);
    const { result } = renderHook(() => useHostFirmware(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockFirmwareList);
  });
});

describe('useDfuStatus', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches DFU status when enabled', async () => {
    vi.mocked(getDfuStatus).mockResolvedValue(mockDfuStatus);
    const { result } = renderHook(() => useDfuStatus(true), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockDfuStatus);
  });

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useDfuStatus(false), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useQueueFirmwareUpdate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls queueFirmwareUpdate with request', async () => {
    const mockRequest = { fleetUID: 'fleet-123', filename: 'firmware-1.2.0.bin', version: '1.2.0' };
    vi.mocked(queueFirmwareUpdate).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useQueueFirmwareUpdate(), { wrapper: createWrapper() });
    await result.current.mutateAsync(mockRequest);
    expect(queueFirmwareUpdate).toHaveBeenCalledWith(mockRequest);
  });
});

describe('useCancelFirmwareUpdate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls cancelFirmwareUpdate with correct args', async () => {
    vi.mocked(cancelFirmwareUpdate).mockResolvedValue({ success: true });
    const { result } = renderHook(() => useCancelFirmwareUpdate(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ fleetUID: 'fleet-123', deviceUID: 'dev:123' });
    expect(cancelFirmwareUpdate).toHaveBeenCalledWith('fleet-123', 'dev:123');
  });
});
