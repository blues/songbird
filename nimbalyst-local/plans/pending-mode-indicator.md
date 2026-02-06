---
planStatus:
  planId: plan-pending-mode-indicator
  title: Pending Mode Change Indicator
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - dashboard
    - config
    - ux
  created: "2026-02-06"
  updated: "2026-02-06T00:00:00.000Z"
  progress: 0
---
# Pending Mode Change Indicator

## Problem

When a user changes a device's operating mode (e.g., Demo -> Transit) via the ConfigPanel, the mode is written to Notehub as an environment variable ("desired" mode). However, the dashboard only displays the device's **reported** mode (from DynamoDB `current_mode` field, populated when the device sends a `track.qo` event). There is no visual indication that a mode change is pending until the device syncs, applies the new mode, and reports it back.

This creates confusion: users change the mode, see the old mode still displayed, and wonder if their change was applied.

## Solution

Add a `pending_mode` field to the Device data model. When a config update includes a mode change, store the desired mode in DynamoDB. The dashboard will compare `mode` (reported) vs `pending_mode` (desired), and when they differ, show a visual "pending" indicator. When the device reports the new mode (via ingest), the pending field is cleared.

## Architecture

```
User changes mode in ConfigPanel
       │
       ▼
PUT /v1/devices/{serial}/config  { mode: "transit" }
       │
       ▼
api-config Lambda
  ├─ Sets env var on Notehub (existing behavior)
  └─ NEW: Writes pending_mode to DynamoDB Devices table
       │
       ▼
Device syncs, applies mode, sends track.qo with mode="transit"
       │
       ▼
api-ingest Lambda
  └─ NEW: If event.body.mode matches pending_mode, clear pending_mode
       │
       ▼
Dashboard fetches device → pending_mode is null → indicator gone
```

## Implementation Steps

### Step 1: Infrastructure — api-config Lambda

**File:** `songbird-infrastructure/lambda/api-config/index.ts`

When `updateDeviceConfig()` successfully writes to Notehub and the config includes a `mode` change:

1. Import DynamoDB `UpdateCommand` from `@aws-sdk/lib-dynamodb`
2. Add `DEVICES_TABLE` environment variable reference
3. After the successful Notehub PUT, write `pending_mode` to the Devices table:
```
   UpdateExpression: "SET pending_mode = :pm"
   Key: { device_uid }
   ExpressionAttributeValues: { ":pm": updates.mode }
```
4. Only write `pending_mode` when `updates.mode` is present in the request body

**New env var needed:** `DEVICES_TABLE` must be passed to the api-config Lambda (via CDK construct).

### Step 2: Infrastructure — api-config CDK construct

**File:** `songbird-infrastructure/lib/api-construct.ts`

- Add the `DEVICES_TABLE` environment variable to the api-config Lambda function, pointing to the Devices DynamoDB table
- Grant the api-config Lambda `dynamodb:UpdateItem` permission on the Devices table

### Step 3: Infrastructure — api-ingest Lambda

**File:** `songbird-infrastructure/lambda/api-ingest/index.ts`

In `updateDeviceMetadata()`, when `event.body.mode` is present:

1. Conditionally remove `pending_mode` only when the device's reported mode matches the pending mode. This requires a DynamoDB condition expression:
   ```
   SET #mode = :mode ...
   REMOVE pending_mode
   ConditionExpression: pending_mode = :mode OR attribute_not_exists(pending_mode)
   ```
   However, since `updateDeviceMetadata` is a single unconditional update, we can't fail the whole update on a condition. Instead, use a two-step approach:
   - In the main update, always set `current_mode` as today (no change).
   - After the main update, issue a separate conditional update to clear `pending_mode` only if it matches the reported mode:
     ```
     UpdateExpression: "REMOVE pending_mode"
     ConditionExpression: "pending_mode = :reported_mode"
     ExpressionAttributeValues: { ":reported_mode": event.body.mode }
     ```
   - Wrap in try/catch and ignore `ConditionalCheckFailedException` (means pending mode doesn't match yet — the device hasn't applied the desired change).

   This ensures the pending indicator stays visible until the device actually confirms the target mode, which is important when a user changes the mode multiple times quickly or when the device reports an intermediate mode.

### Step 4: Infrastructure — api-devices Lambda

**File:** `songbird-infrastructure/lambda/api-devices/index.ts`

In `transformDevice()`, add `pending_mode` to the transformed output:
```typescript
pending_mode: item.pending_mode || null,
```

### Step 5: Dashboard — Types

**File:** `songbird-dashboard/src/types/index.ts`

Add `pending_mode` to the `Device` interface:
```typescript
pending_mode?: OperatingMode | null;
```

### Step 6: Dashboard — ConfigPanel

**File:** `songbird-dashboard/src/components/config/ConfigPanel.tsx`

