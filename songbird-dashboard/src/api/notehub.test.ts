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
import { getNotehubStatus, getNotehubFleets } from './notehub';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
});

describe('notehub API', () => {
  describe('getNotehubStatus', () => {
    it('calls apiGet with the correct endpoint', async () => {
      await getNotehubStatus();
      expect(apiGet).toHaveBeenCalledWith('/v1/notehub/status');
    });

    it('returns the response from apiGet', async () => {
      const mockStatus = { connected: true, projectUID: 'app:12345' };
      vi.mocked(apiGet).mockResolvedValue(mockStatus);
      const result = await getNotehubStatus();
      expect(result).toEqual(mockStatus);
    });
  });

  describe('getNotehubFleets', () => {
    it('calls apiGet with the correct endpoint', async () => {
      vi.mocked(apiGet).mockResolvedValue({ fleets: [] });
      await getNotehubFleets();
      expect(apiGet).toHaveBeenCalledWith('/v1/notehub/fleets');
    });

    it('returns the fleets array from the response', async () => {
      const fleets = [
        { uid: 'fleet:1', label: 'Fleet A' },
        { uid: 'fleet:2', label: 'Fleet B' },
      ];
      vi.mocked(apiGet).mockResolvedValue({ fleets });
      const result = await getNotehubFleets();
      expect(result).toEqual(fleets);
    });
  });
});
