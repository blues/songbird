/**
 * API Firmware Lambda
 *
 * Handles host firmware management operations via Notehub API.
 * All endpoints are admin-only.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});

const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID || '';
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN || '';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// Cache the token to avoid fetching on every request
let cachedToken: string | null = null;

async function getNotehubToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  const command = new GetSecretValueCommand({ SecretId: NOTEHUB_SECRET_ARN });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Notehub API token not found in secret');
  }

  const secret = JSON.parse(response.SecretString);
  cachedToken = secret.token;

  if (!cachedToken) {
    throw new Error('Token field not found in secret');
  }

  return cachedToken;
}

function isAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): boolean {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims) return false;

    const groups = claims['cognito:groups'];
    if (Array.isArray(groups)) {
      return groups.includes('Admin');
    }
    if (typeof groups === 'string') {
      return groups === 'Admin' || groups.includes('Admin');
    }
    return false;
  } catch {
    return false;
  }
}

interface HostFirmwareVersion {
  version?: string;
  organization?: string;
  description?: string;
  product?: string;
  built?: string;
  builder?: string;
}

// Notehub firmware response - handle various field name possibilities
interface HostFirmware {
  filename: string;
  version?: string | HostFirmwareVersion;
  created?: string;
  uploaded?: string;
  modified?: string;
  type: string;
  target?: string;
  md5?: string;
  length?: number;
  size?: number;
  // Additional fields that might be returned
  [key: string]: unknown;
}

interface DfuUpdateEntry {
  status?: string;
  phase?: string;
  datetime?: string;
  description?: string;
}

interface DfuDeviceStatusInfo {
  requested_version?: string;
  current_version?: string;
  initiated?: string;
  updates?: DfuUpdateEntry[];
}

interface DfuCurrentVersion {
  version?: string;
  organization?: string;
  description?: string;
  product?: string;
  built?: string;
  builder?: string;
}

interface DfuDeviceStatus {
  device_uid: string;
  sn?: string;
  current?: string | DfuCurrentVersion;
  requested?: string;
  status?: string | DfuDeviceStatusInfo;
  began?: string;
  updates?: DfuUpdateEntry[];
}

interface DfuStatusResponse {
  firmware_type?: string;
  devices?: DfuDeviceStatus[];
}

async function fetchNotehubApi<T>(
  path: string,
  method: string = 'GET',
  body?: unknown
): Promise<T> {
  const token = await getNotehubToken();

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://api.notefile.net${path}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notehub API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // Handle empty responses (some POST endpoints return empty body)
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text);
}

async function getHostFirmware(): Promise<HostFirmware[]> {
  const result = await fetchNotehubApi<HostFirmware[]>(
    `/v1/projects/${NOTEHUB_PROJECT_UID}/firmware?firmwareType=host`
  );
  return result || [];
}

async function queueFirmwareUpdate(
  filename: string,
  fleetUID?: string,
  deviceUID?: string
): Promise<{ message: string }> {
  let path = `/v1/projects/${NOTEHUB_PROJECT_UID}/dfu/host/update`;
  const queryParams: string[] = [];

  if (fleetUID) {
    queryParams.push(`fleetUID=${encodeURIComponent(fleetUID)}`);
  }
  if (deviceUID) {
    queryParams.push(`deviceUID=${encodeURIComponent(deviceUID)}`);
  }

  if (queryParams.length > 0) {
    path += `?${queryParams.join('&')}`;
  }

  await fetchNotehubApi<unknown>(path, 'POST', { filename });

  return { message: 'Firmware update queued successfully' };
}

async function cancelFirmwareUpdate(
  fleetUID?: string,
  deviceUID?: string
): Promise<{ message: string }> {
  let path = `/v1/projects/${NOTEHUB_PROJECT_UID}/dfu/host/cancel`;
  const queryParams: string[] = [];

  if (fleetUID) {
    queryParams.push(`fleetUID=${encodeURIComponent(fleetUID)}`);
  }
  if (deviceUID) {
    queryParams.push(`deviceUID=${encodeURIComponent(deviceUID)}`);
  }

  if (queryParams.length > 0) {
    path += `?${queryParams.join('&')}`;
  }

  await fetchNotehubApi<unknown>(path, 'POST');

  return { message: 'Firmware update cancelled' };
}

async function getDfuStatus(): Promise<DfuStatusResponse> {
  const result = await fetchNotehubApi<DfuStatusResponse>(
    `/v1/projects/${NOTEHUB_PROJECT_UID}/dfu/host/status`
  );
  return result;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // All firmware endpoints require admin access
  if (!isAdmin(event)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({ error: 'Admin access required' }),
    };
  }

  try {
    // GET /v1/firmware - List available host firmware
    if (method === 'GET' && path === '/v1/firmware') {
      const firmware = await getHostFirmware();

      // Debug: log raw firmware response
      console.log('Raw firmware response:', JSON.stringify(firmware, null, 2));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          firmware: firmware.map(f => {
            // Extract version string from version object if needed
            let versionStr: string | undefined;
            if (typeof f.version === 'string') {
              versionStr = f.version;
            } else if (f.version && typeof f.version === 'object') {
              const vObj = f.version as HostFirmwareVersion;
              versionStr = vObj.version;
            }

            // Convert Unix timestamp to ISO date string
            // Notehub returns created as a Unix timestamp string like "1766937920"
            let dateValue: string | undefined;
            const rawDate = f.created || f.uploaded || f.modified;
            if (rawDate) {
              const timestamp = parseInt(String(rawDate), 10);
              if (!isNaN(timestamp)) {
                // Unix timestamp - convert to ISO string
                dateValue = new Date(timestamp * 1000).toISOString();
              } else {
                // Already an ISO string or other format
                dateValue = String(rawDate);
              }
            }

            // Try all possible size field names
            const sizeValue = f.length || f.size;

            return {
              filename: f.filename,
              version: versionStr,
              created: dateValue,
              type: f.type,
              target: f.target,
              md5: f.md5,
              size: sizeValue,
            };
          }),
        }),
      };
    }

    // GET /v1/firmware/status - Get DFU status
    if (method === 'GET' && path === '/v1/firmware/status') {
      const status = await getDfuStatus();

      // Debug: log raw DFU status response
      console.log('Raw DFU status response:', JSON.stringify(status, null, 2));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          firmware_type: status.firmware_type || 'host',
          devices: (status.devices || []).map(d => {
            // Extract current version - it's an object with version property
            let currentVersion: string | undefined;
            if (typeof d.current === 'string') {
              currentVersion = d.current;
            } else if (d.current && typeof d.current === 'object') {
              currentVersion = d.current.version;
            }

            // Status is an object with requested_version, current_version, updates, etc.
            let requestedVersion: string | undefined;
            let statusPhase: string | undefined;
            let initiated: string | undefined;
            let updates: Array<{ when: string; status: string }> | undefined;

            if (d.status && typeof d.status === 'object') {
              const statusObj = d.status as DfuDeviceStatusInfo;
              requestedVersion = statusObj.requested_version;
              initiated = statusObj.initiated;

              // Get the latest update's phase as the current status
              if (statusObj.updates && statusObj.updates.length > 0) {
                const latestUpdate = statusObj.updates[0]; // First is most recent
                statusPhase = latestUpdate.phase || latestUpdate.description;

                // Map updates to our format
                updates = statusObj.updates.map(u => ({
                  when: u.datetime || '',
                  status: u.phase || u.status || '',
                }));
              }
            } else if (typeof d.status === 'string') {
              statusPhase = d.status;
            }

            return {
              device_uid: d.device_uid,
              serial_number: d.sn,
              current_version: currentVersion,
              requested_version: requestedVersion,
              status: statusPhase,
              began: initiated || d.began,
              updates: updates || d.updates,
            };
          }),
        }),
      };
    }

    // POST /v1/firmware/update - Queue firmware update
    if (method === 'POST' && path === '/v1/firmware/update') {
      const body = event.body ? JSON.parse(event.body) : {};
      const { filename, fleetUID, deviceUID } = body;

      if (!filename) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'filename is required' }),
        };
      }

      const result = await queueFirmwareUpdate(filename, fleetUID, deviceUID);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    // POST /v1/firmware/cancel - Cancel firmware update
    if (method === 'POST' && path === '/v1/firmware/cancel') {
      const body = event.body ? JSON.parse(event.body) : {};
      const { fleetUID, deviceUID } = body;

      const result = await cancelFirmwareUpdate(fleetUID, deviceUID);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    console.error('Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
