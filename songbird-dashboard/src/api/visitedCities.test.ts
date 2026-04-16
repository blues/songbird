import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
  apiPut: vi.fn().mockResolvedValue({}),
  apiPatch: vi.fn().mockResolvedValue({}),
  apiDelete: vi.fn().mockResolvedValue({}),
  apiFetch: vi.fn().mockResolvedValue({}),
  getApiBaseUrl: vi.fn().mockReturnValue('https://api.test.com'),
}));

import { apiGet } from './client';
import { getVisitedCities } from './visitedCities';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
});

describe('visitedCities API', () => {
  describe('getVisitedCities', () => {
    it('calls apiGet with correct endpoint and no optional params', async () => {
      await getVisitedCities('songbird01-bds');
      expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds/visited-cities', {});
    });

    it('includes from param when provided', async () => {
      await getVisitedCities('songbird01-bds', '2025-01-01');
      expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds/visited-cities', {
        from: '2025-01-01',
      });
    });

    it('includes to param when provided', async () => {
      await getVisitedCities('songbird01-bds', undefined, '2025-12-31');
      expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds/visited-cities', {
        to: '2025-12-31',
      });
    });

    it('includes both from and to params when provided', async () => {
      await getVisitedCities('songbird01-bds', '2025-01-01', '2025-12-31');
      expect(apiGet).toHaveBeenCalledWith('/v1/devices/songbird01-bds/visited-cities', {
        from: '2025-01-01',
        to: '2025-12-31',
      });
    });

    it('returns the response from apiGet', async () => {
      const mockResponse = {
        cities: [
          { city: 'Austin', state: 'TX', count: 5 },
          { city: 'Denver', state: 'CO', count: 2 },
        ],
      };
      vi.mocked(apiGet).mockResolvedValue(mockResponse);
      const result = await getVisitedCities('songbird01-bds');
      expect(result).toEqual(mockResponse);
    });
  });
});
