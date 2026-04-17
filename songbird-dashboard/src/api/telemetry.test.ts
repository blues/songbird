import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
}));

import { apiGet } from './client';
import { getTelemetry, getLocationHistory, getPowerHistory, getHealthHistory } from './telemetry';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
});

describe('getTelemetry', () => {
  it('calls apiGet with default hours and limit', async () => {
    await getTelemetry('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/telemetry', {
      hours: 24,
      limit: 1000,
    });
  });

  it('calls apiGet with custom hours and limit', async () => {
    await getTelemetry('sb01', 48, 500);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/telemetry', {
      hours: 48,
      limit: 500,
    });
  });
});

describe('getLocationHistory', () => {
  it('calls apiGet with default hours and limit', async () => {
    await getLocationHistory('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/location', {
      hours: 24,
      limit: 1000,
    });
  });

  it('calls apiGet with custom hours and limit', async () => {
    await getLocationHistory('sb01', 12, 200);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/location', {
      hours: 12,
      limit: 200,
    });
  });
});

describe('getPowerHistory', () => {
  it('calls apiGet with default hours and limit', async () => {
    await getPowerHistory('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/power', {
      hours: 24,
      limit: 1000,
    });
  });

  it('calls apiGet with custom hours and limit', async () => {
    await getPowerHistory('sb01', 72, 50);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/power', {
      hours: 72,
      limit: 50,
    });
  });
});

describe('getHealthHistory', () => {
  it('calls apiGet with default hours (168) and limit (100)', async () => {
    await getHealthHistory('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/health', {
      hours: 168,
      limit: 100,
    });
  });

  it('calls apiGet with custom hours and limit', async () => {
    await getHealthHistory('sb01', 24, 10);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/health', {
      hours: 24,
      limit: 10,
    });
  });
});
