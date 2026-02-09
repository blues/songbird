---
planStatus:
  planId: plan-low-battery-email-alerts
  title: Low Battery Email Alerts
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - alerts
    - email
    - notifications
    - battery
    - ses
    - cognito
  created: "2026-02-06"
  updated: "2026-02-06T12:00:00.000Z"
  progress: 30
  estimatedHours: 6
  actualHours: 0
---
# Low Battery Email Alerts

## Overview

Add email notification capability to alert users when their devices have low battery conditions. Currently, low battery alerts are detected and stored in DynamoDB, but users are only notified through the dashboard UI. This feature will send email notifications to device owners and administrators.

## Current State

### Low Battery Detection

The system already detects low battery conditions in `songbird-infrastructure/lambda/api-ingest/index.ts`:

- **Threshold**: 3.0V (defined as `LOW_BATTERY_THRESHOLD`)
- **Trigger**: When a `_health.qo` event is received with `voltage < 3.0V` AND the device has restarted
- **Alert Creation**:
  - Alert stored in DynamoDB `songbird-alerts` table
  - Alert published to SNS topic `songbird-alerts`
  - Alert includes: device_uid, serial_number, voltage, location, metadata

### Existing Alert Infrastructure

**SNS Topic**: Already exists (`songbird-alerts`)
- Created in `songbird-infrastructure/lib/songbird-stack.ts` (line 42-45)
- Topic ARN passed to ingest Lambda
- Low battery alerts already published to this topic

**Alert Types**: System currently generates:
- `low_battery` - Device restarted due to low battery (< 3.0V)
- `gps_power_save` - GPS disabled for power saving
- `gps_no_sat` - Unable to obtain GPS location
- `temp_high`, `temp_low` - Temperature threshold alerts

### User Management

**User Email Storage** (Confirmed from codebase exploration):
- User emails are stored in Cognito User Pool as a standard attribute (required)
- Email is set during user creation and can be retrieved via Cognito Admin APIs
- `songbird-infrastructure/lambda/api-users/index.ts` shows email retrieval pattern:
```typescript
  const emailAttr = user.Attributes?.find(a => a.Name === 'email');
```

**User Groups** (Confirmed):
- Four groups defined in `auth-construct.ts`:
  - **Admin** - Full access (precedence: 1)
  - **Sales** - Team members (precedence: 10)
  - **FieldEngineering** - Team members (precedence: 10)
  - **Viewer** - Read-only (precedence: 100)
- Groups are retrievable via `AdminListGroupsForUserCommand`
- Can also list all users in a group via Cognito APIs

**Device Assignment** (Confirmed):
- Devices table has `assigned_to` field containing user email (not username)
- Devices table also has `assigned_to_name` field for display purposes
- Each user can be assigned ONE device at a time (enforced in api-users Lambda)
- Assignment logic in `api-users/index.ts` lines 104-144

## Requirements

### Email Notifications

1. **Recipients**:
  - Device owner (if device has assigned_to field set)
  - Admin users (always notified for all low battery alerts)
  - Optional: Sales and Field Engineering groups (configurable)

2. **Email Content**:
  - Subject: "Low Battery Alert: [Device Serial Number]"
  - Body should include:
    - Device serial number and name
    - Current voltage level
    - Timestamp of alert
    - Location (if available)
    - Link to device detail page in dashboard
    - Recommendation to charge device

3. **Alert Conditions**:
  - Only send email when alert is first created (not on subsequent low battery events)
  - Don't send emails for devices that are USB powered
  - Include rate limiting/deduplication (e.g., max 1 email per device per 24 hours)

## Technical Approach

### Option 1: SES Email Subscription (Recommended)

Use AWS SES (Simple Email Service) to send emails triggered by SNS:

**Pros**:
- Native AWS service integration
- Reliable delivery with retries
- Bounce/complaint handling built-in
- Can use SES templates for formatted emails
- Cost-effective for moderate volume

**Cons**:
- Requires SES verification (domain or individual emails)
- Initial SES sandbox limitations
- Need to manage SES sending limits

**Implementation**:
1. Add SES identity verification (domain or email)
2. Create Lambda function subscribed to SNS topic
3. Lambda queries user data and sends SES emails
4. Use SES templates for consistent formatting

### Option 2: SNS Email Subscription (Simple but Limited)

Use SNS's built-in email protocol:

**Pros**:
- Very simple setup
- No additional Lambda needed
- Built-in subscription management

**Cons**:
- Plain text only (no HTML formatting)
- No dynamic recipient selection
- Users must confirm subscription
- Limited customization
- Can't include user-specific content

### Option 3: Third-Party Service (e.g., SendGrid, Mailgun)

**Pros**:
- Advanced features (analytics, A/B testing, templates)
- Better deliverability reputation
- No AWS SES limits

