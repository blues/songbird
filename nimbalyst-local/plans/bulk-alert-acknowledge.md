---
planStatus:
  planId: plan-bulk-alert-acknowledge
  title: Bulk Alert Acknowledgment
  status: in-review
  planType: feature
  priority: medium
  owner: satch
  tags:
    - dashboard
    - alerts
    - ux
  created: "2025-02-02"
  updated: "2025-02-02T18:30:00.000Z"
  progress: 90
---
# Bulk Alert Acknowledgment

## Goals
- Allow device owners and admins to acknowledge all their alerts in a single click
- Reduce manual effort when managing multiple alerts
- Maintain proper authorization (users can only acknowledge alerts they have access to)

## Overview

Currently, users must acknowledge alerts one at a time. When a device generates multiple alerts (e.g., temperature threshold breaches during transit), this becomes tedious. This feature adds a "Acknowledge All" button that acknowledges all visible/filtered alerts at once.

## Implementation Details

### 1. Infrastructure Changes (`songbird-infrastructure/`)

**File: ****`lambda/alerts/index.ts`**

Add new endpoint or action for bulk acknowledgment:

```typescript
// POST /alerts/acknowledge-all
// Body: { alertIds?: string[], filters?: { deviceId?, status?, severity? } }

async function handleBulkAcknowledge(event: APIGatewayEvent) {
  const userId = getUserIdFromToken(event);
  const userGroups = getUserGroupsFromToken(event);
  const isAdmin = userGroups.includes('Admin');

  const { alertIds, filters } = JSON.parse(event.body || '{}');

  // If specific alertIds provided, use those
  // Otherwise, query alerts matching filters that user has access to
  let alertsToAcknowledge: Alert[];

  if (alertIds?.length) {
    alertsToAcknowledge = await getAlertsByIds(alertIds);
  } else {
    alertsToAcknowledge = await queryAlerts({
      ...filters,
      status: 'active'  // Only acknowledge active alerts
    });
  }

  // Filter to only alerts user can acknowledge
  const authorizedAlerts = alertsToAcknowledge.filter(alert => {
    if (isAdmin) return true;
    const device = await getDevice(alert.deviceId);
    return device.assignedTo === userId;
  });

  // Batch update all authorized alerts
  await batchUpdateAlerts(authorizedAlerts.map(a => a.alertId), {
    status: 'acknowledged',
    acknowledgedBy: userId,
    acknowledgedAt: new Date().toISOString()
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      acknowledged: authorizedAlerts.length,
      total: alertsToAcknowledge.length
    })
  };
}
```

### 2. Dashboard Changes (`songbird-dashboard/`)

**File: ****`src/api/alerts.ts`**

Add bulk acknowledge function:

```typescript
export async function acknowledgeAllAlerts(
  alertIds?: string[],
  filters?: AlertFilters
): Promise<{ acknowledged: number; total: number }> {
  const response = await apiClient.post('/alerts/acknowledge-all', {
    alertIds,
    filters
  });
  return response.data;
}
```

**File: ****`src/pages/Alerts.tsx`** (or wherever alert list is rendered)

Add "Acknowledge All" button:

```tsx
<Button
  variant="outline"
  onClick={handleAcknowledgeAll}
  disabled={!hasActiveAlerts || isAcknowledging}
>
  {isAcknowledging ? (
    <Spinner className="mr-2" />
  ) : (
    <CheckCheck className="mr-2 h-4 w-4" />
  )}
  Acknowledge All
</Button>
```

**File: ****`src/components/AlertList.tsx`** (or similar)

- Add button in header/toolbar area
- Only show when there are active alerts
- Include confirmation dialog: "Acknowledge X alerts? This cannot be undone."
- Show success toast with count: "Acknowledged 12 alerts"

### 3. UX Considerations

1. **Confirmation Dialog**: Always confirm before bulk action
2. **Filtered Scope**: Button acknowledges alerts matching current filters
3. **Visual Feedback**: Show loading state, then success/error message
4. **Count Display**: Show how many alerts will be affected before confirming
5. **Undo**: Consider if undo is needed (probably not for acknowledge)

### Authorization Rules

| User Role | Can Acknowledge |
| --- | --- |
| Admin | All alerts |
| Sales | Alerts for devices they own |
| FieldEngineering | Read-only (no acknowledge) |
| Viewer | Read-only (no acknowledge) |

## Acceptance Criteria

- [x] New API endpoint `POST /alerts/acknowledge-all` exists
- [ ] Endpoint validates user authorization before acknowledging each alert
- [x] Admins can acknowledge all alerts
- [ ] Device owners can only acknowledge alerts for their devices
- [x] Dashboard shows "Acknowledge All" button on Alerts page
- [x] Button is disabled when no active alerts exist
- [x] Confirmation dialog shows count of alerts to be acknowledged
- [ ] Success toast shows count of acknowledged alerts
- [x] Alert list refreshes after bulk acknowledgment
- [x] Button respects current filters (only acknowledges filtered alerts)

## Testing

1. **Admin Flow**: Admin can acknowledge all alerts across all devices
2. **Owner Flow**: Device owner can acknowledge alerts only for their devices
3. **Viewer Flow**: Viewer should not see the acknowledge button
4. **Partial Auth**: If some alerts are unauthorized, only authorized ones are acknowledged
5. **Empty State**: Button disabled when no active alerts
6. **Filtered**: With filters applied, only filtered alerts are acknowledged
