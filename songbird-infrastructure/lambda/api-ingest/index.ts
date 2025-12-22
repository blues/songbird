/**
 * Event Ingest API Lambda
 *
 * HTTP endpoint for receiving events from Notehub HTTP routes.
 * Processes incoming Songbird events and writes to DynamoDB.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
const snsClient = new SNSClient({});

// Environment variables
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const COMMANDS_TABLE = process.env.COMMANDS_TABLE!;
const ALERTS_TABLE = process.env.ALERTS_TABLE!;
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN!;

// TTL: 90 days in seconds
const TTL_DAYS = 90;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// Notehub event structure (from HTTP route)
interface NotehubEvent {
  event: string;           // e.g., "dev:xxxxx#track.qo#1"
  session: string;
  best_id: string;
  device: string;          // Device UID
  sn: string;              // Serial number
  product: string;
  app: string;
  received: number;
  req: string;             // e.g., "note.add"
  when: number;            // Unix timestamp
  file: string;            // e.g., "track.qo"
  body: {
    temp?: number;
    humidity?: number;
    pressure?: number;
    voltage?: number;
    motion?: boolean;
    mode?: string;
    transit_locked?: boolean;
    demo_locked?: boolean;
    // Alert-specific fields
    type?: string;
    value?: number;
    threshold?: number;
    message?: string;
    // Command ack fields
    cmd?: string;
    status?: string;
    executed_at?: number;
    // Mojo power monitoring fields (_log.qo)
    milliamp_hours?: number;
    temperature?: number;
    // Health event fields (_health.qo)
    method?: string;
    text?: string;
    voltage_mode?: string;
    // Session fields may appear in body for _session.qo
    power_usb?: boolean;
  };
  best_location_type?: string;
  best_location_when?: number;
  best_lat?: number;
  best_lon?: number;
  best_location?: string;
  tower_location?: string;
  tower_lat?: number;
  tower_lon?: number;
  tower_when?: number;
  // Triangulation fields (from _geolocate.qo or enriched events)
  tri_when?: number;
  tri_lat?: number;
  tri_lon?: number;
  tri_location?: string;
  tri_country?: string;
  tri_timezone?: string;
  tri_points?: number;  // Number of reference points used for triangulation
  fleets?: string[];
  // Session fields (_session.qo) - may appear at top level or in body
  firmware_host?: string;     // JSON string with host firmware info
  firmware_notecard?: string; // JSON string with Notecard firmware info
  sku?: string;               // Notecard SKU (e.g., "NOTE-WBGLW")
  power_usb?: boolean;        // true if device is USB powered
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Ingest request:', JSON.stringify(event));

  const headers = {
    'Content-Type': 'application/json',
  };

  try {
    if (!event.body) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Request body required' }),
      };
    }

    const notehubEvent: NotehubEvent = JSON.parse(event.body);
    console.log('Processing Notehub event:', JSON.stringify(notehubEvent));

    // Transform to internal format
    // Use 'when' if available, otherwise fall back to 'received' (as integer seconds)
    const eventTimestamp = notehubEvent.when || Math.floor(notehubEvent.received);

    // Extract location - prefer GPS (best_lat/best_lon), fall back to triangulation
    const location = extractLocation(notehubEvent);

    // Extract session info (firmware versions, SKU) from _session.qo events
    const sessionInfo = extractSessionInfo(notehubEvent);

    const songbirdEvent = {
      device_uid: notehubEvent.device,
      serial_number: notehubEvent.sn,
      fleet: notehubEvent.fleets?.[0] || 'default',
      event_type: notehubEvent.file,
      timestamp: eventTimestamp,
      received: notehubEvent.received,
      body: notehubEvent.body || {},
      location,
      session: sessionInfo,
    };

    // Write telemetry to DynamoDB (for track.qo events)
    if (songbirdEvent.event_type === 'track.qo') {
      await writeTelemetry(songbirdEvent, 'telemetry');
    }

    // Write Mojo power data to DynamoDB (_log.qo contains power telemetry)
    // Skip if device is USB powered (voltage_mode: "usb") - no battery to monitor
    if (songbirdEvent.event_type === '_log.qo') {
      if (songbirdEvent.body.voltage_mode === 'usb') {
        console.log(`Skipping _log.qo event for ${songbirdEvent.device_uid} - USB powered`);
      } else {
        await writePowerTelemetry(songbirdEvent);
      }
    }

    // Write health events to DynamoDB (_health.qo)
    if (songbirdEvent.event_type === '_health.qo') {
      await writeHealthEvent(songbirdEvent);
    }

    // Handle triangulation results (_geolocate.qo)
    // Write location to telemetry table for location history trail
    if (songbirdEvent.event_type === '_geolocate.qo' && songbirdEvent.location) {
      await writeLocationEvent(songbirdEvent);
    }

    // Update device metadata in DynamoDB
    await updateDeviceMetadata(songbirdEvent);

    // Store and publish alert if this is an alert event
    if (songbirdEvent.event_type === 'alert.qo') {
      await storeAlert(songbirdEvent);
      await publishAlert(songbirdEvent);
    }

    // Process command acknowledgment
    if (songbirdEvent.event_type === 'command_ack.qo') {
      await processCommandAck(songbirdEvent);
    }

    console.log('Event processed successfully');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'ok', device: songbirdEvent.device_uid }),
    };
  } catch (error) {
    console.error('Error processing event:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

interface SessionInfo {
  firmware_version?: string;
  notecard_version?: string;
  notecard_sku?: string;
  usb_powered?: boolean;
}

/**
 * Extract session info (firmware versions, SKU, power status) from Notehub event
 * This info is available in _session.qo events
 * Note: Some fields may appear at the top level or inside the body depending on the HTTP route configuration
 */
