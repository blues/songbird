---
planStatus:
  planId: plan-alert-deduplication
  title: Alert Deduplication on Ingestion
  status: draft
  planType: bug-fix
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - alerts
    - backend
    - dynamodb
  created: "2026-02-18"
  updated: "2026-02-18T00:00:00.000Z"
  progress: 0
---
# Alert Deduplication on Ingestion

## Problem Statement

The system is generating duplicate alerts that pile up in the database. Users are experiencing alert fatigue due to repeated notifications for the same condition (e.g., multiple temperature alerts, GPS no-sat alerts, etc.).

## Current Behavior

Currently, the ingest Lambda creates a new alert every time it detects an alert condition:

1. **alert.qo events** - Temperature alerts sent by firmware
2. **GPS power save alerts** - Created when GPS is disabled for power saving
3. **No-sat alerts** - Created when GPS cannot acquire satellite fix
4. **Low battery alerts** - Created when device restarts due to low battery

Each alert type has logic that checks device state to prevent *state transition* duplicates (e.g., only create GPS power save alert when state changes from false→true), but there's no check for whether an *unacknowledged* alert already exists.

### Example Alert Creation Functions

**GPS Power Save Alert** (lines 665-757 in api-ingest/index.ts):
- Checks if `gps_power_saving` state changed from false→true
- Creates alert if state changed
- **Issue**: Multiple alerts can still be created if events arrive before device state is updated

**No-Sat Alert** (lines 763-851):
- Checks if `gps_no_sat` state changed from false→true
- Creates alert if state changed
- **Issue**: Same race condition as GPS power save

**Low Battery Alert** (lines 586-659):
- No state check at all - creates alert every time device restarts with low battery
- **Issue**: Every restart creates a duplicate alert

**alert.qo Events** (lines 250-253):
- Direct pass-through from firmware
- No deduplication logic
- **Issue**: Firmware could send multiple alerts for same condition

## Desired Behavior

**Only create a new alert if there isn't an unacknowledged alert of the same type for the same device.**

