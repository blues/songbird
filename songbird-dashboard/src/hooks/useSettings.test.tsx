import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('@/api/settings', () => ({
  getFleetDefaults: vi.fn(),
  getAllFleetDefaults: vi.fn(),
  updateFleetDefaults: vi.fn(),
}));

vi.mock('@/api/notehub', () => ({
  getNotehubFleets: vi.fn(),
}));

import { getFleetDefaults, getAllFleetDefaults, updateFleetDefaults } from '@/api/settings';
import { getNotehubFleets } from '@/api/notehub';
import { useFleetDefaults, useAllFleetDefaults, useUpdateFleetDefaults, useNotehubFleets } from './useSettings';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const mockFleetDefaults = {
  fleetUid: 'fleet-123',
  mode: 'demo',
  alert_temp_high: 35,
  alert_temp_low: 0,
};

const mockAllDefaults = [mockFleetDefaults];

const mockFleets = [
  { uid: 'fleet-123', label: 'Default Fleet' },
];

describe('useFleetDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches fleet defaults', async () => {
    vi.mocked(getFleetDefaults).mockResolvedValue(mockFleetDefaults);
    const { result } = renderHook(() => useFleetDefaults('fleet-123'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockFleetDefaults);
    expect(getFleetDefaults).toHaveBeenCalledWith('fleet-123');
  });

  it('does not fetch when fleetUid is undefined', () => {
    const { result } = renderHook(() => useFleetDefaults(undefined), { wrapper: createWrapper() });
    expect(result.current.isFetching).toBe(false);
  });
});

describe('useAllFleetDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches all fleet defaults', async () => {
    vi.mocked(getAllFleetDefaults).mockResolvedValue(mockAllDefaults);
    const { result } = renderHook(() => useAllFleetDefaults(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockAllDefaults);
  });
});

describe('useUpdateFleetDefaults', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls updateFleetDefaults with correct args', async () => {
    vi.mocked(updateFleetDefaults).mockResolvedValue(mockFleetDefaults);
    const { result } = renderHook(() => useUpdateFleetDefaults(), { wrapper: createWrapper() });
    await result.current.mutateAsync({ fleetUid: 'fleet-123', config: { mode: 'transit' } });
    expect(updateFleetDefaults).toHaveBeenCalledWith('fleet-123', { mode: 'transit' });
  });
});

describe('useNotehubFleets', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fetches notehub fleets', async () => {
    vi.mocked(getNotehubFleets).mockResolvedValue(mockFleets);
    const { result } = renderHook(() => useNotehubFleets(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockFleets);
  });
});