function extractSessionInfo(event: NotehubEvent): SessionInfo | undefined {
  // Check for power_usb at top level OR in body
  const powerUsb = event.power_usb ?? event.body?.power_usb;

  if (!event.firmware_host && !event.firmware_notecard && !event.sku && powerUsb === undefined) {
    return undefined;
  }

  const sessionInfo: SessionInfo = {};

  // Parse host firmware version
  if (event.firmware_host) {
    try {
      const hostFirmware = JSON.parse(event.firmware_host);
      sessionInfo.firmware_version = hostFirmware.version;
    } catch (e) {
      console.error('Failed to parse firmware_host:', e);
    }
  }

  // Parse Notecard firmware version
  if (event.firmware_notecard) {
    try {
      const notecardFirmware = JSON.parse(event.firmware_notecard);
      sessionInfo.notecard_version = notecardFirmware.version;
    } catch (e) {
      console.error('Failed to parse firmware_notecard:', e);
    }
  }

  // SKU
  if (event.sku) {
    sessionInfo.notecard_sku = event.sku;
  }

  // USB power status (check top level first, then body)
  if (powerUsb !== undefined) {
    sessionInfo.usb_powered = powerUsb;
    console.log(`Extracted usb_powered: ${powerUsb}`);
  }

  return Object.keys(sessionInfo).length > 0 ? sessionInfo : undefined;
}

/**
 * Normalize location source type from Notehub to our standard values
 */
function normalizeLocationSource(source?: string): string {
  if (!source) return 'gps';
  const normalized = source.toLowerCase();
  // Notehub uses 'triangulated' but we use 'triangulation' for consistency
  if (normalized === 'triangulated') return 'triangulation';
  return normalized;
}

/**
 * Extract location from Notehub event, preferring GPS but falling back to triangulation
 */
function extractLocation(event: NotehubEvent): { lat: number; lon: number; time?: number; source: string; name?: string } | undefined {
  // Prefer GPS location (best_lat/best_lon with type 'gps')
  if (event.best_lat !== undefined && event.best_lon !== undefined) {
    return {
      lat: event.best_lat,
      lon: event.best_lon,
      time: event.best_location_when,
      source: normalizeLocationSource(event.best_location_type),
      name: event.best_location,
    };
  }

  // Fall back to triangulation data
  if (event.tri_lat !== undefined && event.tri_lon !== undefined) {
    return {
      lat: event.tri_lat,
      lon: event.tri_lon,
      time: event.tri_when,
      source: 'triangulation',
      name: event.tower_location,
    };
  }

  // Fall back to tower location
  if (event.tower_lat !== undefined && event.tower_lon !== undefined) {
    return {
      lat: event.tower_lat,
      lon: event.tower_lon,
      time: event.tower_when,
      source: 'tower',
      name: event.tower_location,
    };
  }

  return undefined;
}

