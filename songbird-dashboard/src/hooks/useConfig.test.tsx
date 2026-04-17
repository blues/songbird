import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('@/api/config', () => ({
  getDeviceConfig: vi.fn(),
  updateDeviceConfig: vi.fn(),
  updateFleetConfig: vi.fn(),
  setDeviceWifi: vi.fn(),
}));

import { getDeviceConfig, updateDeviceConfig, updateFleetConfig, setDeviceWifi } from '@/api/config';
import { useDeviceConfig, useUpdateDeviceConfig, useUpdateFleetConfig, useSetDeviceWifi } from './useConfig';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const mockConfig = {
  serialNumber: 'songbird01-bds',
  mode: 'demo',
  alert_temp_high: 35,
  alert_temp_low: 0,
  volume: 50,
};

describe('useDeviceConfig', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches device config', async () => {
    vi.mocked(getDeviceConfig).mockResolvedValue(mockConfig);
    const { result } = renderHook(() => useDeviceConfig('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockConfig);
    expect(getDeviceConfig).toHaveBeenCalledWith('songbird01-bds');
  });

  it('does not fetch when serialNumber is empty', () => {
    const { result } = renderHook(() => useDeviceConfig(''), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useUpdateDeviceConfig', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls updateDeviceConfig with correct args', async () => {
    vi.mocked(updateDeviceConfig).mockResolvedValue(mockConfig);
    const { result } = renderHook(() => useUpdateDeviceConfig(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ serialNumber: 'songbird01-bds', config: { mode: 'transit' } });
    expect(updateDeviceConfig).toHaveBeenCalledWith('songbird01-bds', { mode: 'transit' });
  });
});

describe('useUpdateFleetConfig', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls updateFleetConfig with correct args', async () => {
    vi.mocked(updateFleetConfig).mockResolvedValue(mockConfig);
    const { result } = renderHook(() => useUpdateFleetConfig(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ fleetUid: 'fleet-123', config: { volume: 75 } });
    expect(updateFleetConfig).toHaveBeenCalledWith('fleet-123', { volume: 75 });
  });
});

describe('useSetDeviceWifi', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls setDeviceWifi with correct args', async () => {
    vi.mocked(setDeviceWifi).mockResolvedValue({ success: true, message: 'OK' });
    const { result } = renderHook(() => useSetDeviceWifi(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ serialNumber: 'songbird01-bds', ssid: 'MyWifi', password: 'pass123' });
    expect(setDeviceWifi).toHaveBeenCalledWith('songbird01-bds', 'MyWifi', 'pass123');
  });
});
