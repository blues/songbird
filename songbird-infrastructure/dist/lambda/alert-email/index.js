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
 * Checks for the existence of the claim record
 */
async function isRecentAlert(deviceUid, alertType) {
    try {
        // Check if the claim record exists (same ID format as tryClaimAlert)
        const alertId = `email_claim_${deviceUid}_${alertType}`;
        const result = await docClient.send(new lib_dynamodb_1.GetCommand({
            TableName: ALERTS_TABLE,
            Key: { alert_id: alertId },
        }));
        return result.Item !== undefined;
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
    // Use FIXED alert ID based on device and type only (no timestamp)
    // This ensures all concurrent invocations try to write the SAME record
    const alertId = `email_claim_${deviceUid}_${alertType}`;
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
        // Use the same fixed alert ID format as tryClaimAlert
        const alertId = `email_claim_${deviceUid}_${alertType}`;
        // Delete the claim record
        await docClient.send(new lib_dynamodb_1.DeleteCommand({
            TableName: ALERTS_TABLE,
            Key: {
                alert_id: alertId,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYWxlcnQtZW1haWwvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFHSCxvREFBa0U7QUFDbEUsOERBQTBEO0FBQzFELHdEQUFvSDtBQUVwSCx5QkFBeUI7QUFDekIsTUFBTSxTQUFTLEdBQUcsSUFBSSxzQkFBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3BDLE1BQU0sU0FBUyxHQUFHLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN6QyxNQUFNLFNBQVMsR0FBRyxxQ0FBc0IsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7QUFFekQsd0JBQXdCO0FBQ3hCLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxJQUFJLGtCQUFrQixDQUFDO0FBQ3RFLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLGlCQUFpQixDQUFDO0FBQ25FLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLG1CQUFtQixDQUFDO0FBQ3JFLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsYUFBYSxJQUFJLDRCQUE0QixDQUFDO0FBRWhGLGlEQUFpRDtBQUNqRCxNQUFNLGVBQWUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFFNUMsMkVBQTJFO0FBQzNFLE1BQU0sa0JBQWtCLEdBQUcsR0FBRyxDQUFDLENBQUMsMENBQTBDO0FBRTFFLDBDQUEwQztBQUMxQyxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFDcEIsTUFBTSxXQUFXLEdBQUcsUUFBUSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO0FBMkI1Qzs7R0FFRztBQUNJLE1BQU0sT0FBTyxHQUFHLEtBQUssRUFBRSxL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cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBbGVydCBFbWFpbCBMYW1iZGFcbiAqXG4gKiBTZW5kcyBlbWFpbCBub3RpZmljYXRpb25zIGZvciBsb3cgYmF0dGVyeSBhbGVydHMgdmlhIEFXUyBTRVMuXG4gKiBTdWJzY3JpYmVkIHRvIFNOUyB0b3BpYyAnc29uZ2JpcmQtYWxlcnRzJyBhbmQgZmlsdGVycyBmb3IgbG93X2JhdHRlcnkgYWxlcnRzLlxuICpcbiAqIFJlY2lwaWVudHM6IE9ubHkgdGhlIGRldmljZSBvd25lciAoYXNzaWduZWRfdG8gdXNlcikgcmVjZWl2ZXMgZW1haWxzLlxuICogQWRtaW4gdXNlcnMgZG8gTk9UIHJlY2VpdmUgdGhlc2Ugbm90aWZpY2F0aW9ucy5cbiAqL1xuXG5pbXBvcnQgeyBTTlNFdmVudCwgU05TRXZlbnRSZWNvcmQgfSBmcm9tICdhd3MtbGFtYmRhJztcbmltcG9ydCB7IFNFU0NsaWVudCwgU2VuZEVtYWlsQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zZXMnO1xuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgR2V0Q29tbWFuZCwgUXVlcnlDb21tYW5kLCBQdXRDb21tYW5kLCBEZWxldGVDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcblxuLy8gSW5pdGlhbGl6ZSBBV1MgY2xpZW50c1xuY29uc3Qgc2VzQ2xpZW50ID0gbmV3IFNFU0NsaWVudCh7fSk7XG5jb25zdCBkZGJDbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGRkYkNsaWVudCk7XG5cbi8vIEVudmlyb25tZW50IHZhcmlhYmxlc1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUgfHwgJ3NvbmdiaXJkLWRldmljZXMnO1xuY29uc3QgQUxFUlRTX1RBQkxFID0gcHJvY2Vzcy5lbnYuQUxFUlRTX1RBQkxFIHx8ICdzb25nYmlyZC1hbGVydHMnO1xuY29uc3QgU0VOREVSX0VNQUlMID0gcHJvY2Vzcy5lbnYuU0VOREVSX0VNQUlMIHx8ICdicmFuZG9uQGJsdWVzLmNvbSc7XG5jb25zdCBEQVNIQk9BUkRfVVJMID0gcHJvY2Vzcy5lbnYuREFTSEJPQVJEX1VSTCB8fCAnaHR0cHM6Ly9zb25nYmlyZC5ibHVlcy5jb20nO1xuXG4vLyBEZWR1cGxpY2F0aW9uIHdpbmRvdzogMjQgaG91cnMgaW4gbWlsbGlzZWNvbmRzXG5jb25zdCBERURVUF9XSU5ET1dfTVMgPSAyNCAqIDYwICogNjAgKiAxMDAwO1xuXG4vLyBCYXR0ZXJ5IHJlY292ZXJ5IHRocmVzaG9sZDogdm9sdGFnZSBhYm92ZSB0aGlzIGlzIGNvbnNpZGVyZWQgXCJyZWNvdmVyZWRcIlxuY29uc3QgUkVDT1ZFUllfVEhSRVNIT0xEID0gMy41OyAvLyAwLjVWIGFib3ZlIGxvdyBiYXR0ZXJ5IHRocmVzaG9sZCAoMy4wVilcblxuLy8gVFRMIGZvciBlbWFpbCB0cmFja2luZyByZWNvcmRzOiA5MCBkYXlzXG5jb25zdCBUVExfREFZUyA9IDkwO1xuY29uc3QgVFRMX1NFQ09ORFMgPSBUVExfREFZUyAqIDI0ICogNjAgKiA2MDtcblxuaW50ZXJmYWNlIEFsZXJ0TWVzc2FnZSB7XG4gIGRldmljZV91aWQ6IHN0cmluZztcbiAgc2VyaWFsX251bWJlcj86IHN0cmluZztcbiAgZmxlZXQ/OiBzdHJpbmc7XG4gIGFsZXJ0X3R5cGU6IHN0cmluZztcbiAgdmFsdWU/OiBudW1iZXI7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgdGltZXN0YW1wOiBudW1iZXI7XG4gIGxvY2F0aW9uPzoge1xuICAgIGxhdDogbnVtYmVyO1xuICAgIGxvbjogbnVtYmVyO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgRGV2aWNlIHtcbiAgZGV2aWNlX3VpZDogc3RyaW5nO1xuICBzZXJpYWxfbnVtYmVyPzogc3RyaW5nO1xuICBuYW1lPzogc3RyaW5nO1xuICBhc3NpZ25lZF90bz86IHN0cmluZztcbiAgYXNzaWduZWRfdG9fbmFtZT86IHN0cmluZztcbiAgdm9sdGFnZT86IG51bWJlcjtcbiAgbGFzdF92b2x0YWdlPzogbnVtYmVyO1xuICBsYXN0X3NlZW4/OiBudW1iZXI7XG59XG5cbi8qKlxuICogTWFpbiBMYW1iZGEgaGFuZGxlclxuICovXG5leHBvcnQgY29uc3QgaGFuZGxlciA9IGFzeW5jIChldmVudDogU05TRXZlbnQpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgY29uc29sZS5sb2coJ1JlY2VpdmVkIFNOUyBldmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuXG4gIGZvciAoY29uc3QgcmVjb3JkIG9mIGV2ZW50LlJlY29yZHMpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgcHJvY2Vzc0FsZXJ0UmVjb3JkKHJlY29yZCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHByb2Nlc3NpbmcgYWxlcnQgcmVjb3JkOicsIGVycm9yKTtcbiAgICAgIC8vIENvbnRpbnVlIHByb2Nlc3Npbmcgb3RoZXIgcmVjb3JkcyBldmVuIGlmIG9uZSBmYWlsc1xuICAgIH1cbiAgfVxufTtcblxuLyoqXG4gKiBQcm9jZXNzIGEgc2luZ2xlIFNOUyByZWNvcmRcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0FsZXJ0UmVjb3JkKHJlY29yZDogU05TRXZlbnRSZWNvcmQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbWVzc2FnZTogQWxlcnRNZXNzYWdlID0gSlNPTi5wYXJzZShyZWNvcmQuU25zLk1lc3NhZ2UpO1xuXG4gIGNvbnNvbGUubG9nKCdQcm9jZXNzaW5nIGFsZXJ0IG1lc3NhZ2U6JywgbWVzc2FnZSk7XG5cbiAgLy8gT25seSBwcm9jZXNzIGxvd19iYXR0ZXJ5IGFsZXJ0c1xuICBpZiAobWVzc2FnZS5hbGVydF90eXBlICE9PSAnbG93X2JhdHRlcnknKSB7XG4gICAgY29uc29sZS5sb2coYFNraXBwaW5nIG5vbi1sb3dfYmF0dGVyeSBhbGVydDogJHttZXNzYWdlLmFsZXJ0X3R5cGV9YCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR2V0IGN1cnJlbnQgZGV2aWNlIHN0YXRlXG4gIGNvbnN0IGRldmljZSA9IGF3YWl0IGdldERldmljZShtZXNzYWdlLmRldmljZV91aWQpO1xuXG4gIC8vIENoZWNrIGlmIGJhdHRlcnkgaGFzIHJlY292ZXJlZFxuICBpZiAoZGV2aWNlICYmIGRldmljZS52b2x0YWdlICYmIGRldmljZS52b2x0YWdlID49IFJFQ09WRVJZX1RIUkVTSE9MRCkge1xuICAgIGNvbnNvbGUubG9nKGBEZXZpY2UgJHttZXNzYWdlLmRldmljZV91aWR9IGJhdHRlcnkgaGFzIHJlY292ZXJlZCB0byAke2RldmljZS52b2x0YWdlfVZgKTtcbiAgICBhd2FpdCBoYW5kbGVCYXR0ZXJ5UmVjb3ZlcnkobWVzc2FnZSwgZGV2aWNlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDaGVjayBmb3IgZHVwbGljYXRlIGFsZXJ0cyB3aXRoaW4gMjQtaG91ciB3aW5kb3dcbiAgY29uc3QgaXNEdXBsaWNhdGUgPSBhd2FpdCBpc1JlY2VudEFsZXJ0KG1lc3NhZ2UuZGV2aWNlX3VpZCwgJ2xvd19iYXR0ZXJ5Jyk7XG4gIGlmIChpc0R1cGxpY2F0ZSkge1xuICAgIGNvbnNvbGUubG9nKGBTa2lwcGluZyBkdXBsaWNhdGUgYWxlcnQgZm9yICR7bWVzc2FnZS5kZXZpY2VfdWlkfSAoYWxyZWFkeSBzZW50IHdpdGhpbiAyNCBob3VycylgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUcnkgdG8gY2xhaW0gdGhpcyBhbGVydCBieSB3cml0aW5nIGRlZHVwbGljYXRpb24gcmVjb3JkIEZJUlNUXG4gIC8vIFRoaXMgcHJldmVudHMgcmFjZSBjb25kaXRpb25zIHdoZW4gbXVsdGlwbGUgTGFtYmRhIGludm9jYXRpb25zIGhhcHBlbiBzaW11bHRhbmVvdXNseVxuICBjb25zdCBjbGFpbWVkID0gYXdhaXQgdHJ5Q2xhaW1BbGVydChtZXNzYWdlLmRldmljZV91aWQsICdsb3dfYmF0dGVyeScpO1xuICBpZiAoIWNsYWltZWQpIHtcbiAgICBjb25zb2xlLmxvZyhgQW5vdGhlciBpbnZvY2F0aW9uIGFscmVhZHkgY2xhaW1lZCB0aGlzIGFsZXJ0IGZvciAke21lc3NhZ2UuZGV2aWNlX3VpZH0sIHNraXBwaW5nYCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR2V0IHJlY2lwaWVudHMgKGRldmljZSBvd25lciArIGFsbCBhZG1pbnMpXG4gIGNvbnN0IHJlY2lwaWVudHMgPSBhd2FpdCBnZXRSZWNpcGllbnRzKG1lc3NhZ2UuZGV2aWNlX3VpZCk7XG5cbiAgaWYgKHJlY2lwaWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgY29uc29sZS53YXJuKGBObyByZWNpcGllbnRzIGZvdW5kIGZvciBkZXZpY2UgJHttZXNzYWdlLmRldmljZV91aWR9YCk7XG4gICAgLy8gQ2xlYW4gdXAgdGhlIGNsYWltIHNpbmNlIHdlIHdvbid0IHNlbmRcbiAgICBhd2FpdCBjbGVhckVtYWlsU2VudFJlY29yZChtZXNzYWdlLmRldmljZV91aWQsICdsb3dfYmF0dGVyeScpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnNvbGUubG9nKGBTZW5kaW5nIGxvdyBiYXR0ZXJ5IGFsZXJ0IHRvICR7cmVjaXBpZW50cy5sZW5ndGh9IHJlY2lwaWVudChzKTpgLCByZWNpcGllbnRzKTtcblxuICAvLyBTZW5kIGVtYWlsIHRvIGFsbCByZWNpcGllbnRzXG4gIGF3YWl0IHNlbmRMb3dCYXR0ZXJ5RW1haWwobWVzc2FnZSwgZGV2aWNlLCByZWNpcGllbnRzKTtcbn1cblxuLyoqXG4gKiBIYW5kbGUgYmF0dGVyeSByZWNvdmVyeSAtIHNlbmQgcmVjb3ZlcnkgZW1haWwgaWYgYXBwcm9wcmlhdGVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gaGFuZGxlQmF0dGVyeVJlY292ZXJ5KGFsZXJ0OiBBbGVydE1lc3NhZ2UsIGRldmljZTogRGV2aWNlKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIENoZWNrIGlmIHdlIHNlbnQgYSBsb3cgYmF0dGVyeSBhbGVydCByZWNlbnRseVxuICBjb25zdCByZWNlbnRBbGVydCA9IGF3YWl0IGdldFJlY2VudEFsZXJ0KGRldmljZS5kZXZpY2VfdWlkLCAnbG93X2JhdHRlcnknKTtcblxuICBpZiAoIXJlY2VudEFsZXJ0KSB7XG4gICAgY29uc29sZS5sb2coJ05vIHJlY2VudCBsb3cgYmF0dGVyeSBhbGVydCBmb3VuZCwgc2tpcHBpbmcgcmVjb3ZlcnkgZW1haWwnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDaGVjayBpZiB3ZSBhbHJlYWR5IHNlbnQgYSByZWNvdmVyeSBlbWFpbFxuICBjb25zdCBhbHJlYWR5U2VudFJlY292ZXJ5ID0gYXdhaXQgaXNSZWNlbnRBbGVydChkZXZpY2UuZGV2aWNlX3VpZCwgJ2JhdHRlcnlfcmVjb3ZlcmVkJyk7XG4gIGlmIChhbHJlYWR5U2VudFJlY292ZXJ5KSB7XG4gICAgY29uc29sZS5sb2coJ1JlY292ZXJ5IGVtYWlsIGFscmVhZHkgc2VudCB3aXRoaW4gMjQgaG91cnMsIHNraXBwaW5nJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgcmVjaXBpZW50cyA9IGF3YWl0IGdldFJlY2lwaWVudHMoZGV2aWNlLmRldmljZV91aWQpO1xuXG4gIGlmIChyZWNpcGllbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnNvbGUud2FybihgTm8gcmVjaXBpZW50cyBmb3VuZCBmb3IgZGV2aWNlICR7ZGV2aWNlLmRldmljZV91aWR9YCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc29sZS5sb2coYFNlbmRpbmcgYmF0dGVyeSByZWNvdmVyeSBlbWFpbCB0byAke3JlY2lwaWVudHMubGVuZ3RofSByZWNpcGllbnQocyk6YCwgcmVjaXBpZW50cyk7XG5cbiAgYXdhaXQgc2VuZEJhdHRlcnlSZWNvdmVyeUVtYWlsKGFsZXJ0LCBkZXZpY2UsIHJlY2lwaWVudHMpO1xuXG4gIC8vIENsZWFyIHRoZSBsb3cgYmF0dGVyeSBkZWR1cGxpY2F0aW9uIGJ5IGRlbGV0aW5nIHRoZSB0cmFja2luZyByZWNvcmRcbiAgLy8gVGhpcyBhbGxvd3MgYSBuZXcgbG93IGJhdHRlcnkgZW1haWwgaWYgdGhlIGJhdHRlcnkgZHJvcHMgYWdhaW5cbiAgYXdhaXQgY2xlYXJFbWFpbFNlbnRSZWNvcmQoZGV2aWNlLmRldmljZV91aWQsICdsb3dfYmF0dGVyeScpO1xufVxuXG4vKipcbiAqIEdldCBkZXZpY2UgZGV0YWlscyBmcm9tIER5bmFtb0RCXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZShkZXZpY2VVaWQ6IHN0cmluZyk6IFByb21pc2U8RGV2aWNlIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBHZXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICB9KSk7XG5cbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW0gYXMgRGV2aWNlIHx8IG51bGw7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgZmV0Y2hpbmcgZGV2aWNlOicsIGVycm9yKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgcmVjZW50IGFsZXJ0IG9mIHRoZSBnaXZlbiB0eXBlIGV4aXN0cyBmb3IgdGhpcyBkZXZpY2VcbiAqIENoZWNrcyBmb3IgdGhlIGV4aXN0ZW5jZSBvZiB0aGUgY2xhaW0gcmVjb3JkXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzUmVjZW50QWxlcnQoZGV2aWNlVWlkOiBzdHJpbmcsIGFsZXJ0VHlwZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgLy8gQ2hlY2sgaWYgdGhlIGNsYWltIHJlY29yZCBleGlzdHMgKHNhbWUgSUQgZm9ybWF0IGFzIHRyeUNsYWltQWxlcnQpXG4gICAgY29uc3QgYWxlcnRJZCA9IGBlbWFpbF9jbGFpbV8ke2RldmljZVVpZH1fJHthbGVydFR5cGV9YDtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBHZXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgICAgS2V5OiB7IGFsZXJ0X2lkOiBhbGVydElkIH0sXG4gICAgfSkpO1xuXG4gICAgcmV0dXJuIHJlc3VsdC5JdGVtICE9PSB1bmRlZmluZWQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgY2hlY2tpbmcgZm9yIHJlY2VudCBhbGVydHM6JywgZXJyb3IpO1xuICAgIC8vIElmIHdlIGNhbid0IGNoZWNrLCBlcnIgb24gdGhlIHNpZGUgb2Ygc2VuZGluZyB0aGUgZW1haWxcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIG1vc3QgcmVjZW50IGFsZXJ0IG9mIHRoZSBnaXZlbiB0eXBlIGZvciB0aGlzIGRldmljZVxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRSZWNlbnRBbGVydChkZXZpY2VVaWQ6IHN0cmluZywgYWxlcnRUeXBlOiBzdHJpbmcpOiBQcm9taXNlPGFueSB8IG51bGw+IHtcbiAgY29uc3QgY3V0b2ZmVGltZSA9IERhdGUubm93KCkgLSBERURVUF9XSU5ET1dfTVM7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgUXVlcnlDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgICAgSW5kZXhOYW1lOiAnZGV2aWNlLWluZGV4JyxcbiAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkID0gOmRldmljZV91aWQgQU5EIGNyZWF0ZWRfYXQgPiA6Y3V0b2ZmJyxcbiAgICAgIEZpbHRlckV4cHJlc3Npb246ICcjdHlwZSA9IDphbGVydF90eXBlIEFORCBlbWFpbF9zZW50ID0gOnRydWUnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAgICcjdHlwZSc6ICd0eXBlJyxcbiAgICAgIH0sXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6ZGV2aWNlX3VpZCc6IGRldmljZVVpZCxcbiAgICAgICAgJzphbGVydF90eXBlJzogYWxlcnRUeXBlLFxuICAgICAgICAnOmN1dG9mZic6IGN1dG9mZlRpbWUsXG4gICAgICAgICc6dHJ1ZSc6IHRydWUsXG4gICAgICB9LFxuICAgICAgU2NhbkluZGV4Rm9yd2FyZDogZmFsc2UsIC8vIE1vc3QgcmVjZW50IGZpcnN0XG4gICAgICBMaW1pdDogMSxcbiAgICB9KSk7XG5cbiAgICByZXR1cm4gcmVzdWx0Lkl0ZW1zPy5bMF0gfHwgbnVsbDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBmZXRjaGluZyByZWNlbnQgYWxlcnQ6JywgZXJyb3IpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogR2V0IGxpc3Qgb2YgZW1haWwgcmVjaXBpZW50cyBmb3IgYWxlcnRzXG4gKiBSZXR1cm5zIG9ubHkgdGhlIGRldmljZSBvd25lciAoaWYgYXNzaWduZWQpXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdldFJlY2lwaWVudHMoZGV2aWNlVWlkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHJlY2lwaWVudHM6IHN0cmluZ1tdID0gW107XG5cbiAgdHJ5IHtcbiAgICAvLyBHZXQgZGV2aWNlIG93bmVyIGVtYWlsXG4gICAgY29uc3QgZGV2aWNlID0gYXdhaXQgZ2V0RGV2aWNlKGRldmljZVVpZCk7XG4gICAgaWYgKGRldmljZT8uYXNzaWduZWRfdG8pIHtcbiAgICAgIHJlY2lwaWVudHMucHVzaChkZXZpY2UuYXNzaWduZWRfdG8pO1xuICAgICAgY29uc29sZS5sb2coYEFkZGVkIGRldmljZSBvd25lcjogJHtkZXZpY2UuYXNzaWduZWRfdG99YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUubG9nKGBObyBkZXZpY2Ugb3duZXIgYXNzaWduZWQgZm9yIGRldmljZSAke2RldmljZVVpZH1gKTtcbiAgICB9XG5cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBmZXRjaGluZyByZWNpcGllbnRzOicsIGVycm9yKTtcbiAgfVxuXG4gIHJldHVybiByZWNpcGllbnRzO1xufVxuXG4vLyBDb2duaXRvIGludGVncmF0aW9uIHJlbW92ZWQgLSB3ZSBvbmx5IHNlbmQgdG8gZGV2aWNlIG93bmVycyBub3dcbi8vIEFkbWluIHVzZXJzIGRvIG5vdCByZWNlaXZlIGxvdyBiYXR0ZXJ5IGFsZXJ0c1xuXG4vKipcbiAqIFNlbmQgbG93IGJhdHRlcnkgYWxlcnQgZW1haWxcbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2VuZExvd0JhdHRlcnlFbWFpbChcbiAgYWxlcnQ6IEFsZXJ0TWVzc2FnZSxcbiAgZGV2aWNlOiBEZXZpY2UgfCBudWxsLFxuICByZWNpcGllbnRzOiBzdHJpbmdbXVxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGRldmljZU5hbWUgPSBkZXZpY2U/Lm5hbWUgfHwgZGV2aWNlPy5zZXJpYWxfbnVtYmVyIHx8IGFsZXJ0LnNlcmlhbF9udW1iZXIgfHwgYWxlcnQuZGV2aWNlX3VpZDtcbiAgY29uc3Qgdm9sdGFnZSA9IGFsZXJ0LnZhbHVlPy50b0ZpeGVkKDIpIHx8ICd1bmtub3duJztcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoYWxlcnQudGltZXN0YW1wICogMTAwMCkudG9Mb2NhbGVTdHJpbmcoJ2VuLVVTJywge1xuICAgIHRpbWVab25lOiAnVVRDJyxcbiAgICBkYXRlU3R5bGU6ICdtZWRpdW0nLFxuICAgIHRpbWVTdHlsZTogJ3Nob3J0JyxcbiAgfSk7XG5cbiAgY29uc3QgZGV2aWNlVXJsID0gYCR7REFTSEJPQVJEX1VSTH0vZGV2aWNlcy8ke2FsZXJ0LnNlcmlhbF9udW1iZXIgfHwgYWxlcnQuZGV2aWNlX3VpZH1gO1xuXG4gIGNvbnN0IHN1YmplY3QgPSBg8J+UiyBMb3cgQmF0dGVyeSBBbGVydDogJHtkZXZpY2VOYW1lfSAoJHt2b2x0YWdlfVYpYDtcblxuICBjb25zdCBodG1sQm9keSA9IGdlbmVyYXRlTG93QmF0dGVyeUh0bWxFbWFpbChkZXZpY2VOYW1lLCB2b2x0YWdlLCB0aW1lc3RhbXAsIGRldmljZVVybCwgYWxlcnQpO1xuICBjb25zdCB0ZXh0Qm9keSA9IGdlbmVyYXRlTG93QmF0dGVyeVRleHRFbWFpbChkZXZpY2VOYW1lLCB2b2x0YWdlLCB0aW1lc3RhbXAsIGRldmljZVVybCwgYWxlcnQpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VzQ2xpZW50LnNlbmQobmV3IFNlbmRFbWFpbENvbW1hbmQoe1xuICAgICAgU291cmNlOiBTRU5ERVJfRU1BSUwsXG4gICAgICBEZXN0aW5hdGlvbjoge1xuICAgICAgICBUb0FkZHJlc3NlczogcmVjaXBpZW50cyxcbiAgICAgIH0sXG4gICAgICBNZXNzYWdlOiB7XG4gICAgICAgIFN1YmplY3Q6IHtcbiAgICAgICAgICBEYXRhOiBzdWJqZWN0LFxuICAgICAgICAgIENoYXJzZXQ6ICdVVEYtOCcsXG4gICAgICAgIH0sXG4gICAgICAgIEJvZHk6IHtcbiAgICAgICAgICBIdG1sOiB7XG4gICAgICAgICAgICBEYXRhOiBodG1sQm9keSxcbiAgICAgICAgICAgIENoYXJzZXQ6ICdVVEYtOCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBUZXh0OiB7XG4gICAgICAgICAgICBEYXRhOiB0ZXh0Qm9keSxcbiAgICAgICAgICAgIENoYXJzZXQ6ICdVVEYtOCcsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfSkpO1xuXG4gICAgY29uc29sZS5sb2coJ0VtYWlsIHNlbnQgc3VjY2Vzc2Z1bGx5OicsIHJlc3VsdC5NZXNzYWdlSWQpO1xuXG4gICAgLy8gTm90ZTogRGVkdXBsaWNhdGlvbiByZWNvcmQgYWxyZWFkeSB3cml0dGVuIGJ5IHRyeUNsYWltQWxlcnQgYmVmb3JlIHNlbmRpbmdcblxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHNlbmRpbmcgZW1haWw6JywgZXJyb3IpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKlxuICogU2VuZCBiYXR0ZXJ5IHJlY292ZXJ5IGVtYWlsXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlbmRCYXR0ZXJ5UmVjb3ZlcnlFbWFpbChcbiAgYWxlcnQ6IEFsZXJ0TWVzc2FnZSxcbiAgZGV2aWNlOiBEZXZpY2UsXG4gIHJlY2lwaWVudHM6IHN0cmluZ1tdXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGV2aWNlTmFtZSA9IGRldmljZS5uYW1lIHx8IGRldmljZS5zZXJpYWxfbnVtYmVyIHx8IGFsZXJ0LnNlcmlhbF9udW1iZXIgfHwgYWxlcnQuZGV2aWNlX3VpZDtcbiAgY29uc3Qgdm9sdGFnZSA9IGRldmljZS52b2x0YWdlPy50b0ZpeGVkKDIpIHx8ICd1bmtub3duJztcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0xvY2FsZVN0cmluZygnZW4tVVMnLCB7XG4gICAgdGltZVpvbmU6ICdVVEMnLFxuICAgIGRhdGVTdHlsZTogJ21lZGl1bScsXG4gICAgdGltZVN0eWxlOiAnc2hvcnQnLFxuICB9KTtcblxuICBjb25zdCBkZXZpY2VVcmwgPSBgJHtEQVNIQk9BUkRfVVJMfS9kZXZpY2VzLyR7ZGV2aWNlLnNlcmlhbF9udW1iZXIgfHwgZGV2aWNlLmRldmljZV91aWR9YDtcblxuICBjb25zdCBzdWJqZWN0ID0gYOKchSBCYXR0ZXJ5IFJlY292ZXJlZDogJHtkZXZpY2VOYW1lfSAoJHt2b2x0YWdlfVYpYDtcblxuICBjb25zdCBodG1sQm9keSA9IGdlbmVyYXRlQmF0dGVyeVJlY292ZXJ5SHRtbEVtYWlsKGRldmljZU5hbWUsIHZvbHRhZ2UsIHRpbWVzdGFtcCwgZGV2aWNlVXJsKTtcbiAgY29uc3QgdGV4dEJvZHkgPSBnZW5lcmF0ZUJhdHRlcnlSZWNvdmVyeVRleHRFbWFpbChkZXZpY2VOYW1lLCB2b2x0YWdlLCB0aW1lc3RhbXAsIGRldmljZVVybCk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzZXNDbGllbnQuc2VuZChuZXcgU2VuZEVtYWlsQ29tbWFuZCh7XG4gICAgICBTb3VyY2U6IFNFTkRFUl9FTUFJTCxcbiAgICAgIERlc3RpbmF0aW9uOiB7XG4gICAgICAgIFRvQWRkcmVzc2VzOiByZWNpcGllbnRzLFxuICAgICAgfSxcbiAgICAgIE1lc3NhZ2U6IHtcbiAgICAgICAgU3ViamVjdDoge1xuICAgICAgICAgIERhdGE6IHN1YmplY3QsXG4gICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgfSxcbiAgICAgICAgQm9keToge1xuICAgICAgICAgIEh0bWw6IHtcbiAgICAgICAgICAgIERhdGE6IGh0bWxCb2R5LFxuICAgICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIFRleHQ6IHtcbiAgICAgICAgICAgIERhdGE6IHRleHRCb2R5LFxuICAgICAgICAgICAgQ2hhcnNldDogJ1VURi04JyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICBjb25zb2xlLmxvZygnQmF0dGVyeSByZWNvdmVyeSBlbWFpbCBzZW50IHN1Y2Nlc3NmdWxseTonLCByZXN1bHQuTWVzc2FnZUlkKTtcblxuICAgIC8vIFJlY29yZCB0aGF0IHdlIHNlbnQgYSByZWNvdmVyeSBlbWFpbFxuICAgIGF3YWl0IHJlY29yZEVtYWlsU2VudChkZXZpY2UuZGV2aWNlX3VpZCwgJ2JhdHRlcnlfcmVjb3ZlcmVkJyk7XG5cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvciBzZW5kaW5nIGJhdHRlcnkgcmVjb3ZlcnkgZW1haWw6JywgZXJyb3IpO1xuICAgIHRocm93IGVycm9yO1xuICB9XG59XG5cbi8qKlxuICogVHJ5IHRvIGNsYWltIGFuIGFsZXJ0IGZvciBwcm9jZXNzaW5nIHVzaW5nIGF0b21pYyBjb25kaXRpb25hbCB3cml0ZVxuICogUmV0dXJucyB0cnVlIGlmIHN1Y2Nlc3NmdWxseSBjbGFpbWVkLCBmYWxzZSBpZiBhbm90aGVyIGludm9jYXRpb24gYWxyZWFkeSBjbGFpbWVkIGl0XG4gKiBUaGlzIHByZXZlbnRzIHJhY2UgY29uZGl0aW9ucyB3aGVuIG11bHRpcGxlIExhbWJkYSBpbnZvY2F0aW9ucyBoYXBwZW4gc2ltdWx0YW5lb3VzbHlcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJ5Q2xhaW1BbGVydChkZXZpY2VVaWQ6IHN0cmluZywgYWxlcnRUeXBlOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgdHRsID0gTWF0aC5mbG9vcihub3cgLyAxMDAwKSArIFRUTF9TRUNPTkRTO1xuICAvLyBVc2UgRklYRUQgYWxlcnQgSUQgYmFzZWQgb24gZGV2aWNlIGFuZCB0eXBlIG9ubHkgKG5vIHRpbWVzdGFtcClcbiAgLy8gVGhpcyBlbnN1cmVzIGFsbCBjb25jdXJyZW50IGludm9jYXRpb25zIHRyeSB0byB3cml0ZSB0aGUgU0FNRSByZWNvcmRcbiAgY29uc3QgYWxlcnRJZCA9IGBlbWFpbF9jbGFpbV8ke2RldmljZVVpZH1fJHthbGVydFR5cGV9YDtcblxuICB0cnkge1xuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgICAgSXRlbToge1xuICAgICAgICBhbGVydF9pZDogYWxlcnRJZCxcbiAgICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgICB0eXBlOiBhbGVydFR5cGUsXG4gICAgICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICAgICAgdHRsLFxuICAgICAgICBlbWFpbF9zZW50OiB0cnVlLFxuICAgICAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIE1hdGNoIGV4aXN0aW5nIHNjaGVtYVxuICAgICAgfSxcbiAgICAgIC8vIENvbmRpdGlvbmFsIHdyaXRlIC0gb25seSBzdWNjZWVkIGlmIHRoaXMgYWxlcnRfaWQgZG9lc24ndCBleGlzdCB5ZXRcbiAgICAgIENvbmRpdGlvbkV4cHJlc3Npb246ICdhdHRyaWJ1dGVfbm90X2V4aXN0cyhhbGVydF9pZCknLFxuICAgIH0pKTtcblxuICAgIGNvbnNvbGUubG9nKGBTdWNjZXNzZnVsbHkgY2xhaW1lZCBhbGVydDogJHthbGVydFR5cGV9IGZvciBkZXZpY2UgJHtkZXZpY2VVaWR9YCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICBpZiAoZXJyb3IubmFtZSA9PT0gJ0NvbmRpdGlvbmFsQ2hlY2tGYWlsZWRFeGNlcHRpb24nKSB7XG4gICAgICBjb25zb2xlLmxvZyhgQWxlcnQgYWxyZWFkeSBjbGFpbWVkIGJ5IGFub3RoZXIgaW52b2NhdGlvbjogJHthbGVydFR5cGV9IGZvciBkZXZpY2UgJHtkZXZpY2VVaWR9YCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIGNsYWltaW5nIGFsZXJ0OicsIGVycm9yKTtcbiAgICAvLyBPbiBvdGhlciBlcnJvcnMsIGFsbG93IHRoZSBlbWFpbCB0byBiZSBzZW50XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWNvcmQgdGhhdCBhbiBlbWFpbCB3YXMgc2VudCAoZm9yIGRlZHVwbGljYXRpb24pXG4gKiBDcmVhdGVzIGEgdHJhY2tpbmcgcmVjb3JkIGluIHRoZSBhbGVydHMgdGFibGUgd2l0aCBlbWFpbF9zZW50IGZsYWdcbiAqIE5vdGU6IEZvciBsb3dfYmF0dGVyeSBhbGVydHMsIHVzZSB0cnlDbGFpbUFsZXJ0IGluc3RlYWQgdG8gcHJldmVudCByYWNlIGNvbmRpdGlvbnNcbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVjb3JkRW1haWxTZW50KGRldmljZVVpZDogc3RyaW5nLCBhbGVydFR5cGU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB0dGwgPSBNYXRoLmZsb29yKG5vdyAvIDEwMDApICsgVFRMX1NFQ09ORFM7XG4gIGNvbnN0IGFsZXJ0SWQgPSBgZW1haWxfJHtkZXZpY2VVaWR9XyR7YWxlcnRUeXBlfV8ke25vd31fJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoNyl9YDtcblxuICB0cnkge1xuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBQdXRDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogQUxFUlRTX1RBQkxFLFxuICAgICAgSXRlbToge1xuICAgICAgICBhbGVydF9pZDogYWxlcnRJZCxcbiAgICAgICAgZGV2aWNlX3VpZDogZGV2aWNlVWlkLFxuICAgICAgICB0eXBlOiBhbGVydFR5cGUsXG4gICAgICAgIGNyZWF0ZWRfYXQ6IG5vdyxcbiAgICAgICAgdHRsLFxuICAgICAgICBlbWFpbF9zZW50OiB0cnVlLFxuICAgICAgICBhY2tub3dsZWRnZWQ6ICdmYWxzZScsIC8vIE1hdGNoIGV4aXN0aW5nIHNjaGVtYVxuICAgICAgfSxcbiAgICB9KSk7XG5cbiAgICBjb25zb2xlLmxvZyhgUmVjb3JkZWQgZW1haWwgc2VudDogJHthbGVydFR5cGV9IGZvciBkZXZpY2UgJHtkZXZpY2VVaWR9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgcmVjb3JkaW5nIGVtYWlsIHNlbnQ6JywgZXJyb3IpO1xuICAgIC8vIE5vbi1jcml0aWNhbCwgZG9uJ3QgdGhyb3dcbiAgfVxufVxuXG4vKipcbiAqIENsZWFyIGVtYWlsIHNlbnQgdHJhY2tpbmcgcmVjb3JkcyBmb3IgYSBzcGVjaWZpYyBhbGVydCB0eXBlXG4gKiBVc2VkIHdoZW4gYmF0dGVyeSByZWNvdmVycyB0byBhbGxvdyBuZXcgbG93IGJhdHRlcnkgZW1haWxzIGlmIHZvbHRhZ2UgZHJvcHMgYWdhaW5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2xlYXJFbWFpbFNlbnRSZWNvcmQoZGV2aWNlVWlkOiBzdHJpbmcsIGFsZXJ0VHlwZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgLy8gVXNlIHRoZSBzYW1lIGZpeGVkIGFsZXJ0IElEIGZvcm1hdCBhcyB0cnlDbGFpbUFsZXJ0XG4gICAgY29uc3QgYWxlcnRJZCA9IGBlbWFpbF9jbGFpbV8ke2RldmljZVVpZH1fJHthbGVydFR5cGV9YDtcblxuICAgIC8vIERlbGV0ZSB0aGUgY2xhaW0gcmVjb3JkXG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IERlbGV0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBBTEVSVFNfVEFCTEUsXG4gICAgICBLZXk6IHtcbiAgICAgICAgYWxlcnRfaWQ6IGFsZXJ0SWQsXG4gICAgICB9LFxuICAgIH0pKTtcblxuICAgIGNvbnNvbGUubG9nKGBDbGVhcmVkIGVtYWlsIHRyYWNraW5nIHJlY29yZDogJHthbGVydFR5cGV9IGZvciBkZXZpY2UgJHtkZXZpY2VVaWR9YCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3IgY2xlYXJpbmcgZW1haWwgdHJhY2tpbmcgcmVjb3JkOicsIGVycm9yKTtcbiAgICAvLyBOb24tY3JpdGljYWwsIGRvbid0IHRocm93XG4gIH1cbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBIVE1MIGVtYWlsIGJvZHkgZm9yIGxvdyBiYXR0ZXJ5IGFsZXJ0XG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlTG93QmF0dGVyeUh0bWxFbWFpbChcbiAgZGV2aWNlTmFtZTogc3RyaW5nLFxuICB2b2x0YWdlOiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogc3RyaW5nLFxuICBkZXZpY2VVcmw6IHN0cmluZyxcbiAgYWxlcnQ6IEFsZXJ0TWVzc2FnZVxuKTogc3RyaW5nIHtcbiAgY29uc3QgbG9jYXRpb24gPSBhbGVydC5sb2NhdGlvblxuICAgID8gYFxuICAgIDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBmb250LXdlaWdodDogNjAwOyBjb2xvcjogIzZiNzI4MDtcIj5Mb2NhdGlvbjo8L3RkPlxuICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBjb2xvcjogIzFmMjkzNztcIj4ke2FsZXJ0LmxvY2F0aW9uLmxhdC50b0ZpeGVkKDUpfSwgJHthbGVydC5sb2NhdGlvbi5sb24udG9GaXhlZCg1KX08L3RkPlxuICAgIDwvdHI+YFxuICAgIDogJyc7XG5cbiAgcmV0dXJuIGBcbjwhRE9DVFlQRSBodG1sPlxuPGh0bWw+XG48aGVhZD5cbiAgPG1ldGEgY2hhcnNldD1cInV0Zi04XCI+XG4gIDxtZXRhIG5hbWU9XCJ2aWV3cG9ydFwiIGNvbnRlbnQ9XCJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MS4wXCI+XG4gIDx0aXRsZT5Mb3cgQmF0dGVyeSBBbGVydDwvdGl0bGU+XG48L2hlYWQ+XG48Ym9keSBzdHlsZT1cImZvbnQtZmFtaWx5OiAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsICdTZWdvZSBVSScsIFJvYm90bywgJ0hlbHZldGljYSBOZXVlJywgQXJpYWwsIHNhbnMtc2VyaWY7IGxpbmUtaGVpZ2h0OiAxLjY7IGNvbG9yOiAjMzMzOyBtYXgtd2lkdGg6IDYwMHB4OyBtYXJnaW46IDAgYXV0bzsgcGFkZGluZzogMjBweDsgYmFja2dyb3VuZC1jb2xvcjogI2Y5ZmFmYjtcIj5cbiAgPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsICM2NjdlZWEgMCUsICM3NjRiYTIgMTAwJSk7IHBhZGRpbmc6IDMwcHg7IGJvcmRlci1yYWRpdXM6IDhweCA4cHggMCAwOyB0ZXh0LWFsaWduOiBjZW50ZXI7XCI+XG4gICAgPGgxIHN0eWxlPVwiY29sb3I6ICMwMDAwMDA7IG1hcmdpbjogMDsgZm9udC1zaXplOiAyNHB4O1wiPvCflIsgTG93IEJhdHRlcnkgQWxlcnQ8L2gxPlxuICA8L2Rpdj5cblxuICA8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDogI2ZmZmZmZjsgcGFkZGluZzogMzBweDsgYm9yZGVyOiAxcHggc29saWQgI2U1ZTdlYjsgYm9yZGVyLXRvcDogbm9uZTsgYm9yZGVyLXJhZGl1czogMCAwIDhweCA4cHg7XCI+XG4gICAgPHAgc3R5bGU9XCJmb250LXNpemU6IDE2cHg7IG1hcmdpbi10b3A6IDA7XCI+QSBTb25nYmlyZCBkZXZpY2UgaGFzIGRldGVjdGVkIGEgbG93IGJhdHRlcnkgY29uZGl0aW9uIGFuZCBoYXMgcmVzdGFydGVkLjwvcD5cblxuICAgIDxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiAjZmVmM2M3OyBib3JkZXItbGVmdDogNHB4IHNvbGlkICNmNTllMGI7IHBhZGRpbmc6IDE1cHg7IG1hcmdpbjogMjBweCAwOyBib3JkZXItcmFkaXVzOiA0cHg7XCI+XG4gICAgICA8cCBzdHlsZT1cIm1hcmdpbjogMDsgZm9udC13ZWlnaHQ6IDYwMDtcIj7imqDvuI8gQWN0aW9uIFJlcXVpcmVkPC9wPlxuICAgICAgPHAgc3R5bGU9XCJtYXJnaW46IDVweCAwIDAgMDtcIj5QbGVhc2UgY2hhcmdlIHRoaXMgZGV2aWNlIHNvb24gdG8gcHJldmVudCBzZXJ2aWNlIGludGVycnVwdGlvbi48L3A+XG4gICAgPC9kaXY+XG5cbiAgICA8aDIgc3R5bGU9XCJjb2xvcjogIzFmMjkzNzsgZm9udC1zaXplOiAxOHB4OyBtYXJnaW4tdG9wOiAyNXB4OyBtYXJnaW4tYm90dG9tOiAxNXB4O1wiPkRldmljZSBEZXRhaWxzPC9oMj5cblxuICAgIDx0YWJsZSBzdHlsZT1cIndpZHRoOiAxMDAlOyBib3JkZXItY29sbGFwc2U6IGNvbGxhcHNlO1wiPlxuICAgICAgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+RGV2aWNlOjwvdGQ+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICMxZjI5Mzc7XCI+JHtkZXZpY2VOYW1lfTwvdGQ+XG4gICAgICA8L3RyPlxuICAgICAgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+QmF0dGVyeSBWb2x0YWdlOjwvdGQ+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgY29sb3I6ICNkYzI2MjY7IGZvbnQtd2VpZ2h0OiA2MDA7XCI+JHt2b2x0YWdlfVY8L3RkPlxuICAgICAgPC90cj5cbiAgICAgIDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGZvbnQtd2VpZ2h0OiA2MDA7IGNvbG9yOiAjNmI3MjgwO1wiPlRpbWU6PC90ZD5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBjb2xvcjogIzFmMjkzNztcIj4ke3RpbWVzdGFtcH0gVVRDPC90ZD5cbiAgICAgIDwvdHI+XG4gICAgICAke2xvY2F0aW9ufVxuICAgIDwvdGFibGU+XG5cbiAgICA8ZGl2IHN0eWxlPVwidGV4dC1hbGlnbjogY2VudGVyOyBtYXJnaW4tdG9wOiAzMHB4O1wiPlxuICAgICAgPGEgaHJlZj1cIiR7ZGV2aWNlVXJsfVwiIHN0eWxlPVwiZGlzcGxheTogaW5saW5lLWJsb2NrOyBiYWNrZ3JvdW5kOiAjNjY3ZWVhOyBjb2xvcjogd2hpdGU7IHBhZGRpbmc6IDEycHggMzBweDsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyBib3JkZXItcmFkaXVzOiA2cHg7IGZvbnQtd2VpZ2h0OiA2MDA7XCI+VmlldyBEZXZpY2UgRGFzaGJvYXJkPC9hPlxuICAgIDwvZGl2PlxuXG4gICAgPHAgc3R5bGU9XCJjb2xvcjogIzZiNzI4MDsgZm9udC1zaXplOiAxNHB4OyBtYXJnaW4tdG9wOiAzMHB4OyBwYWRkaW5nLXRvcDogMjBweDsgYm9yZGVyLXRvcDogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICBUaGlzIGlzIGFuIGF1dG9tYXRlZCBhbGVydCBmcm9tIHlvdXIgU29uZ2JpcmQgZmxlZXQgbWFuYWdlbWVudCBzeXN0ZW0uIFlvdSBhcmUgcmVjZWl2aW5nIHRoaXMgYmVjYXVzZSB5b3UgYXJlIGFzc2lnbmVkIHRvIHRoaXMgZGV2aWNlIG9yIGFyZSBhbiBhZG1pbmlzdHJhdG9yLlxuICAgIDwvcD5cbiAgPC9kaXY+XG5cbiAgPGRpdiBzdHlsZT1cInRleHQtYWxpZ246IGNlbnRlcjsgcGFkZGluZzogMjBweDsgY29sb3I6ICM2YjcyODA7IGZvbnQtc2l6ZTogMTJweDtcIj5cbiAgICA8cCBzdHlsZT1cIm1hcmdpbjogMDtcIj5CbHVlcyBXaXJlbGVzcyDigKIgU29uZ2JpcmQgQWxlcnQgU3lzdGVtPC9wPlxuICA8L2Rpdj5cbjwvYm9keT5cbjwvaHRtbD5cbiAgYC50cmltKCk7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgcGxhaW4gdGV4dCBlbWFpbCBib2R5IGZvciBsb3cgYmF0dGVyeSBhbGVydFxuICovXG5mdW5jdGlvbiBnZW5lcmF0ZUxvd0JhdHRlcnlUZXh0RW1haWwoXG4gIGRldmljZU5hbWU6IHN0cmluZyxcbiAgdm9sdGFnZTogc3RyaW5nLFxuICB0aW1lc3RhbXA6IHN0cmluZyxcbiAgZGV2aWNlVXJsOiBzdHJpbmcsXG4gIGFsZXJ0OiBBbGVydE1lc3NhZ2Vcbik6IHN0cmluZyB7XG4gIGNvbnN0IGxvY2F0aW9uID0gYWxlcnQubG9jYXRpb25cbiAgICA/IGBMb2NhdGlvbjogJHthbGVydC5sb2NhdGlvbi5sYXQudG9GaXhlZCg1KX0sICR7YWxlcnQubG9jYXRpb24ubG9uLnRvRml4ZWQoNSl9XFxuYFxuICAgIDogJyc7XG5cbiAgcmV0dXJuIGBcbkxPVyBCQVRURVJZIEFMRVJUXG49PT09PT09PT09PT09PT09PVxuXG5BIFNvbmdiaXJkIGRldmljZSBoYXMgZGV0ZWN0ZWQgYSBsb3cgYmF0dGVyeSBjb25kaXRpb24gYW5kIGhhcyByZXN0YXJ0ZWQuXG5cbuKaoO+4jyBBQ1RJT04gUkVRVUlSRUQ6IFBsZWFzZSBjaGFyZ2UgdGhpcyBkZXZpY2Ugc29vbiB0byBwcmV2ZW50IHNlcnZpY2UgaW50ZXJydXB0aW9uLlxuXG5EZXZpY2UgRGV0YWlsc1xuLS0tLS0tLS0tLS0tLS1cbkRldmljZTogJHtkZXZpY2VOYW1lfVxuQmF0dGVyeSBWb2x0YWdlOiAke3ZvbHRhZ2V9VlxuVGltZTogJHt0aW1lc3RhbXB9IFVUQ1xuJHtsb2NhdGlvbn1cblZpZXcgRGV2aWNlOiAke2RldmljZVVybH1cblxuLS0tXG5UaGlzIGlzIGFuIGF1dG9tYXRlZCBhbGVydCBmcm9tIHlvdXIgU29uZ2JpcmQgZmxlZXQgbWFuYWdlbWVudCBzeXN0ZW0uXG5Zb3UgYXJlIHJlY2VpdmluZyB0aGlzIGJlY2F1c2UgeW91IGFyZSBhc3NpZ25lZCB0byB0aGlzIGRldmljZSBvciBhcmUgYW4gYWRtaW5pc3RyYXRvci5cblxuQmx1ZXMgV2lyZWxlc3Mg4oCiIFNvbmdiaXJkIEFsZXJ0IFN5c3RlbVxuICBgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBIVE1MIGVtYWlsIGJvZHkgZm9yIGJhdHRlcnkgcmVjb3ZlcnlcbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVCYXR0ZXJ5UmVjb3ZlcnlIdG1sRW1haWwoXG4gIGRldmljZU5hbWU6IHN0cmluZyxcbiAgdm9sdGFnZTogc3RyaW5nLFxuICB0aW1lc3RhbXA6IHN0cmluZyxcbiAgZGV2aWNlVXJsOiBzdHJpbmdcbik6IHN0cmluZyB7XG4gIHJldHVybiBgXG48IURPQ1RZUEUgaHRtbD5cbjxodG1sPlxuPGhlYWQ+XG4gIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiPlxuICA8bWV0YSBuYW1lPVwidmlld3BvcnRcIiBjb250ZW50PVwid2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMFwiPlxuICA8dGl0bGU+QmF0dGVyeSBSZWNvdmVyZWQ8L3RpdGxlPlxuPC9oZWFkPlxuPGJvZHkgc3R5bGU9XCJmb250LWZhbWlseTogLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAnU2Vnb2UgVUknLCBSb2JvdG8sICdIZWx2ZXRpY2EgTmV1ZScsIEFyaWFsLCBzYW5zLXNlcmlmOyBsaW5lLWhlaWdodDogMS42OyBjb2xvcjogIzMzMzsgbWF4LXdpZHRoOiA2MDBweDsgbWFyZ2luOiAwIGF1dG87IHBhZGRpbmc6IDIwcHg7IGJhY2tncm91bmQtY29sb3I6ICNmOWZhZmI7XCI+XG4gIDxkaXYgc3R5bGU9XCJiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCAjMTBiOTgxIDAlLCAjMDU5NjY5IDEwMCUpOyBwYWRkaW5nOiAzMHB4OyBib3JkZXItcmFkaXVzOiA4cHggOHB4IDAgMDsgdGV4dC1hbGlnbjogY2VudGVyO1wiPlxuICAgIDxoMSBzdHlsZT1cImNvbG9yOiAjMDAwMDAwOyBtYXJnaW46IDA7IGZvbnQtc2l6ZTogMjRweDtcIj7inIUgQmF0dGVyeSBSZWNvdmVyZWQ8L2gxPlxuICA8L2Rpdj5cblxuICA8ZGl2IHN0eWxlPVwiYmFja2dyb3VuZDogI2ZmZmZmZjsgcGFkZGluZzogMzBweDsgYm9yZGVyOiAxcHggc29saWQgI2U1ZTdlYjsgYm9yZGVyLXRvcDogbm9uZTsgYm9yZGVyLXJhZGl1czogMCAwIDhweCA4cHg7XCI+XG4gICAgPHAgc3R5bGU9XCJmb250LXNpemU6IDE2cHg7IG1hcmdpbi10b3A6IDA7XCI+R29vZCBuZXdzISBUaGUgYmF0dGVyeSBvbiB5b3VyIFNvbmdiaXJkIGRldmljZSBoYXMgcmVjb3ZlcmVkIHRvIG5vcm1hbCBsZXZlbHMuPC9wPlxuXG4gICAgPGRpdiBzdHlsZT1cImJhY2tncm91bmQ6ICNkMWZhZTU7IGJvcmRlci1sZWZ0OiA0cHggc29saWQgIzEwYjk4MTsgcGFkZGluZzogMTVweDsgbWFyZ2luOiAyMHB4IDA7IGJvcmRlci1yYWRpdXM6IDRweDtcIj5cbiAgICAgIDxwIHN0eWxlPVwibWFyZ2luOiAwOyBmb250LXdlaWdodDogNjAwO1wiPuKckyBCYXR0ZXJ5IFN0YXR1czogTm9ybWFsPC9wPlxuICAgICAgPHAgc3R5bGU9XCJtYXJnaW46IDVweCAwIDAgMDtcIj5UaGUgZGV2aWNlIGlzIG9wZXJhdGluZyBub3JtYWxseSBhbmQgbm8gYWN0aW9uIGlzIHJlcXVpcmVkLjwvcD5cbiAgICA8L2Rpdj5cblxuICAgIDxoMiBzdHlsZT1cImNvbG9yOiAjMWYyOTM3OyBmb250LXNpemU6IDE4cHg7IG1hcmdpbi10b3A6IDI1cHg7IG1hcmdpbi1ib3R0b206IDE1cHg7XCI+RGV2aWNlIERldGFpbHM8L2gyPlxuXG4gICAgPHRhYmxlIHN0eWxlPVwid2lkdGg6IDEwMCU7IGJvcmRlci1jb2xsYXBzZTogY29sbGFwc2U7XCI+XG4gICAgICA8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOiAxcHggc29saWQgI2U1ZTdlYjtcIj5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBmb250LXdlaWdodDogNjAwOyBjb2xvcjogIzZiNzI4MDtcIj5EZXZpY2U6PC90ZD5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBjb2xvcjogIzFmMjkzNztcIj4ke2RldmljZU5hbWV9PC90ZD5cbiAgICAgIDwvdHI+XG4gICAgICA8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOiAxcHggc29saWQgI2U1ZTdlYjtcIj5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBmb250LXdlaWdodDogNjAwOyBjb2xvcjogIzZiNzI4MDtcIj5CYXR0ZXJ5IFZvbHRhZ2U6PC90ZD5cbiAgICAgICAgPHRkIHN0eWxlPVwicGFkZGluZzogMTBweCAwOyBjb2xvcjogIzEwYjk4MTsgZm9udC13ZWlnaHQ6IDYwMDtcIj4ke3ZvbHRhZ2V9VjwvdGQ+XG4gICAgICA8L3RyPlxuICAgICAgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNlNWU3ZWI7XCI+XG4gICAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6IDEwcHggMDsgZm9udC13ZWlnaHQ6IDYwMDsgY29sb3I6ICM2YjcyODA7XCI+VGltZTo8L3RkPlxuICAgICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOiAxMHB4IDA7IGNvbG9yOiAjMWYyOTM3O1wiPiR7dGltZXN0YW1wfSBVVEM8L3RkPlxuICAgICAgPC90cj5cbiAgICA8L3RhYmxlPlxuXG4gICAgPGRpdiBzdHlsZT1cInRleHQtYWxpZ246IGNlbnRlcjsgbWFyZ2luLXRvcDogMzBweDtcIj5cbiAgICAgIDxhIGhyZWY9XCIke2RldmljZVVybH1cIiBzdHlsZT1cImRpc3BsYXk6IGlubGluZS1ibG9jazsgYmFja2dyb3VuZDogIzEwYjk4MTsgY29sb3I6IHdoaXRlOyBwYWRkaW5nOiAxMnB4IDMwcHg7IHRleHQtZGVjb3JhdGlvbjogbm9uZTsgYm9yZGVyLXJhZGl1czogNnB4OyBmb250LXdlaWdodDogNjAwO1wiPlZpZXcgRGV2aWNlIERhc2hib2FyZDwvYT5cbiAgICA8L2Rpdj5cblxuICAgIDxwIHN0eWxlPVwiY29sb3I6ICM2YjcyODA7IGZvbnQtc2l6ZTogMTRweDsgbWFyZ2luLXRvcDogMzBweDsgcGFkZGluZy10b3A6IDIwcHg7IGJvcmRlci10b3A6IDFweCBzb2xpZCAjZTVlN2ViO1wiPlxuICAgICAgVGhpcyBpcyBhbiBhdXRvbWF0ZWQgbm90aWZpY2F0aW9uIGZyb20geW91ciBTb25nYmlyZCBmbGVldCBtYW5hZ2VtZW50IHN5c3RlbS5cbiAgICA8L3A+XG4gIDwvZGl2PlxuXG4gIDxkaXYgc3R5bGU9XCJ0ZXh0LWFsaWduOiBjZW50ZXI7IHBhZGRpbmc6IDIwcHg7IGNvbG9yOiAjNmI3MjgwOyBmb250LXNpemU6IDEycHg7XCI+XG4gICAgPHAgc3R5bGU9XCJtYXJnaW46IDA7XCI+Qmx1ZXMgV2lyZWxlc3Mg4oCiIFNvbmdiaXJkIEFsZXJ0IFN5c3RlbTwvcD5cbiAgPC9kaXY+XG48L2JvZHk+XG48L2h0bWw+XG4gIGAudHJpbSgpO1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIHBsYWluIHRleHQgZW1haWwgYm9keSBmb3IgYmF0dGVyeSByZWNvdmVyeVxuICovXG5mdW5jdGlvbiBnZW5lcmF0ZUJhdHRlcnlSZWNvdmVyeVRleHRFbWFpbChcbiAgZGV2aWNlTmFtZTogc3RyaW5nLFxuICB2b2x0YWdlOiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogc3RyaW5nLFxuICBkZXZpY2VVcmw6IHN0cmluZ1xuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcbkJBVFRFUlkgUkVDT1ZFUkVEXG49PT09PT09PT09PT09PT09PVxuXG5Hb29kIG5ld3MhIFRoZSBiYXR0ZXJ5IG9uIHlvdXIgU29uZ2JpcmQgZGV2aWNlIGhhcyByZWNvdmVyZWQgdG8gbm9ybWFsIGxldmVscy5cblxu4pyTIEJhdHRlcnkgU3RhdHVzOiBOb3JtYWwgLSBUaGUgZGV2aWNlIGlzIG9wZXJhdGluZyBub3JtYWxseSBhbmQgbm8gYWN0aW9uIGlzIHJlcXVpcmVkLlxuXG5EZXZpY2UgRGV0YWlsc1xuLS0tLS0tLS0tLS0tLS1cbkRldmljZTogJHtkZXZpY2VOYW1lfVxuQmF0dGVyeSBWb2x0YWdlOiAke3ZvbHRhZ2V9VlxuVGltZTogJHt0aW1lc3RhbXB9IFVUQ1xuXG5WaWV3IERldmljZTogJHtkZXZpY2VVcmx9XG5cbi0tLVxuVGhpcyBpcyBhbiBhdXRvbWF0ZWQgbm90aWZpY2F0aW9uIGZyb20geW91ciBTb25nYmlyZCBmbGVldCBtYW5hZ2VtZW50IHN5c3RlbS5cblxuQmx1ZXMgV2lyZWxlc3Mg4oCiIFNvbmdiaXJkIEFsZXJ0IFN5c3RlbVxuICBgLnRyaW0oKTtcbn1cbiJdfQ==