**Cons**:
- Additional cost
- External dependency
- API key management
- Overkill for this use case

## Recommended Architecture

```
┌─────────────────┐
│  Ingest Lambda  │
│  (api-ingest)   │
└────────┬────────┘
         │ Low battery detected
         ▼
┌─────────────────┐
│   SNS Topic     │ ← Already exists
│ songbird-alerts │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Email Lambda   │ ← NEW
│ (alert-email)   │
└────────┬────────┘
         │
         ├─→ Query Cognito for user emails
         ├─→ Query DynamoDB for device ownership
         ├─→ Check deduplication (recent emails)
         │
         ▼
┌─────────────────┐
│   AWS SES       │ ← NEW
│ (Email Service) │
└─────────────────┘
```

## Implementation Plan

### Phase 1: Infrastructure Setup

1. **Add SES to CDK Stack** (`songbird-infrastructure/lib/songbird-stack.ts`)
  - Verify SES identity (email or domain)
  - Create SES email templates
  - Grant SES permissions to Lambda

2. **Create Email Lambda** (`songbird-infrastructure/lambda/alert-email/`)
  - Subscribe to SNS `songbird-alerts` topic
  - Filter for `low_battery` alert type
  - Fetch user emails from Cognito
  - Fetch device assignments from DynamoDB
  - Implement deduplication logic
  - Send formatted emails via SES

3. **Add Email Deduplication Table** (Optional)
  - DynamoDB table to track recent emails
  - Key: `device_uid + alert_type + date`
  - TTL: 24 hours
  - Prevent duplicate emails for same alert

### Phase 2: Email Template Design

1. **Create HTML Email Template**
  - Professional Blues branding
  - Clear alert information
  - Call-to-action (view device in dashboard)
  - Responsive design for mobile

2. **Plain Text Fallback**
  - Same content in plain text for email clients that don't support HTML

### Phase 3: Email Lambda Implementation

1. **Recipient Resolution Logic**
  - Extract `device_uid` and `serial_number` from SNS message
  - Query DynamoDB devices table to get `assigned_to` email
  - Query Cognito to list all Admin group members
  - Build recipient list: [assigned_to email] + [all Admin emails]
  - Filter out any duplicates

2. **Cognito Integration**
  - Use `ListUsersInGroupCommand` to get all Admin users
  - Parse email attribute from Cognito user attributes
  - Handle errors gracefully (if Cognito is unavailable, log and continue)

3. **Device Assignment Handling**
  - If device has no `assigned_to`, only send to Admins
  - If `assigned_to` email is invalid or user is deleted, log warning and skip
  - Consider caching Admin email list (updates infrequently)

### Phase 4: Testing & Deployment

1. **Unit Tests**
  - Test email formatting
  - Test recipient selection logic
  - Test deduplication

2. **Integration Tests**
  - Test end-to-end flow from low battery detection to email delivery
  - Test with multiple user types (Admin, device owner)
  - Test deduplication

3. **Production Rollout**
  - Deploy to staging first
  - Verify SES sending limits
  - Monitor CloudWatch logs
  - Deploy to production

## Open Questions

### ANSWERED (from codebase exploration):

1. ✅ **User Email Addresses**:
  - Emails ARE stored in Cognito as required standard attribute
  - Need to query Cognito for each alert (or implement short-lived cache)
  - All users must have email to sign up (verified via Cognito email verification)

2. ✅ **Device Assignment**:
  - `assigned_to` field contains user **email** (not username or user ID)
  - Only one device per user currently supported
  - Assignment managed in `api-users` Lambda

### NEED USER INPUT:

3. **Email Preferences**:
  - Should users be able to opt out of low battery emails?
  - Should we add user preferences to settings table?
  - Should we support email digest (daily summary) vs real-time alerts?

4. **SES Setup**:
  - Do we have a domain verified in SES, or should we use email verification?
  - What sending limits apply (sandbox vs production)?
  - From address to use (e.g., alerts@blues.com)?

5. **Alert Deduplication**:
  - Should we deduplicate at the Lambda level or in the database?
  - What's the appropriate deduplication window? (24 hours recommended)
  - Should we send a "battery recovered" email when voltage returns to normal?

6. **Scope**:
  - Should this apply to all alert types, or just low_battery?
  - Should we include GPS alerts (gps_no_sat, gps_power_save)?
  - Should we include temperature alerts (temp_high, temp_low)?
  - Should Sales and FieldEngineering groups receive alerts?

## Effort Estimate

### Development Time: ~4-6 hours

**Phase 1 - Infrastructure (2-3 hours)**:
- SES setup and verification: 30-60 min
- CDK changes (SES construct, Lambda construct): 60 min
- Email Lambda skeleton + SNS subscription: 30-45 min

