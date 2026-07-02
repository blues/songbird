import { describe, it, expect, vi } from 'vitest';
import { sendToDevicesResilient } from './sendToDevices';

describe('sendToDevicesResilient', () => {
  it('sends to all devices even when one fails (one failure does not abort the rest)', async () => {
    const send = vi.fn(async (uid: string) => {
      if (uid === 'dev-2') throw new Error('boom');
      return `ok:${uid}`;
    });

    const summary = await sendToDevicesResilient(['dev-1', 'dev-2', 'dev-3'], send);

    // Every device was attempted despite dev-2 failing.
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith('dev-1');
    expect(send).toHaveBeenCalledWith('dev-2');
    expect(send).toHaveBeenCalledWith('dev-3');

    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);

    const failed = summary.results.find((r) => !r.ok);
    expect(failed?.deviceUid).toBe('dev-2');
    expect(summary.results.filter((r) => r.ok).map((r) => r.deviceUid)).toEqual([
      'dev-1',
      'dev-3',
    ]);
  });

  it('reports all successes when nothing fails', async () => {
    const send = vi.fn(async () => 'ok');
    const summary = await sendToDevicesResilient(['a', 'b'], send);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('handles an empty device list', async () => {
    const send = vi.fn();
    const summary = await sendToDevicesResilient([], send);
    expect(send).not.toHaveBeenCalled();
    expect(summary).toEqual({ results: [], succeeded: 0, failed: 0 });
  });
});