After a successful config apply that includes a mode change, optimistically update the device query cache to set `pending_mode` so the indicator appears immediately without waiting for a device list refetch.

In `useUpdateDeviceConfig` hook (`songbird-dashboard/src/hooks/useConfig.ts`), add cache invalidation for the device query:
```typescript
onSuccess: (_, { serialNumber }) => {
  queryClient.invalidateQueries({ queryKey: ['config', serialNumber] });
  queryClient.invalidateQueries({ queryKey: ['devices'] });  // refresh device data
  queryClient.invalidateQueries({ queryKey: ['device', serialNumber] });
}
```

### Step 7: Dashboard — Mode Badge with Pending Indicator

**Files:**
- `songbird-dashboard/src/components/devices/DeviceCard.tsx`
- `songbird-dashboard/src/pages/DeviceDetail.tsx`

Where the mode badge is rendered, add pending mode logic:

```tsx
{device.pending_mode && device.pending_mode !== device.mode && (
  <Badge variant="outline" className="gap-1 border-blue-300 bg-blue-50 text-blue-700 animate-pulse">
    <ArrowRight className="h-3 w-3" />
    {formatMode(device.pending_mode)}
  </Badge>
)}
```

This will show:
- Current mode badge (existing): e.g., `Demo` (green lock or secondary)
- Pending mode badge (new): e.g., `→ Transit` with a subtle pulse animation and blue styling

The pending badge appears next to the current mode badge, visually indicating "currently Demo, changing to Transit."

### Step 8: Dashboard — ConfigPanel Pending Notice

**File:** `songbird-dashboard/src/components/config/ConfigPanel.tsx`

Need to pass the device's `pending_mode` into ConfigPanel so it can show context. Add a `currentDevice` or `pendingMode` prop.

When there is a pending mode change, show an info banner near the Operating Mode selector:
```
ℹ️ Mode change to "Transit" is pending — waiting for device to sync
```

## UI Mockup

The pending indicator will appear as follows:

**DeviceCard (fleet view):**
```
[Demo] [→ Transit ⟳]    ● Online
```
The first badge is the current reported mode (existing). The second badge is the pending target mode with a subtle pulse animation.

**DeviceDetail page:**
```
Fleet: Default • Assigned: John • [Demo] [→ Transit ⟳] • Last seen: 2 min ago
```

**ConfigPanel:**
```
Operating Mode
[Transit ▼]
ℹ️ Mode change to "Transit" is pending — waiting for device to sync
```

## Edge Cases

1. **User changes mode again before device syncs**: The new `pending_mode` overwrites the old one. Only the latest desired mode matters.

2. **Device reports mode that doesn't match pending**: `pending_mode` is only cleared when the reported mode matches it. The pending indicator stays visible until the device confirms the target mode. For example, if pending is "transit" and device reports "demo", the indicator remains.

3. **Fleet-level mode change**: Fleet config changes via Notehub env vars apply to all devices, but we'd need to set `pending_mode` on each device. For now, we'll scope this to **device-level config changes only**. Fleet-level changes already show a "will take effect on next sync" message.

4. **Offline device**: The pending badge will remain until the device comes online and reports. This is correct behavior — it accurately shows the change hasn't been applied yet.

5. **Config page already shows Notehub env vars**: The ConfigPanel's dropdown already shows the *desired* mode (from Notehub), not the *reported* mode. So the dropdown will already show "Transit" after applying. The new indicator adds visibility to the **device card / detail page** where only the reported mode is shown today.

## Files Changed Summary

| File | Change |
| --- | --- |
| `songbird-infrastructure/lambda/api-config/index.ts` | Write `pending_mode` to DynamoDB on mode change |
| `songbird-infrastructure/lib/api-construct.ts` | Add `DEVICES_TABLE` env var + permissions for api-config |
| `songbird-infrastructure/lambda/api-ingest/index.ts` | Clear `pending_mode` when device reports mode |
| `songbird-infrastructure/lambda/api-devices/index.ts` | Include `pending_mode` in `transformDevice()` |
| `songbird-dashboard/src/types/index.ts` | Add `pending_mode` to `Device` interface |
| `songbird-dashboard/src/components/devices/DeviceCard.tsx` | Show pending mode badge |
| `songbird-dashboard/src/pages/DeviceDetail.tsx` | Show pending mode badge |
| `songbird-dashboard/src/hooks/useConfig.ts` | Invalidate device queries on config update |
| `songbird-dashboard/src/components/config/ConfigPanel.tsx` | Show pending mode info banner |

## No Changes Needed

- **Firmware**: No changes — device already reports mode in `track.qo`
- **DynamoDB schema**: No schema changes needed — DynamoDB is schemaless, `pending_mode` is added dynamically
- **New API endpoints**: None needed — existing device endpoints will include the new field
