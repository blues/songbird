/**
 * Event Processor Lambda
 *
 * Processes incoming Songbird events from IoT Core:
 * - Writes telemetry data to DynamoDB
 * - Updates device metadata in DynamoDB
 * - Triggers alerts via SNS for alert events
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({});

// Environment variables
const TELEMETRY_TABLE = process.env.TELEMETRY_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN!;

// TTL: 90 days in seconds
const TTL_DAYS = 90;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

// Songbird event structure (from Notehub via IoT Core)
interface SongbirdEvent {
  device_uid: string;
  serial_number?: string;
  fleet?: string;
  event_type: string;
  timestamp: number;
  received: number;
  body: {
    temp?: number;
    humidity?: number;
    pressure?: number;
    voltage?: number;
    motion?: boolean | number;
    mode?: string;
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
    temperature?: number;  // Mojo board temperature
    // GPS tracking fields (_track.qo)
    velocity?: number;     // m/s
    bearing?: number;      // degrees
    distance?: number;     // meters since last track
    seconds?: number;      // seconds since last track
    // Journey tracking fields (_track.qo)
    journey?: number;      // Journey ID (UNIX timestamp of journey start)
    jcount?: number;       // Count of events in this journey
    time?: number;         // Time the record was captured
  };
  location?: {
    lat?: number;
    lon?: number;
    time?: number;
    source?: string;
  };
  tower?: {
    lat?: number;
    lon?: number;
  };
}

export const handler = async (event: SongbirdEvent): Promise<void> => {
  console.log('Processing event:', JSON.stringify(event));

  try {
    // Write telemetry to DynamoDB (for track.qo events)
    if (event.event_type === 'track.qo') {
      await writeTelemetry(event, 'telemetry');
    }

    // Write Mojo power data to DynamoDB (_log.qo contains power telemetry)
    if (event.event_type === '_log.qo') {
      await writePowerTelemetry(event);
    }

    // Write GPS tracking data to DynamoDB (_track.qo from card.location.track)
    if (event.event_type === '_track.qo') {
      await writeTrackingTelemetry(event);
    }

    // Update device metadata in DynamoDB
    await updateDeviceMetadata(event);

    // Publish alert if this is an alert event
    if (event.event_type === 'alert.qo') {
      await publishAlert(event);
    }

    console.log('Event processed successfully');
  } catch (error) {
    console.error('Error processing event:', error);
    throw error;
  }
};

async function writeTelemetry(event: SongbirdEvent, dataType: string): Promise<void> {
  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  // Create telemetry record
  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: dataType,
    event_type: event.event_type,
    event_type_timestamp: `${dataType}#${timestamp}`, // For GSI queries
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  // Add telemetry values
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

  // Add location if available
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
  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  // Create power telemetry record
  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: 'power',
    event_type: event.event_type,
    event_type_timestamp: `power#${timestamp}`, // For GSI queries
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  // Add Mojo power values
  if (event.body.voltage !== undefined) {
    record.mojo_voltage = event.body.voltage;
  }
  if (event.body.temperature !== undefined) {
    record.mojo_temperature = event.body.temperature;
  }
  if (event.body.milliamp_hours !== undefined) {
    record.milliamp_hours = event.body.milliamp_hours;
  }

  // Only write if we have at least one power metric
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

async function writeTrackingTelemetry(event: SongbirdEvent): Promise<void> {
  const timestamp = event.timestamp * 1000; // Convert to milliseconds
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  // Create GPS tracking record from _track.qo (card.location.track)
  const record: Record<string, any> = {
    device_uid: event.device_uid,
    timestamp,
    ttl,
    data_type: 'tracking',
    event_type: event.event_type,
    event_type_timestamp: `tracking#${timestamp}`, // For GSI queries
    serial_number: event.serial_number || 'unknown',
    fleet: event.fleet || 'default',
  };

  // Add GPS tracking values
  if (event.body.velocity !== undefined) {
    record.velocity = event.body.velocity; // m/s
  }
  if (event.body.bearing !== undefined) {
    record.bearing = event.body.bearing; // degrees
  }
  if (event.body.distance !== undefined) {
    record.distance = event.body.distance; // meters since last track
  }
  if (event.body.seconds !== undefined) {
    record.seconds_since_last = event.body.seconds;
  }
  if (event.body.temperature !== undefined) {
    record.temperature = event.body.temperature;
  }

  // Add journey tracking fields
  if (event.body.journey !== undefined) {
    record.journey = event.body.journey; // Journey ID (UNIX timestamp of journey start)
  }
  if (event.body.jcount !== undefined) {
    record.jcount = event.body.jcount; // Count of events in this journey
  }
  if (event.body.time !== undefined) {
    record.time = event.body.time; // Time the record was captured
  }
  // Motion defaults to 0 if not present
  record.motion = event.body.motion ?? 0;

  // Location is always included in _track.qo (that's the point!)
  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    record.latitude = event.location.lat;
    record.longitude = event.location.lon;
    record.location_source = 'gps'; // _track.qo is always GPS
    record.location_time = event.location.time || event.timestamp;
  }

  const command = new PutCommand({
    TableName: TELEMETRY_TABLE,
    Item: record,
  });

  await docClient.send(command);
  console.log(`Wrote GPS tracking record for ${event.device_uid}: velocity=${event.body.velocity}m/s, bearing=${event.body.bearing}°`);
}

async function updateDeviceMetadata(event: SongbirdEvent): Promise<void> {
  const now = Date.now();

  // Build update expression dynamically
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  // Always update last_seen and updated_at
  updateExpressions.push('#last_seen = :last_seen');
  expressionAttributeNames['#last_seen'] = 'last_seen';
  expressionAttributeValues[':last_seen'] = now;

  updateExpressions.push('#updated_at = :updated_at');
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = now;

  // Update status to online
  updateExpressions.push('#status = :status');
  expressionAttributeNames['#status'] = 'status';
  expressionAttributeValues[':status'] = 'online';

  // Update serial number if provided
  if (event.serial_number) {
    updateExpressions.push('#sn = :sn');
    expressionAttributeNames['#sn'] = 'serial_number';
    expressionAttributeValues[':sn'] = event.serial_number;
  }

  // Update fleet if provided
  if (event.fleet) {
    updateExpressions.push('#fleet = :fleet');
    expressionAttributeNames['#fleet'] = 'fleet';
    expressionAttributeValues[':fleet'] = event.fleet;
  }

  // Update current mode if in body
  if (event.body.mode) {
    updateExpressions.push('#mode = :mode');
    expressionAttributeNames['#mode'] = 'current_mode';
    expressionAttributeValues[':mode'] = event.body.mode;
  }

  // Update last location if available
  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    updateExpressions.push('#loc = :loc');
    expressionAttributeNames['#loc'] = 'last_location';
    expressionAttributeValues[':loc'] = {
      lat: event.location.lat,
      lon: event.location.lon,
      time: event.location.time || event.timestamp,
      source: event.location.source || 'gps',
    };
  }

  // Update last telemetry for track events
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

  // Update last power data for Mojo power events (_log.qo)
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

  // Set created_at if not exists (first time seeing device)
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
