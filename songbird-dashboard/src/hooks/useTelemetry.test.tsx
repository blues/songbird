import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('@/api/telemetry', () => ({
  getTelemetry: vi.fn(),
  getLocationHistory: vi.fn(),
  getPowerHistory: vi.fn(),
  getHealthHistory: vi.fn(),
}));

import { getTelemetry, getLocationHistory, getPowerHistory, getHealthHistory } from '@/api/telemetry';
import { useTelemetry, useLocationHistory, useLatestTelemetry, usePowerHistory, useHealthHistory } from './useTelemetry';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const mockTelemetryResponse = {
  telemetry: [
    { temperature: 22.5, humidity: 45, pressure: 1013, time: '2025-01-01T00:00:00Z' },
    { temperature: 23.0, humidity: 46, pressure: 1014, time: '2025-01-01T01:00:00Z' },
  ],
};

const mockLocationResponse = {
  locations: [
    { lat: 40.7128, lon: -74.006, time: '2025-01-01T00:00:00Z' },
  ],
};

const mockPowerResponse = {
  power: [
    { voltage: 3.7, current: 120, time: '2025-01-01T00:00:00Z' },
  ],
};

const mockHealthResponse = {
  health: [
    { storage: 50, uptime: 3600, time: '2025-01-01T00:00:00Z' },
  ],
};

describe('useTelemetry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches telemetry data', async () => {
    vi.mocked(getTelemetry).mockResolvedValue(mockTelemetryResponse);
    const { result } = renderHook(() => useTelemetry('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockTelemetryResponse);
    expect(getTelemetry).toHaveBeenCalledWith('songbird01-bds', 24, 1000);
  });

  it('passes custom hours and limit', async () => {
    vi.mocked(getTelemetry).mockResolvedValue(mockTelemetryResponse);
    const { result } = renderHook(() => useTelemetry('songbird01-bds', 48, 5000), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getTelemetry).toHaveBeenCalledWith('songbird01-bds', 48, 5000);
  });

  it('does not fetch when serialNumber is empty', () => {
    const { result } = renderHook(() => useTelemetry(''), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useLocationHistory', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches location history', async () => {
    vi.mocked(getLocationHistory).mockResolvedValue(mockLocationResponse);
    const { result } = renderHook(() => useLocationHistory('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockLocationResponse);
    expect(getLocationHistory).toHaveBeenCalledWith('songbird01-bds', 24);
  });

  it('does not fetch when serialNumber is empty', () => {
    const { result } = renderHook(() => useLocationHistory(''), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useLatestTelemetry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('extracts latest telemetry values', async () => {
    vi.mocked(getTelemetry).mockResolvedValue(mockTelemetryResponse);
    const { result } = renderHook(() => useLatestTelemetry('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      temperature: 22.5,
      humidity: 45,
      pressure: 1013,
      time: '2025-01-01T00:00:00Z',
    });
  });

  it('returns undefined data when no telemetry', async () => {
    vi.mocked(getTelemetry).mockResolvedValue({ telemetry: [] });
    const { result } = renderHook(() => useLatestTelemetry('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('usePowerHistory', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches power history', async () => {
    vi.mocked(getPowerHistory).mockResolvedValue(mockPowerResponse);
    const { result } = renderHook(() => usePowerHistory('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockPowerResponse);
    expect(getPowerHistory).toHaveBeenCalledWith('songbird01-bds', 24, 1000);
  });

  it('does not fetch when serialNumber is empty', () => {
    const { result } = renderHook(() => usePowerHistory(''), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useHealthHistory', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches health history', async () => {
    vi.mocked(getHealthHistory).mockResolvedValue(mockHealthResponse);
    const { result } = renderHook(() => useHealthHistory('songbird01-bds'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockHealthResponse);
    expect(getHealthHistory).toHaveBeenCalledWith('songbird01-bds', 168);
  });

  it('does not fetch when serialNumber is empty', () => {
    const { result } = renderHook(() => useHealthHistory(''), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});
