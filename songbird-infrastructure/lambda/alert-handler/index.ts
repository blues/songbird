/**
 * Alert Handler Lambda
 *
 * Specialized handler for alert events.
 * Sends notifications and updates device status.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({});

const DEVICES_TABLE = process.env.DEVICES_TABLE!;
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN!;

interface AlertEvent {
  device_uid: string;
  serial_number?: string;
  fleet?: string;
  event_type: string;
  timestamp: number;
  body: {
    type: string;
    value: number;
    threshold: number;
    message?: string;
  };
  location?: {
    lat?: number;
    lon?: number;
  };
}

export const handler = async (event: AlertEvent): Promise<void> => {
  console.log('Processing alert:', JSON.stringify(event));

  try {
    // Get device info for enriched notification
    const deviceInfo = await getDeviceInfo(event.device_uid);

    // Update device status to 'alert'
    await updateDeviceStatus(event.device_uid, event.body.type);

    // Send notification with enriched context
    await sendAlertNotification(event, deviceInfo);

    console.log('Alert processed successfully');
  } catch (error) {
    console.error('Error processing alert:', error);
    throw error;
  }
};

async function getDeviceInfo(deviceUid: string): Promise<Record<string, any> | null> {
  try {
    const command = new GetCommand({
      TableName: DEVICES_TABLE,
      Key: { device_uid: deviceUid },
    });

    const result = await docClient.send(command);
    return result.Item || null;
  } catch (error) {
    console.error('Error fetching device info:', error);
    return null;
  }
}

async function updateDeviceStatus(deviceUid: string, alertType: string): Promise<void> {
  const command = new UpdateCommand({
    TableName: DEVICES_TABLE,
    Key: { device_uid: deviceUid },
    UpdateExpression: 'SET #status = :status, #last_alert = :last_alert, #last_alert_type = :alert_type',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#last_alert': 'last_alert',
      '#last_alert_type': 'last_alert_type',
    },
    ExpressionAttributeValues: {
      ':status': 'alert',
      ':last_alert': Date.now(),
      ':alert_type': alertType,
    },
  });

  await docClient.send(command);
}

async function sendAlertNotification(
  event: AlertEvent,
  deviceInfo: Record<string, any> | null
): Promise<void> {
  // Format alert message
  const alertTypeLabels: Record<string, string> = {
    temp_high: 'High Temperature',
    temp_low: 'Low Temperature',
    humidity_high: 'High Humidity',
    humidity_low: 'Low Humidity',
    pressure_change: 'Pressure Change',
    low_battery: 'Low Battery',
    motion: 'Motion Detected',
  };

  const alertLabel = alertTypeLabels[event.body.type] || event.body.type;
  const deviceName = event.serial_number || deviceInfo?.serial_number || event.device_uid;
  const assignedTo = deviceInfo?.assigned_to || 'Unassigned';

  const formattedMessage = `
SONGBIRD ALERT

Device: ${deviceName}
Alert Type: ${alertLabel}
${event.body.message || ''}

Measured Value: ${event.body.value}
Threshold: ${event.body.threshold}

Fleet: ${event.fleet || deviceInfo?.fleet || 'Unknown'}
Assigned To: ${assignedTo}
${event.location?.lat ? `Location: ${event.location.lat.toFixed(5)}, ${event.location.lon?.toFixed(5)}` : ''}

Time: ${new Date(event.timestamp * 1000).toISOString()}
  `.trim();

  const command = new PublishCommand({
    TopicArn: ALERT_TOPIC_ARN,
    Subject: `[Songbird Alert] ${alertLabel} - ${deviceName}`,
    Message: formattedMessage,
    MessageAttributes: {
      alert_type: {
        DataType: 'String',
        StringValue: event.body.type,
      },
      device_uid: {
        DataType: 'String',
        StringValue: event.device_uid,
      },
      fleet: {
        DataType: 'String',
        StringValue: event.fleet || 'default',
      },
      severity: {
        DataType: 'String',
        StringValue: getSeverity(event.body.type),
      },
    },
  });

  await snsClient.send(command);
  console.log(`Alert notification sent for ${deviceName}: ${alertLabel}`);
}

function getSeverity(alertType: string): string {
  const highSeverity = ['low_battery', 'temp_high', 'temp_low'];
  const mediumSeverity = ['humidity_high', 'humidity_low', 'pressure_change'];

  if (highSeverity.includes(alertType)) return 'high';
  if (mediumSeverity.includes(alertType)) return 'medium';
  return 'low';
}