interface SongbirdEvent {
  device_uid: string;
  serial_number?: string;
  fleet?: string;
  event_type: string;
  timestamp: number;
  received: number;
  session?: SessionInfo;
  body: {
    temp?: number;
    humidity?: number;
    pressure?: number;
    voltage?: number;
    motion?: boolean;
    mode?: string;
    transit_locked?: boolean;
    demo_locked?: boolean;
    type?: string;
    value?: number;
    threshold?: number;
    message?: string;
    cmd?: string;
    cmd_id?: string;
    status?: string;
    executed_at?: number;
    milliamp_hours?: number;
    temperature?: number;
    // Health event fields
    method?: string;
    text?: string;
    voltage_mode?: string;
  };
  location?: {
    lat?: number;
    lon?: number;
    time?: number;
    source?: string;
    name?: string;
  };
}

async function writeTelemetry(event: SongbirdEvent, dataType: string): Promise<void> {
  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: dataType,
    event_type: event.event_type,
    event_type_timestamp: `${dataType}#${timestamp}`,
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  if (event.body.temp !== undefined) {
    record.temperature = event.body.temp;
  }
  if (event.body.humidity !== undefined) {
    record.humidity = event.body.humidity;
  }
  if (event.body.pressure !== undefined) {
    record.pressure = event.body.pressure;
  }
  if (event.body.voltage !== undefined) {
    record.voltage = event.body.voltage;
  }
  if (event.body.motion !== undefined) {
    record.motion = event.body.motion;
  }

  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    record.latitude = event.location.lat;
    record.longitude = event.location.lon;
    record.location_source = event.location.source || 'gps';
  }

  const command = new PutCommand({
    TableName: TELEMETRY_TABLE,
    Item: record,
  });

  await docClient.send(command);
  console.log(`Wrote telemetry record for ${event.device_uid}`);
}

async function writePowerTelemetry(event: SongbirdEvent): Promise<void> {
  const timestamp = event.timestamp * 1000;
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: 'power',
    event_type: event.event_type,
    event_type_timestamp: `power#${timestamp}`,
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  if (event.body.voltage !== undefined) {
    record.mojo_voltage = event.body.voltage;
  }
  if (event.body.milliamp_hours !== undefined) {
    record.milliamp_hours = event.body.milliamp_hours;
  }

  if (record.mojo_voltage !== undefined ||
      record.mojo_temperature !== undefined ||
      record.milliamp_hours !== undefined) {
    const command = new PutCommand({
      TableName: TELEMETRY_TABLE,
      Item: record,
    });

    await docClient.send(command);
    console.log(`Wrote power telemetry record for ${event.device_uid}`);
  } else {
    console.log('No power metrics in _log.qo event, skipping');
  }
}

async function writeHealthEvent(event: SongbirdEvent): Promise<void> {
  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: 'health',
    event_type: event.event_type,
    event_type_timestamp: `health#${timestamp}`,
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  // Add health event fields
  if (event.body.method !== undefined) {
    record.method = event.body.method;
  }
  if (event.body.text !== undefined) {
    record.text = event.body.text;
  }
  if (event.body.voltage !== undefined) {
    record.voltage = event.body.voltage;
  }
  if (event.body.voltage_mode !== undefined) {
    record.voltage_mode = event.body.voltage_mode;
  }
  if (event.body.milliamp_hours !== undefined) {
    record.milliamp_hours = event.body.milliamp_hours;
  }

  // Add location if available
  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    record.latitude = event.location.lat;
    record.longitude = event.location.lon;
    record.location_source = event.location.source || 'tower';
  }

  const command = new PutCommand({
    TableName: TELEMETRY_TABLE,
    Item: record,
  });

  await docClient.send(command);
  console.log(`Wrote health event record for ${event.device_uid}: ${event.body.method}`);
}

