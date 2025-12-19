/**
 * Commands API
 */

import { apiGet, apiPost } from './client';
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
export async function getCommands(deviceUid: string): Promise<CommandsResponse> {
  return apiGet<CommandsResponse>(`/v1/devices/${deviceUid}/commands`);
}

/**
 * Send a command to a device
 */
export async function sendCommand(
  deviceUid: string,
  cmd: CommandType,
  params?: Record<string, unknown>
): Promise<CommandResponse> {
  return apiPost<CommandResponse>(`/v1/devices/${deviceUid}/commands`, {
    cmd,
    params,
  });
}

/**
 * Send a ping command
 */
export async function sendPing(deviceUid: string): Promise<CommandResponse> {
  return sendCommand(deviceUid, 'ping');
}

/**
 * Send a locate command
 */
export async function sendLocate(
  deviceUid: string,
  durationSec: number = 30
): Promise<CommandResponse> {
  return sendCommand(deviceUid, 'locate', { duration_sec: durationSec });
}

/**
 * Send a play melody command
 */
export async function sendPlayMelody(
  deviceUid: string,
  melody: string
): Promise<CommandResponse> {
  return sendCommand(deviceUid, 'play_melody', { melody });
}

/**
 * Send a test audio command
 */
export async function sendTestAudio(
  deviceUid: string,
  frequency: number,
  durationMs: number
): Promise<CommandResponse> {
  return sendCommand(deviceUid, 'test_audio', { frequency, duration_ms: durationMs });
}

/**
 * Send a set volume command
 */
export async function sendSetVolume(
  deviceUid: string,
  volume: number
): Promise<CommandResponse> {
  return sendCommand(deviceUid, 'set_volume', { volume });
}
