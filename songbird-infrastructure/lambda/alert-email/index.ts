/**
 * Alert Email Lambda
 *
 * Sends email notifications for low battery alerts via AWS SES.
 * Subscribed to SNS topic 'songbird-alerts' and filters for low_battery alerts.
 *
 * Recipients: Only the device owner (assigned_to user) receives emails.
 * Admin users do NOT receive these notifications.
 */

import { SNSEvent, SNSEventRecord } from 'aws-lambda';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// Initialize AWS clients
const sesClient = new SESClient({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// Environment variables
const DEVICES_TABLE = process.env.DEVICES_TABLE || 'songbird-devices';
const ALERTS_TABLE = process.env.ALERTS_TABLE || 'songbird-alerts';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'brandon@blues.com';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://songbird.blues.com';

// Deduplication window: 24 hours in milliseconds
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Battery recovery threshold: voltage above this is considered "recovered"
const RECOVERY_THRESHOLD = 3.5; // 0.5V above low battery threshold (3.0V)

// TTL for email tracking records: 90 days
const TTL_DAYS = 90;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

interface AlertMessage {
  device_uid: string;
  serial_number?: string;
  fleet?: string;
  alert_type: string;
  value?: number;
  message: string;
  timestamp: number;
  location?: {
    lat: number;
    lon: number;
  };
}

interface Device {
  device_uid: string;
  serial_number?: string;
  name?: string;
  assigned_to?: string;
  assigned_to_name?: string;
  voltage?: number;
  last_voltage?: number;
  last_seen?: number;
}

/**
 * Main Lambda handler
 */
export const handler = async (event: SNSEvent): Promise<void> => {
  console.log('Received SNS event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      await processAlertRecord(record);
    } catch (error) {
      console.error('Error processing alert record:', error);
      // Continue processing other records even if one fails
    }
  }
};

/**
 * Process a single SNS record
 */
async function processAlertRecord(record: SNSEventRecord): Promise<void> {
  const message: AlertMessage = JSON.parse(record.Sns.Message);

  console.log('Processing alert message:', message);

  // Only process low_battery alerts
  if (message.alert_type !== 'low_battery') {
    console.log(`Skipping non-low_battery alert: ${message.alert_type}`);
    return;
  }

  // Get current device state
  const device = await getDevice(message.device_uid);

  // Check if battery has recovered
  if (device && device.voltage && device.voltage >= RECOVERY_THRESHOLD) {
    console.log(`Device ${message.device_uid} battery has recovered to ${device.voltage}V`);
    await handleBatteryRecovery(message, device);
    return;
  }

  // Check for duplicate alerts within 24-hour window
  const isDuplicate = await isRecentAlert(message.device_uid, 'low_battery');
  if (isDuplicate) {
    console.log(`Skipping duplicate alert for ${message.device_uid} (already sent within 24 hours)`);
    return;
  }

  // Try to claim this alert by writing deduplication record FIRST
  // This prevents race conditions when multiple Lambda invocations happen simultaneously
  const claimed = await tryClaimAlert(message.device_uid, 'low_battery');
  if (!claimed) {
    console.log(`Another invocation already claimed this alert for ${message.device_uid}, skipping`);
    return;
  }

  // Get recipients (device owner + all admins)
  const recipients = await getRecipients(message.device_uid);

  if (recipients.length === 0) {
    console.warn(`No recipients found for device ${message.device_uid}`);
    // Clean up the claim since we won't send
    await clearEmailSentRecord(message.device_uid, 'low_battery');
    return;
  }

  console.log(`Sending low battery alert to ${recipients.length} recipient(s):`, recipients);

  // Send email to all recipients
  await sendLowBatteryEmail(message, device, recipients);
}

/**
 * Handle battery recovery - send recovery email if appropriate
 */
async function handleBatteryRecovery(alert: AlertMessage, device: Device): Promise<void> {
  // Check if we sent a low battery alert recently
  const recentAlert = await getRecentAlert(device.device_uid, 'low_battery');

  if (!recentAlert) {
    console.log('No recent low battery alert found, skipping recovery email');
    return;
  }

  // Check if we already sent a recovery email
  const alreadySentRecovery = await isRecentAlert(device.device_uid, 'battery_recovered');
  if (alreadySentRecovery) {
    console.log('Recovery email already sent within 24 hours, skipping');
    return;
  }

  const recipients = await getRecipients(device.device_uid);

  if (recipients.length === 0) {
    console.warn(`No recipients found for device ${device.device_uid}`);
    return;
  }

  console.log(`Sending battery recovery email to ${recipients.length} recipient(s):`, recipients);

  await sendBatteryRecoveryEmail(alert, device, recipients);

  // Clear the low battery deduplication by deleting the tracking record
  // This allows a new low battery email if the battery drops again
  await clearEmailSentRecord(device.device_uid, 'low_battery');
}

/**
 * Get device details from DynamoDB
 */
async function getDevice(deviceUid: string): Promise<Device | null> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: DEVICES_TABLE,
      Key: { device_uid: deviceUid },
    }));

    return result.Item as Device || null;
  } catch (error) {
    console.error('Error fetching device:', error);
    return null;
  }
}

