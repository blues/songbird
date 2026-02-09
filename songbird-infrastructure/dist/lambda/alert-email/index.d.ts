/**
 * Alert Email Lambda
 *
 * Sends email notifications for low battery alerts via AWS SES.
 * Subscribed to SNS topic 'songbird-alerts' and filters for low_battery alerts.
 *
 * Recipients: Only the device owner (assigned_to user) receives emails.
 * Admin users do NOT receive these notifications.
 */
import { SNSEvent } from 'aws-lambda';
/**
 * Main Lambda handler
 */
export declare const handler: (event: SNSEvent) => Promise<void>;
