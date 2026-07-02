import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import {
  PublicDeviceView,
  isValidSerialNumber,
  serialNumberSchema,
} from './PublicDeviceView';

const mockGetPublicDevice = vi.fn();

vi.mock('@/api/devices', () => ({
  getPublicDevice: (sn: string) => mockGetPublicDevice(sn),
}));

// Auth check resolves to unauthenticated so we render the public view path.
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(async () => ({ tokens: undefined })),
}));

// Heavy child components aren't relevant to this test.
vi.mock('@/components/maps/LocationTrail', () => ({ LocationTrail: () => null }));
vi.mock('@/components/charts/TelemetryChart', () => ({ TelemetryChart: () => null }));
vi.mock('@/components/charts/GaugeCard', () => ({ GaugeCard: () => null }));

function renderAt(serial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/public/device/${serial}`]}>
        <Routes>
          <Route
            path="/public/device/:serialNumber"
            element={<PublicDeviceView mapboxToken="pk.test" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('serialNumberSchema / isValidSerialNumber', () => {
  it('accepts normal alphanumeric serials', () => {
    expect(isValidSerialNumber('sb01')).toBe(true);
    expect(isValidSerialNumber('DEV_123-abc')).toBe(true);
  });

  it('rejects empty, oversized, and injection-style values', () => {
    expect(isValidSerialNumber('')).toBe(false);
    expect(isValidSerialNumber(undefined)).toBe(false);
    expect(isValidSerialNumber('a'.repeat(65))).toBe(false);
    expect(isValidSerialNumber('../../etc/passwd')).toBe(false);
    expect(isValidSerialNumber('sb01/config')).toBe(false);
    expect(isValidSerialNumber('sb 01')).toBe(false);
    expect(serialNumberSchema.safeParse('<script>').success).toBe(false);
  });
});

describe('PublicDeviceView query gating', () => {
  beforeEach(() => {
    mockGetPublicDevice.mockReset();
    mockGetPublicDevice.mockResolvedValue({ serial_number: 'sb01' });
  });

  it('does NOT enable the query for an invalid serial number', async () => {
    renderAt('..%2Fadmin');
    // The invalid-serial guard renders "Device Not Found" and the query never runs.
    expect(await screen.findByText('Device Not Found')).toBeTruthy();
    expect(mockGetPublicDevice).not.toHaveBeenCalled();
  });

  it('enables the query for a valid serial number', async () => {
    renderAt('sb01');
    await vi.waitFor(() => expect(mockGetPublicDevice).toHaveBeenCalledWith('sb01'));
  });
});