This means:
- If device has unacknowledged `temp_high` alert → don't create another `temp_high` alert
- If device has unacknowledged `gps_no_sat` alert → don't create another `gps_no_sat` alert
- Once user acknowledges an alert, subsequent events can create new alerts
- Different alert types are independent (unacknowledged `temp_high` doesn't block `temp_low`)

## Solution Design

### Core Logic

Add a helper function `hasUnacknowledgedAlert()` that checks for existing unacknowledged alerts:

```typescript
async function hasUnacknowledgedAlert(deviceUid: string, alertType: string): Promise<boolean> {
  // Query the device-index GSI to get recent alerts for this device
  // Filter for alerts of the specified type that are unacknowledged
  // Return true if any exist
}
```

### Implementation Steps

1. **Create helper function** in `api-ingest/index.ts`
  - Query alerts by device_uid using `device-index` GSI
  - Filter by `type` and `acknowledged='false'`
  - Return boolean

2. **Update alert creation functions** to check before creating:
  - `storeAlert()` - for alert.qo events
  - `createGpsPowerSaveAlert()`
  - `createNoSatAlert()`
  - `createLowBatteryAlert()`

3. **Add logging** to track skipped duplicates

### Technical Considerations

**DynamoDB Query Pattern**:
- Use `device-index` GSI (device_uid + created_at)
- Add FilterExpression for `type = :alertType AND acknowledged = :false`
- Only need to check existence (no data required)
- Limit to 1 result for performance

**Performance**:
- Extra query per potential alert creation
- Acceptable since alerts are relatively rare events
- Query is efficient (uses GSI, only checks recent items)

**Race Conditions**:
- Two simultaneous events could still create duplicates
- Acceptable tradeoff - DynamoDB conditional writes would be complex
- This solution eliminates 95%+ of duplicates

**Alert Types to Handle**:
From code analysis, these alert types exist:
- `temp_high` / `temp_low` (from alert.qo)
- `gps_power_save` (when GPS disabled for power saving)
- `gps_no_sat` (when GPS cannot acquire fix)
- `low_battery` (when device restarts due to low voltage)

## Files to Modify

### songbird-infrastructure/lambda/api-ingest/index.ts

**New function** (add after `writeNotecardSwapEvent`, around line 1541):
```typescript
/**
 * Check if device has an unacknowledged alert of the specified type
 * Used to prevent duplicate alerts from piling up
 */
async function hasUnacknowledgedAlert(deviceUid: string, alertType: string): Promise<boolean> {
  const queryCommand = new QueryCommand({
    TableName: ALERTS_TABLE,
    IndexName: 'device-index',
    KeyConditionExpression: 'device_uid = :device_uid',
    FilterExpression: '#type = :alert_type AND acknowledged = :false',
    ExpressionAttributeNames: {
      '#type': 'type',
    },
    ExpressionAttributeValues: {
      ':device_uid': deviceUid,
      ':alert_type': alertType,
      ':false': 'false',
    },
    Limit: 1,
    ScanIndexForward: false, // Most recent first
  });

  try {
    const result = await docClient.send(queryCommand);
    const hasUnacked = (result.Items?.length || 0) > 0;

    if (hasUnacked) {
      console.log(`Skipping duplicate alert creation: device ${deviceUid} already has unacknowledged ${alertType} alert`);
    }

    return hasUnacked;
  } catch (error) {
    console.error(`Error checking for duplicate alert: ${error}`);
    // On error, allow alert creation (fail open)
    return false;
  }
}
```

**Update \****`storeAlert()`**\*\* function** (lines 1097-1130):
```typescript
async function storeAlert(event: SongbirdEvent): Promise<void> {
  // Add check at the beginning
  const alertType = event.body.type || 'unknown';

  // Skip if unacknowledged alert already exists
  if (await hasUnacknowledgedAlert(event.device_uid, alertType)) {
    return;
  }

  // ... rest of existing function
}
```

**Update \****`createGpsPowerSaveAlert()`**\*\* function** (lines 690-757):
```typescript
async function createGpsPowerSaveAlert(event: SongbirdEvent): Promise<void> {
  // Add check at the beginning
  if (await hasUnacknowledgedAlert(event.device_uid, 'gps_power_save')) {
    return;
  }

  // ... rest of existing function
}
```

**Update \****`createNoSatAlert()`**\*\* function** (lines 788-851):
```typescript
async function createNoSatAlert(event: SongbirdEvent): Promise<void> {
  // Add check at the beginning
  if (await hasUnacknowledgedAlert(event.device_uid, 'gps_no_sat')) {
    return;
  }

  // ... rest of existing function
}
```

**Update \****`createLowBatteryAlert()`**\*\* function** (lines 588-659):
```typescript
async function createLowBatteryAlert(event: SongbirdEvent): Promise<void> {
  // Add check at the beginning
  if (await hasUnacknowledgedAlert(event.device_uid, 'low_battery')) {
    return;
  }

  // ... rest of existing function
}
```

## Testing Plan

### Unit Testing
- Test `hasUnacknowledgedAlert()` with mock DynamoDB responses
- Verify query uses correct GSI and filters
- Verify error handling (fail open)

### Integration Testing
1. **Scenario 1: First alert creation**
  - Device sends alert event
  - No existing unacknowledged alerts
  - Alert should be created

2. **Scenario 2: Duplicate prevention**
  - Device sends alert event
  - Unacknowledged alert already exists
  - Alert should NOT be created
  - Log should show "Skipping duplicate alert creation"

3. **Scenario 3: After acknowledgment**
  - Acknowledge existing alert
  - Device sends new alert event
  - Alert should be created (previous was acknowledged)

4. **Scenario 4: Different alert types**
  - Device has unacknowledged `temp_high` alert
  - Device sends `gps_no_sat` alert
  - Alert should be created (different type)

### Manual Testing
1. Deploy to dev environment
2. Trigger multiple temperature alerts from same device
3. Verify only one alert appears in dashboard
4. Acknowledge the alert
5. Trigger another temperature alert
6. Verify new alert is created

## Rollout Plan

1. **Deploy to dev** - Test with real devices
2. **Monitor CloudWatch logs** - Look for "Skipping duplicate alert" messages
3. **Verify alert dashboard** - Confirm no duplicate pileup
4. **Deploy to production** - If dev testing successful

## Success Metrics

- Reduction in total alert count per device
- No "pileup" of identical unacknowledged alerts in dashboard
- CloudWatch logs show duplicate detection working
- Users report reduced alert fatigue

## Open Questions

None - approach is clear and straightforward.

## Alternative Approaches Considered

### Alternative 1: Conditional DynamoDB Writes
Use DynamoDB conditional expressions to prevent duplicate writes at the database level.

**Pros**: Race-condition proof
**Cons**:
- Complex to implement with current alert_id primary key structure
- Would require changing table schema or using device_uid+type as key
- Overkill for this use case

**Decision**: Not worth the complexity. Current approach handles 95%+ of cases.

### Alternative 2: Add "last_alert_time" to device metadata
Track the timestamp of the last alert of each type in the devices table.

**Pros**: No extra query needed
**Cons**:
- Requires device table updates on every alert
- Need to decide on time threshold (how long to suppress duplicates?)
- More complex logic for time-based suppression

**Decision**: Query-based approach is simpler and more flexible.