async function writeLocationEvent(event: SongbirdEvent): Promise<void> {
  if (!event.location?.lat || !event.location?.lon) {
    console.log('No location data in event, skipping');
    return;
  }

  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: 'telemetry', // Use telemetry so it's picked up by location query
    event_type: event.event_type,
    event_type_timestamp: `telemetry#${timestamp}`,
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
    latitude: event.location.lat,
    longitude: event.location.lon,
    location_source: event.location.source || 'triangulation',
  };

  const command = new PutCommand({
    TableName: TELEMETRY_TABLE,
    Item: record,
  });

  await docClient.send(command);
  console.log(`Wrote location event for ${event.device_uid}: ${event.location.source} (${event.location.lat}, ${event.location.lon})`);
}

async function updateDeviceMetadata(event: SongbirdEvent): Promise<void> {
  const now = Date.now();

  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  updateExpressions.push('#last_seen = :last_seen');
  expressionAttributeNames['#last_seen'] = 'last_seen';
  expressionAttributeValues[':last_seen'] = now;

  updateExpressions.push('#updated_at = :updated_at');
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = now;

  updateExpressions.push('#status = :status');
  expressionAttributeNames['#status'] = 'status';
  expressionAttributeValues[':status'] = 'online';

  if (event.serial_number) {
    updateExpressions.push('#sn = :sn');
    expressionAttributeNames['#sn'] = 'serial_number';
    expressionAttributeValues[':sn'] = event.serial_number;
  }

  if (event.fleet) {
    updateExpressions.push('#fleet = :fleet');
    expressionAttributeNames['#fleet'] = 'fleet';
    expressionAttributeValues[':fleet'] = event.fleet;
  }

  if (event.body.mode) {
    updateExpressions.push('#mode = :mode');
    expressionAttributeNames['#mode'] = 'current_mode';
    expressionAttributeValues[':mode'] = event.body.mode;
  }

  // For track.qo events, update lock states based on presence of the field
  // If locked is true, set it; if absent or false, clear it
  if (event.event_type === 'track.qo') {
    updateExpressions.push('#transit_locked = :transit_locked');
    expressionAttributeNames['#transit_locked'] = 'transit_locked';
    expressionAttributeValues[':transit_locked'] = event.body.transit_locked === true;

    updateExpressions.push('#demo_locked = :demo_locked');
    expressionAttributeNames['#demo_locked'] = 'demo_locked';
    expressionAttributeValues[':demo_locked'] = event.body.demo_locked === true;
  }

  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    updateExpressions.push('#loc = :loc');
    expressionAttributeNames['#loc'] = 'last_location';
    expressionAttributeValues[':loc'] = {
      lat: event.location.lat,
      lon: event.location.lon,
      time: event.location.time || event.timestamp,
      source: event.location.source || 'gps',
      name: event.location.name,
    };
  }

  if (event.event_type === 'track.qo') {
    updateExpressions.push('#telemetry = :telemetry');
    expressionAttributeNames['#telemetry'] = 'last_telemetry';
    expressionAttributeValues[':telemetry'] = {
      temp: event.body.temp,
      humidity: event.body.humidity,
      pressure: event.body.pressure,
      voltage: event.body.voltage,
      motion: event.body.motion,
      timestamp: event.timestamp,
    };
  }

  if (event.event_type === '_log.qo') {
    updateExpressions.push('#power = :power');
    expressionAttributeNames['#power'] = 'last_power';
    expressionAttributeValues[':power'] = {
      voltage: event.body.voltage,
      temperature: event.body.temperature,
      milliamp_hours: event.body.milliamp_hours,
      timestamp: event.timestamp,
    };
  }

  // Update firmware versions from _session.qo events
  if (event.session?.firmware_version) {
    updateExpressions.push('#fw_version = :fw_version');
    expressionAttributeNames['#fw_version'] = 'firmware_version';
    expressionAttributeValues[':fw_version'] = event.session.firmware_version;
  }

  if (event.session?.notecard_version) {
    updateExpressions.push('#nc_version = :nc_version');
    expressionAttributeNames['#nc_version'] = 'notecard_version';
    expressionAttributeValues[':nc_version'] = event.session.notecard_version;
  }

  if (event.session?.notecard_sku) {
    updateExpressions.push('#nc_sku = :nc_sku');
    expressionAttributeNames['#nc_sku'] = 'notecard_sku';
    expressionAttributeValues[':nc_sku'] = event.session.notecard_sku;
  }

  // Update USB power status from _session.qo events
  if (event.session?.usb_powered !== undefined) {
    updateExpressions.push('#usb_powered = :usb_powered');
    expressionAttributeNames['#usb_powered'] = 'usb_powered';
    expressionAttributeValues[':usb_powered'] = event.session.usb_powered;
  }

  updateExpressions.push('#created_at = if_not_exists(#created_at, :created_at)');
  expressionAttributeNames['#created_at'] = 'created_at';
  expressionAttributeValues[':created_at'] = now;

  const command = new UpdateCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: event.device_uid },
    UpdateExpression: 'SET ' + updateExpressions.join(', '),
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  });

  await docClient.send(command);
  console.log(`Updated device metadata for ${event.device_uid}`);
}