/**
 * Check if a recent alert of the given type exists for this device
 * Checks for the existence of the claim record
 */
async function isRecentAlert(deviceUid: string, alertType: string): Promise<boolean> {
  try {
    // Check if the claim record exists (same ID format as tryClaimAlert)
    const alertId = `email_claim_${deviceUid}_${alertType}`;

    const result = await docClient.send(new GetCommand({
      TableName: ALERTS_TABLE,
      Key: { alert_id: alertId },
    }));

    return result.Item !== undefined;
  } catch (error) {
    console.error('Error checking for recent alerts:', error);
    // If we can't check, err on the side of sending the email
    return false;
  }
}

/**
 * Get the most recent alert of the given type for this device
 */
async function getRecentAlert(deviceUid: string, alertType: string): Promise<any | null> {
  const cutoffTime = Date.now() - DEDUP_WINDOW_MS;

  try {
    const result = await docClient.send(new QueryCommand({
      TableName: ALERTS_TABLE,
      IndexName: 'device-index',
      KeyConditionExpression: 'device_uid = :device_uid AND created_at > :cutoff',
      FilterExpression: '#type = :alert_type AND email_sent = :true',
      ExpressionAttributeNames: {
        '#type': 'type',
      },
      ExpressionAttributeValues: {
        ':device_uid': deviceUid,
        ':alert_type': alertType,
        ':cutoff': cutoffTime,
        ':true': true,
      },
      ScanIndexForward: false, // Most recent first
      Limit: 1,
    }));

    return result.Items?.[0] || null;
  } catch (error) {
    console.error('Error fetching recent alert:', error);
    return null;
  }
}

/**
 * Get list of email recipients for alerts
 * Returns only the device owner (if assigned)
 */
async function getRecipients(deviceUid: string): Promise<string[]> {
  const recipients: string[] = [];

  try {
    // Get device owner email
    const device = await getDevice(deviceUid);
    if (device?.assigned_to) {
      recipients.push(device.assigned_to);
      console.log(`Added device owner: ${device.assigned_to}`);
    } else {
      console.log(`No device owner assigned for device ${deviceUid}`);
    }

  } catch (error) {
    console.error('Error fetching recipients:', error);
  }

  return recipients;
}

// Cognito integration removed - we only send to device owners now
// Admin users do not receive low battery alerts

/**
 * Send low battery alert email
 */
async function sendLowBatteryEmail(
  alert: AlertMessage,
  device: Device | null,
  recipients: string[]
): Promise<void> {
  const deviceName = device?.name || device?.serial_number || alert.serial_number || alert.device_uid;
  const voltage = alert.value?.toFixed(2) || 'unknown';
  const timestamp = new Date(alert.timestamp * 1000).toLocaleString('en-US', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const deviceUrl = `${DASHBOARD_URL}/devices/${alert.serial_number || alert.device_uid}`;

  const subject = `🔋 Low Battery Alert: ${deviceName} (${voltage}V)`;

  const htmlBody = generateLowBatteryHtmlEmail(deviceName, voltage, timestamp, deviceUrl, alert);
  const textBody = generateLowBatteryTextEmail(deviceName, voltage, timestamp, deviceUrl, alert);

  try {
    const result = await sesClient.send(new SendEmailCommand({
      Source: SENDER_EMAIL,
      Destination: {
        ToAddresses: recipients,
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: htmlBody,
            Charset: 'UTF-8',
          },
          Text: {
            Data: textBody,
            Charset: 'UTF-8',
          },
        },
      },
    }));

    console.log('Email sent successfully:', result.MessageId);

    // Note: Deduplication record already written by tryClaimAlert before sending

  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

/**
 * Send battery recovery email
 */
async function sendBatteryRecoveryEmail(
  alert: AlertMessage,
  device: Device,
  recipients: string[]
): Promise<void> {
  const deviceName = device.name || device.serial_number || alert.serial_number || alert.device_uid;
  const voltage = device.voltage?.toFixed(2) || 'unknown';
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const deviceUrl = `${DASHBOARD_URL}/devices/${device.serial_number || device.device_uid}`;

  const subject = `✅ Battery Recovered: ${deviceName} (${voltage}V)`;

  const htmlBody = generateBatteryRecoveryHtmlEmail(deviceName, voltage, timestamp, deviceUrl);
  const textBody = generateBatteryRecoveryTextEmail(deviceName, voltage, timestamp, deviceUrl);

  try {
    const result = await sesClient.send(new SendEmailCommand({
      Source: SENDER_EMAIL,
      Destination: {
        ToAddresses: recipients,
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: htmlBody,
            Charset: 'UTF-8',
          },
          Text: {
            Data: textBody,
            Charset: 'UTF-8',
          },
        },
      },
    }));

    console.log('Battery recovery email sent successfully:', result.MessageId);

    // Record that we sent a recovery email
    await recordEmailSent(device.device_uid, 'battery_recovered');

  } catch (error) {
    console.error('Error sending battery recovery email:', error);
    throw error;
  }
}

