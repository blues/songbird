# Alert Email Lambda

Sends email notifications for low battery alerts via AWS SES.

## Overview

This Lambda function is subscribed to the `songbird-alerts` SNS topic and processes low battery alerts. It sends emails to:
- Device owner (if assigned)
- All Admin users

## Features

- **Low Battery Alerts**: Sends emails when a device's battery drops below 3.0V and the device restarts
- **Battery Recovery Notifications**: Sends a follow-up email when battery voltage recovers above 3.5V
- **24-Hour Deduplication**: Prevents duplicate emails for the same alert within 24 hours
- **HTML + Plain Text**: Professional formatted emails with plain text fallback
- **Recipient Resolution**: Automatically finds device owner and all admin users

## Email Configuration

- **Sender**: `brandon@blues.com` (configured in CDK stack)
- **Recipients**: Device owner + all users in Admin group
- **Subject Line**:
  - Low battery: `🔋 Low Battery Alert: [Device Name] ([Voltage]V)`
  - Recovered: `✅ Battery Recovered: [Device Name] ([Voltage]V)`

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DEVICES_TABLE` | DynamoDB devices table name | `songbird-devices` |
| `ALERTS_TABLE` | DynamoDB alerts table name | `songbird-alerts` |
| `USER_POOL_ID` | Cognito User Pool ID | `us-east-1_xxx` |
| `SENDER_EMAIL` | SES verified sender email | `brandon@blues.com` |
| `DASHBOARD_URL` | Dashboard URL for links | `https://songbird.blues.com` |

## IAM Permissions

The Lambda function requires:
- **DynamoDB**: Read access to devices table, read/write to alerts table
- **Cognito**: `cognito-idp:ListUsersInGroup` for Admin group
- **SES**: `ses:SendEmail` and `ses:SendRawEmail` from verified email

## SES Setup

Before deploying, the sender email address must be verified in SES:

### Option 1: Automatic (via CDK)
The CDK stack creates an `EmailIdentity` resource that initiates verification. Check the email inbox for `brandon@blues.com` for a verification link from AWS.

### Option 2: Manual
```bash
aws ses verify-email-identity --email-address brandon@blues.com --region us-east-1
```

Then check the email inbox for the verification link.

### Check Verification Status
```bash
aws ses get-identity-verification-attributes \
  --identities brandon@blues.com \
  --region us-east-1
```

## Deduplication Logic

The Lambda tracks sent emails by creating tracking records in the alerts table:
- Record type: `email_sent = true`
- Alert types: `low_battery` or `battery_recovered`
- TTL: 90 days (matches alert retention)

Before sending an email, the Lambda queries for recent tracking records within the 24-hour window.

## Testing

### Test with Mock SNS Event

Create a test event file `test-event.json`:

```json
{
  "Records": [
    {
      "EventSource": "aws:sns",
      "EventVersion": "1.0",
      "EventSubscriptionArn": "arn:aws:sns:us-east-1:123456789012:songbird-alerts:xxx",
      "Sns": {
        "Type": "Notification",
        "MessageId": "test-message-id",
        "TopicArn": "arn:aws:sns:us-east-1:123456789012:songbird-alerts",
        "Subject": "Songbird Alert: Low Battery - songbird01-bds",
        "Message": "{\"device_uid\":\"dev:xxx\",\"serial_number\":\"songbird01-bds\",\"fleet\":\"default\",\"alert_type\":\"low_battery\",\"value\":2.85,\"message\":\"Device restarted due to low battery (2.85V)\",\"timestamp\":1675000000,\"location\":{\"lat\":37.7749,\"lon\":-122.4194}}",
        "Timestamp": "2024-01-15T10:30:00.000Z",
        "SignatureVersion": "1",
        "Signature": "test-signature",
        "SigningCertUrl": "https://sns.us-east-1.amazonaws.com/test.pem",
        "UnsubscribeUrl": "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe",
        "MessageAttributes": {
          "alert_type": {
            "Type": "String",
            "Value": "low_battery"
          },
          "device_uid": {
            "Type": "String",
            "Value": "dev:xxx"
          }
        }
      }
    }
  ]
}
```

Invoke the Lambda:

```bash
cd songbird-infrastructure
aws lambda invoke \
  --function-name songbird-alert-email \
  --payload file://test-event.json \
  --region us-east-1 \
  response.json

cat response.json
```

### Test Locally

```bash
# Build the Lambda
cd songbird-infrastructure
npm run build

# Run unit tests (if available)
npm test

# Invoke locally with SAM (if configured)
sam local invoke AlertEmailFunction --event test-event.json
```

## Monitoring

### CloudWatch Logs

View logs:
```bash
aws logs tail /aws/lambda/songbird-alert-email --follow --region us-east-1
```

### SES Metrics

Check email delivery metrics in AWS Console:
- AWS Console → SES → Sending Statistics
- View bounce rate, complaint rate, delivery rate

### Key Metrics to Monitor

- **Lambda Invocations**: Should match low battery alert rate
- **Lambda Errors**: Should be near zero
- **SES Bounce Rate**: Should be < 5%
- **SES Complaint Rate**: Should be < 0.1%

### Alarms

Consider setting up CloudWatch alarms for:
- Lambda errors > 5% of invocations
- SES bounce rate > 5%
- Lambda duration > 20 seconds

## Troubleshooting

### Email Not Received

1. **Check Lambda Logs**
   ```bash
   aws logs tail /aws/lambda/songbird-alert-email --region us-east-1
   ```

2. **Verify SES Identity**
   ```bash
   aws ses get-identity-verification-attributes \
     --identities brandon@blues.com \
     --region us-east-1
   ```
   Status should be `Success`.

3. **Check SES Sandbox Status**
   If in sandbox mode, only verified email addresses can receive emails. Move to production:
   - AWS Console → SES → Account dashboard → Request production access

4. **Check Spam Folder**
   Initial emails may land in spam. Verify SPF/DKIM are configured for the domain.

5. **Check Recipient List**
   Ensure device has `assigned_to` set or there are Admin users in Cognito.

### Lambda Timeout

If Lambda times out:
- Check Cognito query latency (Admin user list)
- Check DynamoDB query latency (alerts table)
- Increase Lambda timeout in CDK (currently 30 seconds)

### Duplicate Emails

If users receive duplicate emails:
- Check deduplication logic in CloudWatch logs
- Verify tracking records are being created in alerts table
- Check for race conditions (multiple Lambda instances processing same alert)

## Cost Estimate

Based on estimated usage:

| Service | Usage | Cost |
|---------|-------|------|
| **SES** | 100 emails/month | FREE (first 62k free) |
| **Lambda** | 100 invocations/month @ 500ms | < $0.01/month |
| **DynamoDB** | 200 queries/month (dedup + tracking) | < $0.01/month |
| **CloudWatch Logs** | 1 MB/month | < $0.01/month |
| **Total** | | **< $1/month** |

## Future Enhancements

Possible improvements:
- [ ] Email templates with branding customization
- [ ] Support for more alert types (GPS, temperature)
- [ ] User email preferences (opt-out, digest mode)
- [ ] Email delivery status tracking
- [ ] A/B testing different email formats
- [ ] Localization (multi-language support)
- [ ] Rich notifications with charts/graphs

## References

- [AWS SES Documentation](https://docs.aws.amazon.com/ses/)
- [AWS Lambda + SNS Integration](https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html)
- [Cognito User Pool Groups](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html)
