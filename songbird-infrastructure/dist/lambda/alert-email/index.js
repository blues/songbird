"use strict";
/**
 * Alert Email Lambda
 *
 * Sends email notifications for low battery alerts via AWS SES.
 * Subscribed to SNS topic 'songbird-alerts' and filters for low_battery alerts.
 *
 * Recipients: Only the device owner (assigned_to user) receives emails.
 * Admin users do NOT receive these notifications.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_ses_1 = require("@aws-sdk/client-ses");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
// Initialize AWS clients
const sesClient = new client_ses_1.SESClient({});
const ddbClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(ddbClient);
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
/**
 * Main Lambda handler
 */
const handler = async (event) => {
    console.log('Received SNS event:', JSON.stringify(event, null, 2));
    for (const record of event.Records) {
        try {
            await processAlertRecord(record);
        }
        catch (error) {
            console.error('Error processing alert record:', error);
            // Continue processing other records even if one fails
        }
    }
};
exports.handler = handler;
/**
 * Process a single SNS record
 */
async function processAlertRecord(record) {
    const message = JSON.parse(record.Sns.Message);
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
async function handleBatteryRecovery(alert, device) {
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
async function getDevice(deviceUid) {
    try {
        const result = await docClient.send(new lib_dynamodb_1.GetCommand({
            TableName: DEVICES_TABLE,
            Key: { device_uid: deviceUid },
        }));
        return result.Item || null;
    }
    catch (error) {
        console.error('Error fetching device:', error);
        return null;
    }
}
/**
 * Check if a recent alert of the given type exists for this device
 */
async function isRecentAlert(deviceUid, alertType) {
    const cutoffTime = Date.now() - DEDUP_WINDOW_MS;
    try {
        const result = await docClient.send(new lib_dynamodb_1.QueryCommand({
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
            Limit: 1,
        }));
        return (result.Items?.length || 0) > 0;
    }
    catch (error) {
        console.error('Error checking for recent alerts:', error);
        // If we can't check, err on the side of sending the email
        return false;
    }
}
/**
 * Get the most recent alert of the given type for this device
 */
async function getRecentAlert(deviceUid, alertType) {
    const cutoffTime = Date.now() - DEDUP_WINDOW_MS;
    try {
        const result = await docClient.send(new lib_dynamodb_1.QueryCommand({
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
    }
    catch (error) {
        console.error('Error fetching recent alert:', error);
        return null;
    }
}
/**
 * Get list of email recipients for alerts
 * Returns only the device owner (if assigned)
 */
async function getRecipients(deviceUid) {
    const recipients = [];
    try {
        // Get device owner email
        const device = await getDevice(deviceUid);
        if (device?.assigned_to) {
            recipients.push(device.assigned_to);
            console.log(`Added device owner: ${device.assigned_to}`);
        }
        else {
            console.log(`No device owner assigned for device ${deviceUid}`);
        }
    }
    catch (error) {
        console.error('Error fetching recipients:', error);
    }
    return recipients;
}
// Cognito integration removed - we only send to device owners now
// Admin users do not receive low battery alerts
/**
 * Send low battery alert email
 */
async function sendLowBatteryEmail(alert, device, recipients) {
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
        const result = await sesClient.send(new client_ses_1.SendEmailCommand({
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
    }
    catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}
/**
 * Send battery recovery email
 */
async function sendBatteryRecoveryEmail(alert, device, recipients) {
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
        const result = await sesClient.send(new client_ses_1.SendEmailCommand({
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
    }
    catch (error) {
        console.error('Error sending battery recovery email:', error);
        throw error;
    }
}
/**
 * Try to claim an alert for processing using atomic conditional write
 * Returns true if successfully claimed, false if another invocation already claimed it
 * This prevents race conditions when multiple Lambda invocations happen simultaneously
 */
async function tryClaimAlert(deviceUid, alertType) {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    // Use timestamp-based ID for consistent claiming within same millisecond
    const alertId = `email_${deviceUid}_${alertType}_${now}`;
    try {
        await docClient.send(new lib_dynamodb_1.PutCommand({
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
    }
    catch (error) {
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
async function recordEmailSent(deviceUid, alertType) {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + TTL_SECONDS;
    const alertId = `email_${deviceUid}_${alertType}_${now}_${Math.random().toString(36).substring(7)}`;
    try {
        await docClient.send(new lib_dynamodb_1.PutCommand({
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
    }
    catch (error) {
        console.error('Error recording email sent:', error);
        // Non-critical, don't throw
    }
}
/**
 * Clear email sent tracking records for a specific alert type
 * Used when battery recovers to allow new low battery emails if voltage drops again
 */
async function clearEmailSentRecord(deviceUid, alertType) {
    try {
        // Find the most recent email sent record
        const recentAlert = await getRecentAlert(deviceUid, alertType);
        if (!recentAlert) {
            console.log(`No email tracking record found for ${alertType} on device ${deviceUid}`);
            return;
        }
        // Delete the tracking record
        await docClient.send(new lib_dynamodb_1.DeleteCommand({
            TableName: ALERTS_TABLE,
            Key: {
                alert_id: recentAlert.alert_id,
                created_at: recentAlert.created_at,
            },
        }));
        console.log(`Cleared email tracking record: ${alertType} for device ${deviceUid}`);
    }
    catch (error) {
        console.error('Error clearing email tracking record:', error);
        // Non-critical, don't throw
    }
}
/**
 * Generate HTML email body for low battery alert
 */
function generateLowBatteryHtmlEmail(deviceName, voltage, timestamp, deviceUrl, alert) {
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
function generateLowBatteryTextEmail(deviceName, voltage, timestamp, deviceUrl, alert) {
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
function generateBatteryRecoveryHtmlEmail(deviceName, voltage, timestamp, deviceUrl) {
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
function generateBatteryRecoveryTextEmail(deviceName, voltage, timestamp, deviceUrl) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYWxlcnQtZW1haWwvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFHSCxvREFBa0U7QUFDbEUsOERBQTBEO0FBQzFELHdEQUFvSDtBQUVwSCx5QkFBeUI7QUFDekIsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3BDLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsd0JBQXdCO0FBQ3hCLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxJQUFJLGtCQUFrQixDQUFDO0FBQ3RFLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLGlCQUFpQixDQUFDO0FBQ25FLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLG1CQUFtQixDQUFDO0FBQ3JFLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxJQUFJLDRCQUE0QixDQUFDO0FBRWhGLGlEQUFpRDtBQUNqRCxNQUFNLGVBQWUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFFNUMsMkVBQTJFO0FBQzNFLE1BQU0sa0JBQWtCLEdBQUcsR0FBRyxDQUFDLENBQUMsMENBQTBDO0FBRTFFLDBDQUEwQztBQUMxQyxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBMkI1Qzs7R0FFRztBQUNJLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxL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O0FBQ0gsU0FBUyxnQ0FBZ0MsQ0FDdkMsVUFBa0IsRUFDbEIsT0FBZSxFQUNmLFNBQWlCLEVBQ2pCLFNBQWlCO0lBRWpCLE9BQU87Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O3VEQTBCOEMsVUFBVTs7Ozt5RUFJUSxPQUFPOzs7O3VEQUl6QixTQUFTOzs7OztpQkFLL0MsU0FBUzs7Ozs7Ozs7Ozs7OztHQWF2QixDQUFDLElBQUksRUFBRSxDQUFDO0FBQ1gsQ0FBQztBQUVEOztHQUVHO0FBQ0gsU0FBUyxnQ0FBZ0MsQ0FDdkMsVUFBa0IsRUFDbEIsT0FBZSxFQUNmLFNBQWlCLEVBQ2pCLFNBQWlCO0lBRWpCLE9BQU87Ozs7Ozs7Ozs7VUFVQyxVQUFVO21CQUNELE9BQU87UUFDbEIsU0FBUzs7ZUFFRixTQUFTOzs7Ozs7R0FNckIsQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUNYLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFsZXJ0IEVtYWlsIExhbWJkYVxuICpcbiAqIFNlbmRzIGVtYWlsIG5vdGlmaWNhdGlvbnMgZm9yIGxvdyBiYXR0ZXJ5IGFsZXJ0cyB2aWEgQVdTIFNFUy5cbiAqIFN1YnNjcmliZWQgdG8gU05TIHRvcGljICdzb25nYmlyZC1hbGVydHMnIGFuZCBmaWx0ZXJzIGZvciBsb3dfYmF0dGVyeSBhbGVydHMuXG4gKlxuICogUmVjaXBpZW50czogT25seSB0aGUgZGV2aWNlIG93bmVyIChhc3NpZ25lZF90byB1c2VyKSByZWNlaXZlcyBlbWFpbHMuXG4gKiBBZG1pbiB1c2VycyBkbyBOT1QgcmVjZWl2ZSB0aGVzZSBub3RpZmljYXRpb25zLlxuICovXG5cbmltcG9ydCB7IFNOU0V2ZW50LCBTTlNFdmVudFJlY29yZCB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgU0VTQ2xpZW50LCBTZW5kRW1haWxDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNlcyc7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBHZXRDb21tYW5kLCBRdWVyeUNvbW1hbmQsIFB1dENvbW1hbmQsIERlbGV0ZUNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuXG4vLyBJbml0aWFsaXplIEFXUyBjbGllbnRzXG5jb25zdCBzZXNDbGllbnQgPSBuZXcgU0VTQ2xpZW50KHt9KTtcbmNvbnN0IGRkYkNsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZGRiQ2xpZW50KTtcblxuLy8gRW52aXJvbm1lbnQgdmFyaWFibGVzXG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSB8fCAnc29uZ2JpcmQtZGV2aWNlcyc7XG5jb25zdCBBTEVSVFNfVEFCTEUgPSBwcm9jZXNzLmVudi5BTEVSVFNfVEFCTEUgfHwgJ3NvbmdiaXJkLWFsZXJ0cyc7XG5jb25zdCBTRU5ERVJfRU1BSUwgPSBwcm9jZXNzLmVudi5TRU5ERVJfRU1BSUwgfHwgJ2JyYW5kb25AYmx1ZXMuY29tJztcbmNvbnN0IERBU0hCT0FSRF9VUkwgPSBwcm9jZXNzLmVudi5EQVNIQk9BUkRfVVJMIHx8ICdodHRwczovL3NvbmdiaXJkLmJsdWVzLmNvbSc7XG5cbi8vIERlZHVwbGljYXRpb24gd2luZG93OiAyNCBob3VycyBpbiBtaWxsaXNlY29uZHNcbmNvbnN0IERFRFVQX1dJTkRPV19NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5cbi8vIEJhdHRlcnkgcmVjb3ZlcnkgdGhyZXNob2xkOiB2b2x0YWdlIGFib3ZlIHRoaXMgaXMgY29uc2lkZXJlZCBcInJlY292ZXJlZFwiXG5jb25zdCBSRUNPVkVSWV9USFJFU0hPTEQgPSAzLjU7IC8vIDAuNVYgYWJvdmUgbG93IGJhdHRlcnkgdGhyZXNob2xkICgzLjBWKVxuXG4vLyBUVEwgZm9yIGVtYWlsIHRyYWNraW5nIHJlY29yZHM6IDkwIGRheXNcbmNvbnN0IFRUTF9EQVlTID0gOTA7XG5jb25zdCBUVExfU0VDT05EUyA9IFRUTF9EQVlTICogMjQgKiA2MCAqIDYwO1xuXG5pbnRlcmZhY2UgQWxlcnRNZXNzYWdlIHtcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICBzZXJpYWxfbnVtYmVyPzogc3RyaW5nO1xuICBmbGVldD86IHN0cmluZztcbiAgYWxlcnRfdHlwZTogc3RyaW5nO1xuICB2YWx1ZT86IG51bWJlcjtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgbG9jYXRpb24/OiB7XG4gICAgbGF0OiBudW1iZXI7XG4gICAgbG9uOiBudW1iZXI7XG4gIH07XG59XG5cbmludGVyZmFjZSBEZXZpY2Uge1xuICBkZXZpY2VfdWlkOiBzdHJpbmc7XG4gIHNlcmlhbF9udW1iZXI/OiBzdHJpbmc7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGFzc2lnbmVkX3RvPzogc3RyaW5nO1xuICBhc3NpZ25lZF90b19uYW1lPzogc3RyaW5nO1xuICB2b2x0YWdlPzogbnVtYmVyO1xuICBsYXN0X3ZvbHRhZ2U/OiBudW1iZXI7XG4gIGxhc3Rfc2Vlbj86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBNYWluIExhbWJkYSBoYW5kbGVyXG4gKi9cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiBTTlNFdmVudCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICBjb25zb2xlLmxvZygnUmVjZWl2ZWQgU05TIGV2ZW50OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50LCBudWxsLCAyKSk7XG5cbiAgZm9yIChjb25zdCByZWNvcmQgb2YgZXZlbnQuUmVjb3Jkcykge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBwcm9jZXNzQWxlcnRSZWNvcmQocmVjb3JkKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc29sZS5lcnJvcignRXJyb3IgcHJvY2Vzc2luZyBhbGVydCByZWNvcmQ6JywgZXJyb3IpO1xuICAgICAgLy8gQ29udGludWUgcHJvY2Vzc2luZyBvdGhlciByZWNvcmRzIGV2ZW4gaWYgb25lIGZhaWxzXG4gICAgfVxuICB9XG59O1xuXG4vKipcbiAqIFByb2Nlc3MgYSBzaW5nbGUgU05TIHJlY29yZFxuICovXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzQWxlcnRSZWNvcmQocmVjb3JkOiBTTlNFdmVudFJlY29yZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtZXNzYWdlOiBBbGVydE1lc3NhZ2UgPSBKU09OLnBhcnNlKHJlY29yZC5TbnMuTWVzc2FnZSk7XG5cbiAgY29uc29sZS5sb2coJ1Byb2Nlc3NpbmcgYWxlcnQgbWVzc2FnZTonLCBtZXNzYWdlKTtcblxuICAvLyBPbmx5IHByb2Nlc3MgbG93X2JhdHRlcnkgYWxlcnRzXG4gIGlmIChtZXNzYWdlLmFsZXJ0X3R5cGUgIT09ICdsb3dfYmF0dGVyeScpIHtcbiAgICBjb25zb2xlLmxvZyhgU2tpcHBpbmcgbm9uLWxvd19iYXR0ZXJ5IGFsZXJ0OiAke21lc3NhZ2UuYWxlcnRfdHlwZX1gKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBHZXQgY3VycmVudCBkZXZpY2Ugc3RhdGVcbiAgY29uc3QgZGV2aWNlID0gYXdhaXQgZ2V0RGV2aWNlKG1lc3NhZ2UuZGV2aWNlX3VpZCk7XG5cbiAgLy8gQ2hlY2sgaWYgYmF0dGVyeSBoYXMgcmVjb3ZlcmVkXG4gIGlmIChkZXZpY2UgJiYgZGV2aWNlLnZvbHRhZ2UgJiYgZGV2aWNlLnZvbHRhZ2UgPj0gUkVDT1ZFUllfVEhSRVNIT0xEKSB7XG4gICAgY29uc29sZS5sb2coYERldmljZSAke21lc3NhZ2UuZGV2aWNlX3VpZH0gYmF0dGVyeSBoYXMgcmVjb3ZlcmVkIHRvICR7ZGV2aWNlLnZvbHRhZ2V9VmApO1xuICAgIGF3YWl0IGhhbmRsZUJhdHRlcnlSZWNvdmVyeShtZXNzYWdlLCBkZXZpY2UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENoZWNrIGZvciBkdXBsaWNhdGUgYWxlcnRzIHdpdGhpbiAyNC1ob3VyIHdpbmRvd1xuICBjb25zdCBpc0R1cGxpY2F0ZSA9IGF3YWl0IGlzUmVjZW50QWxlcnQobWVzc2FnZS5kZXZpY2VfdWlkLCAnbG93X2JhdHRlcnknKTtcbiAgaWYgKGlzRHVwbGljYXRlKSB7XG4gICAgY29uc29sZS5sb2coYFNraXBwaW5nIGR1cGxpY2F0ZSBhbGVydCBmb3IgJHttZXNzYWdlLmRldmljZV91aWR9IChhbHJlYWR5IHNlbnQgd2l0aGluIDI0IGhvdXJzKWApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRyeSB0byBjbGFpbSB0aGlzIGFsZXJ0IGJ5IHdyaXRpbmcgZGVkdXBsaWNhdGlvbiByZWNvcmQgRklSU1RcbiAgLy8gVGhpcyBwcmV2ZW50cyByYWNlIGNvbmRpdGlvbnMgd2hlbiBtdWx0aXBsZSBMYW1iZGEgaW52b2NhdGlvbnMgaGFwcGVuIHNpbXVsdGFuZW91c2x5XG4gIGNvbnN0IGNsYWltZWQgPSBhd2FpdCB0cnlDbGFpbUFsZXJ0KG1lc3NhZ2UuZGV2aWNlX3VpZCwgJ2xvd19iYXR0ZXJ5Jyk7XG4gIGlmICghY2xhaW1lZCkge1xuICAgIGNvbnNvbGUubG9nKGBBbm90aGVyIGludm9jYXRpb24gYWxyZWFkeSBjbGFpbWVkIHRoaXMgYWxlcnQgZm9yICR7bWVzc2FnZS5kZXZpY2VfdWlkfSwgc2tpcHBpbmdgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBHZXQgcmVjaXBpZW50cyAoZGV2aWNlIG93bmVyICsgYWxsIGFkbWlucylcbiAgY29uc3QgcmVjaXBpZW50cyA9IGF3YWl0IGdldFJlY2lwaWVudHMobWVzc2FnZS5kZXZpY2VfdWlkKTtcblxuICBpZiAocmVjaXBpZW50cy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLndhcm4oYE5vIHJlY2lwaWVudHMgZm91bmQgZm9yIGRldmljZSAke21lc3NhZ2UuZGV2aWNlX3VpZH1gKTtcbiAgICAvLyBDbGVhbiB1cCB0aGUgY2xhaW0gc2luY2Ugd2Ugd29uJ3Qgc2VuZFxuICAgIGF3YWl0IGNsZWFyRW1haWxTZW50UmVjb3JkKG1lc3NhZ2UuZGV2aWNlX3VpZCwgJ2xvd19iYXR0ZXJ5Jyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc29sZS5sb2coYFNlbmRpbmcgbG93IGJhdHRlcnkgYWxlcnQgdG8gJHtyZWNpcGllbnRzLmxlbmd0aH0gcmVjaXBpZW50KHMpOmAsIHJlY2lwaWVudHMpO1xuXG4gIC8vIFNlbmQgZW1haWwgdG8gYWxsIHJlY2lwaWVudHNcbiAgYXdhaXQgc2VuZExvd0JhdHRlcnlFbWFpbChtZXNzYWdlLCBkZXZpY2UsIHJlY2lwaWVudHMpO1xufVxuXG4vKipcbiAqIEhhbmRsZSBiYXR0ZXJ5IHJlY292ZXJ5IC0gc2VuZCByZWNvdmVyeSBlbWFpbCBpZiBhcHByb3ByaWF0ZVxuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVCYXR0ZXJ5UmVjb3ZlcnkoYWxlcnQ6IEFsZXJ0TWVzc2FnZSwgZGV2aWNlOiBEZXZpY2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gQ2hlY2sgaWYgd2Ugc2VudCBhIGxvdyBiYXR0ZXJ5IGFsZXJ0IHJlY2VudGx5XG4gIGNvbnN0IHJlY2VudEFsZXJ0ID0gYXdhaXQgZ2V0UmVjZW50QWxlcnQoZGV2aWNlLmRldmljZV91aWQsICdsb3dfYmF0dGVyeScpO1xuXG4gIGlmICghcmVjZW50QWxlcnQpIHtcbiAgICBjb25zb2xlLmxvZygnTm8gcmVjZW50IGxvdyBiYXR0ZXJ5IGFsZXJ0IGZvdW5kLCBza2lwcGluZyByZWNvdmVyeSBlbWFpbCcpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENoZWNrIGlmIHdlIGFscmVhZHkgc2VudCBhIHJlY292ZXJ5IGVtYWlsXG4gIGNvbnN0IGFscmVhZHlTZW50UmVjb3ZlcnkgPSBhd2FpdCBpc1JlY2VudEFsZXJ0KGRldmljZS5kZXZpY2VfdWlkLCAnYmF0dGVyeV9yZWNvdmVyZWQnKTtcbiAgaWYgKGFscmVhZHlTZW50UmVjb3ZlcnkpIHtcbiAgICBjb25zb2xlLmxvZygnUmVjb3ZlcnkgZW1haWwgYWxyZWFkeSBzZW50IHdpdGhpbiAyNCBob3Vycywgc2tpcHBpbmcnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCByZWNpcGllbnRzID0gYXdhaXQgZ2V0UmVjaXBpZW50cyhkZXZpY2UuZGV2aWNlX3VpZCk7XG5cbiAgaWYgKHJlY2lwaWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgY29uc29sZS53YXJuKGBObyByZWNpcGllbnRzIGZvdW5kIGZvciBkZXZpY2UgJHtkZXZpY2UuZGV2aWNlX3VpZH1gKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zb2xlLmxvZyhgU2VuZGluZyBiYXR0ZXJ5IHJlY292ZXJ5IGVtYWlsIHRvICR7cmVjaXBpZW50cy5sZW5ndGh9IHJlY2lwaWVudChzKTpgLCByZWNpcGllbnRzKTtcblxuICBhd2FpdCBzZW5kQmF0dGVyeVJlY292ZXJ5RW1haWwoYWxlcnQsIGRldmljZSwgcmVjaXBpZW50cyk7XG5cbiAgLy8gQ2xlYXIgdGhlIGxvdyBiYXR0ZXJ5IGRlZHVwbGljYXRpb24gYnkgZGVsZXRpbmcgdGhlIHRyYWNraW5nIHJlY29yZFxuICAvLyBUaGlzIGFsbG93cyBhIG5ldyBsb3cgYmF0dGVyeSBlbWFpbCBpZiB0aGUgYmF0dGVyeSBkcm9wcyBhZ2FpblxuICBhd2FpdCBjbGVhckVtYWlsU2VudFJlY29yZChkZXZpY2UuZGV2aWNlX3VpZCwgJ2xvd19iYXR0ZXJ5Jyk7XG59XG5cbi8qKlxuICogR2V0IGRldmljZSBkZXRhaWxzIGZyb20gRHluYW1vREJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0RGV2aWNlKGRldmljZVVpZDogc3RyaW5nKTogUHJvbWlzZTxEZXZpY2UgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IEdldENvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgS2V5OiB7IGRldmljZV91aWQ6IGRldmljZVVpZCB9LFxuICAgIH0pKTtcblxuICAgIHJldHVybiByZXN1bHQuSXRlbSBhcyBEZXZpY2UgfHwgbnVsbDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBmZXRjaGluZyBkZXZpY2U6JywgZXJyb3IpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSByZWNlbnQgYWxlcnQgb2YgdGhlIGdpdmVuIHR5cGUgZXhpc3RzIGZvciB0aGlzIGRldmljZVxuICovXG5hc3luYyBmdW5jdGlvbiBpc1JlY2VudEFsZXJ0KGRldmljZVVpZDogc3RyaW5nLCBhbGVydFR5cGU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIERFRFVQX1dJTkRPV19NUztcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgY3JlYXRlZF9hdCA+IDpjdXRvZmYnLFxuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyN0eXBlID0gOmFsZXJ0X3R5cGUgQU5EIGVtYWlsX3NlbnQgPSA6dHJ1ZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0eXBlJzogJ3R5cGUnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmFsZXJ0X3R5cGUnOiBhbGVydFR5cGUsXG4gICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgJzp0cnVlJzogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBMaW1pdDogMSxcbiAgICB9KSk7XG5cbiAgICByZXR1cm4gKHJlc3VsdC5JdGVtcz8ubGVuZ3RoIHx8IDApID4gMDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBjaGVja2luZyBmb3IgcmVjZW50IGFsZXJ0czonLCBlcnJvcik7XG4gICAgLy8gSWYgd2UgY2FuJ3QgY2hlY2ssIGVyciBvbiB0aGUgc2lkZSBvZiBzZW5kaW5nIHRoZSBlbWFpbFxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgbW9zdCByZWNlbnQgYWxlcnQgb2YgdGhlIGdpdmVuIHR5cGUgZm9yIHRoaXMgZGV2aWNlXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldFJlY2VudEFsZXJ0KGRldmljZVVpZDogc3RyaW5nLCBhbGVydFR5cGU6IHN0cmluZyk6IFByb21pc2U8YW55IHwgbnVsbD4ge1xuICBjb25zdCBjdXRvZmZUaW1lID0gRGF0ZS5ub3coKSAtIERFRFVQX1dJTkRPV19NUztcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBRdWVyeUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBJbmRleE5hbWU6ICdkZXZpY2UtaW5kZXgnLFxuICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQgPSA6ZGV2aWNlX3VpZCBBTkQgY3JlYXRlZF9hdCA+IDpjdXRvZmYnLFxuICAgICAgRmlsdGVyRXhwcmVzc2lvbjogJyN0eXBlID0gOmFsZXJ0X3R5cGUgQU5EIGVtYWlsX3NlbnQgPSA6dHJ1ZScsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICAgJyN0eXBlJzogJ3R5cGUnLFxuICAgICAgfSxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpkZXZpY2VfdWlkJzogZGV2aWNlVWlkLFxuICAgICAgICAnOmFsZXJ0X3R5cGUnOiBhbGVydFR5cGUsXG4gICAgICAgICc6Y3V0b2ZmJzogY3V0b2ZmVGltZSxcbiAgICAgICAgJzp0cnVlJzogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICBTY2FuSW5kZXhGb3J3YXJkOiBmYWxzZSwgLy8gTW9zdCByZWNlbnQgZmlyc3RcbiAgICAgIExpbWl0OiAxLFxuICAgIH0pKTtcblxuICAgIHJldHVybiByZXN1bHQuSXRlbXM/LlswXSB8fCBudWxsO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGZldGNoaW5nIHJlY2VudCBhbGVydDonLCBlcnJvcik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgbGlzdCBvZiBlbWFpbCByZWNpcGllbnRzIGZvciBhbGVydHNcbiAqIFJldHVybnMgb25seSB0aGUgZGV2aWNlIG93bmVyIChpZiBhc3NpZ25lZClcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0UmVjaXBpZW50cyhkZXZpY2VVaWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgcmVjaXBpZW50czogc3RyaW5nW10gPSBbXTtcblxuICB0cnkge1xuICAgIC8vIEdldCBkZXZpY2Ugb3duZXIgZW1haWxcbiAgICBjb25zdCBkZXZpY2UgPSBhd2FpdCBnZXREZXZpY2UoZGV2aWNlVWlkKTtcbiAgICBpZiAoZGV2aWNlPy5hc3NpZ25lZF90bykge1xuICAgICAgcmVjaXBpZW50cy5wdXNoKGRldmljZS5hc3NpZ25lZF90byk7XG4gICAgICBjb25zb2xlLmxvZyhgQWRkZWQgZGV2aWNlIG93bmVyOiAke2RldmljZS5hc3NpZ25lZF90b31gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coYE5vIGRldmljZSBvd25lciBhc3NpZ25lZCBmb3IgZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICAgIH1cblxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGZldGNoaW5nIHJlY2lwaWVudHM6JywgZXJyb3IpO1xuICB9XG5cbiAgcmV0dXJuIHJlY2lwaWVudHM7XG59XG5cbi8vIENvZ25pdG8gaW50ZWdyYXRpb24gcmVtb3ZlZCAtIHdlIG9ubHkgc2VuZCB0byBkZXZpY2Ugb3duZXJzIG5vd1xuLy8gQWRtaW4gdXNlcnMgZG8gbm90IHJlY2VpdmUgbG93IGJhdHRlcnkgYWxlcnRzXG5cbi8qKlxuICogU2VuZCBsb3cgYmF0dGVyeSBhbGVydCBlbWFpbFxuICovXG5hc3luYyBmdW5jdGlvbiBzZW5kTG93QmF0dGVyeUVtYWlsKFxuICBhbGVydDogQWxlcnRNZXNzYWdlLFxuICBkZXZpY2U6IERldmljZSB8IG51bGwsXG4gIHJlY2lwaWVudHM6IHN0cmluZ1tdXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGV2aWNlTmFtZSA9IGRldmljZT8ubmFtZSB8fCBkZXZpY2U/LnNlcmlhbF9udW1iZXIgfHwgYWxlcnQuc2VyaWFsX251bWJlciB8fCBhbGVydC5kZXZpY2VfdWlkO1xuICBjb25zdCB2b2x0YWdlID0gYWxlcnQudmFsdWU/LnRvRml4ZWQoMikgfHwgJ3Vua25vd24nO1xuICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZShhbGVydC50aW1lc3RhbXAgKiAxMDAwKS50b0xvY2FsZVN0cmluZygnZW4tVVMnLCB7XG4gICAgdGltZVpvbmU6ICdVVEMnLFxuICAgIGRhdGVTdHlsZTogJ21lZGl1bScsXG4gICAgdGltZVN0eWxlOiAnc2hvcnQnLFxuICB9KTtcblxuICBjb25zdCBkZXZpY2VVcmwgPSBgJHtEQVNIQk9BUkRfVVJMfS9kZXZpY2VzLyR7YWxlcnQuc2VyaWFsX251bWJlciB8fCBhbGVydC5kZXZpY2VfdWlkfWA7XG5cbiAgY29uc3Qgc3ViamVjdCA9IGDwn5SLIExvdyBCYXR0ZXJ5IEFsZXJ0OiAke2RldmljZU5hbWV9ICgke3ZvbHRhZ2V9VilgO1xuXG4gIGNvbnN0IGh0bWxCb2R5ID0gZ2VuZXJhdGVMb3dCYXR0ZXJ5SHRtbEVtYWlsKGRldmljZU5hbWUsIHZvbHRhZ2UsIHRpbWVzdGFtcCwgZGV2aWNlVXJsLCBhbGVydCk7XG4gIGNvbnN0IHRleHRCb2R5ID0gZ2VuZXJhdGVMb3dCYXR0ZXJ5VGV4dEVtYWlsKGRldmljZU5hbWUsIHZvbHRhZ2UsIHRpbWVzdGFtcCwgZGV2aWNlVXJsLCBhbGVydCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzZXNDbGllbnQuc2VuZChuZXcgU2VuZEVtYWlsQ29tbWFuZCh7XG4gICAgICBTb3VyY2U6IFNFTkRFUl9FTUFJTCxcbiAgICAgIERlc3RpbmF0aW9uOiB7XG4gICAgICAgIFRvQWRkcmVzc2VzOiByZWNpcGllbnRzLFxuICAgICAgfSxcbiAgICAgIE1lc3NhZ2U6IHtcbiAgICAgICAgU3ViamVjdDoge1xuICAgICAgICAgIERhdGE6IHN1YmplY3QsXG4gICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgfSxcbiAgICAgICAgQm9keToge1xuICAgICAgICAgIEh0bWw6IHtcbiAgICAgICAgICAgIERhdGE6IGh0bWxCb2R5LFxuICAgICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFRleHQ6IHtcbiAgICAgICAgICAgIERhdGE6IHRleHRCb2R5LFxuICAgICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICBjb25zb2xlLmxvZygnRW1haWwgc2VudCBzdWNjZXNzZnVsbHk6JywgcmVzdWx0Lk1lc3NhZ2VJZCk7XG5cbiAgICAvLyBOb3RlOiBEZWR1cGxpY2F0aW9uIHJlY29yZCBhbHJlYWR5IHdyaXR0ZW4gYnkgdHJ5Q2xhaW1BbGVydCBiZWZvcmUgc2VuZGluZ1xuXG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3Igc2VuZGluZyBlbWFpbDonLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuLyoqXG4gKiBTZW5kIGJhdHRlcnkgcmVjb3ZlcnkgZW1haWxcbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VuZEJhdHRlcnlSZWNvdmVyeUVtYWlsKFxuICBhbGVydDogQWxlcnRNZXNzYWdlLFxuICBkZXZpY2U6IERldmljZSxcbiAgcmVjaXBpZW50czogc3RyaW5nW11cbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkZXZpY2VOYW1lID0gZGV2aWNlLm5hbWUgfHwgZGV2aWNlLnNlcmlhbF9udW1iZXIgfHwgYWxlcnQuc2VyaWFsX251bWJlciB8fCBhbGVydC5kZXZpY2VfdWlkO1xuICBjb25zdCB2b2x0YWdlID0gZGV2aWNlLnZvbHRhZ2U/LnRvRml4ZWQoMikgfHwgJ3Vua25vd24nO1xuICBjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvTG9jYWxlU3RyaW5nKCdlbi1VUycsIHtcbiAgICB0aW1lWm9uZTogJ1VUQycsXG4gICAgZGF0ZVN0eWxlOiAnbWVkaXVtJyxcbiAgICB0aW1lU3R5bGU6ICdzaG9ydCcsXG4gIH0pO1xuXG4gIGNvbnN0IGRldmljZVVybCA9IGAke0RBU0hCT0FSRF9VUkx9L2RldmljZXMvJHtkZXZpY2Uuc2VyaWFsX251bWJlciB8fCBkZXZpY2UuZGV2aWNlX3VpZH1gO1xuXG4gIGNvbnN0IHN1YmplY3QgPSBg4pyFIEJhdHRlcnkgUmVjb3ZlcmVkOiAke2RldmljZU5hbWV9ICgke3ZvbHRhZ2V9VilgO1xuXG4gIGNvbnN0IGh0bWxCb2R5ID0gZ2VuZXJhdGVCYXR0ZXJ5UmVjb3ZlcnlIdG1sRW1haWwoZGV2aWNlTmFtZSwgdm9sdGFnZSwgdGltZXN0YW1wLCBkZXZpY2VVcmwpO1xuICBjb25zdCB0ZXh0Qm9keSA9IGdlbmVyYXRlQmF0dGVyeVJlY292ZXJ5VGV4dEVtYWlsKGRldmljZU5hbWUsIHZvbHRhZ2UsIHRpbWVzdGFtcCwgZGV2aWNlVXJsKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc0NsaWVudC5zZW5kKG5ldyBTZW5kRW1haWxDb21tYW5kKHtcbiAgICAgIFNvdXJjZTogU0VOREVSX0VNQUlMLFxuICAgICAgRGVzdGluYXRpb246IHtcbiAgICAgICAgVG9BZGRyZXNzZXM6IHJlY2lwaWVudHMsXG4gICAgICB9LFxuICAgICAgTWVzc2FnZToge1xuICAgICAgICBTdWJqZWN0OiB7XG4gICAgICAgICAgRGF0YTogc3ViamVjdCxcbiAgICAgICAgICBDaGFyc2V0OiAnVVRGLTgnLFxuICAgICAgICB9LFxuICAgICAgICBCb2R5OiB7XG4gICAgICAgICAgSHRtbDoge1xuICAgICAgICAgICAgRGF0YTogaHRtbEJvZHksXG4gICAgICAgICAgICBDaGFyc2V0OiAnVVRGLTgnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgVGV4dDoge1xuICAgICAgICAgICAgRGF0YTogdGV4dEJvZHksXG4gICAgICAgICAgICBDaGFyc2V0OiAnVVRGLTgnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIGNvbnNvbGUubG9nKCdCYXR0ZXJ5IHJlY292ZXJ5IGVtYWlsIHNlbnQgc3VjY2Vzc2Z1bGx5OicsIHJlc3VsdC5NZXNzYWdlSWQpO1xuXG4gICAgLy8gUmVjb3JkIHRoYXQgd2Ugc2VudCBhIHJlY292ZXJ5IGVtYWlsXG4gICAgYXdhaXQgcmVjb3JkRW1haWxTZW50KGRldmljZS5kZXZpY2VfdWlkLCAnYmF0dGVyeV9yZWNvdmVyZWQnKTtcblxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNlbmRpbmcgYmF0dGVyeSByZWNvdmVyeSBlbWFpbDonLCBlcnJvcik7XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuLyoqXG4gKiBUcnkgdG8gY2xhaW0gYW4gYWxlcnQgZm9yIHByb2Nlc3NpbmcgdXNpbmcgYXRvbWljIGNvbmRpdGlvbmFsIHdyaXRlXG4gKiBSZXR1cm5zIHRydWUgaWYgc3VjY2Vzc2Z1bGx5IGNsYWltZWQsIGZhbHNlIGlmIGFub3RoZXIgaW52b2NhdGlvbiBhbHJlYWR5IGNsYWltZWQgaXRcbiAqIFRoaXMgcHJldmVudHMgcmFjZSBjb25kaXRpb25zIHdoZW4gbXVsdGlwbGUgTGFtYmRhIGludm9jYXRpb25zIGhhcHBlbiBzaW11bHRhbmVvdXNseVxuICovXG5hc3luYyBmdW5jdGlvbiB0cnlDbGFpbUFsZXJ0KGRldmljZVVpZDogc3RyaW5nLCBhbGVydFR5cGU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG4gIC8vIFVzZSB0aW1lc3RhbXAtYmFzZWQgSUQgZm9yIGNvbnNpc3RlbnQgY2xhaW1pbmcgd2l0aGluIHNhbWUgbWlsbGlzZWNvbmRcbiAgY29uc3QgYWxlcnRJZCA9IGBlbWFpbF8ke2RldmljZVVpZH1fJHthbGVydFR5cGV9XyR7bm93fWA7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEFMRVJUU19UQUJMRSxcbiAgICAgIEl0ZW06IHtcbiAgICAgICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgdHlwZTogYWxlcnRUeXBlLFxuICAgICAgICBjcmVhdGVkX2F0OiBub3csXG4gICAgICAgIHR0bCxcbiAgICAgICAgZW1haWxfc2VudDogdHJ1ZSxcbiAgICAgICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBNYXRjaCBleGlzdGluZyBzY2hlbWFcbiAgICAgIH0sXG4gICAgICAvLyBDb25kaXRpb25hbCB3cml0ZSAtIG9ubHkgc3VjY2VlZCBpZiB0aGlzIGFsZXJ0X2lkIGRvZXNuJ3QgZXhpc3QgeWV0XG4gICAgICBDb25kaXRpb25FeHByZXNzaW9uOiAnYXR0cmlidXRlX25vdF9leGlzdHMoYWxlcnRfaWQpJyxcbiAgICB9KSk7XG5cbiAgICBjb25zb2xlLmxvZyhgU3VjY2Vzc2Z1bGx5IGNsYWltZWQgYWxlcnQ6ICR7YWxlcnRUeXBlfSBmb3IgZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgaWYgKGVycm9yLm5hbWUgPT09ICdDb25kaXRpb25hbENoZWNrRmFpbGVkRXhjZXB0aW9uJykge1xuICAgICAgY29uc29sZS5sb2coYEFsZXJ0IGFscmVhZHkgY2xhaW1lZCBieSBhbm90aGVyIGludm9jYXRpb246ICR7YWxlcnRUeXBlfSBmb3IgZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBjbGFpbWluZyBhbGVydDonLCBlcnJvcik7XG4gICAgLy8gT24gb3RoZXIgZXJyb3JzLCBhbGxvdyB0aGUgZW1haWwgdG8gYmUgc2VudFxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbi8qKlxuICogUmVjb3JkIHRoYXQgYW4gZW1haWwgd2FzIHNlbnQgKGZvciBkZWR1cGxpY2F0aW9uKVxuICogQ3JlYXRlcyBhIHRyYWNraW5nIHJlY29yZCBpbiB0aGUgYWxlcnRzIHRhYmxlIHdpdGggZW1haWxfc2VudCBmbGFnXG4gKiBOb3RlOiBGb3IgbG93X2JhdHRlcnkgYWxlcnRzLCB1c2UgdHJ5Q2xhaW1BbGVydCBpbnN0ZWFkIHRvIHByZXZlbnQgcmFjZSBjb25kaXRpb25zXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlY29yZEVtYWlsU2VudChkZXZpY2VVaWQ6IHN0cmluZywgYWxlcnRUeXBlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihub3cgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuICBjb25zdCBhbGVydElkID0gYGVtYWlsXyR7ZGV2aWNlVWlkfV8ke2FsZXJ0VHlwZX1fJHtub3d9XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDcpfWA7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUHV0Q29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IEFMRVJUU19UQUJMRSxcbiAgICAgIEl0ZW06IHtcbiAgICAgICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgICAgIGRldmljZV91aWQ6IGRldmljZVVpZCxcbiAgICAgICAgdHlwZTogYWxlcnRUeXBlLFxuICAgICAgICBjcmVhdGVkX2F0OiBub3csXG4gICAgICAgIHR0bCxcbiAgICAgICAgZW1haWxfc2VudDogdHJ1ZSxcbiAgICAgICAgYWNrbm93bGVkZ2VkOiAnZmFsc2UnLCAvLyBNYXRjaCBleGlzdGluZyBzY2hlbWFcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgY29uc29sZS5sb2coYFJlY29yZGVkIGVtYWlsIHNlbnQ6ICR7YWxlcnRUeXBlfSBmb3IgZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHJlY29yZGluZyBlbWFpbCBzZW50OicsIGVycm9yKTtcbiAgICAvLyBOb24tY3JpdGljYWwsIGRvbid0IHRocm93XG4gIH1cbn1cblxuLyoqXG4gKiBDbGVhciBlbWFpbCBzZW50IHRyYWNraW5nIHJlY29yZHMgZm9yIGEgc3BlY2lmaWMgYWxlcnQgdHlwZVxuICogVXNlZCB3aGVuIGJhdHRlcnkgcmVjb3ZlcnMgdG8gYWxsb3cgbmV3IGxvdyBiYXR0ZXJ5IGVtYWlscyBpZiB2b2x0YWdlIGRyb3BzIGFnYWluXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyRW1haWxTZW50UmVjb3JkKGRldmljZVVpZDogc3RyaW5nLCBhbGVydFR5cGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIC8vIEZpbmQgdGhlIG1vc3QgcmVjZW50IGVtYWlsIHNlbnQgcmVjb3JkXG4gICAgY29uc3QgcmVjZW50QWxlcnQgPSBhd2FpdCBnZXRSZWNlbnRBbGVydChkZXZpY2VVaWQsIGFsZXJ0VHlwZSk7XG5cbiAgICBpZiAoIXJlY2VudEFsZXJ0KSB7XG4gICAgICBjb25zb2xlLmxvZyhgTm8gZW1haWwgdHJhY2tpbmcgcmVjb3JkIGZvdW5kIGZvciAke2FsZXJ0VHlwZX0gb24gZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIERlbGV0ZSB0aGUgdHJhY2tpbmcgcmVjb3JkXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBLZXk6IHtcbiAgICAgICAgYWxlcnRfaWQ6IHJlY2VudEFsZXJ0LmFsZXJ0X2lkLFxuICAgICAgICBjcmVhdGVkX2F0OiByZWNlbnRBbGVydC5jcmVhdGVkX2F0LFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICBjb25zb2xlLmxvZyhgQ2xlYXJlZCBlbWFpbCB0cmFja2luZyByZWNvcmQ6ICR7YWxlcnRUeXBlfSBmb3IgZGV2aWNlICR7ZGV2aWNlVWlkfWApO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNsZWFyaW5nIGVtYWlsIHRyYWNraW5nIHJlY29yZDonLCBlcnJvcik7XG4gICAgLy8gTm9uLWNyaXRpY2FsLCBkb24ndCB0aHJvd1xuICB9XG59XG5cbi8qKlxuICogR2VuZXJhdGUgSFRNTCBlbWFpbCBib2R5IGZvciBsb3cgYmF0dGVyeSBhbGVydFxuICovXG5mdW5jdGlvbiBnZW5lcmF0ZUxvd0JhdHRlcnlIdG1sRW1haWwoXG4gIGRldmljZU5hbWU6IHN0cmluZyxcbiAgdm9sdGFnZTogc3RyaW5nLFxuICB0aW1lc3RhbXA6IHN0cmluZyxcbiAgZGV2aWNlVXJsOiBzdHJpbmcsXG4gIGFsZXJ0OiBBbGVydE1lc3NhZ2Vcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxvY2F0aW9uID0gYWxlcnQubG9jYXRpb25cbiAgICA/IGBcbiAgICA8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOiAxcHggc29saWQgI2U1ZTdlYjtcIj5cbiAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+TG9jYXRpb246PC90ZD5cbiAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICMxZjI5Mzc7XCI+JHthbGVydC5sb2NhdGlvbi5sYXQudG9GaXhlZCg1KX0sICR7YWxlcnQubG9jYXRpb24ubG9uLnRvRml4ZWQoNSl9PC90ZD5cbiAgICA8L3RyPmBcbiAgICA6ICcnO1xuXG4gIHJldHVybiBgXG48IURPQ1RZUEUgaHRtbD5cbjxodG1sPlxuPGhlYWQ+XG4gIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiPlxuICA8bWV0YSBuYW1lPVwidmlld3BvcnRcIiBjb250ZW50PVwid2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMFwiPlxuICA8dGl0bGU+TG93IEJhdHRlcnkgQWxlcnQ8L3RpdGxlPlxuPC9oZWFkPlxuPGJvZHkgc3R5bGU9XCJmb250LWZhbWlseTogLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAnU2Vnb2UgVUknLCBSb2JvdG8sICdIZWx2ZXRpY2EgTmV1ZScsIEFyaWFsLCBzYW5zLXNlcmlmOyBsaW5lLWhlaWdodDogMS42OyBjb2xvcjogIzMzMzsgbWF4LXdpZHRoOiA2MDBweDsgbWFyZ2luOiAwIGF1dG87IHBhZGRpbmc6IDIwcHg7IGJhY2tncm91bmQtY29sb3I6ICNmOWZhZmI7XCI+XG4gIDxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCAjNjY3ZWVhIDAlLCAjNzY0YmEyIDEwMCUpOyBwYWRkaW5nOiAzMHB4OyBib3JkZXItcmFkaXVzOiA4cHggOHB4IDAgMDsgdGV4dC1hbGlnbjogY2VudGVyO1wiPlxuICAgIDxoMSBzdHlsZT1cImNvbG9yOiAjMDAwMDAwOyBtYXJnaW46IDA7IGZvbnQtc2l6ZTogMjRweDtcIj7wn5SLIExvdyBCYXR0ZXJ5IEFsZXJ0PC9oMT5cbiAgPC9kaXY+XG5cbiAgPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6ICNmZmZmZmY7IHBhZGRpbmc6IDMwcHg7IGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7IGJvcmRlci10b3A6IG5vbmU7IGJvcmRlci1yYWRpdXM6IDAgMCA4cHggOHB4O1wiPlxuICAgIDxwIHN0eWxlPVwiZm9udC1zaXplOiAxNnB4OyBtYXJnaW4tdG9wOiAwO1wiPkEgU29uZ2JpcmQgZGV2aWNlIGhhcyBkZXRlY3RlZCBhIGxvdyBiYXR0ZXJ5IGNvbmRpdGlvbiBhbmQgaGFzIHJlc3RhcnRlZC48L3A+XG5cbiAgICA8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDogI2ZlZjNjNzsgYm9yZGVyLWxlZnQ6IDRweCBzb2xpZCAjZjU5ZTBiOyBwYWRkaW5nOiAxNXB4OyBtYXJnaW46IDIwcHggMDsgYm9yZGVyLXJhZGl1czogNHB4O1wiPlxuICAgICAgPHAgc3R5bGU9XCJtYXJnaW46IDA7IGZvbnQtd2VpZ2h0OiA2MDA7XCI+4pqg77iPIEFjdGlvbiBSZXF1aXJlZDwvcD5cbiAgICAgIDxwIHN0eWxlPVwibWFyZ2luOiA1cHggMCAwIDA7XCI+UGxlYXNlIGNoYXJnZSB0aGlzIGRldmljZSBzb29uIHRvIHByZXZlbnQgc2VydmljZSBpbnRlcnJ1cHRpb24uPC9wPlxuICAgIDwvZGl2PlxuXG4gICAgPGgyIHN0eWxlPVwiY29sb3I6ICMxZjI5Mzc7IGZvbnQtc2l6ZTogMThweDsgbWFyZ2luLXRvcDogMjVweDsgbWFyZ2luLWJvdHRvbTogMTVweDtcIj5EZXZpY2UgRGV0YWlsczwvaDI+XG5cbiAgICA8dGFibGUgc3R5bGU9XCJ3aWR0aDogMTAwJTsgYm9yZGVyLWNvbGxhcHNlOiBjb2xsYXBzZTtcIj5cbiAgICAgIDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGZvbnQtd2VpZ2h0OiA2MDA7IGNvbG9yOiAjNmI3MjgwO1wiPkRldmljZTo8L3RkPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGNvbG9yOiAjMWYyOTM3O1wiPiR7ZGV2aWNlTmFtZX08L3RkPlxuICAgICAgPC90cj5cbiAgICAgIDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGZvbnQtd2VpZ2h0OiA2MDA7IGNvbG9yOiAjNmI3MjgwO1wiPkJhdHRlcnkgVm9sdGFnZTo8L3RkPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGNvbG9yOiAjZGMyNjI2OyBmb250LXdlaWdodDogNjAwO1wiPiR7dm9sdGFnZX1WPC90ZD5cbiAgICAgIDwvdHI+XG4gICAgICA8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOiAxcHggc29saWQgI2U1ZTdlYjtcIj5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBmb250LXdlaWdodDogNjAwOyBjb2xvcjogIzZiNzI4MDtcIj5UaW1lOjwvdGQ+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICMxZjI5Mzc7XCI+JHt0aW1lc3RhbXB9IFVUQzwvdGQ+XG4gICAgICA8L3RyPlxuICAgICAgJHtsb2NhdGlvbn1cbiAgICA8L3RhYmxlPlxuXG4gICAgPGRpdiBzdHlsZT1cInRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luLXRvcDogMzBweDtcIj5cbiAgICAgIDxhIGhyZWY9XCIke2RldmljZVVybH1cIiBzdHlsZT1cImRpc3BsYXk6IGlubGluZS1ibG9jazsgYmFja2dyb3VuZDogIzY2N2VlYTsgY29sb3I6IHdoaXRlOyBwYWRkaW5nOiAxMnB4IDMwcHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgYm9yZGVyLXJhZGl1czogNnB4OyBmb250LXdlaWdodDogNjAwO1wiPlZpZXcgRGV2aWNlIERhc2hib2FyZDwvYT5cbiAgICA8L2Rpdj5cblxuICAgIDxwIHN0eWxlPVwiY29sb3I6ICM2YjcyODA7IGZvbnQtc2l6ZTogMTRweDsgbWFyZ2luLXRvcDogMzBweDsgcGFkZGluZy10b3A6IDIwcHg7IGJvcmRlci10b3A6IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgVGhpcyBpcyBhbiBhdXRvbWF0ZWQgYWxlcnQgZnJvbSB5b3VyIFNvbmdiaXJkIGZsZWV0IG1hbmFnZW1lbnQgc3lzdGVtLiBZb3UgYXJlIHJlY2VpdmluZyB0aGlzIGJlY2F1c2UgeW91IGFyZSBhc3NpZ25lZCB0byB0aGlzIGRldmljZSBvciBhcmUgYW4gYWRtaW5pc3RyYXRvci5cbiAgICA8L3A+XG4gIDwvZGl2PlxuXG4gIDxkaXYgc3R5bGU9XCJ0ZXh0LWFsaWduOiBjZW50ZXI7IHBhZGRpbmc6IDIwcHg7IGNvbG9yOiAjNmI3MjgwOyBmb250LXNpemU6IDEycHg7XCI+XG4gICAgPHAgc3R5bGU9XCJtYXJnaW46IDA7XCI+Qmx1ZXMgV2lyZWxlc3Mg4oCiIFNvbmdiaXJkIEFsZXJ0IFN5c3RlbTwvcD5cbiAgPC9kaXY+XG48L2JvZHk+XG48L2h0bWw+XG4gIGAudHJpbSgpO1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIHBsYWluIHRleHQgZW1haWwgYm9keSBmb3IgbG93IGJhdHRlcnkgYWxlcnRcbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVMb3dCYXR0ZXJ5VGV4dEVtYWlsKFxuICBkZXZpY2VOYW1lOiBzdHJpbmcsXG4gIHZvbHRhZ2U6IHN0cmluZyxcbiAgdGltZXN0YW1wOiBzdHJpbmcsXG4gIGRldmljZVVybDogc3RyaW5nLFxuICBhbGVydDogQWxlcnRNZXNzYWdlXG4pOiBzdHJpbmcge1xuICBjb25zdCBsb2NhdGlvbiA9IGFsZXJ0LmxvY2F0aW9uXG4gICAgPyBgTG9jYXRpb246ICR7YWxlcnQubG9jYXRpb24ubGF0LnRvRml4ZWQoNSl9LCAke2FsZXJ0LmxvY2F0aW9uLmxvbi50b0ZpeGVkKDUpfVxcbmBcbiAgICA6ICcnO1xuXG4gIHJldHVybiBgXG5MT1cgQkFUVEVSWSBBTEVSVFxuPT09PT09PT09PT09PT09PT1cblxuQSBTb25nYmlyZCBkZXZpY2UgaGFzIGRldGVjdGVkIGEgbG93IGJhdHRlcnkgY29uZGl0aW9uIGFuZCBoYXMgcmVzdGFydGVkLlxuXG7imqDvuI8gQUNUSU9OIFJFUVVJUkVEOiBQbGVhc2UgY2hhcmdlIHRoaXMgZGV2aWNlIHNvb24gdG8gcHJldmVudCBzZXJ2aWNlIGludGVycnVwdGlvbi5cblxuRGV2aWNlIERldGFpbHNcbi0tLS0tLS0tLS0tLS0tXG5EZXZpY2U6ICR7ZGV2aWNlTmFtZX1cbkJhdHRlcnkgVm9sdGFnZTogJHt2b2x0YWdlfVZcblRpbWU6ICR7dGltZXN0YW1wfSBVVENcbiR7bG9jYXRpb259XG5WaWV3IERldmljZTogJHtkZXZpY2VVcmx9XG5cbi0tLVxuVGhpcyBpcyBhbiBhdXRvbWF0ZWQgYWxlcnQgZnJvbSB5b3VyIFNvbmdiaXJkIGZsZWV0IG1hbmFnZW1lbnQgc3lzdGVtLlxuWW91IGFyZSByZWNlaXZpbmcgdGhpcyBiZWNhdXNlIHlvdSBhcmUgYXNzaWduZWQgdG8gdGhpcyBkZXZpY2Ugb3IgYXJlIGFuIGFkbWluaXN0cmF0b3IuXG5cbkJsdWVzIFdpcmVsZXNzIOKAoiBTb25nYmlyZCBBbGVydCBTeXN0ZW1cbiAgYC50cmltKCk7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgSFRNTCBlbWFpbCBib2R5IGZvciBiYXR0ZXJ5IHJlY292ZXJ5XG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlQmF0dGVyeVJlY292ZXJ5SHRtbEVtYWlsKFxuICBkZXZpY2VOYW1lOiBzdHJpbmcsXG4gIHZvbHRhZ2U6IHN0cmluZyxcbiAgdGltZXN0YW1wOiBzdHJpbmcsXG4gIGRldmljZVVybDogc3RyaW5nXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYFxuPCFET0NUWVBFIGh0bWw+XG48aHRtbD5cbjxoZWFkPlxuICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIj5cbiAgPG1ldGEgbmFtZT1cInZpZXdwb3J0XCIgY29udGVudD1cIndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjBcIj5cbiAgPHRpdGxlPkJhdHRlcnkgUmVjb3ZlcmVkPC90aXRsZT5cbjwvaGVhZD5cbjxib2R5IHN0eWxlPVwiZm9udC1mYW1pbHk6IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgJ1NlZ29lIFVJJywgUm9ib3RvLCAnSGVsdmV0aWNhIE5ldWUnLCBBcmlhbCwgc2Fucy1zZXJpZjsgbGluZS1oZWlnaHQ6IDEuNjsgY29sb3I6ICMzMzM7IG1heC13aWR0aDogNjAwcHg7IG1hcmdpbjogMCBhdXRvOyBwYWRkaW5nOiAyMHB4OyBiYWNrZ3JvdW5kLWNvbG9yOiAjZjlmYWZiO1wiPlxuICA8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgIzEwYjk4MSAwJSwgIzA1OTY2OSAxMDAlKTsgcGFkZGluZzogMzBweDsgYm9yZGVyLXJhZGl1czogOHB4IDhweCAwIDA7IHRleHQtYWxpZ246IGNlbnRlcjtcIj5cbiAgICA8aDEgc3R5bGU9XCJjb2xvcjogIzAwMDAwMDsgbWFyZ2luOiAwOyBmb250LXNpemU6IDI0cHg7XCI+4pyFIEJhdHRlcnkgUmVjb3ZlcmVkPC9oMT5cbiAgPC9kaXY+XG5cbiAgPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6ICNmZmZmZmY7IHBhZGRpbmc6IDMwcHg7IGJvcmRlcjogMXB4IHNvbGlkICNlNWU3ZWI7IGJvcmRlci10b3A6IG5vbmU7IGJvcmRlci1yYWRpdXM6IDAgMCA4cHggOHB4O1wiPlxuICAgIDxwIHN0eWxlPVwiZm9udC1zaXplOiAxNnB4OyBtYXJnaW4tdG9wOiAwO1wiPkdvb2QgbmV3cyEgVGhlIGJhdHRlcnkgb24geW91ciBTb25nYmlyZCBkZXZpY2UgaGFzIHJlY292ZXJlZCB0byBub3JtYWwgbGV2ZWxzLjwvcD5cblxuICAgIDxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiAjZDFmYWU1OyBib3JkZXItbGVmdDogNHB4IHNvbGlkICMxMGI5ODE7IHBhZGRpbmc6IDE1cHg7IG1hcmdpbjogMjBweCAwOyBib3JkZXItcmFkaXVzOiA0cHg7XCI+XG4gICAgICA8cCBzdHlsZT1cIm1hcmdpbjogMDsgZm9udC13ZWlnaHQ6IDYwMDtcIj7inJMgQmF0dGVyeSBTdGF0dXM6IE5vcm1hbDwvcD5cbiAgICAgIDxwIHN0eWxlPVwibWFyZ2luOiA1cHggMCAwIDA7XCI+VGhlIGRldmljZSBpcyBvcGVyYXRpbmcgbm9ybWFsbHkgYW5kIG5vIGFjdGlvbiBpcyByZXF1aXJlZC48L3A+XG4gICAgPC9kaXY+XG5cbiAgICA8aDIgc3R5bGU9XCJjb2xvcjogIzFmMjkzNzsgZm9udC1zaXplOiAxOHB4OyBtYXJnaW4tdG9wOiAyNXB4OyBtYXJnaW4tYm90dG9tOiAxNXB4O1wiPkRldmljZSBEZXRhaWxzPC9oMj5cblxuICAgIDx0YWJsZSBzdHlsZT1cIndpZHRoOiAxMDAlOyBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlO1wiPlxuICAgICAgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+RGV2aWNlOjwvdGQ+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICMxZjI5Mzc7XCI+JHtkZXZpY2VOYW1lfTwvdGQ+XG4gICAgICA8L3RyPlxuICAgICAgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+QmF0dGVyeSBWb2x0YWdlOjwvdGQ+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICMxMGI5ODE7IGZvbnQtd2VpZ2h0OiA2MDA7XCI+JHt2b2x0YWdlfVY8L3RkPlxuICAgICAgPC90cj5cbiAgICAgIDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGZvbnQtd2VpZ2h0OiA2MDA7IGNvbG9yOiAjNmI3MjgwO1wiPlRpbWU6PC90ZD5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBjb2xvcjogIzFmMjkzNztcIj4ke3RpbWVzdGFtcH0gVVRDPC90ZD5cbiAgICAgIDwvdHI+XG4gICAgPC90YWJsZT5cblxuICAgIDxkaXYgc3R5bGU9XCJ0ZXh0LWFsaWduOiBjZW50ZXI7IG1hcmdpbi10b3A6IDMwcHg7XCI+XG4gICAgICA8YSBocmVmPVwiJHtkZXZpY2VVcmx9XCIgc3R5bGU9XCJkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IGJhY2tncm91bmQ6ICMxMGI5ODE7IGNvbG9yOiB3aGl0ZTsgcGFkZGluZzogMTJweCAzMHB4OyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IGJvcmRlci1yYWRpdXM6IDZweDsgZm9udC13ZWlnaHQ6IDYwMDtcIj5WaWV3IERldmljZSBEYXNoYm9hcmQ8L2E+XG4gICAgPC9kaXY+XG5cbiAgICA8cCBzdHlsZT1cImNvbG9yOiAjNmI3MjgwOyBmb250LXNpemU6IDE0cHg7IG1hcmdpbi10b3A6IDMwcHg7IHBhZGRpbmctdG9wOiAyMHB4OyBib3JkZXItdG9wOiAxcHggc29saWQgI2U1ZTdlYjtcIj5cbiAgICAgIFRoaXMgaXMgYW4gYXV0b21hdGVkIG5vdGlmaWNhdGlvbiBmcm9tIHlvdXIgU29uZ2JpcmQgZmxlZXQgbWFuYWdlbWVudCBzeXN0ZW0uXG4gICAgPC9wPlxuICA8L2Rpdj5cblxuICA8ZGl2IHN0eWxlPVwidGV4dC1hbGlnbjogY2VudGVyOyBwYWRkaW5nOiAyMHB4OyBjb2xvcjogIzZiNzI4MDsgZm9udC1zaXplOiAxMnB4O1wiPlxuICAgIDxwIHN0eWxlPVwibWFyZ2luOiAwO1wiPkJsdWVzIFdpcmVsZXNzIOKAoiBTb25nYmlyZCBBbGVydCBTeXN0ZW08L3A+XG4gIDwvZGl2PlxuPC9ib2R5PlxuPC9odG1sPlxuICBgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBwbGFpbiB0ZXh0IGVtYWlsIGJvZHkgZm9yIGJhdHRlcnkgcmVjb3ZlcnlcbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVCYXR0ZXJ5UmVjb3ZlcnlUZXh0RW1haWwoXG4gIGRldmljZU5hbWU6IHN0cmluZyxcbiAgdm9sdGFnZTogc3RyaW5nLFxuICB0aW1lc3RhbXA6IHN0cmluZyxcbiAgZGV2aWNlVXJsOiBzdHJpbmdcbik6IHN0cmluZyB7XG4gIHJldHVybiBgXG5CQVRURVJZIFJFQ09WRVJFRFxuPT09PT09PT09PT09PT09PT1cblxuR29vZCBuZXdzISBUaGUgYmF0dGVyeSBvbiB5b3VyIFNvbmdiaXJkIGRldmljZSBoYXMgcmVjb3ZlcmVkIHRvIG5vcm1hbCBsZXZlbHMuXG5cbuKckyBCYXR0ZXJ5IFN0YXR1czogTm9ybWFsIC0gVGhlIGRldmljZSBpcyBvcGVyYXRpbmcgbm9ybWFsbHkgYW5kIG5vIGFjdGlvbiBpcyByZXF1aXJlZC5cblxuRGV2aWNlIERldGFpbHNcbi0tLS0tLS0tLS0tLS0tXG5EZXZpY2U6ICR7ZGV2aWNlTmFtZX1cbkJhdHRlcnkgVm9sdGFnZTogJHt2b2x0YWdlfVZcblRpbWU6ICR7dGltZXN0YW1wfSBVVENcblxuVmlldyBEZXZpY2U6ICR7ZGV2aWNlVXJsfVxuXG4tLS1cblRoaXMgaXMgYW4gYXV0b21hdGVkIG5vdGlmaWNhdGlvbiBmcm9tIHlvdXIgU29uZ2JpcmQgZmxlZXQgbWFuYWdlbWVudCBzeXN0ZW0uXG5cbkJsdWVzIFdpcmVsZXNzIOKAoiBTb25nYmlyZCBBbGVydCBTeXN0ZW1cbiAgYC50cmltKCk7XG59XG4iXX0=