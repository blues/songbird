/**
 * API Notehub Lambda
 *
 * Fetches Notehub project status and route information.
 * Available to all authenticated users.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const secretsClient = new SecretsManagerClient({});

const NOTEHUB_PROJECT_UID = process.env.NOTEHUB_PROJECT_UID || '';
const NOTEHUB_SECRET_ARN = process.env.NOTEHUB_SECRET_ARN || '';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
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

interface NotehubProject {
  uid: string;
  label: string;
  created: string;
  role: string;
}

interface NotehubRoute {
  uid: string;
  label: string;
  type: string;
  url?: string;
  modified: string;
  disabled: boolean;
}

interface NotehubFleet {
  uid: string;
  label: string;
  created: string;
}

interface NotehubStats {
  device_count: number;
  fleets: NotehubFleet[];
}

async function fetchNotehubApi<T>(path: string): Promise<T> {
  const token = await getNotehubToken();

  const response = await fetch(`https://api.notefile.net${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Notehub API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function getProjectInfo(): Promise<NotehubProject> {
  return fetchNotehubApi<NotehubProject>(`/v1/projects/${NOTEHUB_PROJECT_UID}`);
}

async function getRoutes(): Promise<NotehubRoute[]> {
  // Notehub returns routes as a direct array, not wrapped in { routes: [...] }
  const routes = await fetchNotehubApi<NotehubRoute[]>(`/v1/projects/${NOTEHUB_PROJECT_UID}/routes`);
  console.log('Notehub routes response:', JSON.stringify(routes, null, 2));
  return routes || [];
}

async function getFleets(): Promise<NotehubFleet[]> {
  const result = await fetchNotehubApi<{ fleets: NotehubFleet[] }>(`/v1/projects/${NOTEHUB_PROJECT_UID}/fleets`);
  return result.fleets || [];
}

async function getDeviceCount(): Promise<number> {
  const result = await fetchNotehubApi<{ devices: unknown[]; has_more?: boolean }>(`/v1/projects/${NOTEHUB_PROJECT_UID}/devices?pageSize=1`);
  // The API doesn't return total count directly, so we'll use a summary endpoint or estimate
  // For now, let's fetch all devices (up to a reasonable limit)
  const fullResult = await fetchNotehubApi<{ devices: unknown[] }>(`/v1/projects/${NOTEHUB_PROJECT_UID}/devices?pageSize=500`);
  return fullResult.devices?.length || 0;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  // Handle OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // GET /v1/notehub/status - Get full Notehub connection status
    if (method === 'GET' && path === '/v1/notehub/status') {
      // Fetch all data in parallel
      const [project, routes, fleets, deviceCount] = await Promise.all([
        getProjectInfo(),
        getRoutes(),
        getFleets(),
        getDeviceCount(),
      ]);

      // Determine overall health
      const activeRoutes = routes.filter(r => !r.disabled);
      console.log('Routes:', routes.length, 'Active routes:', activeRoutes.length);
      console.log('Route details:', routes.map(r => ({ name: r.label, disabled: r.disabled })));
      const health = activeRoutes.length > 0 ? 'healthy' : 'warning';

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          project: {
            uid: project.uid,
            name: project.label,
            created: project.created,
          },
          routes: routes.map(r => ({
            uid: r.uid,
            name: r.label,
            type: r.type,
            url: r.url,
            enabled: !r.disabled,
            modified: r.modified,
          })),
          fleets: fleets.map(f => ({
            uid: f.uid,
            name: f.label,
            created: f.created,
          })),
          device_count: deviceCount,
          health,
          last_checked: new Date().toISOString(),
        }),
      };
    }

    // GET /v1/notehub/fleets - Get available fleets
    if (method === 'GET' && path === '/v1/notehub/fleets') {
      const fleets = await getFleets();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          fleets: fleets.map(f => ({
            uid: f.uid,
            name: f.label,
            created: f.created,
          })),
        }),
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

    // Return degraded status if we can't connect
    if (path === '/v1/notehub/status') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          project: {
            uid: NOTEHUB_PROJECT_UID,
            name: 'Unknown',
          },
          routes: [],
          fleets: [],
          device_count: 0,
          health: 'error',
          error: errorMessage,
          last_checked: new Date().toISOString(),
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
}
