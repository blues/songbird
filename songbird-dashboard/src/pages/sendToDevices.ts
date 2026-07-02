/**
 * Resilient multi-device command send.
 *
 * The previous "send to all" loop awaited each mutation sequentially with no
 * error handling, so the first failing device aborted the entire batch and the
 * remaining devices never received the command. This helper sends to every
 * device independently (Promise.allSettled) so one failure can't abort the rest,
 * and reports per-device success/failure to the caller.
 */

export interface DeviceSendResult {
  deviceUid: string;
  ok: boolean;
  error?: unknown;
}

export interface BatchSendSummary {
  results: DeviceSendResult[];
  succeeded: number;
  failed: number;
}

/**
 * Send a command to many devices concurrently. `send` is invoked once per
 * deviceUid; a rejected promise marks that device failed but does NOT abort the
 * others.
 */
export async function sendToDevicesResilient(
  deviceUids: string[],
  send: (deviceUid: string) => Promise<unknown>
): Promise<BatchSendSummary> {
  const settled = await Promise.allSettled(
    deviceUids.map((uid) => send(uid))
  );

  const results: DeviceSendResult[] = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      return { deviceUid: deviceUids[i], ok: true };
    }
    return { deviceUid: deviceUids[i], ok: false, error: outcome.reason };
  });

  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded };
}
