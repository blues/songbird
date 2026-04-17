import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./client', () => ({
  apiGet: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
}));

import { apiGet, apiPost } from './client';
import { getAlerts, getAlert, acknowledgeAlert, acknowledgeAllAlerts } from './alerts';

beforeEach(() => {
  vi.mocked(apiGet).mockReset().mockResolvedValue({});
  vi.mocked(apiPost).mockReset().mockResolvedValue({});
});

describe('getAlerts', () => {
  it('calls apiGet with /v1/alerts and no params when called without args', async () => {
    await getAlerts();
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts', undefined);
  });

  it('passes serial_number as a query param', async () => {
    await getAlerts({ serial_number: 'sb01' });
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts', { serial_number: 'sb01' });
  });

  it('passes acknowledged flag as a query param', async () => {
    await getAlerts({ acknowledged: false });
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts', { acknowledged: false });
  });

  it('passes limit as a query param', async () => {
    await getAlerts({ limit: 50 });
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts', { limit: 50 });
  });

  it('passes all params combined', async () => {
    await getAlerts({ serial_number: 'sb01', acknowledged: true, limit: 10 });
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts', {
      serial_number: 'sb01',
      acknowledged: true,
      limit: 10,
    });
  });
});

describe('getAlert', () => {
  it('calls apiGet with the alert ID', async () => {
    await getAlert('alert-abc');
    expect(apiGet).toHaveBeenCalledWith('/v1/alerts/alert-abc');
  });
});

describe('acknowledgeAlert', () => {
  it('calls apiPost with alert ID and acknowledged_by', async () => {
    await acknowledgeAlert('alert-abc', 'user@test.com');
    expect(apiPost).toHaveBeenCalledWith('/v1/alerts/alert-abc/acknowledge', {
      acknowledged_by: 'user@test.com',
    });
  });

  it('calls apiPost with undefined acknowledged_by when not provided', async () => {
    await acknowledgeAlert('alert-abc');
    expect(apiPost).toHaveBeenCalledWith('/v1/alerts/alert-abc/acknowledge', {
      acknowledged_by: undefined,
    });
  });
});

describe('acknowledgeAllAlerts', () => {
  it('calls apiPost with alert IDs and acknowledged_by', async () => {
    await acknowledgeAllAlerts(['a1', 'a2', 'a3'], 'admin@test.com');
    expect(apiPost).toHaveBeenCalledWith('/v1/alerts/acknowledge-all', {
      alert_ids: ['a1', 'a2', 'a3'],
      acknowledged_by: 'admin@test.com',
    });
  });

  it('calls apiPost without acknowledged_by when not provided', async () => {
    await acknowledgeAllAlerts(['a1']);
    expect(apiPost).toHaveBeenCalledWith('/v1/alerts/acknowledge-all', {
      alert_ids: ['a1'],
      acknowledged_by: undefined,
    });
  });
});
