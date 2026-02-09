# Low Battery Email Alerts - Deployment Notes

## Overview

This deployment adds email notification capability for low battery alerts using AWS SES. When a Songbird device detects a low battery condition (< 3.0V) and restarts, email notifications are automatically sent to the device owner and all Admin users.

## What Was Implemented

### 1. Email Lambda Function
- **Location**: `songbird-infrastructure/lambda/alert-email/index.ts`
- **Purpose**: Processes SNS low_battery alerts and sends emails via SES
- **Features**:
  - Sends emails to device owner + all Admin users
  - 24-hour deduplication (prevents spam)
  - Battery recovery notifications (when voltage > 3.5V)
  - Professional HTML emails with plain text fallback
  - Tracks email sends in alerts table

### 2. CDK Stack Updates
- **File**: `songbird-infrastructure/lib/songbird-stack.ts`
- **Changes**:
  - Added SES email identity for `brandon@blues.com`
  - Created alert email Lambda function
  - Configured SNS subscription with `low_battery` filter
  - Granted necessary IAM permissions (SES, Cognito, DynamoDB)

### 3. Documentation
- **Lambda README**: `songbird-infrastructure/lambda/alert-email/README.md`
  - Setup instructions
  - Testing guide
  - Troubleshooting tips
  - Cost estimates
- **Infrastructure README**: Updated with SES verification steps

## Deployment Steps

### 1. Install Dependencies

```bash
cd songbird-infrastructure
npm install
```

This will install the new `@aws-sdk/client-ses` dependency.

### 2. Build the Stack

```bash
npm run build
```

### 3. Preview Changes

```bash
npm run diff
```

Expected changes:
- New Lambda function: `songbird-alert-email`
- New SES email identity: `brandon@blues.com`
- New SNS subscription to `songbird-alerts` topic
- New IAM policies for Lambda

### 4. Deploy

```bash
npm run deploy
```

Or with approval prompts:

```bash
cdk deploy --require-approval broadening
```

### 5. Verify SES Email

**CRITICAL STEP**: After deployment, you must verify the sender email address.

**Option A - Check Email:**
1. Check inbox for `brandon@blues.com`
2. Look for email from AWS SES with subject "Amazon SES Email Address Verification Request"
3. Click the verification link

**Option B - Manual Trigger:**
```bash
aws ses verify-email-identity \
  --email-address brandon@blues.com \
  --region us-east-1
```

**Verify Status:**
```bash
aws ses get-identity-verification-attributes \
  --identities brandon@blues.com \
  --region us-east-1
```

Look for `"VerificationStatus": "Success"`.

### 6. Test the System

#### Create a Test Low Battery Alert

You can manually publish a test message to SNS to trigger an email:

```bash
# Get the SNS topic ARN from CDK outputs
SNS_TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name SongbirdStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArn`].OutputValue' \
  --output text)

# Publish a test low battery alert
aws sns publish \
  --topic-arn $SNS_TOPIC_ARN \
  --message '{
    "device_uid": "dev:test123",
    "serial_number": "songbird-test",
    "fleet": "default",
    "alert_type": "low_battery",
    "value": 2.85,
    "message": "Device restarted due to low battery (2.85V)",
    "timestamp": '$(date +%s)',
    "location": {
      "lat": 37.7749,
      "lon": -122.4194
    }
  }' \
  --subject "Songbird Alert: Low Battery - songbird-test" \
  --message-attributes '{
    "alert_type": {
      "DataType": "String",
      "StringValue": "low_battery"
    }
  }'
```

#### Check CloudWatch Logs

```bash
aws logs tail /aws/lambda/songbird-alert-email --follow
```

You should see:
- "Processing alert message"
- "Added device owner" (if device is assigned)
- "Added N admin user(s)"
- "Sending low battery alert to N recipient(s)"
- "Email sent successfully: [MessageId]"

## SES Sandbox Limitations

By default, new AWS accounts start in the **SES Sandbox**, which has restrictions:
- ✅ Can send to verified email addresses only
- ✅ Can send up to 200 emails per day
- ✅ Maximum send rate of 1 email per second
- ❌ Cannot send to unverified addresses

### Moving to Production

To send emails to any address (not just verified):

1. Go to AWS Console → SES → Account dashboard
2. Click **"Request production access"**
3. Fill out the form:
   - **Mail type**: Transactional
   - **Website URL**: Your Songbird dashboard URL
   - **Use case description**:
     ```
     Sending automated alert notifications for IoT device fleet management.
     Low battery alerts are sent to device owners and administrators when
     Songbird devices detect low battery conditions. Expected volume:
     < 100 emails per month.
     ```
4. Submit and wait for approval (typically 24-48 hours)

## How It Works

```
┌─────────────────┐
│  _health.qo     │ ← Device sends health event (voltage < 3.0V)
│  from device    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Ingest Lambda  │ ← Detects low battery, creates alert
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   SNS Topic     │ ← Publishes low_battery alert
│ songbird-alerts │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Email Lambda   │ ← Filters for low_battery, sends emails
└────────┬────────┘
         │
         ├─→ Query DynamoDB (device owner)
         ├─→ Query Cognito (Admin users)
         ├─→ Check deduplication (24h window)
         │
         ▼