/**
 * Try to claim an alert for processing using atomic conditional write
 * Returns true if successfully claimed, false if another invocation already claimed it
 * This prevents race conditions when multiple Lambda invocations happen simultaneously
 */
async function tryClaimAlert(deviceUid: string, alertType: string): Promise<boolean> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + TTL_SECONDS;
  // Use FIXED alert ID based on device and type only (no timestamp)
  // This ensures all concurrent invocations try to write the SAME record
  const alertId = `email_claim_${deviceUid}_${alertType}`;

  try {
    await docClient.send(new PutCommand({
      TableName: ALERTS_TABLE,
      Item: {
        alert_id: alertId,
        device_uid: deviceUid,
        type: alertType,
        created_at: now,
        ttl,
        email_sent: true,
        acknowledged: 'false', // Match existing schema
      },
      // Conditional write - only succeed if this alert_id doesn't exist yet
      ConditionExpression: 'attribute_not_exists(alert_id)',
    }));

    console.log(`Successfully claimed alert: ${alertType} for device ${deviceUid}`);
    return true;
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log(`Alert already claimed by another invocation: ${alertType} for device ${deviceUid}`);
      return false;
    }
    console.error('Error claiming alert:', error);
    // On other errors, allow the email to be sent
    return true;
  }
}

/**
 * Record that an email was sent (for deduplication)
 * Creates a tracking record in the alerts table with email_sent flag
 * Note: For low_battery alerts, use tryClaimAlert instead to prevent race conditions
 */
async function recordEmailSent(deviceUid: string, alertType: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + TTL_SECONDS;
  const alertId = `email_${deviceUid}_${alertType}_${now}_${Math.random().toString(36).substring(7)}`;

  try {
    await docClient.send(new PutCommand({
      TableName: ALERTS_TABLE,
      Item: {
        alert_id: alertId,
        device_uid: deviceUid,
        type: alertType,
        created_at: now,
        ttl,
        email_sent: true,
        acknowledged: 'false', // Match existing schema
      },
    }));

    console.log(`Recorded email sent: ${alertType} for device ${deviceUid}`);
  } catch (error) {
    console.error('Error recording email sent:', error);
    // Non-critical, don't throw
  }
}

/**
 * Clear email sent tracking records for a specific alert type
 * Used when battery recovers to allow new low battery emails if voltage drops again
 */
async function clearEmailSentRecord(deviceUid: string, alertType: string): Promise<void> {
  try {
    // Use the same fixed alert ID format as tryClaimAlert
    const alertId = `email_claim_${deviceUid}_${alertType}`;

    // Delete the claim record
    await docClient.send(new DeleteCommand({
      TableName: ALERTS_TABLE,
      Key: {
        alert_id: alertId,
      },
    }));

    console.log(`Cleared email tracking record: ${alertType} for device ${deviceUid}`);
  } catch (error) {
    console.error('Error clearing email tracking record:', error);
    // Non-critical, don't throw
  }
}

/**
 * Generate HTML email body for low battery alert
 */
