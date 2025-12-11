/**
 * Event Processor Lambda
 *
 * Processes incoming Songbird events from IoT Core:
 * - Writes telemetry data to Timestream
 * - Updates device metadata in DynamoDB
 * - Triggers alerts via SNS for alert events
 */

import {
  TimestreamWriteClient,
  WriteRecordsCommand,
  RejectedRecordsException,
} from '@aws-sdk/client-timestream-write';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

// Initialize clients
const timestreamClient = new TimestreamWriteClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({});

// Environment variables
const TIMESTREAM_DATABASE = process.env.TIMESTREAM_DATABASE!;
const TIMESTREAM_TABLE = process.env.TIMESTREAM_TABLE!;
const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN!;

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
    motion?: boolean;
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
    // Write to Timestream (for telemetry events)
    if (event.event_type === 'track.qo') {
      await writeToTimestream(event);
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

async function writeToTimestream(event: SongbirdEvent): Promise<void> {
  const timestamp = (event.timestamp * 1000).toString(); // Convert to milliseconds

  // Build dimensions
  const dimensions = [
    { Name: 'device_uid', Value: event.device_uid },
    { Name: 'serial_number', Value: event.serial_number || 'unknown' },
    { Name: 'fleet', Value: event.fleet || 'default' },
    { Name: 'event_type', Value: event.event_type },
  ];

  // Build measures from body
  const records: any[] = [];

  if (event.body.temp !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'temperature',
      MeasureValue: event.body.temp.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });
  }

  if (event.body.humidity !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'humidity',
      MeasureValue: event.body.humidity.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });
  }

  if (event.body.pressure !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'pressure',
      MeasureValue: event.body.pressure.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });
  }

  if (event.body.voltage !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'voltage',
      MeasureValue: event.body.voltage.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });
  }

  if (event.body.motion !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'motion',
      MeasureValue: event.body.motion ? 'true' : 'false',
      MeasureValueType: 'BOOLEAN',
      Time: timestamp,
    });
  }

  if (event.location?.lat !== undefined && event.location?.lon !== undefined) {
    records.push({
      Dimensions: dimensions,
      MeasureName: 'latitude',
      MeasureValue: event.location.lat.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });

    records.push({
      Dimensions: dimensions,
      MeasureName: 'longitude',
      MeasureValue: event.location.lon.toString(),
      MeasureValueType: 'DOUBLE',
      Time: timestamp,
    });
  }

  if (records.length === 0) {
    console.log('No measures to write to Timestream');
    return;
  }

  try {
    const command = new WriteRecordsCommand({
      DatabaseName: TIMESTREAM_DATABASE,
      TableName: TIMESTREAM_TABLE,
      Records: records,
    });

    await timestreamClient.send(command);
    console.log(`Wrote ${records.length} records to Timestream`);
  } catch (error) {
    if (error instanceof RejectedRecordsException) {
      console.error('Rejected records:', error.RejectedRecords);
    }
    throw error;
  }
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