┌─────────────────┐
│   AWS SES       │ ← Sends emails to recipients
└─────────────────┘
```

## Email Content

### Low Battery Alert Email

**Subject**: `🔋 Low Battery Alert: [Device Name] ([Voltage]V)`

**Content**:
- Device name and serial number
- Current battery voltage (red, highlighted)
- Timestamp of alert
- Location (if available)
- Link to device dashboard
- Call to action: "Please charge this device soon"

### Battery Recovery Email

**Subject**: `✅ Battery Recovered: [Device Name] ([Voltage]V)`

**Content**:
- Device name and serial number
- Recovered battery voltage (green, highlighted)
- Timestamp
- Link to device dashboard
- Confirmation: "Device is operating normally"

## Deduplication

The system prevents duplicate emails using a 24-hour deduplication window:

1. Before sending an email, Lambda queries alerts table for recent `low_battery` alerts with `email_sent = true`
2. If found within 24 hours, email is skipped
3. After successfully sending an email, Lambda creates a tracking record in alerts table
4. Tracking records have TTL of 90 days (auto-deleted)

This ensures users don't get spammed if a device repeatedly restarts due to low battery.

## Recipients

Emails are sent to:
1. **Device Owner**: User listed in `devices.assigned_to` field
2. **All Admin Users**: All users in Cognito "Admin" group

Recipients are de-duplicated (if owner is also an admin, they only receive one email).

## Cost Estimate

Based on typical usage:

| Component | Usage | Cost |
|-----------|-------|------|
| **SES** | 100 emails/month | FREE (first 62k free) |
| **Lambda Invocations** | 100/month | < $0.01 |
| **Lambda Duration** | 50 seconds total | < $0.01 |
| **DynamoDB Queries** | 200/month | < $0.01 |
| **SNS Notifications** | 100/month | < $0.01 |
| **CloudWatch Logs** | 1 MB/month | < $0.01 |
| **Total** | | **< $1/month** |

## Monitoring

### Key Metrics

1. **Lambda Invocations**: Should match low battery alert rate
   ```bash
   aws cloudwatch get-metric-statistics \
     --namespace AWS/Lambda \
     --metric-name Invocations \
     --dimensions Name=FunctionName,Value=songbird-alert-email \
     --statistics Sum \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
     --period 3600
   ```

2. **Lambda Errors**: Should be near zero
3. **SES Bounce Rate**: Should be < 5%
4. **SES Complaint Rate**: Should be < 0.1%

### CloudWatch Logs

```bash
# Tail live logs
aws logs tail /aws/lambda/songbird-alert-email --follow

# Search for errors
aws logs filter-events \
  --log-group-name /aws/lambda/songbird-alert-email \
  --filter-pattern "ERROR"
```

### SES Sending Statistics

View in AWS Console:
- AWS Console → SES → Sending Statistics
- Monitor: Sends, Deliveries, Bounces, Complaints

## Troubleshooting

### Email Not Received

1. **Check Lambda Logs**
   ```bash
   aws logs tail /aws/lambda/songbird-alert-email --region us-east-1
   ```
   Look for "Email sent successfully" message.

2. **Verify SES Identity**
   ```bash
   aws ses get-identity-verification-attributes \
     --identities brandon@blues.com \
     --region us-east-1
   ```
   Status should be "Success".

3. **Check SES Sandbox**
   If in sandbox, recipient email must be verified. Request production access.

4. **Check Spam Folder**
   Initial emails may be flagged as spam.

5. **Check Recipient List**
   Ensure device has `assigned_to` set OR there are Admin users.

### Lambda Timeout

If Lambda times out (rare):
- Check Cognito query latency
- Check DynamoDB query latency
- Increase timeout in CDK (currently 30s)

### Duplicate Emails

If users receive duplicate emails:
- Check CloudWatch logs for deduplication logic
- Verify tracking records are created in alerts table
- Check for race conditions (multiple alerts in quick succession)

## Testing Checklist

Before considering deployment complete:

- [ ] CDK deployment successful
- [ ] SES email identity verified (`brandon@blues.com`)
- [ ] Lambda function created and healthy
- [ ] SNS subscription active with correct filter
- [ ] Test alert sent and email received
- [ ] CloudWatch logs show successful email delivery
- [ ] Email rendering looks good (HTML + plain text)
- [ ] Links in email work correctly
- [ ] Deduplication prevents duplicate emails (test with 2 alerts < 24h apart)
- [ ] Battery recovery email works (when voltage rises)
- [ ] Admins receive emails
- [ ] Device owners receive emails

## Rollback

If you need to rollback this deployment:

```bash
# Remove just the email Lambda and SES resources
# (Manual - not recommended, better to fix forward)

# Or rollback entire stack to previous version
cdk deploy --previous-version
```

To disable email alerts without rollback:
1. Remove SNS subscription manually in AWS Console
2. Or disable the Lambda function

## Next Steps

Potential future enhancements:
- [ ] Support more alert types (GPS, temperature)
- [ ] User email preferences (opt-out, digest mode)
- [ ] Email templates with more branding
- [ ] Localization (multi-language support)
- [ ] Rich notifications with charts
- [ ] SMS notifications for critical alerts

## Support

For issues or questions:
- Check Lambda logs: `/aws/lambda/songbird-alert-email`
- Review `lambda/alert-email/README.md` for detailed troubleshooting
- Check SES sending statistics in AWS Console

---

**Deployed by**: Claude Code Assistant
**Date**: 2026-02-06
**Stack Version**: Songbird v1.0 + Email Alerts