**Phase 2 - Implementation (1.5-2 hours)**:
- Recipient resolution logic: 45 min
- Email template creation (HTML + text): 45 min
- Deduplication logic: 30 min

**Phase 3 - Testing & Deployment (0.5-1 hour)**:
- Local testing with mock events: 20 min
- Integration testing in dev environment: 20 min
- Production deployment + monitoring: 20 min

### AWS Costs (Estimated)

**SES**:
- First 62,000 emails per month: FREE (when sent from EC2/Lambda)
- After that: $0.10 per 1,000 emails
- Expected volume: < 100 emails/month → **FREE**

**Lambda**:
- Alert email Lambda executions: ~100/month
- Duration: ~500ms per execution
- Cost: < $0.01/month → **NEGLIGIBLE**

**DynamoDB** (for deduplication queries):
- Alert table queries: ~100/month (already have the table)
- Cost: < $0.01/month → **NEGLIGIBLE**

**Total Monthly Cost**: < $1 (essentially free for this volume)

### Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| SES sandbox limits | Can't send to unverified emails | Move to production SES, verify domain |
| Cognito query latency | Slow email delivery | Cache Admin user list (refresh every 5 min) |
| Email delivery failures | Users don't get alerts | Log failures, set up CloudWatch alarms |
| Spam filters | Emails end up in spam | Use verified domain, proper SPF/DKIM, test with popular clients |
| Too many emails | Alert fatigue | Implement 24-hour deduplication window |

## Success Criteria

1. **Functional**:
  - Email sent within 1 minute of low battery detection
  - Correct recipients receive emails (device owner + admins)
  - No duplicate emails sent for same alert within 24 hours
  - Email contains accurate device information and link to dashboard

2. **Quality**:
  - Email deliverability > 95%
  - Well-formatted HTML email with fallback
  - Mobile-responsive design
  - Professional appearance

3. **Operational**:
  - CloudWatch logs show email delivery status
  - Failed deliveries are logged and can be investigated
  - SES bounce/complaint handling configured
  - Monitoring alerts for email delivery failures

## Technical Details

### Recipient Resolution Algorithm

```typescript
async function getRecipients(deviceUid: string): Promise<string[]> {
  const recipients = new Set<string>();

  // 1. Get device owner email from DynamoDB
  const device = await getDevice(deviceUid);
  if (device.assigned_to) {
    recipients.add(device.assigned_to);
  }

  // 2. Get all Admin users from Cognito
  const adminUsers = await listUsersInGroup('Admin');
  for (const user of adminUsers) {
    const email = user.Attributes.find(a => a.Name === 'email')?.Value;
    if (email) {
      recipients.add(email);
    }
  }

  return Array.from(recipients);
}
```

### Email Content Structure

**Subject**: `🔋 Low Battery Alert: ${deviceSerialNumber} (${voltage.toFixed(2)}V)`

**Body**:
- Device identification (serial number, name if set)
- Current battery voltage
- Time of alert
- Location (city/address if available)
- Direct link to device detail page
- Action recommendation ("Please charge the device soon")

**From**: `alerts@blues.com` or configured sender email

**Reply-To**: `support@blues.com` or configured support email

### Deduplication Strategy

Use existing DynamoDB alerts table TTL:
- Query alerts table for recent low_battery alerts for this device
- If alert exists with `created_at` within last 24 hours, skip email
- This leverages existing infrastructure and avoids new table

Alternative: Add `email_sent_at` timestamp to alert record after sending

### Files to Create/Modify

**New Files**:
1. `songbird-infrastructure/lambda/alert-email/index.ts` - Main email Lambda
2. `songbird-infrastructure/lambda/alert-email/email-template.html` - HTML template
3. `songbird-infrastructure/lambda/alert-email/email-template.txt` - Plain text template

**Modified Files**:
1. `songbird-infrastructure/lib/songbird-stack.ts` - Add SES, create email Lambda, subscribe to SNS
2. `songbird-infrastructure/lib/api-construct.ts` - May need to reference email Lambda (if permissions needed)

## Next Steps

### Before Implementation:

1. ✅ ~~Investigate user email storage in Cognito~~ (COMPLETED)
2. ✅ ~~Understand device assignment pattern~~ (COMPLETED)
3. ❓ **Clarify requirements with user**:
  - Which alert types should trigger emails?
  - Should Sales/FieldEngineering receive emails?
  - Email preferences / opt-out needed?
  - SES domain verification status?
4. Get SES sending credentials and verify identity
5. Design email template (HTML + plain text)

### Implementation Order:

1. Set up SES in CDK (identity, templates)
2. Create email Lambda with SNS subscription
3. Implement recipient resolution logic
4. Implement email sending with SES
5. Add deduplication logic
6. Test with mock low battery alerts
7. Deploy and monitor