async function processCommandAck(event: SongbirdEvent): Promise<void> {
  const cmdId = event.body.cmd_id;
  if (!cmdId) {
    console.log('Command ack missing cmd_id, skipping');
    return;
  }

  const now = Date.now();

  const command = new UpdateCommand({
    TableName: COMMANDS_TABLE,
    Key: {
      device_uid: event.device_uid,
      command_id: cmdId,
    },
    UpdateExpression: 'SET #status = :status, #message = :message, #executed_at = :executed_at, #updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#message': 'message',
      '#executed_at': 'executed_at',
      '#updated_at': 'updated_at',
    },
    ExpressionAttributeValues: {
      ':status': event.body.status || 'unknown',
      ':message': event.body.message || '',
      ':executed_at': event.body.executed_at ? event.body.executed_at * 1000 : now,
      ':updated_at': now,
    },
  });

  await docClient.send(command);
  console.log(`Updated command ${cmdId} with status: ${event.body.status}`);
}

async function storeAlert(event: SongbirdEvent): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + TTL_SECONDS;

  // Generate a unique alert ID
  const alertId = `alert_${event.device_uid}_${now}_${Math.random().toString(36).substring(7)}`;

  const alertRecord = {
    alert_id: alertId,
    device_uid: event.device_uid,
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
    type: event.body.type || 'unknown',
    value: event.body.value,
    threshold: event.body.threshold,
    message: event.body.message || '',
    created_at: now,
    event_timestamp: event.timestamp * 1000,
    acknowledged: 'false', // String for GSI partition key
    ttl,
    location: event.location ? {
      lat: event.location.lat,
      lon: event.location.lon,
    } : undefined,
  };

  const command = new PutCommand({
    TableName: ALERTS_TABLE,
    Item: alertRecord,
  });

  await docClient.send(command);
  console.log(`Stored alert ${alertId} for ${event.device_uid}`);
}

async function publishAlert(event: SongbirdEvent): Promise<void> {
  const alertMessage = {
    device_uid: event.device_uid,
    serial_number: event.serial_number,
    fleet: event.fleet,
    alert_type: event.body.type,
    value: event.body.value,
    threshold: event.body.threshold,
    message: event.body.message,
    timestamp: event.timestamp,
    location: event.location,
  };

  const command = new PublishCommand({
    TopicArn: ALERT_TOPIC_ARN,
    Subject: `Songbird Alert: ${event.body.type} - ${event.serial_number || event.device_uid}`,
    Message: JSON.stringify(alertMessage, null, 2),
    MessageAttributes: {
      alert_type: {
        DataType: 'String',
        StringValue: event.body.type || 'unknown',
      },
      device_uid: {
        DataType: 'String',
        StringValue: event.device_uid,
      },
      fleet: {
        DataType: 'String',
        StringValue: event.fleet || 'default',
      },
    },
  });

  await snsClient.send(command);
  console.log(`Published alert to SNS: ${event.body.type}`);
}
