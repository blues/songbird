import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
}));

import { apiGet, apiPost, apiDelete } from './client';
import {
  getJourneys,
  getJourneyDetail,
  matchJourney,
  getLocationHistoryFull,
  deleteJourney,
} from './journeys';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
  vi.mocked(apiDelete).mockReset().mockResolvedValue({});
});

describe('getJourneys', () => {
  it('calls apiGet with default limit and no status', async () => {
    await getJourneys('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/journeys', { limit: 50 });
  });

  it('calls apiGet with status filter', async () => {
    await getJourneys('sb01', 'active');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/journeys', {
      limit: 50,
      status: 'active',
    });
  });

  it('calls apiGet with custom limit', async () => {
    await getJourneys('sb01', 'completed', 10);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/journeys', {
      limit: 10,
      status: 'completed',
    });
  });
});

describe('getJourneyDetail', () => {
  it('calls apiGet with serial number and journey ID', async () => {
    await getJourneyDetail('sb01', 1700000000);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/journeys/1700000000');
  });
});

describe('matchJourney', () => {
  it('calls apiPost with the match endpoint', async () => {
    await matchJourney('sb01', 1700000000);
    expect(apiPost).toHaveBeenCalledWith('/v1/devices/sb01/journeys/1700000000/match');
  });
});

describe('getLocationHistoryFull', () => {
  it('calls apiGet with default params and no source', async () => {
    await getLocationHistoryFull('sb01');
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/locations', {
      hours: 24,
      limit: 1000,
    });
  });

  it('calls apiGet with source filter', async () => {
    await getLocationHistoryFull('sb01', 48, 'gps', 500);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/locations', {
      hours: 48,
      limit: 500,
      source: 'gps',
    });
  });

  it('calls apiGet without source when not provided', async () => {
    await getLocationHistoryFull('sb01', 12, undefined, 200);
    expect(apiGet).toHaveBeenCalledWith('/v1/devices/sb01/locations', {
      hours: 12,
      limit: 200,
    });
  });
});

describe('deleteJourney', () => {
  it('calls apiDelete with serial number and journey ID', async () => {
    await deleteJourney('sb01', 1700000000);
    expect(apiDelete).toHaveBeenCalledWith('/v1/devices/sb01/journeys/1700000000');
  });
});
