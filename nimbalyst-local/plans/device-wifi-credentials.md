---
planStatus:
  planId: plan-device-wifi-credentials
  title: Device Wi-Fi Credentials Management
  status: in-review
  planType: feature
  priority: medium
  owner: developer
  tags:
    - dashboard
    - config
    - wifi
    - notehub
  created: "2026-01-22"
  updated: "2026-01-22T12:30:00.000Z"
  progress: 100
---
# Device Wi-Fi Credentials Management

## Goals
- Allow device owners to configure Wi-Fi credentials for their claimed devices
- Securely handle password input with proper masking
- Only show Wi-Fi configuration to the user assigned to the device (not admins viewing other users' devices)
- Set the `_wifi` environment variable on individual devices via Notehub API

## Overview

This feature enables users who have claimed a device to configure Wi-Fi credentials that will be synced to the device's Notecard. This uses the Notehub `_wifi` environment variable feature documented at [Managing a Notecard's WiFi Network Remotely](https://dev.blues.io/example-apps/sample-apps/managing-a-notecards-wi-fi-network-remotely/).

The `_wifi` environment variable expects credentials in the format:
```
["SSID","PASSWORD"]
```

Multiple networks can be specified:
```
["FIRST-SSID","FIRST-PASSWORD"],["SECOND-SSID","SECOND-PASSWORD"]
```

**Requirements:**
- Notecard firmware 8.1.3 or later
- Device configured to use Sessions via `hub.set`

## Implementation Details

### Frontend Changes

#### 1. Update ConfigPanel Component
**File:** `songbird-dashboard/src/components/config/ConfigPanel.tsx`

Add a new "Wi-Fi Configuration" section at the bottom of the config panel that:
- **Visibility:** Only shown when `userProfile?.email === assignedTo` (the current user is the device owner)
- **NOT shown to admins** viewing other users' devices (privacy concern - passwords)
- Contains:
  - SSID input field (text)
  - Password input field (type="password" with show/hide toggle)
  - "Set Wi-Fi" button (separate from main Apply Changes button)
  - Helper text explaining the feature

```tsx
{/* Wi-Fi Configuration - Only visible to device owner */}
{userProfile?.email && assignedTo === userProfile.email && (
  <div className="space-y-4 border-t pt-4">
    <h4 className="text-sm font-medium flex items-center gap-2">
      <Wifi className="h-4 w-4" />
      Wi-Fi Configuration
    </h4>
    <p className="text-xs text-muted-foreground">
      Configure Wi-Fi credentials for this device. Requires Notecard firmware 8.1.3+.
    </p>
    {/* SSID and Password inputs */}
    {/* Set Wi-Fi button */}
  </div>
)}
```

#### 2. Add Wi-Fi State Management
- Local state for `wifiSsid` and `wifiPassword`
- Separate mutation for updating Wi-Fi (uses different API endpoint or passes `_wifi` key)
- Show/hide password toggle state

#### 3. Add UI Components
- Use existing `Input` component for SSID
- Use `Input` with `type="password"` for password
- Add Eye/EyeOff toggle icon for password visibility
- Button to "Set Wi-Fi Credentials"

### Backend Changes

#### 1. Update Config Lambda to Handle `_wifi`
**File:** `songbird-infrastructure/lambda/api-config/index.ts`

Option A: **Special handling for ****`_wifi`**** key**
- Add `_wifi` to accepted keys (not in CONFIG_SCHEMA since it has special format)
- In `updateDeviceConfig`, check for `_wifi` key and pass it through directly to Notehub
- Format: `["SSID","PASSWORD"]`

Option B: **New dedicated endpoint** (preferred for separation of concerns)
- Add new endpoint: `PUT /v1/devices/{serial_number}/wifi`
- Request body: `{ ssid: string, password: string }`
- Lambda formats into `_wifi` env var format and sends to Notehub

#### 2. Frontend API Client
**File:** `songbird-dashboard/src/api/config.ts`

Add new function:
```typescript
export async function setDeviceWifi(
  serialNumber: string,
  ssid: string,
  password: string
): Promise<{ success: boolean; message: string }> {
  return apiPut(`/v1/devices/${serialNumber}/wifi`, { ssid, password });
}
```

#### 3. Add React Query Hook
**File:** `songbird-dashboard/src/hooks/useConfig.ts`

```typescript
export function useSetDeviceWifi() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ serialNumber, ssid, password }: {
      serialNumber: string;
      ssid: string;
      password: string
    }) => setDeviceWifi(serialNumber, ssid, password),
    onSuccess: () => {
      // Optionally invalidate device config query
    }
  });
}
```

### Security Considerations

1. **Password never stored in frontend state longer than needed** - cleared after submission
2. **Password never logged** in Lambda
3. **Only device owner can see/set** - not even admins (since they'd see the password)
4. **HTTPS only** - already enforced by API Gateway

## UI/UX Design

```
┌─────────────────────────────────────────┐
│ ⚙️ Device Configuration                 │
├─────────────────────────────────────────┤
│ ... existing config sections ...        │
│                                         │
├─────────────────────────────────────────┤
│ 📶 Wi-Fi Configuration                  │
│                                         │
│ Configure Wi-Fi credentials for this    │
│ device.                                │
│                                         │
│ Network Name (SSID)                     │
│ ┌─────────────────────────────────────┐ │
│ │ MyNetwork                           │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Password                                │
│ ┌─────────────────────────────────┬───┐ │
│ │ ••••••••••••                    │ 👁 │ │
│ └─────────────────────────────────┴───┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │         Set Wi-Fi Credentials       │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Changes will take effect on next sync.  │
└─────────────────────────────────────────┘
```

## File Changes Summary

| File | Change |
| --- | --- |
| `songbird-dashboard/src/components/config/ConfigPanel.tsx` | Add Wi-Fi section with SSID/password inputs |
| `songbird-dashboard/src/api/config.ts` | Add `setDeviceWifi()` function |
| `songbird-dashboard/src/hooks/useConfig.ts` | Add `useSetDeviceWifi()` hook |
| `songbird-infrastructure/lambda/api-config/index.ts` | Add Wi-Fi endpoint handler |
| `songbird-infrastructure/lib/api-construct.ts` | Add route for Wi-Fi endpoint |

## Acceptance Criteria

- [x] Wi-Fi configuration section appears at bottom of ConfigPanel
- [x] Section only visible when current user email matches device `assignedTo`
- [x] Admins viewing other users' devices do NOT see Wi-Fi section
- [x] Password field is masked by default with show/hide toggle
- [x] SSID and password are sent to backend and formatted correctly as `_wifi` env var
- [x] Success/error feedback shown to user after submission
- [x] Form fields cleared after successful submission
- [x] Backend validates SSID is non-empty
- [x] Backend formats `_wifi` value correctly: `["SSID","PASSWORD"]`
