---
planStatus:
  planId: plan-low-battery-alert-detection
  title: Low Battery Alert Detection
  status: ready-for-development
  planType: feature
  priority: medium
  owner: developer
  tags:
    - infrastructure
    - alerts
    - dashboard
    - battery
    - health-monitoring
  created: "2025-01-15"
  updated: "2025-01-15"
  progress: 0
---

# Low Battery Alert Detection

## Goals
- Detect low-battery conditions by inspecting `_health.qo` messages from the Notecard
- Create alerts when devices restart due to insufficient battery power
- Display low battery alerts in the dashboard with appropriate visual indicators

## Overview

The Notecard sends `_health.qo` messages that contain voltage readings and restart information. When a device restarts due to low battery (brownout), the system should detect this condition and create an alert to notify users before the device becomes completely unresponsive.

## Health Message Payload

The Notecard sends `_health.qo` messages with the following structure:
```json
{
  "method": "dfu",
  "milliamp_hours": 1432.928,
  "text": "host restarted: notecard restarted",
  "voltage": 2.9042969,
  "voltage_mode": "normal"
}
```

**Key indicators of low battery:**
- `voltage` < 3.0V
- `text` contains "restarted" (indicates device restarted, likely due to brownout)

---

## Implementation Details

### 1. Infrastructure Changes

#### 1.1 Update Ingest Lambda

**File:** `songbird-infrastructure/lambda/ingest/index.ts`

Add handler for `_health.qo` notefile:

```typescript
// In the event processing logic
if (event.file === '_health.qo') {
  await processHealthEvent(event);
}

async function processHealthEvent(event: NotehubEvent): Promise<void> {
  const body = event.body;
  const LOW_BATTERY_THRESHOLD = 3.0;

  // Check for low battery condition
  if (
    typeof body.voltage === 'number' &&
    body.voltage < LOW_BATTERY_THRESHOLD &&
    typeof body.text === 'string' &&
    body.text.includes('restarted')
  ) {
    // Create low battery alert
    await createAlert({
      deviceId: event.device,
      serialNumber: event.sn,
      type: 'low_battery',
      severity: 'warning',
      message: `Device restarted due to low battery (${body.voltage.toFixed(2)}V)`,
      metadata: {
        voltage: body.voltage,
        voltage_mode: body.voltage_mode,
        milliamp_hours: body.milliamp_hours,
        health_text: body.text,
      },
      timestamp: event.when,
    });
  }
}
```

#### 1.2 Add Alert Type

**File:** `songbird-infrastructure/lambda/alerts/index.ts`

Add `low_battery` to supported alert types:

```typescript
const ALERT_TYPES = [
  'temperature_high',
  'temperature_low',
  'low_battery',  // New alert type
  'geofence_exit',
  // ... other types
];
```

---

### 2. Dashboard Changes

#### 2.1 Update Alert Type Definitions

**File:** `songbird-dashboard/src/types/index.ts`

Add `low_battery` to the `AlertType` enum:

```typescript
export type AlertType =
  | 'temperature_high'
  | 'temperature_low'
  | 'low_battery'  // New type
  | 'geofence_exit'
  // ... other types
```

#### 2.2 Update Alert Display

**File:** `songbird-dashboard/src/components/alerts/AlertItem.tsx`

Add display handling for low battery alerts:

```typescript
const alertTypeConfig: Record<AlertType, { icon: LucideIcon; color: string; label: string }> = {
  // ... existing types
  low_battery: {
    icon: BatteryLow,
    color: 'text-orange-500',
    label: 'Low Battery',
  },
};
```

---

## Acceptance Criteria

- [ ] Ingest Lambda processes `_health.qo` events
- [ ] Alerts are created when voltage < 3.0V and text contains "restarted"
- [ ] Alert includes voltage reading and health metadata
- [ ] Dashboard displays low battery alerts with appropriate icon
- [ ] Alert severity is set to "warning"

---

## Testing Plan

1. **Simulate low battery event**: Send a test `_health.qo` event with voltage < 3.0V and "restarted" in text
2. **Verify alert creation**: Confirm alert appears in Alerts table with correct metadata
3. **Dashboard display**: Verify alert shows with battery icon and orange color
4. **Edge cases**: Test with voltage exactly at 3.0V (should not trigger), test without "restarted" text (should not trigger)

---

## Files to Modify

### Infrastructure
1. `songbird-infrastructure/lambda/ingest/index.ts` - Add `_health.qo` processing
2. `songbird-infrastructure/lambda/alerts/index.ts` - Add `low_battery` alert type

### Dashboard
3. `songbird-dashboard/src/types/index.ts` - Add `low_battery` to AlertType
4. `songbird-dashboard/src/components/alerts/AlertItem.tsx` - Add low battery display config
