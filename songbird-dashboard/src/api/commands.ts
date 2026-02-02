/**
 * Commands API
 */

import { apiGet, apiPost, apiDelete } from './client';
import type { Command, CommandResponse, CommandType } from '@/types';

interface CommandsResponse {
  device_uid: string;
  commands: Command[];
}

interface AllCommandsResponse {
  commands: Command[];
  total: number;
}

/**
 * Get all commands across all devices (optionally filtered by device)
 */
export async function getAllCommands(deviceUid?: string): Promise<AllCommandsResponse> {
  const params = deviceUid ? { device_uid: deviceUid } : undefined;
  return apiGet<AllCommandsResponse>('/v1/commands', params);
}

/**
 * Get command history for a device
 */
export async function getCommands(serialNumber: string): Promise<CommandsResponse> {
  return apiGet<CommandsResponse>(`/v1/devices/${serialNumber}/commands`);
}

/**
 * Send a command to a device
 */
export async function sendCommand(
  serialNumber: string,
  cmd: CommandType,
  params?: Record<string, unknown>
): Promise<CommandResponse> {
  return apiPost<CommandResponse>(`/v1/devices/${serialNumber}/commands`, {
    cmd,
    params,
  });
}

/**
 * Send a ping command
 */
export async function sendPing(serialNumber: string): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'ping');
}

/**
 * Send a locate command
 */
export async function sendLocate(
  serialNumber: string,
  durationSec: number = 30
): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'locate', { duration_sec: durationSec });
}

/**
 * Send a play melody command
 */
export async function sendPlayMelody(
  serialNumber: string,
  melody: string
): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'play_melody', { melody });
}

/**
 * Send a test audio command
 */
export async function sendTestAudio(
  serialNumber: string,
  frequency: number,
  durationMs: number
): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'test_audio', { frequency, duration_ms: durationMs });
}

/**
 * Send a set volume command
 */
export async function sendSetVolume(
  serialNumber: string,
  volume: number
): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'set_volume', { volume });
}

export type UnlockType = 'transit' | 'demo' | 'all';

/**
 * Send an unlock command to clear transit or demo lock
 */
export async function sendUnlock(
  serialNumber: string,
  lockType: UnlockType = 'all'
): Promise<CommandResponse> {
  return sendCommand(serialNumber, 'unlock', { lock_type: lockType });
}

/**
 * Delete a command from history
 */
export async function deleteCommand(
  commandId: string,
  deviceUid: string
): Promise<{ message: string; command_id: string }> {
  return apiDelete(`/v1/commands/${commandId}?device_uid=${encodeURIComponent(deviceUid)}`);
}