function generateLowBatteryHtmlEmail(
  deviceName: string,
  voltage: string,
  timestamp: string,
  deviceUrl: string,
  alert: AlertMessage
): string {
  const location = alert.location
    ? `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Location:</td>
      <td style="padding: 10px 0; color: #1f2937;">${alert.location.lat.toFixed(5)}, ${alert.location.lon.toFixed(5)}</td>
    </tr>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Low Battery Alert</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="color: #000000; margin: 0; font-size: 24px;">🔋 Low Battery Alert</h1>
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="font-size: 16px; margin-top: 0;">A Songbird device has detected a low battery condition and has restarted.</p>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; font-weight: 600;">⚠️ Action Required</p>
      <p style="margin: 5px 0 0 0;">Please charge this device soon to prevent service interruption.</p>
    </div>

    <h2 style="color: #1f2937; font-size: 18px; margin-top: 25px; margin-bottom: 15px;">Device Details</h2>

    <table style="width: 100%; border-collapse: collapse;">
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Device:</td>
        <td style="padding: 10px 0; color: #1f2937;">${deviceName}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Battery Voltage:</td>
        <td style="padding: 10px 0; color: #dc2626; font-weight: 600;">${voltage}V</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Time:</td>
        <td style="padding: 10px 0; color: #1f2937;">${timestamp} UTC</td>
      </tr>
      ${location}
    </table>

    <div style="text-align: center; margin-top: 30px;">
      <a href="${deviceUrl}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600;">View Device Dashboard</a>
    </div>

    <p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      This is an automated alert from your Songbird fleet management system. You are receiving this because you are assigned to this device or are an administrator.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p style="margin: 0;">Blues Wireless • Songbird Alert System</p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text email body for low battery alert
 */
function generateLowBatteryTextEmail(
  deviceName: string,
  voltage: string,
  timestamp: string,
  deviceUrl: string,
  alert: AlertMessage
): string {
  const location = alert.location
    ? `Location: ${alert.location.lat.toFixed(5)}, ${alert.location.lon.toFixed(5)}\n`
    : '';

  return `
LOW BATTERY ALERT
=================

A Songbird device has detected a low battery condition and has restarted.

⚠️ ACTION REQUIRED: Please charge this device soon to prevent service interruption.

Device Details
--------------
Device: ${deviceName}
Battery Voltage: ${voltage}V
Time: ${timestamp} UTC
${location}
View Device: ${deviceUrl}

---
This is an automated alert from your Songbird fleet management system.
You are receiving this because you are assigned to this device or are an administrator.

Blues Wireless • Songbird Alert System
  `.trim();
}

/**
 * Generate HTML email body for battery recovery
 */
function generateBatteryRecoveryHtmlEmail(
  deviceName: string,
  voltage: string,
  timestamp: string,
  deviceUrl: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Battery Recovered</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
  <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="color: #000000; margin: 0; font-size: 24px;">✅ Battery Recovered</h1>
  </div>

  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p style="font-size: 16px; margin-top: 0;">Good news! The battery on your Songbird device has recovered to normal levels.</p>

    <div style="background: #d1fae5; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; font-weight: 600;">✓ Battery Status: Normal</p>
      <p style="margin: 5px 0 0 0;">The device is operating normally and no action is required.</p>
    </div>

    <h2 style="color: #1f2937; font-size: 18px; margin-top: 25px; margin-bottom: 15px;">Device Details</h2>

    <table style="width: 100%; border-collapse: collapse;">
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Device:</td>
        <td style="padding: 10px 0; color: #1f2937;">${deviceName}</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Battery Voltage:</td>
        <td style="padding: 10px 0; color: #10b981; font-weight: 600;">${voltage}V</td>
      </tr>
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: 600; color: #6b7280;">Time:</td>
        <td style="padding: 10px 0; color: #1f2937;">${timestamp} UTC</td>
      </tr>
    </table>

    <div style="text-align: center; margin-top: 30px;">
      <a href="${deviceUrl}" style="display: inline-block; background: #10b981; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: 600;">View Device Dashboard</a>
    </div>

    <p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      This is an automated notification from your Songbird fleet management system.
    </p>
  </div>

  <div style="text-align: center; padding: 20px; color: #6b7280; font-size: 12px;">
    <p style="margin: 0;">Blues Wireless • Songbird Alert System</p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text email body for battery recovery
 */
function generateBatteryRecoveryTextEmail(
  deviceName: string,
  voltage: string,
  timestamp: string,
  deviceUrl: string
): string {
  return `
BATTERY RECOVERED
=================

Good news! The battery on your Songbird device has recovered to normal levels.

✓ Battery Status: Normal - The device is operating normally and no action is required.

Device Details
--------------
Device: ${deviceName}
Battery Voltage: ${voltage}V
Time: ${timestamp} UTC

View Device: ${deviceUrl}

---
This is an automated notification from your Songbird fleet management system.

Blues Wireless • Songbird Alert System
  `.trim();
}
